import { AppError } from './errors.js';
import { deepClone, jsonByteLength, nowIso, randomId } from './utils.js';

export const TASK_STATUSES = Object.freeze([
  'queued',
  'running',
  'succeeded',
  'partial',
  'failed',
  'waiting_approval',
  'awaiting_manual',
  'unknown',
  'interrupted',
  'cancelled'
]);

export const TASK_KINDS = Object.freeze([
  'browse',
  'comment',
  'dm',
  'diary',
  'production',
  'publish',
  'im',
  'maintenance'
]);

export const TASK_TRANSITIONS = Object.freeze({
  queued: ['running', 'waiting_approval', 'awaiting_manual', 'cancelled'],
  running: [
    'succeeded',
    'partial',
    'failed',
    'waiting_approval',
    'awaiting_manual',
    'unknown',
    'interrupted',
    'cancelled'
  ],
  waiting_approval: ['running', 'cancelled', 'failed'],
  awaiting_manual: ['succeeded', 'failed', 'cancelled', 'unknown'],
  unknown: ['running', 'succeeded', 'partial', 'failed'],
  interrupted: ['running', 'unknown', 'failed', 'cancelled'],
  partial: ['running', 'succeeded', 'partial', 'failed'],
  failed: ['running', 'succeeded', 'partial', 'failed'],
  succeeded: [],
  cancelled: []
});

const TERMINAL_SETTLED = new Set(['succeeded', 'cancelled']);

/**
 * Pure field-combination check for one task (SPEC §10.1). Shared by
 * TaskManager.assertSettledCombination and JsonStore.validateState so an
 * illegal combination can never be committed to the ledger.
 */
export function validateTaskCombination(task) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    throw new AppError('STORE_CORRUPTED', 'task record is invalid');
  }
  if (!TASK_STATUSES.includes(task.status)) {
    throw new AppError('STORE_CORRUPTED', 'task status is invalid', {
      details: { taskId: task.id || null, status: task.status ?? null }
    });
  }
  const fail = () => {
    throw new AppError('STORE_CORRUPTED', `invalid task field combination for ${task.status}`, {
      details: {
        taskId: task.id || null,
        status: task.status,
        isSettled: task.isSettled,
        executionActive: task.executionActive,
        finishedAt: task.finishedAt ?? null,
        hasUnknownOperation: task.hasUnknownOperation === true
      }
    });
  };
  if (task.isSettled === true && task.hasUnknownOperation === true) fail();
  switch (task.status) {
    case 'succeeded':
    case 'cancelled':
      if (task.executionActive !== false) fail();
      // A completed task can still be unsettled (finishedAt=null) while a
      // pending approval or unknown operation blocks settlement (I3); once
      // settled it must stay inactive.
      if (task.isSettled === true) break;
      if (task.finishedAt !== null) fail();
      break;
    case 'unknown':
      if (task.isSettled !== false || task.executionActive !== false || task.finishedAt !== null) fail();
      break;
    case 'queued':
    case 'waiting_approval':
    case 'awaiting_manual':
    case 'interrupted':
      if (task.isSettled !== false || task.executionActive !== false) fail();
      break;
    case 'running':
      if (task.isSettled !== false) fail();
      break;
    case 'partial':
    case 'failed':
      if (task.isSettled === true) {
        if (task.executionActive !== false) fail();
      } else if (task.finishedAt !== null) {
        fail();
      }
      break;
    default:
      break;
  }
  return true;
}

export class TaskManager {
  constructor({ store, now = () => new Date() } = {}) {
    this.store = store;
    this.now = now;
  }

