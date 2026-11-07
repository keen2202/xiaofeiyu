import { AppError } from '../errors.js';
import { assertWritablePhase, computeInputHash, effectiveDryRun } from '../contracts.js';
import { deepClone, normalizedTextHash, normalizeText, nowIso, truncateText } from '../utils.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export class DirectMessagesModule {
  constructor({ store, taskManager, adapter, configService, effectGateway, now = () => new Date(), logger } = {}) {
    this.store = store;
    this.taskManager = taskManager;
    this.adapter = adapter;
    this.configService = configService;
    this.effectGateway = effectGateway;
    this.now = now;
    this.logger = logger;
  }

  async _activeAccount() {
    const state = await this.store.getSnapshot();
    if (!state.activeAccountRef) throw new AppError('IDENTITY_UNVERIFIED', 'DM requires a verified account');
    const account = state.accounts[`bilibili:${state.activeAccountRef.accountId}`];
    if (!account) throw new AppError('IDENTITY_UNVERIFIED', 'active account record is missing');
    return account;
  }

  _parseRecipient(recipientMid) {
    if (Array.isArray(recipientMid)) {
      throw new AppError('RECIPIENT_NOT_ALLOWED', 'bulk recipient arrays are not supported');
    }
    if (typeof recipientMid !== 'string' && !Number.isSafeInteger(recipientMid)) {
      throw new AppError('RECIPIENT_NOT_ALLOWED', 'recipientMid must be a single platform account id');
    }
    const recipient = String(recipientMid);
    if (!/^\d+$/.test(recipient) || recipient === '0') {
      throw new AppError('RECIPIENT_NOT_ALLOWED', 'recipientMid is invalid');
    }
    return recipient;
  }

  _checkTargetCooldown(state, key, config) {
    const existing = state.businessKeys[key];
    if (!existing) return;
    if (['reserved', 'dispatching', 'unknown'].includes(existing.status)) {
      throw new AppError('DUPLICATE_TARGET', 'recipient already has an unresolved DM operation');
    }
    if (existing.status === 'confirmed') {
      if (config.directMessages.sameVideoDays === 0) {
        throw new AppError('DUPLICATE_TARGET', 'recipient cooldown is permanent (0 days)');
      }
      const until = existing.cooldownUntil
        ? Date.parse(existing.cooldownUntil)
        : Date.parse(existing.confirmedAt || 0) + config.directMessages.sameVideoDays * DAY_MS;
      if (Number.isFinite(until) && this.now().getTime() < until) {
        throw new AppError('DUPLICATE_TARGET', 'recipient cooldown is active', {
          details: { cooldownUntil: new Date(until).toISOString() }
        });
      }
    }
  }

  async send({
    content = null,
    recipientMid,
    text,
    mode = 'go',
    principal,
    trigger = 'manual',
    parentTaskId = null,
    resumeTaskId = null
  }) {
    if (!['dry', 'go'].includes(mode)) throw new AppError('CONFIG_INVALID', 'mode must be dry or go');
    const config = this.configService.get();
    if (!config.directMessages.enabled) throw new AppError('FEATURE_DISABLED', 'direct messages are disabled');
    const recipient = this._parseRecipient(recipientMid);
    const whitelist = config.directMessages.allowedRecipientMids.map(String);
    if (whitelist.length === 0 || !whitelist.includes(recipient)) {
      throw new AppError('RECIPIENT_NOT_ALLOWED', 'recipient is not in the explicit whitelist');
    }
    const account = await this._activeAccount();
    if (recipient === account.accountRef.accountId) throw new AppError('FORBIDDEN', 'cannot message yourself');
    let message = normalizeText(text);
    if (message === '') throw new AppError('INPUT_REQUIRED', 'DM text is required');
    if (message.length > config.directMessages.maxLength) {
      throw new AppError('INPUT_REQUIRED', `DM exceeds ${config.directMessages.maxLength} characters`);
    }
    if (content) {
      if (!content.contentRef?.contentId) throw new AppError('INPUT_REQUIRED', 'DM content reference is invalid');
      if (content.author?.accountId === account.accountRef.accountId) {
        throw new AppError('FORBIDDEN', 'cannot share your own content with yourself');
      }
    }
    const effective = effectiveDryRun({ config, feature: 'dm', invocationMode: mode });
    // Whitelist/self checks happen before any network call. Mutual-follow is a
    // read-only preflight for real attempts; the adapter repeats it at dispatch.
    if (!effective.dryRun) {
      await this.adapter.checkRecipient({
        recipientMid: recipient,
        requireMutual: config.directMessages.requireMutual
      });
    }

    const targetHash = normalizedTextHash(content?.contentRef?.contentId || message);
    const targetKey = `dm-target:${account.accountRef.platform}:${account.accountRef.accountId}:${recipient}`;
    const primaryKey = `dm:${account.accountRef.platform}:${account.accountRef.accountId}:${recipient}:${targetHash}`;
    const input = {
      recipientMid: recipient,
      text: message,
      textHash: normalizedTextHash(message),
      contentRef: content?.contentRef ? deepClone(content.contentRef) : null,
      platformData: content?.platformData ? deepClone(content.platformData) : null,
      targetKey,
      primaryKey,
      title: truncateText(content?.title || '', 300)
    };
    const inputHash = computeInputHash({
      action: 'dm.send',
      input: { recipientMid: recipient, text: message, contentRef: input.contentRef },
      target: { platform: account.accountRef.platform, accountId: account.accountRef.accountId, recipient },
      feeCapMinor: 0
    });
    if (effective.dryRun) {
      if (resumeTaskId) {
        return {
          task: deepClone((await this.store.getSnapshot()).tasks[resumeTaskId]),
          dryRun: true,
          executionMode: 'dry',
          blockedBy: effective.blockedBy,
          plan: { action: 'dm.resume', taskId: resumeTaskId, recipientMid: recipient }
        };
      }
      const task = await this.store.transaction(async (draft, tx) => {
        assertWritablePhase(draft);
        const created = this.taskManager.create(tx, {
          kind: 'dm',
          principalId: principal.id,
          accountRef: account.accountRef,
          parentTaskId,
          trigger,
          sourceKind: principal.sourceKind,
          input,
          inputHash
        });
        this.taskManager.transition(tx, created, 'running', { actor: principal.id, reason: 'dm dry run' });
        this.taskManager.transition(tx, created, 'succeeded', {
          actor: principal.id,
          reason: 'dm dry run preflight',
          result: {
            executionMode: 'dry',
            recipientMid: recipient,
            textHash: input.textHash,
            contentRef: input.contentRef
          }
        });
        tx.appendEvent({
          type: 'dm.dry_run',
          actor: principal.id,
          taskId: created.id,
          accountRef: account.accountRef,
          payload: { recipientMid: recipient, textHash: input.textHash, blockedBy: effective.blockedBy }
        });
        return deepClone(created);
      });
      return { task, dryRun: true, executionMode: 'dry', blockedBy: effective.blockedBy, plan: { recipientMid: recipient } };
    }

    const state = await this.store.getSnapshot();
    if (resumeTaskId) {
      const existing = state.tasks[resumeTaskId];
      if (!existing || existing.kind !== 'dm') throw new AppError('INPUT_REQUIRED', 'task is not a DM task');
      if (existing.inputHash !== inputHash) {
        throw new AppError('INPUT_REQUIRED', 'DM resume input does not match the original task');
      }
    }
    this._checkTargetCooldown(state, targetKey, config);
    const reusable = [];
    for (const key of [primaryKey, targetKey]) {
      const record = state.businessKeys[key];
      if (record && ['failed', 'not_sent', 'cancelled'].includes(record.status)) reusable.push(key);
    }
    if (state.businessKeys[targetKey]?.status === 'confirmed') {
      this._checkTargetCooldown(state, targetKey, config);
      reusable.push(targetKey);
    }

    const task = await this.store.transaction(async (draft, tx) => {
      assertWritablePhase(draft);
      if (resumeTaskId) {
        const current = draft.tasks[resumeTaskId];
        if (!current || current.kind !== 'dm') throw new AppError('INPUT_REQUIRED', 'task is not a DM task');
        if (current.status === 'unknown' && (current.pendingOperationIds || []).length > 0) {
          throw new AppError('OPERATION_UNKNOWN', 'unknown DM operation must be resolved before resume');
        }
        this.taskManager.resume(tx, current, {
          manual: true,
          verified: true,
          actor: principal.id,
          reason: 'human verified old DM attempt stopped'
        });
        current.cancelRequestedAt = null;
        tx.appendEvent({
          type: 'dm.resume.requested',
          actor: principal.id,
          taskId: current.id,
          accountRef: current.accountRef,
          payload: { attempts: current.attempts, previousStatus: current.history.at(-2)?.from || null }
        });
        return deepClone(current);
      }
      const created = this.taskManager.create(tx, {
        kind: 'dm',
        principalId: principal.id,
        accountRef: account.accountRef,
        parentTaskId,
        trigger,
        sourceKind: principal.sourceKind,
        input,
        inputHash
      });
      this.taskManager.transition(tx, created, 'running', {
        approved: true,
        actor: principal.id,
        reason: 'dm dispatch started'
      });
      tx.appendEvent({
        type: 'dm.task.created',
        actor: principal.id,
        taskId: created.id,
        accountRef: account.accountRef,
        payload: { recipientMid: recipient, textHash: input.textHash, contentRef: input.contentRef }
      });
      return deepClone(created);
    });

    const quota =
      config.directMessages.dailyLimit > 0
        ? { perDay: config.directMessages.dailyLimit, perHour: config.rateLimit.writePerHour }
        : undefined;
    const outcome = await this.effectGateway.executeOperation(
      {
        namespace: 'platform',
        action: 'dm',
        receiptAction: 'dm',
        recoveryAction: 'dm',
        accountRef: account.accountRef,
        businessKey: primaryKey,
        extraBusinessKeys: [targetKey],
        reusableBusinessKeys: reusable,
        taskIds: [task.id],
        inputHash,
        quota: { key: `bilibili:${account.accountRef.accountId}`, action: 'dm', actionQuota: quota },
        protected: true,
        target: {
          platform: account.accountRef.platform,
          accountId: account.accountRef.accountId,
          recipient
        },
        metadata: { textHash: input.textHash, contentRef: input.contentRef }
      },
      async (operationContext) =>
        this.adapter.sendDirectMessage({
          recipientMid: recipient,
          text: message,
          operationContext,
          requireMutual: config.directMessages.requireMutual
        }),
      {
        applyResult: async (tx, operation, status) => {
          const currentTask = tx.state.tasks[task.id];
          const target = tx.state.businessKeys[targetKey];
          if (status === 'confirmed') {
            if (target) {
              target.cooldownUntil =
                config.directMessages.sameVideoDays > 0
                  ? new Date(this.now().getTime() + config.directMessages.sameVideoDays * DAY_MS).toISOString()
                  : null;
              target.lastConfirmedAt = nowIso(this.now);
            }
            if (currentTask.status === 'running') {
              this.taskManager.transition(tx, currentTask, 'succeeded', {
                actor: 'system',
                reason: 'dm confirmed',
                result: {
                  recipientMid: recipient,
                  textHash: input.textHash,
                  receipt: operation.resultSummary,
                  contentRef: input.contentRef
                }
              });
            }
          } else if ((status === 'failed' || status === 'not_sent') && currentTask.status === 'running') {
            this.taskManager.transition(tx, currentTask, 'failed', {
              actor: 'system',
              reason: `dm ${status}`,
              error: operation.error
            });
          }
        }
      }
    );
    return {
      task: (await this.store.getSnapshot()).tasks[task.id],
      operation: outcome.operation,
      executionMode: 'go',
      receipt: outcome.operation.receipt || null
    };
  }

  async resume({ taskId, mode = 'go', principal }) {
    if (!['dry', 'go'].includes(mode)) throw new AppError('CONFIG_INVALID', 'mode must be dry or go');
    if (!principal?.id) throw new AppError('FORBIDDEN', 'resume requires a trusted principal');
    const config = this.configService.get();
    if (!config.directMessages.enabled) throw new AppError('FEATURE_DISABLED', 'direct messages are disabled');
    const state = await this.store.getSnapshot();
    const task = state.tasks[taskId];
    if (!task) throw new AppError('FORBIDDEN', 'DM task not found');
    if (task.kind !== 'dm') throw new AppError('INPUT_REQUIRED', 'task is not a DM task');
    if (!['interrupted', 'failed', 'partial', 'unknown'].includes(task.status)) {
      throw new AppError('FORBIDDEN', `task status ${task.status} cannot be resumed`);
    }
    if (task.executionActive) throw new AppError('OPERATION_UNKNOWN', 'previous DM execution is still active');
    const unknown = (task.operationIds || [])
      .map((id) => state.operations[id])
      .filter((operation) => operation?.status === 'unknown');
    const pending = (task.pendingOperationIds || [])
      .map((id) => state.operations[id])
      .filter((operation) => operation && !['confirmed', 'not_sent', 'failed', 'cancelled'].includes(operation.status));
    if (unknown.length > 0 || pending.length > 0) {
      throw new AppError('OPERATION_UNKNOWN', 'unknown DM operations must be resolved with evidence before resume');
    }
    return this.send({
      content: task.input.contentRef
        ? { contentRef: task.input.contentRef, title: task.input.title, platformData: task.input.platformData }
        : null,
      recipientMid: task.input.recipientMid,
      text: task.input.text,
      mode,
      principal,
      trigger: task.trigger,
      parentTaskId: task.parentTaskId,
      resumeTaskId: task.id
    });
  }
}

export default DirectMessagesModule;
