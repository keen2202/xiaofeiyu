import { AppError } from './errors.js';
import {
  buildRequestKey,
  computeInputHash,
  normalizeRequestEnvelope
} from './contracts.js';
import { deepClone, isSafeRelativePath, nowIso, truncateText } from './utils.js';

const OWNER_ONLY_ACTIONS = new Set([
  'config.update',
  'artifact.import',
  'publish.complete',
  'publish.resolve',
  'operation.resolve',
  'outbox.resolve',
  'im.bind',
  'im.revoke',
  'migration.prepare',
  'migration.export',
  'migration.release',
  'migration.import',
  'migration.validate',
  'migration.activate',
  'migration.abort',
  'migration.disable-target',
  'migration.rollback',
  'backup.create',
  'backup.verify',
  'backup.prune',
  'recovery.restore',
  'recovery.reconcile',
  'recovery.authorize',
  'account.verify'
]);

const READ_ONLY_ACTIONS = new Set(['status.get', 'task.get', 'task.list']);

const IM_ACTIONS = new Set([
  'production.create',
  'task.get',
  'task.list',
  'task.cancel',
  'task.resume',
  'approval.decide',
  'comment.draft'
]);

export class CommandService {
  constructor({
    store,
    taskManager,
    identity,
    configService,
    approvalService,
    effectGateway = null,
    services = {},
    now = () => new Date(),
    logger
  } = {}) {
    this.store = store;
    this.taskManager = taskManager;
    this.identity = identity;
    this.configService = configService;
    this.approvalService = approvalService;
    this.effectGateway = effectGateway;
    this.services = services;
    this.now = now;
    this.logger = logger;
    this._locks = new Map();
  }

  async execute(envelope, principal, { sourceKind = 'http', humanContext = null, trusted = false } = {}) {
    if (!trusted) throw new AppError('TRUST_UNAVAILABLE', 'request context is not trusted');
    const request = normalizeRequestEnvelope(envelope);
    const state = await this.store.getSnapshot();
    if (!principal || principal.revokedAt) throw new AppError('FORBIDDEN', 'principal is missing or revoked');
    if (principal.workspaceId && principal.workspaceId !== state.workspaceId) {
      throw new AppError('FORBIDDEN', 'principal belongs to another workspace');
    }
    const requestKey = buildRequestKey({
      workspaceId: state.workspaceId,
      principalId: principal.id,
      action: request.action,
      requestId: request.requestId
    });
    const requestHash = computeInputHash({ action: request.action, input: request.input, metadata: { mode: request.mode } });
    if (READ_ONLY_ACTIONS.has(request.action)) {
      this._authorize(request, principal, state, sourceKind);
      const outcome = await this._dispatch(request, principal, { sourceKind, humanContext });
      return {
        accepted: true,
        deduplicated: false,
        taskId: outcome?.task?.id || null,
        status: outcome?.task?.status || 'accepted',
        executionMode: 'dry',
        result: outcome?.result ?? null
      };
    }
    return this._withLock(requestKey, async () => {
      const fresh = await this.store.getSnapshot();
      const existing = fresh.requests[requestKey];
      if (existing) {
        if (existing.inputHash !== requestHash) {
          throw new AppError('IDEMPOTENCY_CONFLICT', 'requestId was reused with different input');
        }
        if (existing.status === 'pending') {
          throw new AppError('DUPLICATE_OPERATION', 'the same request is still being processed', {
            retryable: true,
            details: { requestKey }
          });
        }
        if (existing.status === 'failed') {
          throw new AppError(existing.error?.code || 'DEPENDENCY_UNAVAILABLE', existing.error?.message || 'request failed', {
            details: { requestKey, replayed: true }
          });
        }
        return {
          accepted: true,
          deduplicated: true,
          taskId: existing.taskId || null,
          status: existing.taskStatus || existing.status,
          executionMode: existing.executionMode || 'go',
          result: deepClone(existing.result || null)
        };
      }
      await this.store.transaction(async (draft, tx) => {
        if (draft.requests[requestKey]) {
          throw new AppError('DUPLICATE_OPERATION', 'concurrent request reservation exists', { retryable: true });
        }
        draft.requests[requestKey] = {
          requestKey,
          workspaceId: draft.workspaceId,
          principalId: principal.id,
          action: request.action,
          requestId: request.requestId,
          inputHash: requestHash,
          status: 'pending',
          taskId: null,
          taskStatus: null,
          executionMode: request.mode,
          result: null,
          error: null,
          createdAt: nowIso(this.now),
          updatedAt: nowIso(this.now)
        };
        tx.appendEvent({
          type: 'request.accepted',
          actor: principal.id,
          payload: { requestKey, action: request.action, requestId: request.requestId }
        });
      });
      try {
        this._authorize(request, principal, state, sourceKind);
        const outcome = await this._dispatch(request, principal, { sourceKind, humanContext });
        const taskId = outcome?.task?.id || outcome?.taskId || null;
        const taskStatus = outcome?.task?.status || null;
        const summary = this._summarize(outcome);
        await this.store.transaction(async (draft) => {
          const record = draft.requests[requestKey];
          if (!record) return;
          record.status = 'accepted';
          record.taskId = taskId;
          record.taskStatus = taskStatus;
          record.executionMode = outcome?.executionMode || request.mode;
          record.result = summary;
          record.updatedAt = nowIso(this.now);
        });
        return {
          accepted: true,
          deduplicated: false,
          taskId,
          status: taskStatus || 'accepted',
          executionMode: outcome?.executionMode || request.mode,
          result: deepClone(outcome?.result || summary),
          ...(outcome?.approval ? { approval: deepClone(outcome.approval) } : {}),
          ...(outcome?.nonce ? { nonce: outcome.nonce } : {}),
          ...(outcome?.expiresAt ? { expiresAt: outcome.expiresAt } : {})
        };
      } catch (error) {
        await this.store.transaction(async (draft) => {
          const record = draft.requests[requestKey];
          if (!record) return;
          record.status = 'failed';
          record.error = {
            code: error.code || 'DEPENDENCY_UNAVAILABLE',
            message: truncateText(error.message || String(error), 500)
          };
          record.updatedAt = nowIso(this.now);
        }).catch(() => {});
        throw error;
      }
    });
  }