  create(tx, data) {
    if (!data || typeof data.kind !== 'string' || !TASK_KINDS.includes(data.kind)) {
      throw new AppError('INPUT_REQUIRED', 'task kind is invalid');
    }
    if (!data.principalId) throw new AppError('FORBIDDEN', 'task principalId is required');
    const now = nowIso(this.now);
    const id = data.id || randomId('task');
    const task = {
      id,
      workspaceId: tx.workspaceId,
      principalId: data.principalId,
      accountRef: data.accountRef ? deepClone(data.accountRef) : null,
      parentTaskId: data.parentTaskId || null,
      childTaskIds: [],
      kind: data.kind,
      status: data.status || 'queued',
      isSettled: false,
      executionActive: false,
      hasUnknownOperation: false,
      trigger: data.trigger || 'manual',
      sourceKind: data.sourceKind || 'local_cli',
      input: deepClone(data.input || {}),
      inputHash: data.inputHash || '',
      revision: 1,
      attempts: 0,
      createdAt: now,
      startedAt: data.startedAt || null,
      finishedAt: null,
      cancelRequestedAt: null,
      result: null,
      error: null,
      operationIds: [],
      pendingOperationIds: [],
      holds: [],
      executionIds: [],
      history: []
    };
    if (!TASK_STATUSES.includes(task.status)) {
      throw new AppError('INPUT_REQUIRED', 'initial task status is invalid');
    }
    if (task.status !== 'queued') {
      throw new AppError('INPUT_REQUIRED', 'new tasks must start in queued');
    }
    if (jsonByteLength(task) > 256 * 1024) {
      throw new AppError('INPUT_REQUIRED', 'task input is too large');
    }
    tx.state.tasks[id] = task;
    if (task.parentTaskId) {
      const parent = tx.state.tasks[task.parentTaskId];
      if (!parent) throw new AppError('INPUT_REQUIRED', 'parent task does not exist');
      if (!parent.childTaskIds.includes(id)) parent.childTaskIds.push(id);
      this.recompute(tx, parent);
    }
    return task;
  }

  get(tx, taskId) {
    const task = tx.state.tasks[taskId];
    if (!task) throw new AppError('FORBIDDEN', 'task not found');
    return task;
  }

  assertTransition(task, to, options = {}, state = null) {
    if (!TASK_STATUSES.includes(to)) {
      throw new AppError('INPUT_REQUIRED', `unknown task status: ${to}`);
    }
    if (task.status === to) return;
    const allowed = TASK_TRANSITIONS[task.status] || [];
    if (!allowed.includes(to)) {
      throw new AppError('INPUT_REQUIRED', `illegal task transition ${task.status} -> ${to}`, {
        details: { taskId: task.id, from: task.status, to }
      });
    }
    if (to === 'cancelled' && task.status === 'running') {
      // Never trust a caller-provided "proven undispatched" claim alone: the
      // ledger itself must show no dispatched Operation for this task.
      if (state && hasDispatchedOperation(state, task)) {
        throw new AppError('OPERATION_UNKNOWN', 'cannot cancel a task with a dispatched operation', {
          details: { taskId: task.id }
        });
      }
      if (options.provenUndispatched !== true) {
        throw new AppError('OPERATION_UNKNOWN', 'cannot cancel a dispatched task without verified side-effect state');
      }
    }
    if (task.status === 'waiting_approval' && to === 'running' && options.approved !== true) {
      throw new AppError('APPROVAL_REQUIRED', 'waiting_approval tasks need an approved challenge');
    }
    if (task.status === 'awaiting_manual' && to === 'succeeded' && options.manualReceipt !== true) {
      throw new AppError('FORBIDDEN', 'awaiting_manual tasks need a verified manual receipt');
    }
    if (['unknown'].includes(task.status) && options.verified !== true) {
      throw new AppError('OPERATION_UNKNOWN', 'unknown task state can only change after verification');
    }
    if (['partial', 'failed'].includes(task.status) && options.manual !== true && options.verified !== true) {
      throw new AppError('FORBIDDEN', 'partial/failed tasks can only be re-opened by human recovery');
    }
    if (to === 'succeeded' && (task.pendingOperationIds || []).length > 0 && options.allowPending !== true) {
      throw new AppError('OPERATION_UNKNOWN', 'task still has pending operations');
    }
    if (to === 'succeeded' && (task.holds || []).some((hold) => hold.status !== 'released')) {
      throw new AppError('RECOVERY_GAP', 'task still has an active recovery/migration hold');
    }
    if (to === 'cancelled' && (task.pendingOperationIds || []).length > 0) {
      throw new AppError('OPERATION_UNKNOWN', 'task still has pending operations and cannot be cancelled safely');
    }
  }

