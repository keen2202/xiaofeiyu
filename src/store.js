import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from './errors.js';
import {
  atomicWriteJson,
  deepClone,
  ensureDir,
  getProcessStartMs,
  isPlainObject,
  isProcessAlive,
  jsonByteLength,
  nowIso,
  pathExists,
  processStartIso,
  randomId,
  randomToken,
  sleep
} from './utils.js';

export const DEFAULT_ALLOWED_CAPABILITIES = Object.freeze([
  'core:read',
  'core:write',
  'platform:bilibili',
  'production:local',
  'publish:manual',
  'publish:external',
  'im'
]);

export const RECOVERY_PHASES = Object.freeze([
  'normal',
  'readonly',
  'reconciling',
  'restricted',
  'released',
  'blocked'
]);

export const MIGRATION_PHASES = Object.freeze([
  'active',
  'quiescing',
  'sealed',
  'released',
  'aborted',
  'imported',
  'validated',
  'disabled'
]);

const REQUIRED_OBJECTS = [
  'accounts',
  'operations',
  'businessKeys',
  'requests',
  'tasks',
  'videos',
  'journalPending',
  'journalSegments',
  'cursors',
  'diaries',
  'rate',
  'publishes',
  'principals',
  'bindings',
  'approvals',
  'inboxKeys',
  'outbox',
  'artifacts',
  'artifactPendingImports',
  'productions',
  'executions',
  'budgets'
];

export function createInitialState({
  workspaceId,
  historyEpoch,
  configRevision,
  timeZone = 'Asia/Shanghai',
  now = () => new Date()
}) {
  const state = {
    version: 3,
    workspaceId,
    historyEpoch,
    configRevision: configRevision || { version: 0, sha256: '' },
    recovery: { id: null, phase: 'normal', revision: 0, holds: [] },
    activeAccountRef: null,
    accounts: {},
    operations: {},
    businessKeys: {},
    requests: {},
    tasks: {},
    videos: {},
    events: [],
    eventSeq: 0,
    journalPending: {},
    journalSegments: {},
    cursors: {},
    diaries: {},
    rate: {},
    publishes: {},
    principals: {},
    bindings: {},
    approvals: {},
    inboxKeys: {},
    outbox: {},
    artifacts: {},
    artifactPendingImports: {},
    productions: {},
    executions: {},
    budgets: {},
    migration: { phase: 'active', id: null },
    checkpointFence: null,
    artifactPins: {},
    backups: {},
    timeZone,
    createdAt: nowIso(now),
    updatedAt: nowIso(now)
  };
  return state;
}

export function validateState(state) {
  if (!isPlainObject(state)) {
    throw new AppError('STORE_CORRUPTED', 'state is not an object');
  }
  if (state.version !== 3) {
    if (state.version === 1 || state.version === 2) {
      throw new AppError('SCHEMA_UNSUPPORTED', 'legacy state version has no automatic upgrade path', {
        details: { version: state.version }
      });
    }
    throw new AppError('SCHEMA_UNSUPPORTED', 'unsupported state version', {
      details: { version: state.version }
    });
  }
  if (typeof state.workspaceId !== 'string' || state.workspaceId.length === 0) {
    throw new AppError('STORE_CORRUPTED', 'state.workspaceId is missing');
  }
  if (typeof state.historyEpoch !== 'string' || state.historyEpoch.length === 0) {
    throw new AppError('STORE_CORRUPTED', 'state.historyEpoch is missing');
  }
  if (!Number.isSafeInteger(state.eventSeq) || state.eventSeq < 0) {
    throw new AppError('STORE_CORRUPTED', 'state.eventSeq is invalid');
  }
  if (!Array.isArray(state.events)) {
    throw new AppError('STORE_CORRUPTED', 'state.events is invalid');
  }
  if (!isPlainObject(state.recovery) || !RECOVERY_PHASES.includes(state.recovery.phase)) {
    throw new AppError('STORE_CORRUPTED', 'state.recovery is invalid');
  }
  if (!Array.isArray(state.recovery.holds)) {
    throw new AppError('STORE_CORRUPTED', 'state.recovery.holds is invalid');
  }
  if (!isPlainObject(state.migration) || !MIGRATION_PHASES.includes(state.migration.phase)) {
    throw new AppError('STORE_CORRUPTED', 'state.migration is invalid');
  }
  if (!isPlainObject(state.configRevision)) {
    throw new AppError('STORE_CORRUPTED', 'state.configRevision is invalid');
  }
  for (const key of REQUIRED_OBJECTS) {
    if (!isPlainObject(state[key])) {
      throw new AppError('STORE_CORRUPTED', `state.${key} is invalid`);
    }
  }
  if (!isPlainObject(state.recovery.holdsByScope)) state.recovery.holdsByScope = {};
  return state;
}

