import { AppError } from './errors.js';
import { deepClone, nowIso } from './utils.js';

export class Coordinator {
  constructor({
    store,
    taskManager,
    identity,
    configService,
    browse,
    comments,
    directMessages,
    diary,
    production = null,
    publisher = null,
    agent = null,
    now = () => new Date(),
    logger
  } = {}) {
    this.store = store;
    this.taskManager = taskManager;
    this.identity = identity;
    this.configService = configService;
    this.browse = browse;
    this.comments = comments;
    this.directMessages = directMessages;
    this.diary = diary;
    this.production = production;
    this.publisher = publisher;
    this.agent = agent;
    this.now = now;
    this.logger = logger;
    this.timer = null;
    this.started = false;
    this.stopping = false;
    this.active = new Set();
    this.executingKinds = new Set();
    this._tickPromise = null;
  }

  async _schedulerPrincipal() {
    return this.store.transaction(async (draft, tx) => this.identity.ensureScheduler(tx, this.configService.get()));
  }

  async start() {
    if (this.started) return { started: true, deduplicated: true };
    this.started = true;
    this.stopping = false;
    const config = this.configService.get();
    const instance = await this.store.getInstance();
    const schedulerAllowed =
      instance?.status === 'active' &&
      instance.schedulerDisabled !== true &&
      config.scheduler.enabled === true;
    if (schedulerAllowed) {
      this.timer = setInterval(() => {
        this.tick().catch((error) => {
          this.logger?.warn?.('coordinator tick failed', { message: error.message });
        });
      }, config.scheduler.tickSeconds * 1000);
      this.timer.unref?.();
    }
    return {
      started: true,
      scheduler: schedulerAllowed,
      schedulerDisabledByInstance: !schedulerAllowed &&
        (instance?.schedulerDisabled === true || instance?.status !== 'active')
    };
  }