  transition(tx, taskOrId, to, options = {}) {
    const task = typeof taskOrId === 'string' ? this.get(tx, taskOrId) : taskOrId;
    this.assertTransition(task, to, options, tx?.state || null);
    const now = nowIso(this.now);
    const previous = task.status;
    if (previous !== to) {
      task.status = to;
      task.history.push({ from: previous, to, at: now, reason: options.reason || null, actor: options.actor || null });
      if (task.history.length > 100) task.history.shift();
    }
    if (to === 'running') {
      task.startedAt = task.startedAt || now;
      task.executionActive = options.executionActive === true;
    }
    if (to === 'waiting_approval' || to === 'awaiting_manual' || to === 'interrupted') {
      task.executionActive = false;
    }
    if (to === 'unknown') {
      task.executionActive = false;
      task.finishedAt = null;
    }
    if (to === 'succeeded' || to === 'cancelled') {
      task.executionActive = false;
      task.finishedAt = now;
    }
    if (to === 'failed' || to === 'partial') {
      task.executionActive = false;
    }
    if (options.result !== undefined) task.result = deepClone(options.result);
    if (options.error !== undefined) task.error = deepClone(options.error);
    this.recompute(tx, task);
    return task;
  }

  recompute(tx, taskOrId) {
    const task = typeof taskOrId === 'string' ? this.get(tx, taskOrId) : taskOrId;
    const operations = (task.operationIds || [])
      .map((id) => tx.state.operations[id])
      .filter(Boolean);
    const pendingIds = task.pendingOperationIds || [];
    const pending = pendingIds.map((id) => tx.state.operations[id]).filter(Boolean);
    const activeHolds = (task.holds || []).filter((hold) => hold.status !== 'released');
    const pendingApprovals = Object.values(tx.state.approvals || {}).filter(
      (approval) => approval.taskId === task.id && !approval.decidedAt && !approval.supersededAt
    );
    const hasUnknown = operations.some((operation) => operation.status === 'unknown');
    // `hasUnknownOperation` is a durable aggregate used by parent aggregation.
    // It only follows operations still listed as pending on this task.
    const hasUnknownOperation = pending.some(
      (operation) => operation.status === 'unknown' || operation.status === 'dispatching'
    );
    const hasDispatched = operations.some((operation) => operation.dispatchAt);
    const noPending = pendingIds.length === 0;
    const settledable =
      noPending && !hasUnknown && activeHolds.length === 0 && pendingApprovals.length === 0;
    switch (task.status) {
      case 'queued':
      case 'waiting_approval':
      case 'awaiting_manual':
      case 'interrupted':
        task.isSettled = false;
        task.executionActive = false;
        task.finishedAt = null;
        break;
      case 'running':
        task.isSettled = false;
        task.finishedAt = null;
        break;
      case 'unknown':
        task.isSettled = false;
        task.executionActive = false;
        task.finishedAt = null;
        break;
      case 'succeeded':
        task.isSettled = settledable;
        if (!task.isSettled) task.finishedAt = null;
        else task.finishedAt = task.finishedAt || nowIso(this.now);
        break;
      case 'cancelled':
        task.isSettled = noPending && !hasUnknown;
        if (!task.isSettled) task.finishedAt = null;
        else task.finishedAt = task.finishedAt || nowIso(this.now);
        break;
      case 'partial':
      case 'failed':
        task.isSettled = settledable;
        if (!task.isSettled) task.finishedAt = null;
        else task.finishedAt = task.finishedAt || nowIso(this.now);
        break;
      default:
        task.isSettled = false;
    }
    task.hasUnknownOperation = hasUnknownOperation;
    task.hasDispatchedOperation = hasDispatched;
    if (task.parentTaskId) {
      const parent = tx.state.tasks[task.parentTaskId];
      if (parent) this.recomputeParent(tx, parent);
    }
    return task;
  }