export function validateInstance(instance) {
  if (!isPlainObject(instance)) throw new AppError('STORE_CORRUPTED', 'instance.json is not an object');
  if (instance.schemaVersion !== 1) {
    throw new AppError('SCHEMA_UNSUPPORTED', 'unsupported instance schemaVersion', {
      details: { schemaVersion: instance.schemaVersion }
    });
  }
  for (const field of ['instanceId', 'workspaceId']) {
    if (typeof instance[field] !== 'string' || instance[field] === '') {
      throw new AppError('STORE_CORRUPTED', `instance.${field} is missing`);
    }
  }
  if (!Array.isArray(instance.allowedCapabilities)) {
    throw new AppError('STORE_CORRUPTED', 'instance.allowedCapabilities is invalid');
  }
  if (!Number.isSafeInteger(instance.activationRevision) || instance.activationRevision < 0) {
    throw new AppError('STORE_CORRUPTED', 'instance.activationRevision is invalid');
  }
  if (instance.bootstrapComplete !== true) {
    throw new AppError('STORE_CORRUPTED', 'instance bootstrap is incomplete');
  }
  if (!['active', 'paused', 'validated', 'disabled', 'retired', 'recovery-readonly'].includes(instance.status || 'active')) {
    throw new AppError('STORE_CORRUPTED', 'instance.status is invalid');
  }
  return instance;
}

function readJsonSync(file, code, label) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new AppError(code, `cannot read ${label}`, { cause: error, details: { file: path.basename(file) } });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new AppError(code, `invalid JSON in ${label}`, { cause: error, details: { file: path.basename(file) } });
  }
}

export class JsonStore {
  constructor({
    file,
    instanceFile,
    lockTimeoutMs = 5000,
    staleLockMs = 30000,
    now = () => new Date(),
    logger,
    hooks = {},
    instanceId,
    readOnly = false
  } = {}) {
    if (!file) throw new Error('JsonStore requires a state file');
    this.file = file;
    this.instanceFile = instanceFile || path.join(path.dirname(file), 'instance.json');
    this.lockFile = `${file}.lock`;
    this.instanceLockFile = `${this.instanceFile}.lock`;
    this.lockTimeoutMs = lockTimeoutMs;
    this.staleLockMs = staleLockMs;
    this.now = now;
    this.logger = logger;
    this.hooks = hooks;
    this.instanceId = instanceId || null;
    this.readOnly = readOnly;
    this._inTransaction = false;
    this._lockToken = null;
    this.initialized = false;
  }

