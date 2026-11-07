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
    parentTaskId = null
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
}

export default DirectMessagesModule;