  recomputeParent(tx, parent) {
    const children = (parent.childTaskIds || []).map((id) => tx.state.tasks[id]).filter(Boolean);
    if (children.length === 0) return parent;
    const unsettled = children.filter((child) => !child.isSettled);
    const unknown = children.filter((child) => child.status === 'unknown' || child.hasUnknownOperation);
    const failed = children.filter((child) => ['failed', 'partial'].includes(child.status));
    const succeeded = children.filter((child) => child.status === 'succeeded' && child.isSettled);
    if (parent.result?.unresolvedTaskIds) parent.result.unresolvedTaskIds = unsettled.map((child) => child.id);
    if (parent.executionActive) {
      parent.isSettled = false;
      parent.finishedAt = null;
      return parent;
    }
    if (unsettled.length > 0) {
      parent.isSettled = false;
      parent.finishedAt = null;
      if (['succeeded', 'cancelled'].includes(parent.status)) {
        parent.status = unknown.length ? 'unknown' : 'running';
      }
    } else if (unknown.length > 0) {
      parent.isSettled = false;
      parent.finishedAt = null;
      if (!['unknown'].includes(parent.status)) parent.status = 'unknown';
    } else if (failed.length > 0) {
      // A settled failed/partial child never downgrades a browse round to
      // `failed`: completed work stays visible as `partial` (M07). Late child
      // failures after the parent already settled follow the same rule.
      parent.isSettled = true;
      parent.status = parent.kind === 'browse' || succeeded.length > 0 ? 'partial' : 'failed';
      parent.finishedAt = parent.finishedAt || nowIso(this.now);
    } else if (
      succeeded.length === children.length &&
      (parent.status === 'running' ||
        (parent.kind === 'browse' &&
          parent.status === 'partial' &&
          parent.result?.interactions &&
          !parent.result.interactions.skipped.length &&
          !parent.result.failed?.length))
    ) {
      parent.isSettled = true;
      parent.status = 'succeeded';
      parent.finishedAt = parent.finishedAt || nowIso(this.now);
    }
    return parent;
  }

  addOperation(tx, task, operation) {
    if (!task.operationIds.includes(operation.id)) task.operationIds.push(operation.id);
    if (!['confirmed', 'failed', 'not_sent', 'cancelled'].includes(operation.status)) {
      if (!task.pendingOperationIds.includes(operation.id)) task.pendingOperationIds.push(operation.id);
    } else {
      task.pendingOperationIds = task.pendingOperationIds.filter((id) => id !== operation.id);
    }
    this.recompute(tx, task);
  }

  settleOperation(tx, operation) {
    for (const taskId of operation.taskIds || []) {
      const task = tx.state.tasks[taskId];
      if (!task) continue;
      task.pendingOperationIds = (task.pendingOperationIds || []).filter((id) => id !== operation.id);
      this.recompute(tx, task);
    }
  }

  requestCancel(tx, taskOrId, { reason = null, actor = null } = {}) {
    const task = typeof taskOrId === 'string' ? this.get(tx, taskOrId) : taskOrId;
    if (['succeeded', 'cancelled'].includes(task.status)) {
      throw new AppError('FORBIDDEN', 'task is already terminal');
    }
    task.cancelRequestedAt = task.cancelRequestedAt || nowIso(this.now);
    task.cancelReason = reason;
    task.history.push({ from: task.status, to: task.status, at: nowIso(this.now), reason: 'cancel_requested', actor });
    return task;
  }

  /**
   * Revise a task's input under a new revision. Any undecided approval for the
   * old input is superseded so it can never authorize the revised input
   * (SPEC §21.1/§22.2, FIX_PLAN I3).
   */
  reviseInput(tx, taskOrId, changes = {}, options = {}) {
    const task = typeof taskOrId === 'string' ? this.get(tx, taskOrId) : taskOrId;
    if (TERMINAL_SETTLED.has(task.status)) {
      throw new AppError('FORBIDDEN', 'terminal task input cannot be revised');
    }
    if (!changes || typeof changes !== 'object') {
      throw new AppError('INPUT_REQUIRED', 'revised input payload is required');
    }
    const nextInputHash = changes.inputHash !== undefined ? changes.inputHash : task.inputHash;
    if (typeof nextInputHash !== 'string' || nextInputHash === '') {
      throw new AppError('INPUT_REQUIRED', 'revised task inputHash is required');
    }
    task.input = changes.input !== undefined ? deepClone(changes.input) : task.input;
    task.inputHash = nextInputHash;
    task.revision = (task.revision || 1) + 1;
    const superseded = [];
    for (const [approvalId, approval] of Object.entries(tx.state.approvals || {})) {
      if (approval.taskId !== task.id || approval.decidedAt || approval.supersededAt) continue;
      approval.supersededAt = nowIso(this.now);
      approval.supersededByRevision = task.revision;
      superseded.push(approvalId);
    }
    tx.appendEvent({
      type: 'task.input.revised',
      actor: options.actor || 'system',
      taskId: task.id,
      payload: {
        revision: task.revision,
        inputHash: task.inputHash,
        supersededApprovals: superseded
      }
    });
    this.recompute(tx, task);
    return task;
  }

