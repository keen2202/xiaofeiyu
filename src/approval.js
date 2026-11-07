import { AppError } from './errors.js';
import { deepClone, jcsHash, nowIso, randomId, randomToken, sha256Hex } from './utils.js';

export const APPROVAL_ACTIONS = Object.freeze([
  'comment.send',
  'dm.send',
  'production.run',
  'publish.prepare',
  'publish.external',
  'publish.complete',
  'operation.resolve',
  'outbox.resolve',
  'artifact.import',
  'backup.create',
  'migration.prepare',
  'migration.export',
  'migration.release',
  'migration.activate',
  'recovery.reconcile',
  'recovery.authorize',
  'config.update',
  'im.bind',
  'im.revoke'
]);

export class ApprovalService {
  constructor({
    store,
    taskManager,
    identity,
    humanProof,
    now = () => new Date(),
    defaultTtlSec = 600
  } = {}) {
    this.store = store;
    this.taskManager = taskManager;
    this.identity = identity;
    this.humanProof = humanProof;
    this.now = now;
    this.defaultTtlSec = defaultTtlSec;
  }

  create(tx, { task, action, inputHash, principalId, ttlSec = this.defaultTtlSec, source = 'local' }) {
    if (!APPROVAL_ACTIONS.includes(action)) {
      throw new AppError('CAPABILITY_UNSUPPORTED', `approval action ${action} is not supported`);
    }
    if (!task || task.status !== 'waiting_approval') {
      throw new AppError('APPROVAL_REQUIRED', 'approval can only be created for waiting_approval tasks');
    }
    if (task.inputHash !== inputHash) {
      throw new AppError('APPROVAL_STALE', 'approval input hash does not match task');
    }
    if (!Number.isSafeInteger(ttlSec) || ttlSec < 60 || ttlSec > 3600) {
      throw new AppError('CONFIG_INVALID', 'approval TTL must be 60..3600 seconds');
    }
    for (const existing of Object.values(tx.state.approvals)) {
      if (
        existing.taskId === task.id &&
        existing.action === action &&
        !existing.decidedAt &&
        !existing.supersededAt
      ) {
        existing.supersededAt = nowIso(this.now);
      }
    }
    const nonce = randomToken(32);
    const approval = {
      id: randomId('approval'),
      taskId: task.id,
      action,
      inputHash,
      taskRevision: task.revision,
      principalId,
      nonceHash: sha256Hex(nonce),
      expiresAt: new Date(this.now().getTime() + ttlSec * 1000).toISOString(),
      decision: 'pending',
      decidedAt: null,
      decidedBy: null,
      source,
      createdAt: nowIso(this.now),
      supersededAt: null,
      usedByOperationId: null
    };
    tx.state.approvals[approval.id] = approval;
    tx.appendEvent({
      type: 'approval.created',
      actor: source,
      taskId: task.id,
      payload: { approvalId: approval.id, action, inputHash, expiresAt: approval.expiresAt }
    });
    return { approval: deepClone(approval), nonce, expiresAt: approval.expiresAt };
  }

  get(tx, approvalId) {
    const approval = tx.state.approvals[approvalId];
    if (!approval) throw new AppError('APPROVAL_STALE', 'approval not found');
    return approval;
  }

