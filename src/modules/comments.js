import { AppError } from '../errors.js';
import { assertWritablePhase, computeInputHash, effectiveDryRun } from '../contracts.js';
import {
  deepClone,
  normalizedTextHash,
  normalizeText,
  nowIso,
  truncateText
} from '../utils.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export class CommentsModule {
  constructor({
    store,
    taskManager,
    approvalService,
    adapter,
    configService,
    effectGateway,
    now = () => new Date(),
    logger,
    approvalTtlSec = 600
  } = {}) {
    this.store = store;
    this.effectGateway = effectGateway;
    this.taskManager = taskManager;
    this.approvalService = approvalService;
    this.adapter = adapter;
    this.configService = configService;
    this.now = now;
    this.logger = logger;
    this.approvalTtlSec = approvalTtlSec;
  }

  async _activeAccount() {
    const state = await this.store.getSnapshot();
    if (!state.activeAccountRef) throw new AppError('IDENTITY_UNVERIFIED', 'comments require a verified account');
    const account = state.accounts[`bilibili:${state.activeAccountRef.accountId}`];
    if (!account) throw new AppError('IDENTITY_UNVERIFIED', 'active account record is missing');
    return account;
  }

  _prepareText(text, config, candidate) {
    let message = normalizeText(text ?? '');
    if (message === '') {
      if (!config.comments.allowTemplate) {
        throw new AppError('AGENT_DISABLED', 'no agent text and template comments are disabled');
      }
      message = `看完《${truncateText(candidate.title, 60)}》很有收获，感谢分享。`;
    }
    if (config.comments.mentionOwner) {
      const mention = `@${config.owner.name.trim()}`;
      const occurrences = message.split(mention).length - 1;
      if (occurrences > 1) throw new AppError('INPUT_REQUIRED', 'owner can be mentioned at most once');
      if (occurrences === 0) message = `${message} ${mention}`;
    }
    if (message.length > config.comments.maxLength) {
      throw new AppError('INPUT_REQUIRED', `comment exceeds ${config.comments.maxLength} characters`);
    }
    return message;
  }

  _targetKeys(account, candidate, textHash) {
    const platform = candidate.contentRef.platform;
    const contentId = candidate.contentRef.contentId;
    return {
      primary: `comment:${platform}:${account.accountRef.accountId}:${contentId}:${textHash}`,
      target: `comment-target:${platform}:${account.accountRef.accountId}:${contentId}`,
      text: `comment-text:${platform}:${account.accountRef.accountId}:${textHash}`
    };
  }

  _checkTargetCooldown(state, key, config) {
    const existing = state.businessKeys[key];
    if (!existing) return;
    if (['reserved', 'dispatching', 'unknown'].includes(existing.status)) {
      throw new AppError('DUPLICATE_TARGET', 'target already has an unresolved comment operation', {
        details: { targetKey: key, status: existing.status }
      });
    }
    if (existing.status === 'confirmed') {
      if (config.comments.sameVideoDays === 0) {
        throw new AppError('DUPLICATE_TARGET', 'same-video comment cooldown is permanent (0 days)');
      }
      const cooldownUntil = existing.cooldownUntil
        ? Date.parse(existing.cooldownUntil)
        : Date.parse(existing.confirmedAt || existing.updatedAt || 0) + config.comments.sameVideoDays * DAY_MS;
      if (Number.isFinite(cooldownUntil) && this.now().getTime() < cooldownUntil) {
        throw new AppError('DUPLICATE_TARGET', 'same-video comment cooldown is active', {
          details: { cooldownUntil: new Date(cooldownUntil).toISOString() }
        });
      }
    }
  }

  _checkTextReuse(state, key) {
    const existing = state.businessKeys[key];
    if (!existing) return;
    if (['reserved', 'dispatching', 'unknown', 'confirmed'].includes(existing.status)) {
      throw new AppError('DUPLICATE_TARGET', 'identical normalized text was already used on another video', {
        details: { textKey: key, status: existing.status }
      });
    }
  }

  _findPendingDraft(state, targetKey) {
    return Object.values(state.tasks).find(
      (task) =>
        task.kind === 'comment' &&
        task.status === 'waiting_approval' &&
        task.input?.targetKey === targetKey
    );
  }

  async createDraft({ candidate, text = null, root = 0, parent = 0, principal, trigger = 'manual', parentTaskId = null }) {
    const config = this.configService.get();
    if (!config.comments.enabled) throw new AppError('FEATURE_DISABLED', 'comments are disabled');
    if (!candidate?.contentRef?.contentId) throw new AppError('INPUT_REQUIRED', 'comment candidate is required');
    if (candidate.platformData?.aid === undefined && candidate.contentRef.platform !== 'bilibili') {
      throw new AppError('INPUT_REQUIRED', 'platformData.aid is required for Bilibili comments');
    }
    const account = await this._activeAccount();
    if (candidate.author?.accountId === account.accountRef.accountId) {
      throw new AppError('FORBIDDEN', 'cannot comment on your own content');
    }
    const message = this._prepareText(text, config, candidate);
    const textHash = normalizedTextHash(message);
    const keys = this._targetKeys(account, candidate, textHash);
    const input = {
      contentRef: deepClone(candidate.contentRef),
      platformData: deepClone(candidate.platformData || {}),
      title: truncateText(candidate.title, 300),
      author: deepClone(candidate.author || null),
      text: message,
      textHash,
      root: Number(root) || 0,
      parent: Number(parent) || 0,
      mode: config.comments.mode,
      targetKey: keys.target,
      primaryKey: keys.primary,
      textKey: keys.text
    };
    const inputHash = computeInputHash({
      action: 'comment.send',
      input: {
        contentRef: input.contentRef,
        text: message,
        root: input.root,
        parent: input.parent
      },
      target: {
        platform: account.accountRef.platform,
        accountId: account.accountRef.accountId,
        contentId: candidate.contentRef.contentId
      },
      feeCapMinor: 0
    });

    const result = await this.store.transaction(async (draft, tx) => {
      assertWritablePhase(draft);
      const now = this.now().getTime();
      this._checkTargetCooldown(draft, keys.target, config);
      this._checkTextReuse(draft, keys.text);
      const pending = this._findPendingDraft(draft, keys.target);
      if (pending) {
        if (pending.inputHash !== inputHash) {
          throw new AppError('DUPLICATE_TARGET', 'target already has a pending draft for different text', {
            details: { taskId: pending.id }
          });
        }
        if (config.comments.mode === 'approval') {
          const challenge = this.approvalService.create(tx, {
            task: pending,
            action: 'comment.send',
            inputHash: pending.inputHash,
            principalId: principal.id,
            ttlSec: this.approvalTtlSec,
            source: principal.sourceKind
          });
          pending.input.approvalId = challenge.approval.id;
          return { task: pending, challenge, reused: true };
        }
        return { task: pending, challenge: null, reused: true };
      }

      const task = this.taskManager.create(tx, {
        kind: 'comment',
        principalId: principal.id,
        accountRef: account.accountRef,
        parentTaskId,
        trigger,
        sourceKind: principal.sourceKind,
        input,
        inputHash
      });
      tx.appendEvent({
        type: 'comment.draft.created',
        actor: principal.id,
        taskId: task.id,
        accountRef: account.accountRef,
        payload: {
          contentRef: input.contentRef,
          textHash,
          mode: config.comments.mode,
          expiresAt: new Date(now + this.approvalTtlSec * 1000).toISOString()
        }
      });
      if (config.comments.mode === 'approval') {
        this.taskManager.transition(tx, task, 'waiting_approval');
        const challenge = this.approvalService.create(tx, {
          task,
          action: 'comment.send',
          inputHash,
          principalId: principal.id,
          ttlSec: this.approvalTtlSec,
          source: principal.sourceKind
        });
        task.input.approvalId = challenge.approval.id;
        return { task, challenge, reused: false };
      }
      tx.appendEvent({
        type: 'comment.auto.policy',
        actor: principal.id,
        taskId: task.id,
        payload: { policy: 'comments.mode=auto', configRevision: draft.configRevision }
      });
      return { task, challenge: null, reused: false };
    });

    return {
      task: deepClone(result.task),
      approval: result.challenge?.approval || null,
      nonce: result.challenge?.nonce || null,
      expiresAt: result.challenge?.expiresAt || null,
      reused: result.reused,
      dryRun: false
    };
  }

  async send({ taskId, mode = 'go', principal = null }) {
    if (!['dry', 'go'].includes(mode)) throw new AppError('CONFIG_INVALID', 'mode must be dry or go');
    const config = this.configService.get();
    if (!config.comments.enabled) throw new AppError('FEATURE_DISABLED', 'comments are disabled');
    const state = await this.store.getSnapshot();
    const task = state.tasks[taskId];
    if (!task) throw new AppError('FORBIDDEN', 'comment task not found');
    if (task.kind !== 'comment') throw new AppError('INPUT_REQUIRED', 'task is not a comment task');
    if (['succeeded', 'cancelled', 'failed', 'unknown'].includes(task.status)) {
      return { task: deepClone(task), skipped: true, executionMode: 'go' };
    }
    const effective = effectiveDryRun({ config, feature: 'comments', invocationMode: mode });
    if (effective.dryRun) {
      return {
        task: deepClone(task),
        dryRun: true,
        executionMode: 'dry',
        blockedBy: effective.blockedBy,
        plan: { action: 'comment', contentRef: task.input.contentRef, text: task.input.text }
      };
    }
    if (task.status === 'waiting_approval') {
      throw new AppError('APPROVAL_REQUIRED', 'comment draft is waiting for human approval');
    }
    if (task.status !== 'running') {
      await this.store.transaction(async (draft, tx) => {
        const current = draft.tasks[taskId];
        this.taskManager.transition(tx, current, 'running', {
          approved: current.input.mode === 'auto',
          actor: principal?.id || 'system',
          reason: 'comment dispatch started'
        });
      });
    }
    const latest = (await this.store.getSnapshot()).tasks[taskId];
    if (latest.cancelRequestedAt) {
      await this.store.transaction(async (draft, tx) => {
        this.taskManager.transition(tx, draft.tasks[taskId], 'cancelled', {
          provenUndispatched: true,
          actor: principal?.id || 'system',
          reason: 'cancel requested before send'
        });
      });
      return { task: (await this.store.getSnapshot()).tasks[taskId], skipped: true };
    }
    const account = state.accounts[`bilibili:${latest.accountRef.accountId}`];
    if (!account) throw new AppError('IDENTITY_UNVERIFIED', 'comment account is not bound');
    const targetKey = latest.input.targetKey;
    const textKey = latest.input.textKey;
    const existingTarget = state.businessKeys[targetKey];
    let reusable = [];
    if (existingTarget?.status === 'confirmed') {
      this._checkTargetCooldown(state, targetKey, config);
      reusable = [targetKey];
    }
    for (const key of [latest.input.primaryKey, targetKey, textKey]) {
      const record = state.businessKeys[key];
      if (record && ['failed', 'not_sent', 'cancelled'].includes(record.status)) reusable.push(key);
    }
    reusable = [...new Set(reusable)];
    // Re-check permanent text reuse immediately before dispatch.
    const existingText = state.businessKeys[textKey];
    if (existingText && ['reserved', 'dispatching', 'unknown', 'confirmed'].includes(existingText.status)) {
      if (existingText.lastOperationId && existingText.lastOperationId === latest.operationIds?.at(-1)) {
        // the same unresolved attempt
      } else {
        throw new AppError('DUPLICATE_TARGET', 'identical normalized text was already used');
      }
    }
    const quota = config.comments.dailyLimit > 0 ? { perDay: config.comments.dailyLimit } : null;
    const actionQuota = quota ? { ...quota, perHour: config.rateLimit.writePerHour } : undefined;
    const candidate = {
      contentRef: latest.input.contentRef,
      platformData: latest.input.platformData,
      title: latest.input.title,
      author: latest.input.author
    };
    const outcome = await (async () => {
      const gateway = this.effectGateway;
      if (!gateway) throw new AppError('DEPENDENCY_UNAVAILABLE', 'effect gateway is not configured');
      const reservation = {
        namespace: 'platform',
        action: 'comment',
        receiptAction: 'comment',
        recoveryAction: 'comment',
        accountRef: account.accountRef,
        businessKey: latest.input.primaryKey,
        extraBusinessKeys: [targetKey, textKey],
        reusableBusinessKeys: reusable,
        taskIds: [taskId],
        inputHash: latest.inputHash,
        approvalId: latest.input.mode === 'approval' ? latest.input.approvalId : null,
        approvalAction: 'comment.send',
        quota: { key: `bilibili:${account.accountRef.accountId}`, action: 'comment', actionQuota },
        protected: true,
        target: {
          platform: account.accountRef.platform,
          accountId: account.accountRef.accountId,
          contentId: latest.input.contentRef.contentId
        },
        metadata: { textHash: latest.input.textHash, contentRef: latest.input.contentRef }
      };
      return gateway.executeOperation(
        reservation,
        async (operationContext) =>
          this.adapter.writeComment({
            candidate,
            text: latest.input.text,
            root: latest.input.root,
            parent: latest.input.parent,
            operationContext
          }),
        {
          applyResult: async (tx, operation, status) => {
            const currentTask = tx.state.tasks[taskId];
            const target = tx.state.businessKeys[targetKey];
            if (status === 'confirmed') {
              const cooldownUntil =
                config.comments.sameVideoDays > 0
                  ? new Date(this.now().getTime() + config.comments.sameVideoDays * DAY_MS).toISOString()
                  : null;
              if (target) {
                target.cooldownUntil = cooldownUntil;
                target.lastConfirmedAt = nowIso(this.now);
              }
              const textRecord = tx.state.businessKeys[textKey];
              if (textRecord) textRecord.contentRef = latest.input.contentRef;
              if (currentTask.status === 'running') {
                this.taskManager.transition(tx, currentTask, 'succeeded', {
                  actor: 'system',
                  reason: 'comment confirmed',
                  result: {
                    receipt: operation.resultSummary,
                    textHash: latest.input.textHash,
                    contentRef: latest.input.contentRef
                  }
                });
              }
            } else if (status === 'failed' || status === 'not_sent') {
              if (currentTask.status === 'running') {
                this.taskManager.transition(tx, currentTask, 'failed', {
                  actor: 'system',
                  reason: `comment ${status}`,
                  error: operation.error
                });
              }
            }
          }
        }
      );
    })();
    return {
      task: (await this.store.getSnapshot()).tasks[taskId],
      operation: outcome.operation,
      executionMode: 'go',
      receipt: outcome.operation.receipt || null
    };
  }
}

export default CommentsModule;
