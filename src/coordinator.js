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
    this._tickPromise = null;
  }

  async _ownerPrincipal() {
    return this.store.transaction(async (draft, tx) => this.identity.ensureLocalOwner(tx));
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
    if (!this.started) return { stopped: true, deduplicated: true };
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
    this.stopping = false;
    return { stopped: true, active: this.active.size };
  }

  async tick() {
    if (!this.started || this.stopping) return { skipped: true, reason: 'stopped' };
    if (this._tickPromise) return this._tickPromise;
    const config = this.configService.get();
    if (!config.scheduler.enabled) return { skipped: true, reason: 'scheduler_disabled' };
    this._tickPromise = (async () => {
      const state = await this.store.getSnapshot();
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
      for (const action of actions) {
        if (action === 'browse') {
          await this.runBrowse({ trigger: 'scheduler' }).catch((error) => {
            this.logger?.warn?.('scheduled browse failed', { message: error.message });
          });
          await this.store.transaction(async (draft) => {
            draft.cursors.scheduler = { ...(draft.cursors.scheduler || {}), browseLastRunAt: nowIso(this.now) };
          });
        } else if (action === 'diary') {
          const principal = await this._ownerPrincipal();
          const scope = `workspace/${state.workspaceId}`;
          await this.diary
            .generate({ date: today, scope, book: config.diary.publicBook ? 'public' : 'private', principal })
            .catch((error) => {
              this.logger?.warn?.('scheduled diary failed', { message: error.message });
            });
          await this.store.transaction(async (draft) => {
            draft.cursors.scheduler = { ...(draft.cursors.scheduler || {}), diaryLastDate: today };
          });
        }
      }
      return { ran: actions };
    })().finally(() => {
      this._tickPromise = null;
    });
    return this._tickPromise;
  }

  async runBrowse({ trigger = 'manual', principal = null } = {}) {
    if (this.active.has('browse')) throw new AppError('DUPLICATE_OPERATION', 'a browse round is already active');
    const config = this.configService.get();
    if (!config.browse.enabled) throw new AppError('FEATURE_DISABLED', 'browse is disabled');
    if (trigger === 'scheduler' && !config.scheduler.enabled) {
      throw new AppError('FEATURE_DISABLED', 'scheduler is disabled');
    }
    const owner = principal || (await this._ownerPrincipal());
    const promise = (async () => {
      const task = await this.browse.createTask({ principal: owner, trigger });
      const round = await this.browse.run({ taskId: task.id, principal: owner });
      const interactions = await this._consumeCandidates({
        candidates: round.candidates || [],
        browseTaskId: task.id,
        principal: owner,
        config
      });
      return { ...round, interactions };
    })();
    this.active.add(promise);
    try {
      return await promise;
    } finally {
      this.active.delete(promise);
    }
  }

  async _consumeCandidates({ candidates, browseTaskId, principal, config }) {
    const results = { comments: [], dms: [], skipped: [] };
    if (!Array.isArray(candidates) || candidates.length === 0) return results;
    if (config.comments.enabled && config.comments.perRound > 0) {
      for (const candidate of candidates.slice(0, config.comments.perRound)) {
        try {
          let text = null;
          if (this.agent) {
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
            sent = await this.comments.send({ taskId: draft.task.id, mode: 'go', principal });
          }
          results.comments.push({
            taskId: draft.task.id,
            status: draft.task.status,
            approvalId: draft.approval?.id || null,
            sent: sent ? sent.operation?.status || null : null
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
              mode: 'go',
              principal,
              trigger: 'scheduler',
              parentTaskId: browseTaskId
            });
            results.dms.push({ taskId: outcome.task.id, status: outcome.task.status });
          } catch (error) {
            results.skipped.push({ channel: 'dm', reason: error.code || 'DEPENDENCY_UNAVAILABLE' });
          }
        }
      }
    }
    return results;
  }

  async runDiary({ date, scope = null, book = null, force = false, principal = null } = {}) {
    if (this.active.has('diary')) throw new AppError('DUPLICATE_OPERATION', 'a diary build is already active');
    const owner = principal || (await this._ownerPrincipal());
    const config = this.configService.get();
    const state = await this.store.getSnapshot();
    const promise = this.diary.generate({
      date,
      scope: scope || `workspace/${state.workspaceId}`,
      book: book || (config.diary.publicBook ? 'public' : 'private'),
      force,
      principal: owner
    });
    this.active.add(promise);
    try {
      return await promise;
    } finally {
      this.active.delete(promise);
    }
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