  async decide({ approvalId, decision, nonce, mode = 'go' }, humanContext) {
    if (!['approve', 'reject'].includes(decision)) {
      throw new AppError('CONFIG_INVALID', 'decision must be approve or reject');
    }
    if (!['dry', 'go'].includes(mode)) throw new AppError('CONFIG_INVALID', 'mode must be dry or go');
    const state = await this.store.getSnapshot();
    const approval = state.approvals[approvalId];
    if (!approval) throw new AppError('APPROVAL_STALE', 'approval not found');
    const task = state.tasks[approval.taskId];
    if (!task) throw new AppError('APPROVAL_STALE', 'approval task not found');

    if (mode === 'dry') {
      this._assertChallengeCurrent(approval, task);
      return {
        dryRun: true,
        executionMode: 'dry',
        approval: deepClone(approval),
        task: deepClone(task),
        consumed: false
      };
    }

    if (!nonce || typeof nonce !== 'string') {
      throw new AppError('APPROVAL_STALE', 'approval nonce is required');
    }
    if (humanContext?.principal?.id !== approval.principalId) {
      throw new AppError('FORBIDDEN', 'human principal does not match approval principal');
    }
    if (this.humanProof) {
      await this.humanProof.assert(humanContext, {
        approvalId: approval.id,
        taskId: approval.taskId,
        action: approval.action,
        inputHash: approval.inputHash,
        taskRevision: approval.taskRevision,
        bindingHash: jcsHash({ approvalId: approval.id, inputHash: approval.inputHash })
      });
    }

    return this.store.transaction(async (draft, tx) => {
      const principal = draft.principals[humanContext.principal.id];
      if (!principal || principal.revokedAt) {
        throw new AppError('FORBIDDEN', 'approving principal is no longer active');
      }
      const current = draft.approvals[approvalId];
      if (!current) throw new AppError('APPROVAL_STALE', 'approval disappeared');
      if (current.decidedAt) {
        if (current.decision === decision) {
          return { approval: deepClone(current), task: deepClone(draft.tasks[current.taskId]), deduplicated: true };
        }
        throw new AppError('APPROVAL_STALE', 'approval already decided differently');
      }
      if (current.supersededAt) throw new AppError('APPROVAL_STALE', 'approval was superseded');
      this._assertChallengeCurrent(current, draft.tasks[current.taskId], nonce);
      if (current.taskRevision !== draft.tasks[current.taskId]?.revision) {
        throw new AppError('APPROVAL_STALE', 'task revision changed');
      }
      if (current.inputHash !== draft.tasks[current.taskId]?.inputHash) {
        throw new AppError('APPROVAL_STALE', 'task input changed');
      }
      const task = draft.tasks[current.taskId];
      current.decision = decision;
      current.decidedAt = nowIso(this.now);
      current.decidedBy = humanContext.principal.id;
      current.nonceHash = null;
      if (decision === 'approve') {
        this.taskManager.transition(tx, task, 'running', {
          approved: true,
          actor: humanContext.principal.id,
          reason: 'approval approved'
        });
      } else {
        this.taskManager.transition(tx, task, 'failed', {
          actor: humanContext.principal.id,
          reason: 'approval rejected',
          error: { code: 'FORBIDDEN', message: 'approval rejected' }
        });
      }
      tx.appendEvent({
        type: decision === 'approve' ? 'approval.approved' : 'approval.rejected',
        actor: humanContext.principal.id,
        taskId: task.id,
        payload: { approvalId: current.id, action: current.action, inputHash: current.inputHash }
      });
      return { approval: deepClone(current), task: deepClone(task), deduplicated: false };
    });
  }

  _assertChallengeCurrent(approval, task, nonce = null) {
    if (!task) throw new AppError('APPROVAL_STALE', 'approval task not found');
    if (approval.supersededAt) throw new AppError('APPROVAL_STALE', 'approval was superseded');
    if (approval.decidedAt && approval.decision !== 'pending') {
      throw new AppError('APPROVAL_STALE', 'approval is already decided');
    }
    if (Date.parse(approval.expiresAt) <= this.now().getTime()) {
      throw new AppError('APPROVAL_STALE', 'approval has expired');
    }
    if (task.revision !== approval.taskRevision) {
      throw new AppError('APPROVAL_STALE', 'task revision changed');
    }
    if (task.inputHash !== approval.inputHash) {
      throw new AppError('APPROVAL_STALE', 'task input changed');
    }
    if (nonce !== null) {
      if (typeof approval.nonceHash !== 'string' || approval.nonceHash.length === 0) {
        throw new AppError('APPROVAL_STALE', 'approval nonce was already consumed');
      }
      if (sha256Hex(nonce) !== approval.nonceHash) {
        throw new AppError('APPROVAL_STALE', 'approval nonce is invalid');
      }
    }
    return true;
  }

  /** Check an approved decision before an operation is dispatched. */
  assertApproved(state, { taskId, action, inputHash, operationId = null }) {
    const candidates = Object.values(state.approvals).filter(
      (approval) =>
        approval.taskId === taskId &&
        approval.action === action &&
        approval.decision === 'approve' &&
        approval.decidedAt
    );
    const approval = candidates.sort((a, b) => String(b.decidedAt).localeCompare(String(a.decidedAt)))[0];
    if (!approval) throw new AppError('APPROVAL_REQUIRED', 'no approved challenge for this action');
    if (approval.inputHash !== inputHash) throw new AppError('APPROVAL_STALE', 'approval input no longer matches');
    if (Date.parse(approval.expiresAt) <= this.now().getTime()) {
      throw new AppError('APPROVAL_STALE', 'approval decision has expired');
    }
    if (approval.usedByOperationId && approval.usedByOperationId !== operationId) {
      throw new AppError('APPROVAL_STALE', 'approval was already consumed by another operation');
    }
    return approval;
  }

  consume(tx, approval, operationId) {
    const current = tx.state.approvals[approval.id];
    if (!current) throw new AppError('APPROVAL_STALE', 'approval disappeared');
    if (current.usedByOperationId && current.usedByOperationId !== operationId) {
      throw new AppError('APPROVAL_STALE', 'approval was consumed by another operation');
    }
    current.usedByOperationId = operationId;
    current.usedAt = nowIso(this.now);
    return current;
  }

  async listForTask(taskId) {
    const state = await this.store.getSnapshot();
    return Object.values(state.approvals)
      .filter((approval) => approval.taskId === taskId)
      .map((approval) => {
        const copy = deepClone(approval);
        delete copy.nonceHash;
        return copy;
      });
  }
}

export default ApprovalService;
