import { AppError } from './errors.js';
import {
  assertNoMatchingHold,
  assertOperationContext,
  assertOutboxDispatchContext,
  assertReceipt,
  findMatchingHolds,
  makeReceipt,
  normalizeScope,
  scopeKeyFor
} from './contracts.js';
import { computeConfigHash } from './config.js';
import {
  deepClone,
  formatDateTimeInZone,
  isProcessAlive,
  getProcessStartMs,
  processStartIso,
  jcsHash,
  nowIso,
  randomId,
  randomToken,
  sha256Hex,
  truncateText
} from './utils.js';

const PLATFORM_CAPABILITY = {
  bilibili: 'platform:bilibili'
};

function capabilityFor({ namespace, action, platform }) {
  if (namespace === 'platform') return PLATFORM_CAPABILITY[platform] || `platform:${platform}`;
  if (namespace === 'provider') return 'production:paid';
  if (namespace === 'external') return 'publish:external';
  if (namespace === 'manual') return 'publish:manual';
  if (namespace === 'im') return 'im';
  if (namespace === 'local') return 'production:local';
  return `namespace:${namespace}`;
}

function recoveryScopeForOperation({ op, config }) {
  if (op.recoveryScope) return normalizeScope(op.recoveryScope, op.workspaceId);
  if (op.namespace === 'platform') {
    return normalizeScope({
      kind: 'account_action',
      workspaceId: op.workspaceId,
      platform: op.accountRef?.platform || 'bilibili',
      accountId: op.accountRef?.accountId || '0',
      action: op.recoveryAction || op.action
    });
  }
  if (op.namespace === 'provider') {
    return normalizeScope({
      kind: 'provider_budget',
      workspaceId: op.workspaceId,
      provider: op.budget?.provider || 'unknown',
      budgetId: op.budget?.budgetId || 'default'
    });
  }
  if (op.namespace === 'external') {
    return normalizeScope({
      kind: 'account_action',
      workspaceId: op.workspaceId,
      platform: op.accountRef?.platform || 'bilibili',
      accountId: op.accountRef?.accountId || '0',
      action: 'external_publish'
    });
  }
  if (op.namespace === 'im') {
    return normalizeScope({
      kind: 'im_conversation',
      workspaceId: op.workspaceId,
      adapterId: op.binding?.adapterId || 'dsh-im',
      botAccountId: op.binding?.botAccountId || 'unknown',
      conversationId: op.binding?.conversationId || 'unknown'
    });
  }
  return normalizeScope({ kind: 'workspace', workspaceId: op.workspaceId });
}

export class EffectGateway {
  constructor({
    store,
    taskManager,
    approvalService,
    identity,
    humanProof,
    rateLimiter,
    configService,
    getConfig,
    protection = null,
    now = () => new Date(),
    hooks = {},
    logger
  } = {}) {
    this.store = store;
    this.taskManager = taskManager;
    this.approvalService = approvalService;
    this.identity = identity;
    this.humanProof = humanProof;
    this.rateLimiter = rateLimiter;
    this.configService = configService;
    this.getConfig = getConfig || (() => configService.get());
    this.protection = protection;
    this.now = now;
    this.hooks = hooks;
    this.logger = logger;
    this._contextVerifier = this._makeContextVerifier();
  }

  _makeContextVerifier() {
    const issued = new Map();
    const gateway = this;
    return {
      issue(operation) {
        const token = randomToken(24);
        issued.set(token, {
          operationId: operation.id,
          accountRef: operation.accountRef,
          inputHash: operation.inputHash,
          businessKey: operation.businessKey
        });
        return {
          operationId: operation.id,
          businessKey: operation.businessKey,
          accountRef: operation.accountRef,
          action: operation.action,
          inputHash: operation.inputHash,
          permit: 'dispatch-once',
          token
        };
      },
      verify(context) {
        assertOperationContext(context);
        const entry = issued.get(context.token);
        if (!entry) throw new AppError('FORBIDDEN', 'OperationContext was not issued by this core');
        if (entry.operationId !== context.operationId || entry.inputHash !== context.inputHash) {
          throw new AppError('FORBIDDEN', 'OperationContext does not match reservation');
        }
        return true;
      },
      consume(context) {
        this.verify(context);
        issued.delete(context.token);
      }
    };
  }

  get operationContextVerifier() {
    return this._contextVerifier;
  }

  _assertConfig(tx) {
    if (this.configService?.assertCurrentState) {
      this.configService.assertCurrentState(tx.state);
      return;
    }
    const config = this.getConfig();
    const hash = computeConfigHash(config);
    if (tx.state.configRevision?.sha256 !== hash) {
      throw new AppError('CONFIG_INVALID', 'dispatching configuration revision is stale');
    }
  }

  _assertInstance(tx, capability) {
    const instance = tx.getInstance();
    if (!instance) throw new AppError('RECOVERY_REQUIRED', 'instance.json is missing');
    if (['retired', 'disabled', 'paused', 'recovery-readonly'].includes(instance.status)) {
      throw new AppError('MIGRATION_BLOCKED', `instance is ${instance.status}`);
    }
    if (instance.status !== 'active') {
      throw new AppError('MIGRATION_BLOCKED', `instance is not active (${instance.status})`);
    }
    if (!instance.allowedCapabilities.includes(capability)) {
      throw new AppError('FORBIDDEN', `capability ${capability} is not activated on this instance`, {
        details: { capability }
      });
    }
    return instance;
  }

  _assertMigration(tx) {
    if (tx.state.migration?.phase !== 'active') {
      throw new AppError('MIGRATION_BLOCKED', 'migration freeze blocks new dispatch', {
        details: { phase: tx.state.migration?.phase }
      });
    }
    const instance = tx.getInstance();
    if (instance?.status === 'retired') {
      throw new AppError('MIGRATION_BLOCKED', 'source instance is retired');
    }
  }

  _assertRecoveryPhase(tx) {
    const phase = tx.state.recovery?.phase || 'normal';
    if (!['normal', 'restricted', 'released'].includes(phase)) {
      throw new AppError('RECOVERY_GAP', `recovery phase ${phase} blocks dispatch`);
    }
  }