  _authorize(request, principal, state, sourceKind) {
    if (OWNER_ONLY_ACTIONS.has(request.action)) {
      if (principal.kind !== 'human' || principal.role !== 'owner' || !principal.scopes?.includes('*')) {
        throw new AppError('FORBIDDEN', 'local owner is required for this action');
      }
      return true;
    }
    if (sourceKind === 'im' && !IM_ACTIONS.has(request.action)) {
      throw new AppError('FORBIDDEN', 'action is not available over IM');
    }
    const scope = {
      'browse.run': 'browse.run',
      'diary.generate': 'diary.generate.own',
      'comment.draft': 'comment.draft',
      'comment.send': 'comment.draft',
      'dm.send': 'dm.send',
      'production.create': 'production.create',
      'production.run': 'production.create',
      'publish.create': 'publish.create',
      'publish.prepare': 'publish.create',
      'approval.decide': 'approval.decide.own',
      'task.get': 'task.read.own',
      'task.list': 'task.read.own',
      'task.cancel': 'task.cancel.own',
      'task.resume': 'task.resume.own',
      'status.get': 'config.read'
    }[request.action];
    if (scope) {
      if (principal.kind === 'human' && principal.role === 'owner' && principal.scopes?.includes('*')) return true;
      this.identity.authorize(principal, scope);
    }
    return true;
  }