  async init(options = {}) {
    await ensureDir(path.dirname(this.file));
    if (await pathExists(this.file)) {
      const state = await this.getSnapshot();
      const instance = await this.getInstance();
      if (!instance) {
        throw new AppError('RECOVERY_REQUIRED', 'state exists but instance.json is missing');
      }
      if (instance.workspaceId !== state.workspaceId) {
        throw new AppError('RECOVERY_REQUIRED', 'state and instance workspaceId differ');
      }
      this.instanceId = instance.instanceId;
      this.initialized = true;
      return { state, instance, bootstrapped: false };
    }

    const existingInstance = await this.getInstance();
    if (existingInstance?.bootstrapComplete === true) {
      throw new AppError('RECOVERY_REQUIRED', 'instance is initialized but state.json is missing');
    }
    const journalDir = path.join(path.dirname(this.file), 'journal');
    if (await pathExists(journalDir)) {
      const entries = await fsp.readdir(journalDir).catch(() => []);
      if (entries.length > 0) {
        throw new AppError('RECOVERY_REQUIRED', 'journal exists but state.json is missing');
      }
    }
    if (!options.bootstrap) {
      throw new AppError('RECOVERY_REQUIRED', 'state has not been bootstrapped');
    }
    if (this.readOnly) throw new AppError('RECOVERY_REQUIRED', 'cannot bootstrap a read-only store');

    const workspaceId = options.workspaceId || randomId('workspace');
    const historyEpoch = options.historyEpoch || randomId('epoch');
    const instanceId = options.instanceId || this.instanceId || randomId('instance');
    const createdAt = nowIso(this.now);
    const state = createInitialState({
      workspaceId,
      historyEpoch,
      configRevision: options.configRevision,
      timeZone: options.timeZone,
      now: this.now
    });
    const instance = {
      schemaVersion: 1,
      instanceId,
      workspaceId,
      processStartedAt: processStartIso(),
      createdAt,
      bootstrapComplete: true,
      status: options.status || 'active',
      activationRevision: options.activationRevision ?? 1,
      allowedCapabilities: options.allowedCapabilities || [...DEFAULT_ALLOWED_CAPABILITIES],
      configRevision: options.configRevision || { version: 0, sha256: '' },
      recoveryRevision: 0,
      schedulerDisabled: options.schedulerDisabled ?? false,
      previousInstanceId: options.previousInstanceId || null
    };
    await this._writeBootstrap(state, instance);
    this.instanceId = instanceId;
    this.initialized = true;
    return { state, instance, bootstrapped: true };
  }

  async _writeBootstrap(state, instance) {
    // Write the state first, instance last. A crash in between is detected as
    // RECOVERY_REQUIRED on the next start, never silently re-initialized.
    await atomicWriteJson(this.file, state, { hooks: this.hooks });
    await atomicWriteJson(this.instanceFile, instance, { hooks: this.hooks });
  }

  async getSnapshot() {
    if (!(await pathExists(this.file))) {
      throw new AppError('RECOVERY_REQUIRED', 'state.json is missing');
    }
    const state = readJsonSync(this.file, 'STORE_CORRUPTED', 'state.json');
    validateState(state);
    return state;
  }

  async getInstance() {
    if (!(await pathExists(this.instanceFile))) return null;
    const instance = readJsonSync(this.instanceFile, 'STORE_CORRUPTED', 'instance.json');
    return validateInstance(instance);
  }

  async updateInstance(mutator) {
    if (this.readOnly) throw new AppError('STORE_CORRUPTED', 'store is read-only');
    return this._withFileLock(`${this.instanceFile}.lock`, async () => {
      const current = await this.getInstance();
      if (!current) throw new AppError('RECOVERY_REQUIRED', 'instance.json is missing');
      const draft = deepClone(current);
      const result = await mutator(draft);
      validateInstance(draft);
      await atomicWriteJson(this.instanceFile, draft, { hooks: this.hooks });
      return result;
    });
  }

  async writeInstance(instance) {
    if (this.readOnly) throw new AppError('STORE_CORRUPTED', 'store is read-only');
    validateInstance(instance);
    return this._withFileLock(`${this.instanceFile}.lock`, async () => {
      await atomicWriteJson(this.instanceFile, instance, { hooks: this.hooks });
    });
  }

  async _withFileLock(lockFile, fn) {
    const token = await this._acquireLock(lockFile);
    try {
      return await fn();
    } finally {
      await this._releaseLock(lockFile, token);
    }
  }

  async _acquireLock(lockFile = this.lockFile) {
    const deadline = Date.now() + this.lockTimeoutMs;
    const token = randomToken(24);
    while (Date.now() <= deadline) {
      try {
        const handle = await fsp.open(lockFile, 'wx', 0o600);
        const payload = {
          schemaVersion: 1,
          token,
          ownerPid: process.pid,
          processStartedAt: processStartIso(),
          instanceId: this.instanceId || null,
          createdAt: nowIso(this.now)
        };
        await handle.writeFile(`${JSON.stringify(payload)}\n`);
        await handle.sync();
        await handle.close();
        return token;
      } catch (error) {
        if (error.code !== 'EEXIST') {
          throw new AppError('STORE_CORRUPTED', 'cannot acquire state lock', { cause: error });
        }
        const stole = await this._tryStealStaleLock(lockFile);
        if (!stole) await sleep(25 + Math.floor(Math.random() * 25));
      }
    }
    throw new AppError('STORE_CORRUPTED', 'state lock is held by another owner', {
      details: { lock: path.basename(lockFile), timeoutMs: this.lockTimeoutMs }
    });
  }