  _assertFence(tx) {
    const fence = tx.state.checkpointFence;
    if (!fence) return;
    const expiresAt = Date.parse(fence.expiresAt || '');
    const expired = Number.isFinite(expiresAt) && expiresAt <= this.now().getTime();
    if (expired) {
      const ownerAlive = isProcessAlive(fence.ownerPid);
      let pidReused = false;
      if (ownerAlive) {
        const actualStart = getProcessStartMs(fence.ownerPid);
        const recordedStart = Date.parse(fence.processStartedAt || '');
        pidReused =
          actualStart !== null &&
          Number.isFinite(recordedStart) &&
          Math.abs(actualStart - recordedStart) > 5000;
      }
      // Only an expired fence whose owner is provably gone (or whose PID was
      // reused by a different process) may be cleared.
      if (!ownerAlive || pidReused) {
        tx.state.checkpointFence = null;
        tx.appendEvent({
          type: 'fence.expired',
          actor: 'system',
          payload: { fenceId: fence.id, kind: fence.kind, ownerPid: fence.ownerPid }
        });
        return;
      }
    }
    throw new AppError('BACKUP_UNPROTECTED', 'checkpoint fence is active; new dispatch is blocked', {
      details: { fenceId: fence.id, kind: fence.kind, expiresAt: fence.expiresAt }
    });
  }

  _assertBusinessKeyAvailable(tx, key, { allowRetry, humanAuthorized }) {
    const existing = tx.state.businessKeys[key];
    if (!existing) return null;
    const status = existing.status;
    if (status === 'failed' || status === 'not_sent' || status === 'cancelled') {
      if (!allowRetry || !humanAuthorized) {
        throw new AppError('DUPLICATE_OPERATION', 'business key is in a retryable terminal state; explicit human retry is required', {
          details: { businessKey: key, status }
        });
      }
      return existing;
    }
    throw new AppError('DUPLICATE_OPERATION', 'business key already has a reserved/confirmed/unknown operation', {
      details: { businessKey: key, status }
    });
  }

  async _protectionCheck(scope) {
    if (!this.protection?.getProtection) {
      throw new AppError('BACKUP_UNPROTECTED', 'no backup protection service is configured');
    }
    let result;
    try {
      result = await this.protection.getProtection(scope);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('BACKUP_UNPROTECTED', 'backup protection check failed', { cause: error });
    }
    const status = result?.status;
    if (status === 'protected') return result;
    if (status === 'degraded' || status === 'stale') {
      throw new AppError('BACKUP_STALE', 'latest recovery point is stale or degraded', {
        details: { ageMs: result.ageMs, cutAt: result.cutAt, reason: result.reason }
      });
    }
    if (status === 'invalid') {
      throw new AppError('BACKUP_INVALID', 'recovery point failed verification', {
        details: { reason: result.reason }
      });
    }
    throw new AppError('BACKUP_UNPROTECTED', 'no independent verified recovery point is available', {
      details: { reason: result?.reason || 'not_configured' }
    });
  }

  async _assertProtected(tx, opLike) {
    const scope = recoveryScopeForOperation({ op: opLike, config: this.getConfig() });
    const holdCheck = assertNoMatchingHold(tx.state, scope);
    const result = await this._protectionCheck(scope);
    return { scope, result, holdCheck };
  }

  _assertUnknownExposure(tx, budget) {
    const exposures = Object.values(tx.state.recovery?.unknownExposures || {});
    for (const exposure of exposures) {
      if (exposure.maxMinor !== null) continue;
      if (!exposure.scope) continue;
      let matches = false;
      try {
        matches = findMatchingHolds(
          [{ status: 'active', kind: 'recovery', scope: exposure.scope }],
          {
            kind: 'provider_budget',
            workspaceId: tx.state.workspaceId,
            provider: budget.provider,
            budgetId: budget.budgetId
          }
        ).length > 0;
      } catch {
        matches = true;
      }
      if (matches) {
        throw new AppError('BUDGET_EXCEEDED', 'unknown exposure with no cost ceiling blocks paid calls', {
          details: { exposureId: exposure.id }
        });
      }
    }
  }