  async _dispatch(request, principal, { sourceKind, humanContext }) {
    switch (request.action) {
      case 'status.get':
        return { executionMode: 'dry', result: await this.status(principal) };
      case 'browse.run': {
        const browse = this.services.browse;
        if (!browse) throw new AppError('CAPABILITY_UNSUPPORTED', 'browse service is unavailable');
        const task = await browse.createTask({ principal, trigger: sourceKind === 'im' ? 'im' : 'manual', input: request.input });
        const outcome = await browse.run({ taskId: task.id, principal });
        return { ...outcome, executionMode: 'go' };
      }
      case 'diary.generate': {
        const diary = this.services.diary;
        if (!diary) throw new AppError('CAPABILITY_UNSUPPORTED', 'diary service is unavailable');
        const result = await diary.generate({
          date: request.input.date,
          scope: request.input.scope,
          book: request.input.book || null,
          force: request.input.force === true,
          principal
        });
        return { executionMode: 'go', result: { ...result, content: undefined } };
      }
      case 'comment.draft': {
        const comments = this.services.comments;
        if (!comments) throw new AppError('CAPABILITY_UNSUPPORTED', 'comments service is unavailable');
        const outcome = await comments.createDraft({
          candidate: request.input.candidate || {
            contentRef: request.input.contentRef,
            platformData: request.input.platformData,
            title: request.input.title,
            author: request.input.author
          },
          text: request.input.text,
          root: request.input.root || 0,
          parent: request.input.parent || 0,
          principal,
          trigger: sourceKind === 'im' ? 'im' : 'manual'
        });
        return { ...outcome, executionMode: 'dry' };
      }
      case 'comment.send': {
        const comments = this.services.comments;
        if (!comments) throw new AppError('CAPABILITY_UNSUPPORTED', 'comments service is unavailable');
        const outcome = await comments.send({ taskId: request.input.taskId, mode: request.mode, principal });
        return { ...outcome };
      }
      case 'dm.send': {
        const dm = this.services.directMessages;
        if (!dm) throw new AppError('CAPABILITY_UNSUPPORTED', 'DM service is unavailable');
        const outcome = await dm.send({
          content: request.input.content || null,
          recipientMid: request.input.recipientMid,
          text: request.input.text,
          mode: request.mode,
          principal,
          trigger: sourceKind
        });
        return { ...outcome };
      }
      case 'production.create': {
        const production = this.services.production;
        if (!production) throw new AppError('CAPABILITY_UNSUPPORTED', 'production service is unavailable');
        const outcome = await production.create(request.input, principal);
        return { ...outcome };
      }
      case 'production.run': {
        const production = this.services.production;
        if (!production) throw new AppError('CAPABILITY_UNSUPPORTED', 'production service is unavailable');
        return production.run({ taskId: request.input.taskId, mode: request.mode, principal });
      }
      case 'publish.create': {
        const publisher = this.services.publisher;
        if (!publisher) throw new AppError('CAPABILITY_UNSUPPORTED', 'publisher service is unavailable');
        return publisher.create({ ...request.input, mode: request.mode }, principal);
      }
      case 'publish.prepare': {
        const publisher = this.services.publisher;
        if (!publisher) throw new AppError('CAPABILITY_UNSUPPORTED', 'publisher service is unavailable');
        return publisher.prepare({ taskId: request.input.taskId, mode: request.mode, principal });
      }
      case 'approval.decide': {
        if (!humanContext) throw new AppError('TRUST_UNAVAILABLE', 'approval decisions require a trusted human context');
        return this.approvalService.decide(
          {
            approvalId: request.input.approvalId,
            decision: request.input.decision,
            nonce: request.input.nonce,
            mode: request.mode
          },
          humanContext
        );
      }
      case 'task.get': {
        const task = await this.getTask(request.input.taskId, principal);
        return { executionMode: 'dry', result: task };
      }
      case 'task.list': {
        const tasks = await this.listTasks(principal, { limit: request.input.limit });
        return { executionMode: 'dry', result: tasks };
      }
      case 'task.cancel': {
        const task = await this.cancelTask(request.input.taskId, principal);
        return { executionMode: 'dry', result: task };
      }
      case 'task.resume': {
        const task = await this.getTask(request.input.taskId, principal);
        const kindScope = {
          production: 'production.create',
          comment: 'comment.draft',
          dm: 'dm.send'
        }[task.kind];
        if (!kindScope) throw new AppError('CAPABILITY_UNSUPPORTED', `task kind ${task.kind} has no resume path`);
        this.identity.authorize(principal, kindScope);
        if (task.kind === 'production') {
          if (!this.services.production) throw new AppError('CAPABILITY_UNSUPPORTED', 'resume service is unavailable');
          return this.services.production.resume({
            taskId: task.id,
            mode: request.mode,
            principal
          });
        }
        if (task.kind === 'comment') {
          if (!this.services.comments) throw new AppError('CAPABILITY_UNSUPPORTED', 'comment service is unavailable');
          return this.services.comments.resume({ taskId: task.id, mode: request.mode, principal });
        }
        if (task.kind === 'dm') {
          if (!this.services.directMessages) throw new AppError('CAPABILITY_UNSUPPORTED', 'DM service is unavailable');
          return this.services.directMessages.resume({ taskId: task.id, mode: request.mode, principal });
        }
        throw new AppError('CAPABILITY_UNSUPPORTED', `task kind ${task.kind} has no resume path`);
      }
      case 'config.update': {
        if (!this.services.configService) throw new AppError('CAPABILITY_UNSUPPORTED', 'config service is unavailable');
        const result = await this.services.configService.update(request.input.patch, { source: 'http' });
        return { executionMode: 'dry', result };
      }
      default:
        throw new AppError('CAPABILITY_UNSUPPORTED', `action ${request.action} is not wired to an HTTP/host command`, {
          details: { action: request.action }
        });
    }
  }