  resume(tx, taskOrId, options = {}) {
    const task = typeof taskOrId === 'string' ? this.get(tx, taskOrId) : taskOrId;
    if (!['interrupted', 'unknown', 'failed', 'partial', 'waiting_approval'].includes(task.status)) {
      throw new AppError('FORBIDDEN', `task status ${task.status} cannot be resumed`);
    }
    if (task.status === 'waiting_approval' && options.approved !== true) {
      throw new AppError('APPROVAL_REQUIRED', 'approval is required before resuming');
    }
    if (task.status === 'unknown' && options.verified !== true) {
      throw new AppError('OPERATION_UNKNOWN', 'unknown task must be verified before resuming');
    }
    if (['failed', 'partial'].includes(task.status) && options.manual !== true) {
      throw new AppError('FORBIDDEN', 'failed/partial tasks require explicit human resume');
    }
    const activeHolds = (task.holds || []).filter((hold) => hold.status !== 'released');
    if (activeHolds.length > 0 && options.ignoreHolds !== true) {
      throw new AppError('RECOVERY_GAP', 'task has an active recovery/migration hold');
    }
    this.transition(tx, task, 'running', {
      ...options,
      manual: true,
      verified: true,
      approved: options.approved !== false,
      executionActive: false
    });
    // A resumed task is a new input revision: stale approvals can no longer
    // authorize it and the previous finishedAt must not survive (I3).
    task.revision = (task.revision || 1) + 1;
    task.finishedAt = null;
    task.attempts += 1;
    task.cancelRequestedAt = null;
    this.recompute(tx, task);
    return task;
  }

  addHold(tx, taskOrId, hold) {
    const task = typeof taskOrId === 'string' ? this.get(tx, taskOrId) : taskOrId;
    const normalized = {
      id: hold.id || randomId('hold'),
      kind: hold.kind,
      caseId: hold.caseId ?? null,
      scope: deepClone(hold.scope),
      scopeKey: hold.scopeKey,
      revision: hold.revision ?? 1,
      status: hold.status || 'active',
      evidenceRefs: hold.evidenceRefs || [],
      createdAt: hold.createdAt || nowIso(this.now),
      releasedAt: hold.releasedAt || null,
      releaseDecisionRef: hold.releaseDecisionRef || null
    };
    const existing = task.holds.find((entry) => entry.id === normalized.id);
    if (existing) Object.assign(existing, normalized);
    else task.holds.push(normalized);
    this.recompute(tx, task);
    return normalized;
  }

  releaseHold(tx, taskOrId, holdId, decisionRef) {
    const task = typeof taskOrId === 'string' ? this.get(tx, taskOrId) : taskOrId;
    const hold = task.holds.find((entry) => entry.id === holdId);
    if (!hold) throw new AppError('RECOVERY_GAP', 'hold not found on task');
    hold.status = 'released';
    hold.releasedAt = nowIso(this.now);
    hold.releaseDecisionRef = decisionRef || null;
    this.recompute(tx, task);
    return hold;
  }

  /** Human resume must verify the previous execution is genuinely stopped. */
  registerExecution(tx, task, execution) {
    task.executionIds.push(execution.executionId);
    task.executionActive = execution.status === 'accepted' || execution.status === 'running' || execution.status === 'cancel_requested';
    if (task.executionActive) task.executionActive = true;
    this.recompute(tx, task);
    return execution;
  }

  assertSettledCombination(task) {
    return validateTaskCombination(task);
  }
}

/** Operations linked to a task either directly or through their taskIds list. */
function linkedOperations(state, task) {
  const operations = state?.operations || {};
  const direct = (task.operationIds || []).map((id) => operations[id]).filter(Boolean);
  const known = new Set(direct.map((operation) => operation.id));
  const indirect = Object.values(operations).filter(
    (operation) => !known.has(operation.id) && (operation.taskIds || []).includes(task.id)
  );
  return [...direct, ...indirect];
}

function hasDispatchedOperation(state, task) {
  return linkedOperations(state, task).some((operation) => Boolean(operation.dispatchAt));
}

export default TaskManager;