  async _tryStealStaleLock(lockFile) {
    let text;
    try {
      text = await fsp.readFile(lockFile, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return true;
      throw new AppError('STORE_CORRUPTED', 'cannot read existing state lock', { cause: error });
    }
    let lock;
    try {
      lock = JSON.parse(text);
    } catch {
      // A malformed lock cannot establish ownership; never steal it.
      return false;
    }
    if (!lock || !Number.isInteger(lock.ownerPid) || typeof lock.token !== 'string') return false;
    const ageMs = Date.now() - Date.parse(lock.createdAt || '');
    if (!Number.isFinite(ageMs) || ageMs <= this.staleLockMs) return false;
    const alive = isProcessAlive(lock.ownerPid);
    let stale = false;
    if (!alive) {
      stale = true;
    } else {
      const actualStart = getProcessStartMs(lock.ownerPid);
      const recordedStart = Date.parse(lock.processStartedAt || '');
      if (
        actualStart !== null &&
        Number.isFinite(recordedStart) &&
        Math.abs(actualStart - recordedStart) > 5000
      ) {
        stale = true;
      }
    }
    if (!stale) return false;
    // Rename the stale lock so a live-but-unrecognized owner cannot accidentally
    // release the fresh lock created by this process.
    const staleName = `${lockFile}.stale.${process.pid}.${randomToken(4)}`;
    try {
      await fsp.rename(lockFile, staleName);
      await fsp.rm(staleName, { force: true });
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return true;
      return false;
    }
  }

  async _releaseLock(lockFile = this.lockFile, token) {
    try {
      const text = await fsp.readFile(lockFile, 'utf8');
      const lock = JSON.parse(text);
      if (lock.token !== token) return;
      await fsp.rm(lockFile, { force: true });
    } catch {
      // A missing or replaced lock is not ours to remove.
    }
  }

  async transaction(fn, options = {}) {
    if (this.readOnly) throw new AppError('STORE_CORRUPTED', 'store is read-only');
    if (this._inTransaction) {
      throw new AppError('STORE_CORRUPTED', 'nested store transaction');
    }
    const token = await this._acquireLock();
    this._inTransaction = true;
    this._lockToken = token;
    try {
      const state = await this.getSnapshot();
      const draft = deepClone(state);
      const instance = await this.getInstance();
      if (!instance) throw new AppError('RECOVERY_REQUIRED', 'instance.json is missing');
      const tx = this._makeContext(draft, instance, options);
      const result = await fn(draft, tx);
      validateState(draft);
      draft.updatedAt = nowIso(this.now);
      await this.hooks.beforeCommit?.({ state: draft, instance });
      await atomicWriteJson(this.file, draft, {
        hooks: {
          afterTempWrite: this.hooks.afterTempWrite,
          beforeRename: this.hooks.beforeRename,
          afterRename: this.hooks.afterRename
        }
      });
      await this.hooks.afterCommit?.({ state: draft, instance });
      return result;
    } finally {
      this._inTransaction = false;
      this._lockToken = null;
      await this._releaseLock(this.lockFile, token);
    }
  }

  _makeContext(draft, instance, options) {
    const store = this;
    return {
      state: draft,
      instance,
      workspaceId: draft.workspaceId,
      historyEpoch: draft.historyEpoch,
      instanceId: instance.instanceId,
      now: () => nowIso(store.now),
      getInstance: () => deepClone(instance),
      appendEvent: (event) => {
        if (!isPlainObject(event) || typeof event.type !== 'string' || event.type.length === 0) {
          throw new AppError('CONFIG_INVALID', 'event.type is required');
        }
        const payload = event.payload === undefined ? {} : event.payload;
        const eventObject = {
          eventId: randomId('evt'),
          historyEpoch: draft.historyEpoch,
          seq: draft.eventSeq + 1,
          workspaceId: draft.workspaceId,
          accountRef: event.accountRef ?? null,
          type: event.type,
          taskId: event.taskId ?? null,
          occurredAt: event.occurredAt || nowIso(store.now),
          payload
        };
        if (jsonByteLength(eventObject) > 64 * 1024) {
          throw new AppError('INPUT_REQUIRED', 'event payload exceeds 64KiB; use a managed artifact reference');
        }
        draft.eventSeq = eventObject.seq;
        draft.events.push(eventObject);
        while (draft.events.length > 2000) draft.events.shift();
        draft.journalPending[eventObject.eventId] = eventObject;
        return deepClone(eventObject);
      },
      assertBusinessAcceptance: () => {
        const pending = Object.keys(draft.journalPending).length;
        if (pending >= 10000) {
          throw new AppError('JOURNAL_CORRUPTED', 'journal backlog is full; new business is paused', {
            details: { journalPending: pending }
          });
        }
        return true;
      },
      hasPendingCommit: () => {
        if (Object.keys(draft.journalPending).length > 0) return true;
        return Object.values(draft.diaries).some((entry) => entry.pendingCommit);
      },
      options
    };
  }

  async appendEvent() {
    throw new AppError('STORE_CORRUPTED', 'appendEvent is only available inside transaction()');
  }

  async close() {
    if (this._lockToken) {
      await this._releaseLock(this.lockFile, this._lockToken);
      this._lockToken = null;
    }
  }

  async stateSizeBytes() {
    const text = await fsp.readFile(this.file, 'utf8');
    return Buffer.byteLength(text, 'utf8');
  }

  async journalPendingCount() {
    const state = await this.getSnapshot();
    return Object.keys(state.journalPending).length;
  }

  /** Remove only settled, unreferenced hot records. Permanent facts survive. */
  async prune({ maxTasks = 500, maxOperations = 5000 } = {}) {
    return this.transaction(async (draft, tx) => {
      const referencedTasks = new Set();
      const referencedOps = new Set();
      for (const task of Object.values(draft.tasks)) {
        if (!task.isSettled) {
          referencedTasks.add(task.id);
          for (const opId of task.pendingOperationIds || []) referencedOps.add(opId);
        }
        for (const child of task.childTaskIds || []) referencedTasks.add(child);
        if (task.parentTaskId) referencedTasks.add(task.parentTaskId);
      }
      for (const outbox of Object.values(draft.outbox)) {
        if (!['sent', 'not_sent', 'suppressed'].includes(outbox.status)) {
          if (outbox.taskId) referencedTasks.add(outbox.taskId);
        }
      }
      for (const request of Object.values(draft.requests)) {
        if (request.taskId) referencedTasks.add(request.taskId);
      }
      for (const approval of Object.values(draft.approvals)) {
        if (!approval.decidedAt || approval.decision === 'pending') referencedTasks.add(approval.taskId);
      }
      for (const op of Object.values(draft.operations)) {
        if (!['confirmed', 'failed', 'not_sent', 'cancelled'].includes(op.status)) {
          referencedOps.add(op.id);
          for (const taskId of op.taskIds || []) referencedTasks.add(taskId);
        }
      }
      const tasks = Object.values(draft.tasks).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
      let removedTasks = 0;
      for (const task of tasks) {
        if (Object.keys(draft.tasks).length - removedTasks <= maxTasks) break;
        if (!task.isSettled || referencedTasks.has(task.id)) continue;
        delete draft.tasks[task.id];
        removedTasks += 1;
      }
      const operations = Object.values(draft.operations).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
      let removedOps = 0;
      for (const op of operations) {
        if (Object.keys(draft.operations).length - removedOps <= maxOperations) break;
        if (!['confirmed', 'failed', 'not_sent', 'cancelled'].includes(op.status)) continue;
        if (referencedOps.has(op.id)) continue;
        delete draft.operations[op.id];
        removedOps += 1;
      }
      if (removedTasks || removedOps) {
        tx.appendEvent({
          type: 'store.pruned',
          actor: 'system',
          payload: { removedTasks, removedOps }
        });
      }
      return { removedTasks, removedOps };
    });
  }
}

export default JsonStore;