  async listTasks(principal, { limit = 50 } = {}) {
    const state = await this.store.getSnapshot();
    const isOwner = principal.kind === 'human' && principal.role === 'owner' && principal.scopes?.includes('*');
    const tasks = Object.values(state.tasks)
      .filter((task) => isOwner || task.principalId === principal.id)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, Math.min(Math.max(limit, 1), 200))
      .map((task) => ({
        id: task.id,
        kind: task.kind,
        status: task.status,
        isSettled: task.isSettled,
        executionActive: task.executionActive,
        createdAt: task.createdAt,
        finishedAt: task.finishedAt,
        error: task.error ? { code: task.error.code } : null
      }));
    return { tasks, count: tasks.length };
  }

  async getTask(taskId, principal) {
    const state = await this.store.getSnapshot();
    const task = state.tasks[taskId];
    if (!task) throw new AppError('CAPABILITY_UNSUPPORTED', 'task not found', { details: { reason: 'task_not_found' } });
    const isOwner = principal.kind === 'human' && principal.role === 'owner' && principal.scopes?.includes('*');
    if (!isOwner && task.principalId !== principal.id) throw new AppError('FORBIDDEN', 'task belongs to another principal');
    return deepClone(task);
  }

  async cancelTask(taskId, principal) {
    const state = await this.store.getSnapshot();
    const task = state.tasks[taskId];
    if (!task) throw new AppError('CAPABILITY_UNSUPPORTED', 'task not found', { details: { reason: 'task_not_found' } });
    const isOwner = principal.kind === 'human' && principal.role === 'owner' && principal.scopes?.includes('*');
    if (!isOwner && task.principalId !== principal.id) throw new AppError('FORBIDDEN', 'task belongs to another principal');
    if (task.kind === 'production' && this.services.production) {
      return this.services.production.cancel({ taskId, principal });
    }
    return this.store.transaction(async (draft, tx) => {
      const current = draft.tasks[taskId];
      this.taskManager.requestCancel(tx, current, { reason: 'human cancel request', actor: principal.id });
      tx.appendEvent({ type: 'task.cancel.requested', actor: principal.id, taskId, payload: {} });
      return deepClone(current);
    });
  }

  async status(principal) {
    const state = await this.store.getSnapshot();
    const instance = await this.store.getInstance();
    const isOwner = principal?.kind === 'human' && principal.role === 'owner' && principal.scopes?.includes('*');
    const tasks = Object.values(state.tasks);
    return {
      workspaceId: state.workspaceId,
      historyEpoch: state.historyEpoch,
      instance: {
        status: instance.status,
        activationRevision: instance.activationRevision,
        capabilities: instance.allowedCapabilities
      },
      migration: { phase: state.migration.phase, id: state.migration.id },
      recovery: { phase: state.recovery.phase, revision: state.recovery.revision, holds: state.recovery.holds.length },
      counts: {
        tasks: isOwner ? tasks.length : tasks.filter((task) => task.principalId === principal?.id).length,
        unsettled: tasks.filter((task) => !task.isSettled).length,
        operations: Object.keys(state.operations).length,
        unknownOperations: Object.values(state.operations).filter((operation) => operation.status === 'unknown').length,
        journalPending: Object.keys(state.journalPending).length,
        artifacts: Object.keys(state.artifacts).length
      },
      accounts: Object.values(state.accounts).map((account) => ({
        accountRef: account.accountRef,
        uname: account.uname,
        credentialRevision: account.credentialRevision ? 'recorded' : null
      })),
      capabilities: 'declared/cached/unverified',
      loginProbe: false
    };
  }

  _summarize(outcome) {
    if (!outcome) return null;
    const summary = {
      executionMode: outcome.executionMode || null,
      taskId: outcome.task?.id || outcome.taskId || null,
      taskStatus: outcome.task?.status || null,
      dryRun: outcome.dryRun === true,
      readyForPublish: outcome.task?.result?.readyForPublish === true,
      awaitingManual: outcome.awaitingManual === true
    };
    if (outcome.operation) {
      summary.operationId = outcome.operation.id;
      summary.operationStatus = outcome.operation.status;
    }
    if (outcome.receipt) {
      summary.receipt = {
        externalId: outcome.receipt.externalId,
        verification: outcome.receipt.verification
      };
    }
    return summary;
  }

  async _withLock(key, fn) {
    const previous = this._locks.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => current);
    this._locks.set(key, chained);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this._locks.get(key) === chained) this._locks.delete(key);
    }
  }
}

export default CommandService;
