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

  assertTransition(task, to, options = {}) {
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
    if (to === 'cancelled' && task.status === 'running' && options.provenUndispatched !== true) {
      throw new AppError('OPERATION_UNKNOWN', 'cannot cancel a dispatched task without verified side-effect state');
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
    this.assertTransition(task, to, options);
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
    const pending = (task.pendingOperationIds || []).filter((id) => tx.state.operations[id]);
    const activeHolds = (task.holds || []).filter((hold) => hold.status !== 'released');
    const pendingApprovals = Object.values(tx.state.approvals || {}).filter(
      (approval) => approval.taskId === task.id && !approval.decidedAt
    );
    const hasUnknown = operations.some((operation) => operation.status === 'unknown') || pending.some((id) => tx.state.operations[id]?.status === 'unknown');
    const hasDispatched = operations.some((operation) => operation.dispatchAt);
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
        break;
      case 'unknown':
        task.isSettled = false;
        task.executionActive = false;
        task.finishedAt = null;
        break;
      case 'succeeded':
        task.isSettled = pending.length === 0 && !hasUnknown && activeHolds.length === 0;
        if (!task.isSettled) task.finishedAt = null;
        break;
      case 'cancelled':
        task.isSettled = !hasUnknown && pending.length === 0;
        if (!task.isSettled) task.finishedAt = null;
        break;
      case 'partial':
      case 'failed':
        task.isSettled =
          pending.length === 0 &&
          !hasUnknown &&
          activeHolds.length === 0 &&
          pendingApprovals.length === 0;
        if (!task.isSettled) task.finishedAt = null;
        else task.finishedAt = task.finishedAt || nowIso(this.now);
        break;
      default:
        task.isSettled = false;
    }
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
    } else if (failed.length > 0 && succeeded.length > 0) {
      parent.isSettled = true;
      parent.status = 'partial';
      parent.finishedAt = parent.finishedAt || nowIso(this.now);
    } else if (failed.length > 0) {
      parent.isSettled = true;
      parent.status = 'failed';
      parent.finishedAt = parent.finishedAt || nowIso(this.now);
    } else if (succeeded.length === children.length && parent.status === 'running') {
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
    task.attempts += 1;
    task.cancelRequestedAt = null;
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
    const valid = {
      succeeded: () => task.isSettled === true && task.executionActive === false,
      cancelled: () => task.isSettled === true && task.executionActive === false,
      unknown: () => task.isSettled === false && task.executionActive === false && task.finishedAt === null,
      queued: () => task.isSettled === false && task.executionActive === false,
      waiting_approval: () => task.isSettled === false && task.executionActive === false,
      awaiting_manual: () => task.isSettled === false && task.executionActive === false,
      interrupted: () => task.isSettled === false && task.executionActive === false,
      running: () => task.isSettled === false
    };
    const check = valid[task.status];
    if (check && !check()) {
      throw new AppError('STORE_CORRUPTED', `invalid task field combination for ${task.status}`, {
        details: { taskId: task.id, isSettled: task.isSettled, executionActive: task.executionActive }
      });
    }
    return true;
  }
}

export default TaskManager;