  _reserveBudget(tx, budget) {
    if (!budget) return null;
    const { provider, budgetId, currency, amountMinor, capMinor } = budget;
    if (!provider || !budgetId) throw new AppError('BUDGET_EXCEEDED', 'provider budget id is required');
    if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
      throw new AppError('BUDGET_EXCEEDED', 'budget amount must be a non-negative integer');
    }
    if (!Number.isSafeInteger(capMinor) || capMinor < 0) {
      throw new AppError('BUDGET_EXCEEDED', 'paid call requires a finite cost ceiling');
    }
    if (amountMinor > capMinor) {
      throw new AppError('BUDGET_EXCEEDED', 'requested cost exceeds the per-call ceiling');
    }
    this._assertUnknownExposure(tx, budget);
    const key = `${tx.workspaceId}:${provider}:${budgetId}`;
    const existing = tx.state.budgets[key] || {
      key,
      workspaceId: tx.workspaceId,
      provider,
      budgetId,
      currency,
      capMinor,
      spentMinor: 0,
      reservedMinor: 0,
      unknownMinor: 0,
      updatedAt: nowIso(this.now)
    };
    if (existing.currency !== currency) {
      throw new AppError('BUDGET_EXCEEDED', 'currency mismatch; implicit conversion is forbidden');
    }
    const effectiveCap = Math.min(existing.capMinor, capMinor);
    if (existing.spentMinor + existing.reservedMinor + (existing.unknownMinor || 0) + amountMinor > effectiveCap) {
      throw new AppError('BUDGET_EXCEEDED', 'provider budget is exhausted', {
        details: {
          capMinor: effectiveCap,
          spentMinor: existing.spentMinor,
          reservedMinor: existing.reservedMinor,
          unknownMinor: existing.unknownMinor || 0,
          requested: amountMinor
        }
      });
    }
    existing.capMinor = effectiveCap;
    existing.reservedMinor += amountMinor;
    existing.updatedAt = nowIso(this.now);
    tx.state.budgets[key] = existing;
    return { key, amountMinor, currency, provider, budgetId, capMinor: effectiveCap };
  }

  _settleBudget(tx, operation, outcome) {
    if (!operation.budget?.key) return;
    const budget = tx.state.budgets[operation.budget.key];
    if (!budget) return;
    const amount = operation.amountMinor || 0;
    if (outcome === 'confirmed') {
      budget.reservedMinor = Math.max(0, budget.reservedMinor - amount);
      budget.spentMinor += amount;
    } else if (outcome === 'unknown') {
      budget.reservedMinor = Math.max(0, budget.reservedMinor - amount);
      budget.unknownMinor += amount;
    } else {
      budget.reservedMinor = Math.max(0, budget.reservedMinor - amount);
    }
    budget.updatedAt = nowIso(this.now);
  }

  _resolveBudget(tx, operation, decision) {
    if (!operation.budget?.key) return;
    const budget = tx.state.budgets[operation.budget.key];
    if (!budget) return;
    const amount = operation.amountMinor || 0;
    const unknown = budget.unknownMinor || 0;
    if (decision === 'confirmed') {
      budget.unknownMinor = Math.max(0, unknown - amount);
      budget.spentMinor += amount;
    } else {
      budget.unknownMinor = Math.max(0, unknown - amount);
    }
    budget.updatedAt = nowIso(this.now);
  }

  _newOperation(tx, data) {
    const now = nowIso(this.now);
    return {
      id: data.operationId || randomId('op'),
      workspaceId: tx.workspaceId,
      namespace: data.namespace,
      action: data.action,
      receiptAction: data.receiptAction || data.action,
      recoveryAction: data.recoveryAction || null,
      status: 'reserved',
      instanceId: tx.instanceId,
      ownerPid: process.pid,
      processStartedAt: processStartIso(),
      createdAt: now,
      dispatchAt: null,
      finishedAt: null,
      businessKey: data.businessKey,
      taskIds: [...new Set(data.taskIds || [])],
      accountRef: data.accountRef ? deepClone(data.accountRef) : null,
      inputHash: data.inputHash,
      approvalId: data.approvalId || null,
      approvalAction: data.approvalAction || null,
      quota: data.quota || null,
      budget: data.budget || null,
      amountMinor: data.amountMinor || 0,
      currency: data.budget?.currency || null,
      recoveryScope: data.recoveryScope ? normalizeScope(data.recoveryScope, tx.workspaceId) : null,
      protected: Boolean(data.protected),
      metadata: data.metadata ? deepClone(data.metadata) : {},
      attempts: 0,
      resultSummary: null,
      error: null,
      receipt: null
    };
  }

  async reserveOperation(data) {
    if (!data.namespace || !data.action || !data.businessKey || !data.inputHash) {
      throw new AppError('CONFIG_INVALID', 'operation namespace/action/businessKey/inputHash are required');
    }
    const protectedOperation =
      data.protected ?? ['platform', 'provider', 'external', 'im'].includes(data.namespace);
    return this.store.transaction(async (draft, tx) => {
      tx.assertBusinessAcceptance();
      this._assertConfig(tx);
      this._assertMigration(tx);
      this._assertRecoveryPhase(tx);
      this._assertFence(tx);
      const capability = data.capability || capabilityFor({
        namespace: data.namespace,
        action: data.action,
        platform: data.accountRef?.platform
      });
      this._assertInstance(tx, capability);
      const extraKeys = [...new Set((data.extraBusinessKeys || []).filter(Boolean))].filter(
        (key) => key !== data.businessKey
      );
      const existingMap = new Map();
      const allKeys = [data.businessKey, ...extraKeys];
      const reusableKeys = new Set(data.reusableBusinessKeys || []);
      for (const key of allKeys) {
        const current = tx.state.businessKeys[key];
        if (
          reusableKeys.has(key) &&
          current &&
          ['confirmed', 'failed', 'not_sent', 'cancelled'].includes(current.status)
        ) {
          existingMap.set(key, current);
          continue;
        }
        existingMap.set(
          key,
          this._assertBusinessKeyAvailable(tx, key, {
            allowRetry: data.allowRetry === true,
            humanAuthorized: data.humanAuthorized === true
          })
        );
      }
      const existing = existingMap.get(data.businessKey) || null;
      if (data.operationId && draft.operations[data.operationId]) {
        const op = draft.operations[data.operationId];
        if (op.businessKey === data.businessKey && op.inputHash === data.inputHash) {
          return { operation: deepClone(op), deduplicated: true };
        }
        throw new AppError('IDEMPOTENCY_CONFLICT', 'operationId was reused with different input');
      }
      if (data.approvalId && this.approvalService) {
        this.approvalService.assertApproved(draft, {
          taskId: data.taskIds?.[0],
          action: data.approvalAction || data.action,
          inputHash: data.inputHash
        });
      }
      const op = this._newOperation(tx, {
        ...data,
        taskIds: data.taskIds || (data.taskId ? [data.taskId] : []),
        protected: protectedOperation
      });
      for (const taskId of op.taskIds) {
        const task = draft.tasks[taskId];
        if (task?.holds?.some((hold) => hold.status !== 'released')) {
          throw new AppError('RECOVERY_GAP', 'task has an active recovery/migration hold');
        }
      }
      if (data.quota) {
        this.rateLimiter.reserveWrite(draft, {
          key: data.quota.key,
          limits: this.getConfig().rateLimit,
          action: data.quota.action || data.action,
          actionQuota: data.quota.actionQuota || null
        });
        op.quota = {
          key: data.quota.key,
          action: data.quota.action || data.action,
          reservedAt: nowIso(this.now)
        };
      }
      if (data.budget) {
        op.budget = this._reserveBudget(tx, data.budget);
        op.amountMinor = data.budget.amountMinor;
        op.currency = data.budget.currency;
      }
      let protectionInfo = null;
      if (protectedOperation) {
        protectionInfo = await this._assertProtected(tx, op);
      } else {
        assertNoMatchingHold(
          draft,
          op.recoveryScope || { kind: 'workspace', workspaceId: tx.workspaceId }
        );
      }
      op.businessKeys = allKeys;
      draft.operations[op.id] = op;
      for (const key of allKeys) {
        const previous = existingMap.get(key) || {
          key,
          namespace: data.namespace,
          type: data.action,
          createdAt: nowIso(this.now)
        };
        draft.businessKeys[key] = {
          ...previous,
          key,
          namespace: data.namespace,
          type: data.action,
          status: 'reserved',
          target: data.target || previous.target || null,
          lastAttemptAt: nowIso(this.now),
          lastOperationId: op.id
        };
      }
      for (const taskId of op.taskIds) {
        const task = draft.tasks[taskId];
        if (task) this.taskManager.addOperation(tx, task, op);
      }
      tx.appendEvent({
        type: 'operation.reserved',
        actor: data.actor || 'system',
        taskId: op.taskIds[0] || null,
        accountRef: op.accountRef,
        payload: {
          operationId: op.id,
          namespace: op.namespace,
          action: op.action,
          businessKey: op.businessKey,
          protected: op.protected,
          budgetKey: op.budget?.key || null,
          amountMinor: op.amountMinor
        }
      });
      return {
        operation: deepClone(op),
        deduplicated: false,
        protection: protectionInfo?.result?.status || null
      };
    });
  }

  async _prepareDispatch(operationId) {
    return this.store.transaction(async (draft, tx) => {
      const op = draft.operations[operationId];
      if (!op) throw new AppError('FORBIDDEN', 'operation not found');
      if (['confirmed', 'failed', 'not_sent', 'cancelled'].includes(op.status)) {
        return { terminal: true, operation: deepClone(op) };
      }
      if (op.status === 'dispatching' || op.status === 'unknown') {
        throw new AppError('OPERATION_UNKNOWN', 'operation was already dispatched; it cannot be sent again', {
          details: { operationId, status: op.status }
        });
      }
      if (op.status !== 'reserved') {
        throw new AppError('OPERATION_UNKNOWN', 'operation state is not dispatchable');
      }
      this._assertConfig(tx);
      this._assertMigration(tx);
      this._assertRecoveryPhase(tx);
      this._assertFence(tx);
      const capability = capabilityFor({
        namespace: op.namespace,
        action: op.action,
        platform: op.accountRef?.platform
      });
      this._assertInstance(tx, capability);
      if (op.protected) await this._assertProtected(tx, op);
      else assertNoMatchingHold(tx.state, op.recoveryScope || { kind: 'workspace', workspaceId: tx.workspaceId });
      if (op.approvalId && this.approvalService) {
        const approval = this.approvalService.assertApproved(draft, {
          taskId: op.taskIds[0],
          action: op.approvalAction || op.action,
          inputHash: op.inputHash,
          operationId: op.id
        });
        this.approvalService.consume(tx, approval, op.id);
      }
      op.status = 'dispatching';
      op.dispatchAt = nowIso(this.now);
      op.attempts += 1;
      op.ownerPid = process.pid;
      op.processStartedAt = processStartIso();
      for (const taskId of op.taskIds) {
        const task = draft.tasks[taskId];
        if (task?.holds?.some((hold) => hold.status !== 'released')) {
          throw new AppError('RECOVERY_GAP', 'task has an active recovery/migration hold');
        }
      }
      const context = this._contextVerifier.issue(op);
      for (const taskId of op.taskIds) {
        const task = draft.tasks[taskId];
        if (task) {
          task.executionActive = false;
          this.taskManager.recompute(tx, task);
        }
      }
      tx.appendEvent({
        type: 'operation.dispatching',
        actor: 'system',
        taskId: op.taskIds[0] || null,
        accountRef: op.accountRef,
        payload: { operationId: op.id, attempt: op.attempts, businessKey: op.businessKey }
      });
      return { terminal: false, operation: deepClone(op), context };
    });
  }

  async _settleDispatch(operationId, outcome, { receipt = null, error = null, applyResult = null, context = null } = {}) {
    return this.store.transaction(async (draft, tx) => {
      const op = draft.operations[operationId];
      if (!op) throw new AppError('FORBIDDEN', 'operation not found for settlement');
      if (['confirmed', 'failed', 'not_sent', 'cancelled'].includes(op.status)) {
        return { operation: deepClone(op), deduplicated: true };
      }
      if (op.status !== 'dispatching' && op.status !== 'unknown') {
        // A late result may still settle a reserved record only when it was
        // genuinely dispatched by this attempt.
        if (!op.dispatchAt) {
          throw new AppError('OPERATION_UNKNOWN', 'cannot settle an operation that was never dispatched');
        }
      }
      if (outcome === 'confirmed' && !receipt) {
        throw new AppError('OPERATION_UNKNOWN', 'confirmed operation requires a structured receipt');
      }
      op.status = outcome;
      op.finishedAt = nowIso(this.now);
      op.receipt = receipt ? deepClone(receipt) : null;
      op.error = error
        ? {
            code: error.code || 'DEPENDENCY_UNAVAILABLE',
            message: truncateText(error.message || String(error), 500),
            retryable: false
          }
        : null;
      op.resultSummary = receipt
        ? { externalId: receipt.externalId, url: receipt.url || null, verification: receipt.verification }
        : null;
      if (outcome === 'confirmed') {
        op.confirmedAt = op.finishedAt;
      }
      this._settleBudget(tx, op, outcome);
      for (const key of op.businessKeys || [op.businessKey]) {
        const businessKey = draft.businessKeys[key];
        if (!businessKey) continue;
        businessKey.status = outcome;
        if (outcome === 'confirmed') {
          businessKey.confirmedAt = op.finishedAt;
          businessKey.receipt = op.resultSummary;
        } else if (outcome === 'unknown') {
          businessKey.unknownAt = op.finishedAt;
        } else {
          businessKey.settledAt = op.finishedAt;
          businessKey.error = op.error;
        }
        businessKey.lastOperationId = op.id;
        businessKey.updatedAt = nowIso(this.now);
      }
      for (const taskId of op.taskIds) {
        const task = draft.tasks[taskId];
        if (!task) continue;
        this.taskManager.settleOperation(tx, op);
        if (outcome === 'unknown' && task.status === 'running') {
          this.taskManager.transition(tx, task, 'unknown', {
            actor: 'system',
            reason: 'operation result unknown',
            error: op.error || { code: 'OPERATION_UNKNOWN' }
          });
        }
      }
      if (applyResult) {
        try {
          await applyResult(tx, op, outcome);
        } catch (applyError) {
          op.settlementError = {
            code: applyError.code || 'DEPENDENCY_UNAVAILABLE',
            message: truncateText(applyError.message || String(applyError), 500)
          };
        }
      }
      tx.appendEvent({
        type: `operation.${outcome}`,
        actor: 'system',
        taskId: op.taskIds[0] || null,
        accountRef: op.accountRef,
        payload: {
          operationId: op.id,
          action: op.action,
          businessKey: op.businessKey,
          receipt: op.resultSummary,
          error: op.error,
          settlementError: op.settlementError || null
        }
      });
      if (context) this._contextVerifier.consume(context);
      return { operation: deepClone(op), deduplicated: false };
    });
  }

  async dispatchOperation(operationId, execute, { applyResult = null } = {}) {
    const prepared = await this._prepareDispatch(operationId);
    if (prepared.terminal) return { operation: prepared.operation, terminal: true, skipped: true };
    let receipt = null;
    let outcome;
    let error = null;
    try {
      const result = await execute(prepared.context);
      if (!result || result.status === undefined) {
        if (result && result.externalId) {
          receipt = result;
          outcome = 'confirmed';
        } else {
          outcome = 'unknown';
          error = new AppError('OPERATION_UNKNOWN', 'adapter returned no structured result');
        }
      } else if (result.status === 'confirmed') {
        receipt = result.receipt || result;
        outcome = 'confirmed';
      } else if (['failed', 'not_sent'].includes(result.status)) {
        outcome = result.status;
        error = result.error || null;
      } else if (result.status === 'unknown') {
        outcome = 'unknown';
        error = result.error || new AppError('OPERATION_UNKNOWN', 'adapter reported unknown');
      } else {
        outcome = 'unknown';
        error = new AppError('OPERATION_UNKNOWN', `unexpected adapter result: ${result.status}`);
      }
    } catch (caught) {
      error = caught;
      if (caught?.notSent === true) outcome = 'failed';
      else outcome = 'unknown';
    }
    if (outcome === 'confirmed' && receipt) {
      const op = prepared.operation;
      try {
        assertReceipt(receipt, {
          platform: op.accountRef?.platform || null,
          accountId: op.accountRef?.accountId || null,
          action: op.receiptAction || op.action
        });
      } catch (receiptError) {
        outcome = 'unknown';
        error = receiptError;
        receipt = null;
      }
    }
    const settled = await this._settleDispatch(operationId, outcome, {
      receipt,
      error,
      applyResult,
      context: prepared.context
    });
    return { ...settled, skipped: false };
  }

  async executeOperation(reservation, execute, options = {}) {
    const reserved = await this.reserveOperation(reservation);
    if (
      reserved.deduplicated &&
      ['confirmed', 'failed', 'not_sent', 'cancelled', 'unknown', 'dispatching'].includes(reserved.operation.status)
    ) {
      return { operation: reserved.operation, deduplicated: true, skipped: true };
    }
    return this.dispatchOperation(reserved.operation.id, execute, options);
  }

  async cancelReserved(operationId, { provenUndispatched = false, reason = 'cancelled' } = {}) {
    return this.store.transaction(async (draft, tx) => {
      const op = draft.operations[operationId];
      if (!op) throw new AppError('FORBIDDEN', 'operation not found');
      if (op.status !== 'reserved' || op.dispatchAt) {
        throw new AppError('OPERATION_UNKNOWN', 'only a never-dispatched reserved operation can be cancelled');
      }
      if (!provenUndispatched) {
        throw new AppError('OPERATION_UNKNOWN', 'cancellation requires proof that dispatch did not happen');
      }
      op.status = 'cancelled';
      op.finishedAt = nowIso(this.now);
      op.error = { code: 'FORBIDDEN', message: truncateText(reason, 300), retryable: false };
      this._settleBudget(tx, op, 'cancelled');
      for (const key of op.businessKeys || [op.businessKey]) {
        const businessKey = draft.businessKeys[key];
        if (!businessKey) continue;
        businessKey.status = 'cancelled';
        businessKey.settledAt = op.finishedAt;
        businessKey.error = op.error;
      }
      for (const taskId of op.taskIds) {
        const task = draft.tasks[taskId];
        if (task) this.taskManager.settleOperation(tx, op);
      }
      tx.appendEvent({
        type: 'operation.cancelled',
        actor: 'system',
        taskId: op.taskIds[0] || null,
        payload: { operationId: op.id, reason }
      });
      return deepClone(op);
    });
  }

  async resolve({ operationId, decision, receipt = null, note = '' }, humanContext, { applyResult = null } = {}) {
    if (!['confirmed', 'not_sent'].includes(decision)) {
      throw new AppError('CONFIG_INVALID', 'resolve decision must be confirmed or not_sent');
    }
    if (!humanContext?.principal || !humanContext?.proof) {
      throw new AppError('TRUST_UNAVAILABLE', 'operation resolve requires a trusted local human');
    }
    const snapshot = await this.store.getSnapshot();
    const op = snapshot.operations[operationId];
    if (!op) throw new AppError('FORBIDDEN', 'operation not found');
    if (this.humanProof) {
      await this.humanProof.assert(humanContext, {
        action: 'operation.resolve',
        operationId,
        decision,
        businessKey: op.businessKey,
        inputHash: op.inputHash
      });
    }
    if (decision === 'confirmed') {
      if (!receipt) throw new AppError('OPERATION_UNKNOWN', 'confirmed resolve requires a receipt');
      assertReceipt(receipt, {
        platform: op.accountRef?.platform || null,
        accountId: op.accountRef?.accountId || null,
        action: op.receiptAction || op.action
      });
      if (op.namespace === 'external') {
        if (!receipt.externalId || !receipt.url) {
          throw new AppError('OPERATION_UNKNOWN', 'external publish receipt requires bvid/url');
        }
        if (!['publisher_receipt', 'platform_readback'].includes(receipt.verification)) {
          throw new AppError('OPERATION_UNKNOWN', 'external publish requires publisher/platform verification');
        }
      }
    } else if (!note && !receipt) {
      throw new AppError('OPERATION_UNKNOWN', 'not_sent requires verified evidence or a note');
    }
    return this.store.transaction(async (draft, tx) => {
      const current = draft.operations[operationId];
      if (!current) throw new AppError('FORBIDDEN', 'operation not found');
      if (current.status === decision) {
        return { operation: deepClone(current), deduplicated: true };
      }
      if (current.status !== 'unknown') {
        throw new AppError('OPERATION_UNKNOWN', 'only unknown operations can be resolved');
      }
      current.status = decision;
      current.resolvedAt = nowIso(this.now);
      current.resolution = {
        decision,
        note: truncateText(note || '', 1000),
        receipt: receipt ? deepClone(receipt) : null,
        resolvedBy: humanContext.principal.id,
        verification: decision === 'confirmed' ? receipt.verification : 'manual_assertion'
      };
      current.receipt = receipt ? deepClone(receipt) : current.receipt;
      if (decision === 'confirmed') {
        current.confirmedAt = current.resolvedAt;
        current.resultSummary = {
          externalId: receipt.externalId,
          url: receipt.url || null,
          verification: receipt.verification
        };
      }
      this._resolveBudget(tx, current, decision);
      for (const key of current.businessKeys || [current.businessKey]) {
        const businessKey = draft.businessKeys[key];
        if (!businessKey) continue;
        businessKey.status = decision;
        businessKey.lastOperationId = current.id;
        businessKey.updatedAt = nowIso(this.now);
        if (decision === 'confirmed') {
          businessKey.confirmedAt = current.resolvedAt;
          businessKey.receipt = current.resultSummary;
        } else {
          businessKey.settledAt = current.resolvedAt;
        }
      }
      for (const taskId of current.taskIds) {
        const task = draft.tasks[taskId];
        if (!task) continue;
        this.taskManager.settleOperation(tx, current);
        const noPending = (task.pendingOperationIds || []).length === 0;
        if (decision === 'confirmed') {
          if (noPending && ['running', 'unknown'].includes(task.status)) {
            this.taskManager.transition(tx, task, 'succeeded', {
              verified: true,
              actor: humanContext.principal.id,
              reason: 'operation resolve confirmed'
            });
          }
        } else if (noPending && ['running', 'unknown'].includes(task.status)) {
          this.taskManager.transition(tx, task, 'failed', {
            verified: true,
            actor: humanContext.principal.id,
            reason: 'operation resolve not_sent'
          });
        }
      }
      if (applyResult) {
        try {
          await applyResult(tx, current, decision);
        } catch (applyError) {
          current.settlementError = {
            code: applyError.code || 'DEPENDENCY_UNAVAILABLE',
            message: truncateText(applyError.message || String(applyError), 500)
          };
        }
      }
      tx.appendEvent({
        type: decision === 'confirmed' ? 'operation.confirmed' : 'operation.not_sent',
        actor: humanContext.principal.id,
        taskId: current.taskIds[0] || null,
        accountRef: current.accountRef,
        payload: {
          operationId: current.id,
          action: current.action,
          businessKey: current.businessKey,
          receipt: current.resultSummary || null,
          note: truncateText(note || '', 500)
        }
      });
      return { operation: deepClone(current), deduplicated: false };
    });
  }

  assertLocalDispatchInTransaction(tx, data = {}) {
    this._assertConfig(tx);
    this._assertMigration(tx);
    this._assertRecoveryPhase(tx);
    this._assertFence(tx);
    this._assertInstance(tx, data.capability || 'production:local');
    const scope = data.recoveryScope
      ? normalizeScope(data.recoveryScope, tx.workspaceId)
      : normalizeScope({ kind: 'workspace', workspaceId: tx.workspaceId });
    assertNoMatchingHold(tx.state, scope);
    return { scope, scopeKey: scopeKeyFor(scope) };
  }

  /**
   * Normal same-machine restart recovery. Only operations whose owner is
   * provably gone are changed: never-dispatched reserved -> cancelled;
   * dispatching -> unknown. No side effect is replayed.
   */
  async recoverOrphanedOperations() {
    return this.store.transaction(async (draft, tx) => {
      const recovered = [];
      for (const op of Object.values(draft.operations || {})) {
        if (!['reserved', 'dispatching'].includes(op.status)) continue;
        const alive = op.ownerPid && isProcessAlive(op.ownerPid);
        let sameOwner = false;
        let startUnknown = false;
        if (alive) {
          const actualStart = getProcessStartMs(op.ownerPid);
          const recordedStart = Date.parse(op.processStartedAt || '');
          if (actualStart === null) startUnknown = true;
          else {
            sameOwner =
              Number.isFinite(recordedStart) && Math.abs(actualStart - recordedStart) <= 5000;
          }
        }
        // A live PID with an unverifiable start time is never stolen.
        if (alive && (sameOwner || startUnknown)) continue;
        const next = op.dispatchAt ? 'unknown' : 'cancelled';
        op.status = next;
        op.finishedAt = nowIso(this.now);
        op.error = {
          code: next === 'unknown' ? 'OPERATION_UNKNOWN' : 'FORBIDDEN',
          message: next === 'unknown'
            ? 'dispatch boundary was crossed and owner disappeared'
            : 'reserved operation owner disappeared before dispatch',
          retryable: false
        };
        this._settleBudget(tx, op, next);
        for (const key of op.businessKeys || [op.businessKey]) {
          const businessKey = draft.businessKeys[key];
          if (!businessKey) continue;
          businessKey.status = next;
          businessKey.updatedAt = nowIso(this.now);
          if (next === 'unknown') businessKey.unknownAt = op.finishedAt;
          else businessKey.settledAt = op.finishedAt;
        }
        for (const taskId of op.taskIds || []) {
          const task = draft.tasks[taskId];
          if (!task) continue;
          this.taskManager.settleOperation(tx, op);
          if (next === 'unknown' && task.status === 'running') {
            this.taskManager.transition(tx, task, 'unknown', {
              verified: true,
              actor: 'system',
              reason: 'operation owner disappeared after dispatch',
              error: op.error
            });
          }
        }
        tx.appendEvent({
          type: `operation.${next}`,
          actor: 'system',
          taskId: op.taskIds?.[0] || null,
          accountRef: op.accountRef,
          payload: {
            operationId: op.id,
            businessKey: op.businessKey,
            recoveredOnRestart: true,
            previousStatus: op.dispatchAt ? 'dispatching' : 'reserved'
          }
        });
        recovered.push({ operationId: op.id, status: next });
      }
      return { recovered };
    });
  }

  async assertLocalDispatch(data) {
    return this.store.transaction(async (draft, tx) => this.assertLocalDispatchInTransaction(tx, data));
  }

  /** Manual publish assertions are protected dispatch entries (SPEC §27.8). */
  async assertProtectedCompletionInTransaction(tx, { accountRef, recoveryScope, capability = 'publish:manual' }) {
    this._assertConfig(tx);
    this._assertMigration(tx);
    this._assertRecoveryPhase(tx);
    this._assertFence(tx);
    this._assertInstance(tx, capability);
    const scope = recoveryScope
      ? normalizeScope(recoveryScope, tx.workspaceId)
      : normalizeScope({ kind: 'workspace', workspaceId: tx.workspaceId });
    assertNoMatchingHold(tx.state, scope);
    await this._protectionCheck(scope);
    return { scope, scopeKey: scopeKeyFor(scope) };
  }

  async getProtectionStatus(scope) {
    if (!this.protection?.getProtection) {
      return { status: 'unprotected', reason: 'not_configured' };
    }
    try {
      return await this.protection.getProtection(scope || { kind: 'workspace', workspaceId: (await this.store.getSnapshot()).workspaceId });
    } catch (error) {
      return { status: 'invalid', reason: error.message };
    }
  }

  /* ------------------------------- outbox ------------------------------- */

  async _notificationScope(data, binding) {
    const state = await this.store.getSnapshot();
    return normalizeScope(
      {
        kind: 'im_conversation',
        workspaceId: state.workspaceId,
        adapterId: binding.adapterId,
        botAccountId: binding.botAccountId,
        conversationId: data.conversationId
      },
      state.workspaceId
    );
  }

  _notificationBudget(tx, binding, data) {
    const config = this.getConfig();
    if (!config.im.notifications.enabled) {
      throw new AppError('FEATURE_DISABLED', 'IM notifications are disabled');
    }
    const key = `im:${binding.adapterId}:${binding.botAccountId}`;
    if (!tx.state.rate[key]) tx.state.rate[key] = {};
    const bucket = tx.state.rate[key];
    const now = this.now();
    const timeZone = config.timeZone;
    const minuteKey = formatDateTimeInZone(now, timeZone).slice(0, 16);
    if (bucket.notify?.minuteKey !== minuteKey) {
      bucket.notify = { minuteKey, count: 0, lastAt: null };
    }
    if (bucket.notify.lastAt && now.getTime() - Date.parse(bucket.notify.lastAt) < config.im.notifications.minGapMs) {
      throw new AppError('RATE_LIMITED', 'notification gap is active', { retryable: true });
    }
    if (bucket.notify.count >= config.im.notifications.perMinute) {
      throw new AppError('QUOTA_EXCEEDED', 'notification per-minute quota exhausted');
    }
    bucket.notify.count += 1;
    bucket.notify.lastAt = now.toISOString();
    return key;
  }

  /**
   * Enqueue a notification in an existing business transaction. Callers must
   * have obtained a healthy protection status via assertNotificationProtection
   * immediately before the transaction; dispatch re-checks it.
   */
  appendNotification(tx, data) {
    if (!data.bindingId || !data.conversationId || !data.summary) {
      throw new AppError('INPUT_REQUIRED', 'notification binding/conversation/summary are required');
    }
    const binding = tx.state.bindings[data.bindingId];
    if (!binding || binding.revokedAt) throw new AppError('FORBIDDEN', 'notification binding is inactive');
    if (!binding.conversationIds.includes(data.conversationId)) {
      throw new AppError('FORBIDDEN', 'notification conversation is not authorized');
    }
    this._assertMigration(tx);
    this._assertFence(tx);
    const scope = normalizeScope({
      kind: 'im_conversation',
      workspaceId: tx.workspaceId,
      adapterId: binding.adapterId,
      botAccountId: binding.botAccountId,
      conversationId: data.conversationId
    });
    assertNoMatchingHold(tx.state, scope);
    this._notificationBudget(tx, binding, data);
    const notification = {
      id: data.notificationId || randomId('outbox'),
      notificationId: null,
      taskId: data.taskId || null,
      taskRevision: data.taskRevision || null,
      bindingId: binding.bindingId,
      adapterId: binding.adapterId,
      botAccountId: binding.botAccountId,
      conversationId: data.conversationId,
      summary: truncateText(data.summary, data.maxSummaryChars || 500),
      payloadHash: data.payloadHash || jcsHash({ summary: data.summary }),
      status: 'pending',
      revision: 1,
      createdAt: nowIso(this.now),
      sendingAt: null,
      sentAt: null,
      failedAt: null,
      attempts: 0,
      receipt: null,
      error: null,
      suppressionReason: null
    };
    notification.notificationId = notification.id;
    tx.state.outbox[notification.id] = notification;
    tx.appendEvent({
      type: 'outbox.pending',
      actor: data.actor || 'system',
      taskId: notification.taskId,
      payload: {
        notificationId: notification.id,
        bindingId: binding.bindingId,
        conversationId: data.conversationId,
        payloadHash: notification.payloadHash
      }
    });
    return deepClone(notification);
  }

  async assertNotificationProtection(binding, conversationId) {
    const scope = normalizeScope({
      kind: 'im_conversation',
      workspaceId: (await this.store.getSnapshot()).workspaceId,
      adapterId: binding.adapterId,
      botAccountId: binding.botAccountId,
      conversationId
    });
    return this._protectionCheck(scope);
  }

  async dispatchNotification(notificationId, channel) {
    if (!channel?.send) throw new AppError('DEPENDENCY_UNAVAILABLE', 'IM channel is unavailable');
    const prepared = await this.store.transaction(async (draft, tx) => {
      const notification = draft.outbox[notificationId];
      if (!notification) throw new AppError('FORBIDDEN', 'notification not found');
      if (['sent', 'not_sent', 'failed', 'suppressed'].includes(notification.status)) {
        return { terminal: true, notification: deepClone(notification) };
      }
      if (notification.status !== 'pending') {
        throw new AppError('OPERATION_UNKNOWN', 'notification is already sending/unknown');
      }
      const binding = draft.bindings[notification.bindingId];
      if (!binding || binding.revokedAt) {
        notification.status = 'suppressed';
        notification.suppressionReason = 'binding_revoked';
        notification.finishedAt = nowIso(this.now);
        tx.appendEvent({
          type: 'outbox.suppressed',
          actor: 'system',
          taskId: notification.taskId,
          payload: { notificationId, reason: 'binding_revoked' }
        });
        return { terminal: true, notification: deepClone(notification) };
      }
      if (!binding.conversationIds.includes(notification.conversationId)) {
        throw new AppError('FORBIDDEN', 'notification conversation is no longer authorized');
      }
      this._assertMigration(tx);
      this._assertFence(tx);
      this._assertRecoveryPhase(tx);
      const scope = normalizeScope({
        kind: 'im_conversation',
        workspaceId: tx.workspaceId,
        adapterId: binding.adapterId,
        botAccountId: binding.botAccountId,
        conversationId: notification.conversationId
      });
      assertNoMatchingHold(tx.state, scope);
      await this._assertProtected(tx, {
        namespace: 'im',
        workspaceId: tx.workspaceId,
        accountRef: null,
        recoveryScope: scope,
        action: 'notify'
      });
      notification.status = 'sending';
      notification.sendingAt = nowIso(this.now);
      notification.attempts += 1;
      const context = {
        notificationId: notification.id,
        bindingId: notification.bindingId,
        payloadHash: notification.payloadHash,
        permit: 'dispatch-once',
        conversationId: notification.conversationId
      };
      assertOutboxDispatchContext(context);
      tx.appendEvent({
        type: 'outbox.sending',
        actor: 'system',
        taskId: notification.taskId,
        payload: { notificationId, attempt: notification.attempts }
      });
      return { terminal: false, notification: deepClone(notification), context };
    });
    if (prepared.terminal) return prepared;
    let result;
    let error = null;
    try {
      result = await channel.send(prepared.context, prepared.notification);
      if (!result || typeof result !== 'object') {
        error = new AppError('OPERATION_UNKNOWN', 'channel returned no structured delivery result');
        result = { status: 'unknown' };
      }
    } catch (caught) {
      error = caught;
      result = { status: caught?.notSent === true ? 'failed' : 'unknown' };
    }
    return this.store.transaction(async (draft, tx) => {
      const notification = draft.outbox[notificationId];
      if (!notification) throw new AppError('FORBIDDEN', 'notification disappeared');
      if (['sent', 'not_sent', 'failed', 'suppressed'].includes(notification.status)) {
        return { notification: deepClone(notification), deduplicated: true };
      }
      if (result.status === 'sent') {
        notification.status = 'sent';
        notification.sentAt = nowIso(this.now);
        notification.receipt = result.receipt || result;
      } else if (result.status === 'not_sent' || result.status === 'failed') {
        notification.status = 'failed';
        notification.failedAt = nowIso(this.now);
        notification.error = { code: error?.code || 'DEPENDENCY_UNAVAILABLE', message: truncateText(error?.message || 'delivery failed', 300) };
      } else {
        notification.status = 'unknown';
        notification.finishedAt = nowIso(this.now);
        notification.error = { code: error?.code || 'OPERATION_UNKNOWN', message: truncateText(error?.message || 'delivery unknown', 300) };
      }
      tx.appendEvent({
        type: `outbox.${notification.status}`,
        actor: 'system',
        taskId: notification.taskId,
        payload: {
          notificationId,
          receipt: notification.receipt ? { externalId: notification.receipt.externalId || null } : null
        }
      });
      return { notification: deepClone(notification), deduplicated: false };
    });
  }

  async queryNotificationDelivery(notificationId, channel) {
    if (!channel?.queryDelivery) {
      throw new AppError('CAPABILITY_UNSUPPORTED', 'channel does not support delivery queries');
    }
    const state = await this.store.getSnapshot();
    const notification = state.outbox[notificationId];
    if (!notification) throw new AppError('FORBIDDEN', 'notification not found');
    if (!channel.capabilities?.delivery?.query) {
      throw new AppError('CAPABILITY_UNSUPPORTED', 'channel delivery.query is not declared');
    }
    const result = await channel.queryDelivery(notificationId, notification.receipt);
    if (!['sent', 'not_sent', 'unknown'].includes(result?.status)) {
      throw new AppError('OPERATION_UNKNOWN', 'delivery query result is not trustworthy');
    }
    return this.store.transaction(async (draft, tx) => {
      const current = draft.outbox[notificationId];
      if (!current) throw new AppError('FORBIDDEN', 'notification not found');
      if (['sent', 'not_sent', 'failed', 'suppressed'].includes(current.status)) {
        return deepClone(current);
      }
      if (result.status === 'sent') {
        current.status = 'sent';
        current.sentAt = nowIso(this.now);
      } else if (result.status === 'not_sent') {
        current.status = 'not_sent';
        current.settledAt = nowIso(this.now);
      } else {
        current.status = 'unknown';
      }
      tx.appendEvent({
        type: `outbox.${current.status}`,
        actor: 'system',
        taskId: current.taskId,
        payload: { notificationId, source: 'delivery_query' }
      });
      return deepClone(current);
    });
  }

  async resolveNotification({ notificationId, decision, receipt = null, note = '' }, humanContext) {
    if (!['confirmed', 'not_sent'].includes(decision)) {
      throw new AppError('CONFIG_INVALID', 'outbox resolve decision must be confirmed or not_sent');
    }
    if (!humanContext?.principal || !humanContext?.proof) {
      throw new AppError('TRUST_UNAVAILABLE', 'outbox resolve requires a trusted local human');
    }
    const state = await this.store.getSnapshot();
    const notification = state.outbox[notificationId];
    if (!notification) throw new AppError('FORBIDDEN', 'notification not found');
    if (this.humanProof) {
      await this.humanProof.assert(humanContext, {
        action: 'outbox.resolve',
        notificationId,
        decision,
        payloadHash: notification.payloadHash
      });
    }
    return this.store.transaction(async (draft, tx) => {
      const current = draft.outbox[notificationId];
      if (!current) throw new AppError('FORBIDDEN', 'notification not found');
      const target = decision === 'confirmed' ? 'sent' : 'not_sent';
      if (current.status === target) return deepClone(current);
      if (!['unknown', 'sending', 'pending', 'failed'].includes(current.status)) {
        throw new AppError('FORBIDDEN', 'notification cannot be resolved from its current state');
      }
      current.status = target;
      current.resolvedAt = nowIso(this.now);
      current.resolution = {
        decision,
        note: truncateText(note, 1000),
        receipt: receipt ? deepClone(receipt) : null,
        resolvedBy: humanContext.principal.id
      };
      current.receipt = receipt || current.receipt;
      tx.appendEvent({
        type: `outbox.${target}`,
        actor: humanContext.principal.id,
        taskId: current.taskId,
        payload: { notificationId, source: 'local_human' }
      });
      return deepClone(current);
    });
  }

  async suppressNotificationsForBinding(bindingId, reason = 'binding_revoked') {
    return this.store.transaction(async (draft, tx) => {
      let count = 0;
      for (const notification of Object.values(draft.outbox)) {
        if (
          notification.bindingId === bindingId &&
          ['pending', 'sending', 'unknown'].includes(notification.status)
        ) {
          notification.status = 'suppressed';
          notification.suppressionReason = reason;
          notification.finishedAt = nowIso(this.now);
          count += 1;
        }
      }
      if (count > 0) {
        tx.appendEvent({
          type: 'outbox.suppressed',
          actor: 'system',
          payload: { bindingId, count, reason }
        });
      }
      return { suppressed: count };
    });
  }
}

export default EffectGateway;