  async stop() {
    if (!this.started && this.active.size === 0) {
      this.stopping = true;
      return { stopped: true, deduplicated: true };
    }
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.started = false;
    // Do not cancel in-flight effects; wait for local rounds to finish.
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(resolve, 5000);
      timer.unref?.();
    });
    await Promise.race([Promise.allSettled([...this.active]), timeout]);
    clearTimeout(timer);
    return { stopped: true, active: this.active.size };
  }

  _todayDate(timeZone = null) {
    const config = this.configService.get();
    const zone = timeZone || config.timeZone;
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(this.now());
  }

  _workspaceScope(workspaceId) {
    return `workspace/${workspaceId}`;
  }

  async tick() {
    if (!this.started || this.stopping) return { skipped: true, reason: 'stopped' };
    if (this._tickPromise) return this._tickPromise;
    const config = this.configService.get();
    if (!config.scheduler.enabled) return { skipped: true, reason: 'scheduler_disabled' };
    this._tickPromise = (async () => {
      const state = await this.store.getSnapshot();
      const capacity = await this.store.capacityStatus(state);
      if (capacity.status !== 'healthy') return { skipped: true, reason: 'capacity_warning', capacity };
      const cursor = state.cursors.scheduler || {};
      const now = this.now();
      const localTime = new Intl.DateTimeFormat('en-GB', {
        timeZone: config.timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
      }).format(now);
      const today = new Intl.DateTimeFormat('en-CA', {
        timeZone: config.timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).format(now);
      const actions = [];
      if (config.browse.enabled) {
        const last = cursor.browseLastRunAt ? Date.parse(cursor.browseLastRunAt) : 0;
        if (!last || now.getTime() - last >= config.scheduler.browseIntervalMinutes * 60 * 1000) {
          actions.push('browse');
        }
      }
      if (config.diary.enabled && config.diary.daily && localTime >= config.scheduler.diaryTime && cursor.diaryLastDate !== today) {
        actions.push('diary');
      }
      if (actions.length === 0) return { ran: [] };
      const outcomes = [];
      for (const action of actions) {
        if (action === 'browse') {
          await this.runBrowse({ trigger: 'scheduler' }).catch((error) => {
            this.logger?.warn?.('scheduled browse failed', { message: error.message });
          });
          await this.store.transaction(async (draft) => {
            draft.cursors.scheduler = { ...(draft.cursors.scheduler || {}), browseLastRunAt: nowIso(this.now) };
          });
          outcomes.push('browse');
        } else if (action === 'diary') {
          // Scheduled diary goes through runDiary so the diary kind lock and
          // both-book generation match manual runs (§16 / M06).
          let succeeded = false;
          try {
            const principal = await this._schedulerPrincipal();
            await this.runDiary({
              date: today,
              scope: this._workspaceScope(state.workspaceId),
              book: null,
              force: false,
              principal
            });
            succeeded = true;
          } catch (error) {
            this.logger?.warn?.('scheduled diary failed', {
              code: error.code || 'DEPENDENCY_UNAVAILABLE',
              message: error.message
            });
          }
          // Only advance the daily cursor after every configured book succeeded;
          // a failure is retried on the next tick (F07/M03).
          if (succeeded) {
            await this.store.transaction(async (draft) => {
              draft.cursors.scheduler = { ...(draft.cursors.scheduler || {}), diaryLastDate: today };
            });
          }
          outcomes.push(succeeded ? 'diary' : 'diary_failed');
        }
      }
      return { ran: actions, outcomes };
    })().finally(() => {
      this._tickPromise = null;
    });
    return this._tickPromise;
  }

  async runBrowse(options = {}) {
    return this._exclusive('browse', () => this._runBrowse(options));
  }

  async _exclusive(kind, run) {
    if (this.stopping || this.executingKinds.has(kind)) throw new AppError('DUPLICATE_OPERATION', `${kind} is already active or stopping`);
    this.executingKinds.add(kind);
    const promise = Promise.resolve().then(run);
    this.active.add(promise);
    try { return await promise; }
    finally { this.executingKinds.delete(kind); this.active.delete(promise); }
  }

  async _runBrowse({ trigger = 'manual', principal = null, mode = 'go', input = {} } = {}) {
    const config = this.configService.get();
    if (!config.browse.enabled) throw new AppError('FEATURE_DISABLED', 'browse is disabled');
    if (trigger === 'scheduler' && !config.scheduler.enabled) {
      throw new AppError('FEATURE_DISABLED', 'scheduler is disabled');
    }
    const owner = principal || (await this._schedulerPrincipal());
    const promise = (async () => {
      const task = await this.browse.createTask({ principal: owner, trigger, input });
      const round = await this.browse.run({ taskId: task.id, principal: owner, deferCompletion: true });
      const interactions = await this._consumeCandidates({
        candidates: round.candidates || [],
        browseTaskId: task.id,
        principal: owner,
        config, mode
      });
      const finalTask = await this.store.transaction(async (draft, tx) => {
        const current = draft.tasks[task.id];
        const children = (current.childTaskIds || []).map((id) => draft.tasks[id]).filter(Boolean);
        const unresolved = children.filter((child) => !child.isSettled);
        // Post-step failures are aggregated from the settled child state, not
        // only from the interactions snapshot (M-P1-2 / M01).
        const failedChildren = children.filter(
          (child) => child.isSettled && ['failed', 'partial'].includes(child.status)
        );
        const unknownChildren = children.filter(
          (child) => child.status === 'unknown' || child.hasUnknownOperation === true
        );
        const failedInteractions = interactions.comments.filter((entry) =>
          ['failed', 'not_sent', 'unknown'].includes(entry.sent)
        );
        const hasFailure =
          interactions.skipped.length > 0 ||
          unresolved.length > 0 ||
          failedChildren.length > 0 ||
          failedInteractions.length > 0;
        const aggregate = unknownChildren.length > 0 ? 'unknown' : hasFailure ? 'partial' : 'succeeded';
        const result = {
          ...round.result,
          interactions,
          unresolvedTaskIds: unresolved.map((child) => child.id),
          failedChildTaskIds: failedChildren.map((child) => child.id),
          unknownChildTaskIds: unknownChildren.map((child) => child.id)
        };
        if (current.status === 'running') {
          this.taskManager.transition(tx, current, aggregate, {
            result,
            reason: 'browse and configured follow-up steps completed'
          });
        } else {
          // A browse parent is a successful read round with post-steps: never
          // let a late follow-up failure downgrade it to failed (§16).
          if (current.kind === 'browse' && current.status === 'failed' && aggregate !== 'failed') {
            this.taskManager.transition(tx, current, aggregate === 'unknown' ? 'partial' : aggregate, {
              verified: true,
              actor: 'system',
              reason: 'browse round succeeded; follow-up failures aggregate to partial'
            });
          }
          current.result = result;
        }
        if (unresolved.length) {
          current.isSettled = false;
          current.finishedAt = null;
        }
        return deepClone(current);
      });
      let diary = null;
      if (this.diary && config.diary.enabled && config.diary.afterBrowse) {
        const state = await this.store.getSnapshot();
        try {
          diary = await this.runDiary({
            date: this._todayDate(config.timeZone),
            scope: this._workspaceScope(state.workspaceId),
            book: null,
            force: false,
            principal: owner
          });
        } catch (error) {
          // Diary is a derived projection: a failure must never flip the browse
          // round result, only be reported (F07).
          diary = { skipped: true, code: error.code || 'DEPENDENCY_UNAVAILABLE', message: error.message };
          this.logger?.warn?.('afterBrowse diary failed', { message: error.message, code: error.code });
        }
      }
      return { ...round, task: finalTask, interactions, diary };
    })();
    return promise;
  }

  async _consumeCandidates({ candidates, browseTaskId, principal, config, mode = 'go' }) {
    const results = { comments: [], dms: [], skipped: [] };
    if (!Array.isArray(candidates) || candidates.length === 0) return results;
    if (config.comments.enabled && config.comments.perRound > 0) {
      for (const candidate of candidates.slice(0, config.comments.perRound)) {
        try {
          let text = null;
          if (this.agent && mode !== 'dry') {
            try {
              text = await this.agent.generateText({
                task: 'comment',
                input: {
                  title: candidate.title,
                  description: candidate.description,
                  subtitle: candidate.subtitle?.text?.slice(0, 2000) || ''
                },
                maxChars: Math.min(config.comments.maxLength, 180),
                persona: config.agent.persona
              });
            } catch (error) {
              if (!config.comments.allowTemplate) {
                results.skipped.push({ channel: 'comment', reason: error.code || 'AGENT_DISABLED' });
                continue;
              }
            }
          }
          if (!text && !config.comments.allowTemplate) {
            results.skipped.push({ channel: 'comment', reason: 'agent_disabled_and_template_not_allowed' });
            continue;
          }
          const draft = await this.comments.createDraft({
            candidate,
            text,
            principal,
            trigger: 'scheduler',
            parentTaskId: browseTaskId
          });
          let sent = null;
          if (config.comments.mode === 'auto' && !draft.dryRun) {
            sent = await this.comments.send({ taskId: draft.task.id, mode, principal });
          }
          // Record the post-dispatch task status, not the pre-send draft status
          // (M11): a failed/unknown send must not be reported as queued.
          const finalChild = sent?.task || (await this.store.getSnapshot()).tasks[draft.task.id] || null;
          results.comments.push({
            taskId: draft.task.id,
            status: sent?.task?.status || finalChild?.status || draft.task.status,
            approvalId: draft.approval?.id || null,
            sent: sent ? sent.operation?.status || null : null,
            isSettled: finalChild?.isSettled === true,
            operationId: sent?.operation?.id || null
          });
        } catch (error) {
          results.skipped.push({ channel: 'comment', reason: error.code || 'DEPENDENCY_UNAVAILABLE' });
        }
      }
    }
    if (config.directMessages.enabled && config.directMessages.perRound > 0) {
      const recipient = config.directMessages.allowedRecipientMids[0];
      if (!recipient) {
        results.skipped.push({ channel: 'dm', reason: 'empty_whitelist' });
      } else {
        for (const candidate of candidates.slice(0, config.directMessages.perRound)) {
          try {
            const outcome = await this.directMessages.send({
              content: candidate,
              recipientMid: recipient,
              text: `分享一个视频：${candidate.title}`,
              mode,
              principal,
              trigger: 'scheduler',
              parentTaskId: browseTaskId
            });
            results.dms.push({
              taskId: outcome.task.id,
              status: outcome.task.status,
              sent: outcome.operation?.status || null,
              isSettled: outcome.task.isSettled === true,
              operationId: outcome.operation?.id || null
            });
          } catch (error) {
            results.skipped.push({ channel: 'dm', reason: error.code || 'DEPENDENCY_UNAVAILABLE' });
          }
        }
      }
    }
    return results;
  }

  async runDiary({ date, scope = null, book = null, force = false, principal = null } = {}) {
    return this._exclusive('diary', () => this._runDiary({ date, scope, book, force, principal }));
  }

  async _runDiary({ date, scope = null, book = null, force = false, principal = null } = {}) {
    const owner = principal || (await this._schedulerPrincipal());
    const config = this.configService.get();
    const state = await this.store.getSnapshot();
    const resolvedScope = scope || this._workspaceScope(state.workspaceId);
    // F07: a daily/manual run rebuilds each enabled book separately; an
    // explicitly requested book keeps the single-result shape.
    const books = book
      ? [book]
      : [
          ...(config.diary.publicBook ? ['public'] : []),
          ...(config.diary.privateBook ? ['private'] : [])
        ];
    if (books.length === 0) throw new AppError('FEATURE_DISABLED', 'no diary book is enabled');
    const results = [];
    let failure = null;
    for (const selectedBook of books) {
      try {
        const outcome = await this.diary.generate({
          date,
          scope: resolvedScope,
          book: selectedBook,
          force,
          principal: owner
        });
        results.push(outcome);
      } catch (error) {
        if (!failure) failure = error;
        this.logger?.warn?.('diary book generation failed', {
          book: selectedBook,
          code: error.code || 'DEPENDENCY_UNAVAILABLE',
          message: error.message
        });
      }
    }
    if (failure) throw failure;
    if (results.length === 1) return results[0];
    return {
      books: results,
      unchanged: results.every((entry) => entry.unchanged === true),
      diaryIds: results.map((entry) => entry.diaryId)
    };
  }

  async status(principal = null) {
    const state = await this.store.getSnapshot();
    return {
      started: this.started,
      active: this.active.size,
      schedulerEnabled: this.configService.get().scheduler.enabled,
      tasks: Object.values(state.tasks).map((task) => ({
        id: task.id,
        kind: task.kind,
        status: task.status,
        isSettled: task.isSettled
      })),
      pluginOnly: true
    };
  }
}

export default Coordinator;
