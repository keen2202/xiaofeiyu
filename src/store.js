import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { AppError } from './errors.js';
import { validateTaskCombination } from './task-manager.js';
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

/** Journal backlog gate (SPEC §6.3): new business is paused at this count. */
export const JOURNAL_PENDING_LIMIT = 10000;
/** How long an internal capacity scan may reuse its recovery-directory total. */
export const CAPACITY_CACHE_MS = 30000;

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
    configIntent: null,
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

  // I10: nested fields added by the gateway/modules/prodmig owners are allowed,
  // but present values are shape-checked so a corrupt write still fails closed.
  if (state.configIntent !== undefined && state.configIntent !== null) {
    const intent = state.configIntent;
    if (
      !isPlainObject(intent) ||
      intent.phase !== 'prepared' ||
      !Number.isSafeInteger(intent.nextVersion) ||
      intent.nextVersion < 1 ||
      typeof intent.nextSha256 !== 'string' ||
      typeof intent.nextFile !== 'string'
    ) {
      throw new AppError('STORE_CORRUPTED', 'state.configIntent is invalid');
    }
  }
  validateExtendedNestedState(state);
  return state;
}

/** Shape checks for the I10 extension fields (fail closed, absent is fine). */
function validateExtendedNestedState(state) {
  for (const [key, account] of Object.entries(state.accounts)) {
    if (!isPlainObject(account)) {
      throw new AppError('STORE_CORRUPTED', `state.accounts.${key} is invalid`);
    }
    for (const field of ['authPausedAt', 'authPausedReason', 'authPausedCode', 'credentialMismatchAt']) {
      const value = account[field];
      if (value !== undefined && value !== null && typeof value !== 'string') {
        throw new AppError('STORE_CORRUPTED', `state.accounts.${key}.${field} is invalid`);
      }
    }
  }
  if (state.migration.lateReceipts !== undefined) {
    if (!Array.isArray(state.migration.lateReceipts)) {
      throw new AppError('STORE_CORRUPTED', 'state.migration.lateReceipts is invalid');
    }
    for (const receipt of state.migration.lateReceipts) {
      if (!isPlainObject(receipt)) {
        throw new AppError('STORE_CORRUPTED', 'state.migration.lateReceipts entry is invalid');
      }
    }
  }
  for (const field of ['sealedPackage', 'executorStopEvidence', 'releaseCut']) {
    const value = state.migration[field];
    if (value !== undefined && value !== null && !isPlainObject(value)) {
      throw new AppError('STORE_CORRUPTED', `state.migration.${field} is invalid`);
    }
  }
  for (const field of [
    'executorStopEvidenceHash',
    'targetStopEvidenceHash',
    'targetStopEvidence',
    'targetDataDir',
    'targetDisabledAt',
    'reopenedAt'
  ]) {
    const value = state.migration[field];
    if (value !== undefined && value !== null && typeof value !== 'string') {
      throw new AppError('STORE_CORRUPTED', `state.migration.${field} is invalid`);
    }
  }
  if (state.migration.targetDisabled !== undefined && typeof state.migration.targetDisabled !== 'boolean') {
    throw new AppError('STORE_CORRUPTED', 'state.migration.targetDisabled is invalid');
  }
  if (state.migration.unsettledExecutions !== undefined) {
    if (
      !Array.isArray(state.migration.unsettledExecutions) ||
      !state.migration.unsettledExecutions.every((entry) => typeof entry === 'string')
    ) {
      throw new AppError('STORE_CORRUPTED', 'state.migration.unsettledExecutions is invalid');
    }
  }
  for (const [index, hold] of (state.recovery.holds || []).entries()) {
    if (!isPlainObject(hold)) {
      throw new AppError('STORE_CORRUPTED', `state.recovery.holds[${index}] is invalid`);
    }
    if (hold.exposureId !== undefined && hold.exposureId !== null && typeof hold.exposureId !== 'string') {
      throw new AppError('STORE_CORRUPTED', `state.recovery.holds[${index}].exposureId is invalid`);
    }
    if (hold.exposureIds !== undefined) {
      if (!Array.isArray(hold.exposureIds) || !hold.exposureIds.every((entry) => typeof entry === 'string')) {
        throw new AppError('STORE_CORRUPTED', `state.recovery.holds[${index}].exposureIds is invalid`);
      }
    }
  }
  for (const [diaryId, diary] of Object.entries(state.diaries)) {
    // `__pendingRebuild` is the reserved dirty-marker index, not a diary entry.
    if (diaryId === '__pendingRebuild') {
      if (!isPlainObject(diary)) {
        throw new AppError('STORE_CORRUPTED', 'state.diaries.__pendingRebuild is invalid');
      }
      for (const [targetId, marker] of Object.entries(diary)) {
        if (!isPlainObject(marker)) {
          throw new AppError('STORE_CORRUPTED', `state.diaries.__pendingRebuild.${targetId} is invalid`);
        }
      }
      continue;
    }
    if (!isPlainObject(diary)) {
      throw new AppError('STORE_CORRUPTED', `state.diaries.${diaryId} is invalid`);
    }
    const factsHash = diary.factsHash;
    if (factsHash !== undefined && factsHash !== null && typeof factsHash !== 'string') {
      throw new AppError('STORE_CORRUPTED', `state.diaries.${diaryId}.factsHash is invalid`);
    }
  }
  for (const [taskId, task] of Object.entries(state.tasks)) {
    if (!isPlainObject(task)) {
      throw new AppError('STORE_CORRUPTED', `state.tasks.${taskId} is invalid`);
    }
    validateTaskCombination(task);
    if (task.hasUnknownOperation !== undefined && typeof task.hasUnknownOperation !== 'boolean') {
      throw new AppError('STORE_CORRUPTED', `state.tasks.${taskId}.hasUnknownOperation is invalid`);
    }
    if (task.revision !== undefined && (!Number.isSafeInteger(task.revision) || task.revision < 1)) {
      throw new AppError('STORE_CORRUPTED', `state.tasks.${taskId}.revision is invalid`);
    }
    if (task.holds !== undefined) {
      if (!Array.isArray(task.holds)) {
        throw new AppError('STORE_CORRUPTED', `state.tasks.${taskId}.holds is invalid`);
      }
      for (const [index, hold] of task.holds.entries()) {
        if (!isPlainObject(hold)) {
          throw new AppError('STORE_CORRUPTED', `state.tasks.${taskId}.holds[${index}] is invalid`);
        }
        for (const field of ['releaseNote', 'releasedBy']) {
          const value = hold[field];
          if (value !== undefined && value !== null && typeof value !== 'string') {
            throw new AppError('STORE_CORRUPTED', `state.tasks.${taskId}.holds[${index}].${field} is invalid`);
          }
        }
      }
    }
  }
  for (const [operationId, operation] of Object.entries(state.operations)) {
    if (!isPlainObject(operation)) {
      throw new AppError('STORE_CORRUPTED', `state.operations.${operationId} is invalid`);
    }
    const revision = operation.credentialRevision;
    if (revision !== undefined && revision !== null && typeof revision !== 'string') {
      throw new AppError('STORE_CORRUPTED', `state.operations.${operationId}.credentialRevision is invalid`);
    }
  }
  for (const [executionId, execution] of Object.entries(state.executions)) {
    if (!isPlainObject(execution)) {
      throw new AppError('STORE_CORRUPTED', `state.executions.${executionId} is invalid`);
    }
    for (const field of [
      'previousExecutionId',
      'checkpointRef',
      'requestId',
      'workspaceId',
      'instanceId',
      'sourceProcessStartedAt'
    ]) {
      const value = execution[field];
      if (value !== undefined && value !== null && typeof value !== 'string') {
        throw new AppError('STORE_CORRUPTED', `state.executions.${executionId}.${field} is invalid`);
      }
    }
    const sourceOwnerPid = execution.sourceOwnerPid;
    if (
      sourceOwnerPid !== undefined &&
      sourceOwnerPid !== null &&
      (!Number.isSafeInteger(sourceOwnerPid) || sourceOwnerPid < 0)
    ) {
      throw new AppError('STORE_CORRUPTED', `state.executions.${executionId}.sourceOwnerPid is invalid`);
    }
    if (execution.inputArtifactRefs !== undefined && !Array.isArray(execution.inputArtifactRefs)) {
      throw new AppError('STORE_CORRUPTED', `state.executions.${executionId}.inputArtifactRefs is invalid`);
    }
  }
  for (const [importId, entry] of Object.entries(state.artifactPendingImports)) {
    if (!isPlainObject(entry)) {
      throw new AppError('STORE_CORRUPTED', `state.artifactPendingImports.${importId} is invalid`);
    }
    const fileMode = entry.fileMode;
    if (fileMode !== undefined && (!Number.isSafeInteger(fileMode) || fileMode < 0)) {
      throw new AppError('STORE_CORRUPTED', `state.artifactPendingImports.${importId}.fileMode is invalid`);
    }
  }
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
    this.commandContext = new AsyncLocalStorage();
    this.transactionContext = new AsyncLocalStorage();
    this.commitObservers = new Set();
    this.capacityLimits = { warningBytes: 80 * 1024 * 1024, hardBytes: 100 * 1024 * 1024 };
    this.capacityCacheMs = CAPACITY_CACHE_MS;
    this._capacityCache = null;
    this._legacySegmentBytes = new Map();
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
          // Windows can report EPERM/EACCES/EBUSY while another process or async
          // branch is creating/removing the lock (delete-pending state). Treat it
          // as contention and retry within the deadline instead of failing the
          // whole transaction with a misleading corruption error.
          if (['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) {
            await sleep(25 + Math.floor(Math.random() * 25));
            continue;
          }
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
      // The lock may be in a transient delete-pending state on Windows; do not
      // upgrade it to STORE_CORRUPTED, let the acquisition loop retry.
      if (['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) return false;
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
    if (this.transactionContext.getStore()) {
      throw new AppError('STORE_CORRUPTED', 'nested store transaction');
    }
    return this.transactionContext.run(true, () => this._transaction(fn, options));
  }

  async _transaction(fn, options) {
    const token = await this._acquireLock();
    this._inTransaction = true;
    this._lockToken = token;
    try {
      const state = await this.getSnapshot();
      const draft = deepClone(state);
      const instance = await this.getInstance();
      if (!instance) throw new AppError('RECOVERY_REQUIRED', 'instance.json is missing');
      const capacity = await this.capacityStatus(state, { allowCache: true });
      const tx = this._makeContext(draft, instance, { ...options, capacity });
      const result = await fn(draft, tx);
      const context = this.commandContext.getStore();
      const request = context && draft.requests[context.requestKey];
      if (request) {
        const task = draft.tasks[request.taskId || context.taskId] || Object.values(draft.tasks).find(
          (item) => !state.tasks[item.id] && !item.parentTaskId && item.principalId === request.principalId
        );
        if (task) {
          if (!request.taskId) tx.appendEvent({ type: 'request.accepted', actor: request.principalId, taskId: task.id, payload: { requestKey: request.requestKey, action: request.action } });
          request.taskId = task.id;
          request.taskStatus = task.status;
          request.status = 'accepted';
          request.result = { taskId: task.id, taskStatus: task.status, executionMode: request.executionMode };
          if (context.notificationTarget && !task.notificationTarget) task.notificationTarget = deepClone(context.notificationTarget);
          if (context.inboxKey && draft.inboxKeys[context.inboxKey]) {
            Object.assign(draft.inboxKeys[context.inboxKey], {
              status: 'accepted', taskId: task.id,
              result: { accepted: true, taskId: task.id, status: task.status, executionMode: request.executionMode }
            });
          }
        }
      }
      for (const observer of this.commitObservers) observer(tx, state);
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
      assertBusinessAcceptance: () => store._assertCapacityAcceptance(draft, options.capacity),
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

  /**
   * Capacity snapshot (SPEC §6.3). Totals are a fresh scan unless the caller
   * explicitly opts into the short-lived internal cache used by hot
   * transaction paths (`allowCache`); `status.capacity` therefore stays exact.
   */
  async capacityStatus(state = null, { allowCache = false } = {}) {
    const snapshot = state || await this.getSnapshot();
    const stateBytes = Buffer.byteLength(JSON.stringify(snapshot, null, 2)) + 1;
    let journalBytes = 0;
    for (const segment of Object.values(snapshot.journalSegments || {})) {
      if (Number.isSafeInteger(segment.sizeBytes)) {
        journalBytes += segment.sizeBytes;
        continue;
      }
      // Legacy segments did not persist size; measure once and remember.
      let cached = this._legacySegmentBytes.get(segment.relativePath);
      if (cached === undefined) {
        const file = path.resolve(this.journalDir || path.join(path.dirname(this.file), 'journal'), segment.relativePath);
        const stat = await fsp.stat(file).catch(() => null);
        cached = stat?.size ?? this.capacityLimits.hardBytes;
        if (stat) this._legacySegmentBytes.set(segment.relativePath, cached);
      }
      journalBytes += cached;
    }
    const nowMs = Date.now();
    let recoveryBytes;
    if (allowCache && this._capacityCache && nowMs - this._capacityCache.at <= this.capacityCacheMs) {
      recoveryBytes = this._capacityCache.recoveryBytes;
    } else {
      const recoveryRoot = this.recoveryDir || path.join(path.dirname(this.file), 'recovery');
      let scanned = 0;
      const countRecovery = async (dir) => {
        let entries;
        try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
        catch (error) { if (error.code === 'ENOENT') return; scanned += this.capacityLimits.hardBytes; return; }
        for (const entry of entries) {
          const file = path.join(dir, entry.name);
          if (entry.isSymbolicLink()) { scanned += this.capacityLimits.hardBytes; continue; }
          if (entry.isDirectory()) await countRecovery(file);
          else if (entry.isFile()) {
            try { scanned += (await fsp.stat(file)).size; }
            catch (error) { if (error.code !== 'ENOENT') scanned += this.capacityLimits.hardBytes; }
          }
        }
      };
      await countRecovery(recoveryRoot);
      recoveryBytes = scanned;
      this._capacityCache = { at: nowMs, recoveryBytes };
    }
    const totalBytes = stateBytes + journalBytes + recoveryBytes;
    return {
      stateBytes,
      journalBytes,
      recoveryBytes,
      totalBytes,
      businessKeyBytes: jsonByteLength(snapshot.businessKeys),
      pendingCount: Object.keys(snapshot.journalPending).length,
      pendingLimit: JOURNAL_PENDING_LIMIT,
      ...this.capacityLimits,
      status: totalBytes >= this.capacityLimits.hardBytes
        ? 'blocked'
        : totalBytes >= this.capacityLimits.warningBytes
          ? 'warning'
          : 'healthy'
    };
  }

  _assertCapacityAcceptance(stateLike, capacity = null) {
    if (
      (capacity && capacity.totalBytes >= this.capacityLimits.hardBytes) ||
      jsonByteLength(stateLike) >= this.capacityLimits.hardBytes
    ) {
      throw new AppError('STORE_CORRUPTED', 'metadata capacity limit reached; only maintenance and settlement are allowed', {
        details: { reason: 'capacity_limit', ...(capacity || {}) }
      });
    }
    const pending = Object.keys(stateLike?.journalPending || {}).length;
    if (pending >= JOURNAL_PENDING_LIMIT) {
      throw new AppError('JOURNAL_CORRUPTED', 'journal backlog is full; new business is paused', {
        details: { journalPending: pending }
      });
    }
    return true;
  }

  /**
   * Public capacity gate for callers that start business outside a transaction
   * (e.g. diary.generate must call this before writing). Inside a transaction
   * use `tx.assertBusinessAcceptance()` so the draft size is included.
   */
  async assertBusinessAcceptance(state = null) {
    const snapshot = state || await this.getSnapshot();
    const capacity = await this.capacityStatus(snapshot);
    return this._assertCapacityAcceptance(snapshot, capacity);
  }

  async journalPendingCount() {
    const state = await this.getSnapshot();
    return Object.keys(state.journalPending).length;
  }

  /**
   * Remove only settled, unreferenced hot records. Permanent facts survive.
   * Any task/operation referenced by an unsettled task, an active hold, an
   * approval, an execution, a request, an outbox item or a production/publish
   * record is never evicted (SPEC §6.2). Exposed for the maintenance loop;
   * this method never runs on its own.
   */
  async prune({ maxTasks = 500, maxOperations = 5000 } = {}) {
    return this.transaction(async (draft, tx) => {
      const protectedTasks = new Set();
      const protectedOps = new Set();
      const protectTask = (taskId) => {
        if (taskId) protectedTasks.add(taskId);
      };
      const protectOperation = (operationId) => {
        if (operationId) protectedOps.add(operationId);
      };

      for (const task of Object.values(draft.tasks)) {
        if (!task.isSettled) {
          protectTask(task.id);
          for (const opId of task.pendingOperationIds || []) protectOperation(opId);
          for (const opId of task.operationIds || []) protectOperation(opId);
        }
        for (const child of task.childTaskIds || []) protectTask(child);
        protectTask(task.parentTaskId);
        if ((task.holds || []).some((hold) => hold.status !== 'released')) protectTask(task.id);
      }
      for (const approval of Object.values(draft.approvals)) protectTask(approval.taskId);
      for (const outbox of Object.values(draft.outbox)) {
        protectTask(outbox.taskId);
        protectOperation(outbox.operationId);
      }
      for (const request of Object.values(draft.requests)) protectTask(request.taskId);
      for (const execution of Object.values(draft.executions)) {
        protectTask(execution.taskId);
        protectOperation(execution.operationId);
      }
      for (const record of [...Object.values(draft.productions || {}), ...Object.values(draft.publishes || {})]) {
        if (!isPlainObject(record)) continue;
        protectTask(record.taskId);
        protectOperation(record.operationId);
      }
      for (const hold of draft.recovery?.holds || []) {
        if (isPlainObject(hold)) protectTask(hold.taskId);
      }
      for (const operation of Object.values(draft.operations)) {
        for (const taskId of operation.taskIds || []) {
          if (protectedTasks.has(taskId)) protectOperation(operation.id);
        }
      }
      for (const operation of Object.values(draft.operations)) {
        if (!protectedOps.has(operation.id)) continue;
        for (const taskId of operation.taskIds || []) protectTask(taskId);
      }

      const tasks = Object.values(draft.tasks).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
      let removedTasks = 0;
      for (const task of tasks) {
        if (Object.keys(draft.tasks).length - removedTasks <= maxTasks) break;
        if (!task.isSettled || protectedTasks.has(task.id)) continue;
        delete draft.tasks[task.id];
        removedTasks += 1;
      }
      const operations = Object.values(draft.operations).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
      let removedOps = 0;
      for (const op of operations) {
        if (Object.keys(draft.operations).length - removedOps <= maxOperations) break;
        if (!['confirmed', 'failed', 'not_sent', 'cancelled'].includes(op.status)) continue;
        if (protectedOps.has(op.id)) continue;
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
