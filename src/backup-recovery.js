import fsp from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './errors.js';
import {
  assertNoMatchingHold,
  makeRecoveryHold,
  makeMigrationHold,
  normalizeScope,
  scopeCovers,
  scopeKeyFor
} from './contracts.js';
import {
  atomicWriteFile,
  atomicWriteJson,
  copyFileWithHash,
  deepClone,
  ensureDir,
  ensureWithin,
  fileSha256,
  isSafeRelativePath,
  isProcessAlive,
  getProcessStartMs,
  jcsHash,
  normalizeText,
  nowIso,
  pathExists,
  processStartIso,
  randomId,
  randomToken,
  resolveInside,
  sha256Hex
} from './utils.js';

export const BACKUP_SCHEMA_VERSION = 1;
export const BACKUP_POLICY_SCHEMA_VERSION = 1;
export const RECOVERY_SCHEMA_VERSION = 1;
export const BACKUP_KINDS = Object.freeze(['ledger', 'full']);

export const DEFAULT_BACKUP_POLICY = Object.freeze({
  schemaVersion: BACKUP_POLICY_SCHEMA_VERSION,
  scheduleEnabled: false,
  destinationRoot: '',
  failureDomain: '',
  verifiedBy: '',
  verifiedAt: null,
  intervalMinutes: 15,
  maxPointAgeMinutes: 20,
  fullIntervalHours: 24,
  keepRecent: 8,
  keepDaily: 7,
  keepWeekly: 4,
  autoPrune: false,
  checkpointTimeoutMs: 5000
});

export function validateBackupPolicy(policy, { dataDir = null, requireDestination = false } = {}) {
  if (!policy || typeof policy !== 'object') throw new AppError('CONFIG_INVALID', 'backup policy must be an object');
  const unknown = Object.keys(policy).filter((key) => !(key in DEFAULT_BACKUP_POLICY));
  if (unknown.length > 0) throw new AppError('CONFIG_INVALID', 'unknown backup policy keys', { details: { unknown } });
  const merged = { ...DEFAULT_BACKUP_POLICY, ...policy };
  if (merged.schemaVersion !== BACKUP_POLICY_SCHEMA_VERSION) {
    throw new AppError('SCHEMA_UNSUPPORTED', 'backup policy schemaVersion must be 1');
  }
  if (typeof merged.scheduleEnabled !== 'boolean') throw new AppError('CONFIG_INVALID', 'scheduleEnabled must be boolean');
  if (requireDestination || merged.scheduleEnabled) {
    if (typeof merged.destinationRoot !== 'string' || !path.isAbsolute(merged.destinationRoot)) {
      throw new AppError('CONFIG_INVALID', 'backup destinationRoot must be an absolute path');
    }
    if (dataDir && ensureWithin(dataDir, merged.destinationRoot)) {
      throw new AppError('CONFIG_INVALID', 'backup destination must not be inside the active data directory');
    }
    if (dataDir && ensureWithin(merged.destinationRoot, dataDir)) {
      throw new AppError('CONFIG_INVALID', 'backup destination must not contain the active data directory');
    }
    if (typeof merged.failureDomain !== 'string' || merged.failureDomain.trim() === '') {
      throw new AppError('CONFIG_INVALID', 'failureDomain must be recorded by the owner');
    }
    if (typeof merged.verifiedBy !== 'string' || merged.verifiedBy.trim() === '') {
      throw new AppError('CONFIG_INVALID', 'verifiedBy must record who verified the failure domain');
    }
  }
  for (const key of ['intervalMinutes', 'maxPointAgeMinutes', 'fullIntervalHours', 'keepRecent', 'keepDaily', 'keepWeekly']) {
    if (!Number.isSafeInteger(merged[key]) || merged[key] <= 0) {
      throw new AppError('CONFIG_INVALID', `backup ${key} must be a positive integer`);
    }
  }
  if (merged.intervalMinutes > merged.maxPointAgeMinutes) {
    throw new AppError('CONFIG_INVALID', 'intervalMinutes must not exceed maxPointAgeMinutes');
  }
  if (!Number.isSafeInteger(merged.checkpointTimeoutMs) || merged.checkpointTimeoutMs < 100 || merged.checkpointTimeoutMs > 60000) {
    throw new AppError('CONFIG_INVALID', 'checkpointTimeoutMs must be 100..60000');
  }
  if (typeof merged.autoPrune !== 'boolean') throw new AppError('CONFIG_INVALID', 'autoPrune must be boolean');
  return merged;
}

export class BackupPolicyService {
  constructor({ file, dataDir, now = () => new Date() } = {}) {
    this.file = file;
    this.dataDir = dataDir;
    this.now = now;
    this.cached = null;
  }

  async load({ missingOk = true } = {}) {
    if (!(await pathExists(this.file))) {
      if (missingOk) return null;
      throw new AppError('BACKUP_UNPROTECTED', 'backup policy is not configured');
    }
    let raw;
    try {
      raw = JSON.parse(await fsp.readFile(this.file, 'utf8'));
    } catch (error) {
      throw new AppError('BACKUP_INVALID', 'backup policy is not valid JSON', { cause: error });
    }
    const policy = validateBackupPolicy(raw, { dataDir: this.dataDir });
    this.cached = policy;
    return policy;
  }

  async save(policy) {
    const validated = validateBackupPolicy(policy, { dataDir: this.dataDir, requireDestination: true });
    await ensureDir(path.dirname(this.file));
    await atomicWriteJson(this.file, validated, { mode: 0o600 });
    this.cached = validated;
    return validated;
  }

  async revision() {
    const policy = await this.load();
    return policy ? jcsHash(policy) : null;
  }
}

const INTERNAL_STATE_KEYS = new Set(['checkpointFence', 'backups']);

export function sanitizeStateForBackup(state) {
  const clone = deepClone(state);
  for (const key of INTERNAL_STATE_KEYS) delete clone[key];
  if (clone.recovery) {
    clone.recovery = {
      ...clone.recovery,
      holds: (clone.recovery.holds || []).map((hold) => ({
        ...hold,
        status: 'active',
        evidenceRefs: [],
        releaseDecisionRef: null
      })),
      unknownExposures: deepClone(clone.recovery.unknownExposures || {})
    };
  }
  clone.approvals = Object.fromEntries(
    Object.entries(clone.approvals || {}).map(([id, approval]) => [
      id,
      {
        ...approval,
        nonceHash: null,
        usableForAuthorization: false
      }
    ])
  );
  clone.bindings = {};
  clone.principals = Object.fromEntries(
    Object.entries(clone.principals || {}).map(([id, principal]) => [
      id,
      { ...principal, scopes: [], requiresReverification: true }
    ])
  );
  if (clone.migration) {
    clone.migration = {
      phase: clone.migration.phase,
      id: clone.migration.id,
      snapshotHash: clone.migration.snapshotHash || null,
      receipt: null,
      retired: clone.migration.retired || null
    };
  }
  clone.outbox = Object.fromEntries(
    Object.entries(clone.outbox || {}).map(([id, notification]) => [
      id,
      ['pending', 'sending'].includes(notification.status)
        ? {
            ...notification,
            capturedStatus: notification.capturedStatus || notification.status,
            status: 'suppressed',
            suppressionReason: 'backup_snapshot'
          }
        : notification
    ])
  );
  clone.secretsExcluded = true;
  return clone;
}

export function computeSourceStateHash({ state, cutAt }) {
  return jcsHash({
    stateVersion: 3,
    workspaceId: state.workspaceId,
    historyEpoch: state.historyEpoch,
    eventSeq: state.eventSeq,
    configRevision: state.configRevision,
    timeZone: state.timeZone || 'Asia/Shanghai',
    cutAt,
    state
  });
}

export function computeSnapshotHash(manifest) {
  const without = { ...manifest };
  delete without.snapshotHash;
  return jcsHash({ manifestWithoutSnapshotHash: without, files: manifest.files });
}

async function writeFileEntry(tmpDir, relativePath, sourceFile, { role, artifactId = null, required = true, maxBytes = null } = {}) {
  if (!isSafeRelativePath(relativePath)) throw new AppError('BACKUP_INVALID', 'unsafe backup path');
  const target = resolveInside(tmpDir, relativePath);
  await ensureDir(path.dirname(target));
  const copied = await copyFileWithHash(sourceFile, target, { maxBytes: maxBytes ?? Number.MAX_SAFE_INTEGER });
  return {
    path: relativePath,
    role,
    artifactId,
    sizeBytes: copied.sizeBytes,
    sha256: copied.sha256,
    required
  };
}

async function listBackupFiles(root, prefix = '') {
  const files = [];
  const entries = await fsp.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const relative = prefix ? path.posix.join(prefix, entry.name) : entry.name;
    const absolute = path.join(root, entry.name);
    const lstat = await fsp.lstat(absolute);
    if (lstat.isSymbolicLink()) throw new AppError('BACKUP_INVALID', 'backup contains a symbolic link');
    if (lstat.isDirectory()) files.push(...(await listBackupFiles(absolute, relative)));
    else if (lstat.isFile()) files.push(relative);
    else throw new AppError('BACKUP_INVALID', 'backup contains a non-regular entry');
  }
  return files;
}

async function clearRestoreTarget(targetDir) {
  const entries = await fsp.readdir(targetDir).catch(() => []);
  for (const entry of entries) {
    await fsp.rm(path.join(targetDir, entry), { recursive: true, force: true });
  }
}

export async function verifyBackupDirectory(dir, { now = () => new Date() } = {}) {
  const manifestFile = path.join(dir, 'manifest.json');
  if (!(await pathExists(manifestFile))) throw new AppError('BACKUP_INVALID', 'backup manifest is missing');
  let manifest;
  try {
    manifest = JSON.parse(await fsp.readFile(manifestFile, 'utf8'));
  } catch (error) {
    throw new AppError('BACKUP_INVALID', 'backup manifest is not valid JSON', { cause: error });
  }
  if (manifest.schemaVersion !== BACKUP_SCHEMA_VERSION || manifest.kind !== 'backup' || manifest.stateVersion !== 3) {
    throw new AppError('BACKUP_INVALID', 'unsupported backup manifest version/kind');
  }
  if (!BACKUP_KINDS.includes(manifest.tier)) throw new AppError('BACKUP_INVALID', 'backup tier is invalid');
  const stateFile = path.join(dir, 'state.json');
  if (!(await pathExists(stateFile))) throw new AppError('BACKUP_INVALID', 'backup state.json is missing');
  const state = JSON.parse(await fsp.readFile(stateFile, 'utf8'));
  if (state.version !== 3) throw new AppError('BACKUP_INVALID', 'backup state is not v3');
  const sourceHash = computeSourceStateHash({ state, cutAt: manifest.cutAt });
  if (sourceHash !== manifest.sourceStateHash) {
    throw new AppError('BACKUP_INVALID', 'sourceStateHash does not match the snapshot');
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new AppError('BACKUP_INVALID', 'backup file list is empty');
  }
  const actualFiles = await listBackupFiles(dir);
  const allowed = new Set([...manifest.files.map((entry) => entry.path), 'manifest.json']);
  for (const actual of actualFiles) {
    if (!allowed.has(actual)) {
      throw new AppError('BACKUP_INVALID', 'backup contains an unlisted file', { details: { path: actual } });
    }
  }
  const seen = new Set();
  for (const entry of manifest.files) {
    if (!entry || !isSafeRelativePath(entry.path) || seen.has(entry.path)) {
      throw new AppError('BACKUP_INVALID', 'backup file list has an unsafe/duplicate path');
    }
    seen.add(entry.path);
    const file = resolveInside(dir, entry.path);
    const stat = await fsp.lstat(file).catch(() => null);
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
      throw new AppError('BACKUP_INVALID', 'backup file is missing or not a regular file', {
        details: { path: entry.path }
      });
    }
    if (stat.size !== entry.sizeBytes) {
      throw new AppError('BACKUP_INVALID', 'backup file size mismatch', { details: { path: entry.path } });
    }
    const hash = (await fileSha256(file)).sha256;
    if (hash !== entry.sha256) {
      throw new AppError('BACKUP_INVALID', 'backup file hash mismatch', { details: { path: entry.path } });
    }
  }
  if (computeSnapshotHash(manifest) !== manifest.snapshotHash) {
    throw new AppError('BACKUP_INVALID', 'snapshotHash does not match the manifest/files');
  }
  return {
    ok: true,
    manifest,
    state,
    ageMs: Math.max(0, now().getTime() - Date.parse(manifest.cutAt)),
    mediaCoverage: manifest.mediaCoverage
  };
}

export class BackupService {
  constructor({
    store,
    configService,
    policyService,
    artifactStore = null,
    journalDir = null,
    dataDir = null,
    humanProof = null,
    prepareCapture = null,
    statfs = null,
    now = () => new Date(),
    hooks = {},
    logger
  } = {}) {
    this.store = store;
    this.configService = configService;
    this.policyService = policyService;
    this.artifactStore = artifactStore;
    this.journalDir = journalDir;
    this.dataDir = dataDir;
    this.humanProof = humanProof;
    this.prepareCapture = prepareCapture;
    this.statfs = statfs || ((target) => fsp.statfs(target));
    this.now = now;
    this.hooks = hooks;
    this.logger = logger;
    this._indexLock = null;
    this._indexLockTimeoutMs = 5000;
    this._indexStaleMs = 15000;
  }

  async _withIndexLock(fn) {
    const previous = this._indexLock || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => gate);
    this._indexLock = chained;
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this._indexLock === chained) this._indexLock = null;
    }
  }

  _indexLockFile(policy) {
    return path.join(policy.destinationRoot, '.index.lock');
  }

  async _acquireIndexFileLock(policy) {
    await ensureDir(policy.destinationRoot);
    const lockFile = this._indexLockFile(policy);
    const token = randomToken(12);
    const deadline = Date.now() + this._indexLockTimeoutMs;
    while (Date.now() <= deadline) {
      try {
        const handle = await fsp.open(lockFile, 'wx', 0o600);
        try {
          await handle.writeFile(
            JSON.stringify({
              ownerPid: process.pid,
              processStartedAt: processStartIso(),
              token,
              createdAt: nowIso(this.now)
            }),
            'utf8'
          );
          await handle.sync();
        } finally {
          await handle.close().catch(() => {});
        }
        return token;
      } catch (error) {
        if (error.code !== 'EEXIST') {
          throw new AppError('BACKUP_INVALID', 'cannot acquire the backup index file lock', { cause: error });
        }
        const stolen = await this._tryStealIndexLock(lockFile);
        if (!stolen) {
          await new Promise((resolve) => setTimeout(resolve, 20 + Math.floor(Math.random() * 30)));
        }
      }
    }
    throw new AppError('BACKUP_INVALID', 'backup index is locked by another process', {
      details: { lockFile, timeoutMs: this._indexLockTimeoutMs }
    });
  }

  async _tryStealIndexLock(lockFile) {
    let raw;
    try {
      raw = await fsp.readFile(lockFile, 'utf8');
    } catch {
      return true;
    }
    let lock;
    try {
      lock = JSON.parse(raw);
    } catch {
      // A malformed lock cannot establish ownership; never steal it.
      return false;
    }
    if (!lock || !Number.isInteger(lock.ownerPid) || typeof lock.token !== 'string') return false;
    const ageMs = Date.now() - Date.parse(lock.createdAt || '');
    if (!Number.isFinite(ageMs) || ageMs < 1000) return false;
    const alive = isProcessAlive(lock.ownerPid);
    let pidReused = false;
    if (alive) {
      const actualStart = getProcessStartMs(lock.ownerPid);
      const recordedStart = Date.parse(lock.processStartedAt || '');
      pidReused =
        actualStart !== null &&
        Number.isFinite(recordedStart) &&
        Math.abs(actualStart - recordedStart) > 5000;
    }
    if (alive && !pidReused) return false;
    const staleName = `${lockFile}.stale.${process.pid}.${randomToken(4)}`;
    try {
      await fsp.rename(lockFile, staleName);
    } catch {
      return false;
    }
    await fsp.rm(staleName, { force: true }).catch(() => {});
    return true;
  }

  async _releaseIndexFileLock(policy, token) {
    const lockFile = this._indexLockFile(policy);
    try {
      const raw = await fsp.readFile(lockFile, 'utf8');
      const lock = JSON.parse(raw);
      if (lock.token !== token) return;
      await fsp.rm(lockFile, { force: true });
    } catch {
      // A missing or replaced lock is not ours to remove.
    }
  }

  async _policy({ required = true } = {}) {
    const policy = await this.policyService.load({ missingOk: !required });
    if (!policy && required) throw new AppError('BACKUP_UNPROTECTED', 'backup policy is not configured');
    return policy;
  }

  _indexFile(policy) {
    return path.join(policy.destinationRoot, 'index.json');
  }

  async _readIndex(policy) {
    const file = this._indexFile(policy);
    if (!(await pathExists(file))) return { schemaVersion: 1, version: 0, backups: {}, updatedAt: null };
    let index;
    try {
      index = JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch (error) {
      throw new AppError('BACKUP_INVALID', 'backup index is not valid JSON', { cause: error });
    }
    if (!index || typeof index !== 'object' || typeof index.backups !== 'object') {
      throw new AppError('BACKUP_INVALID', 'backup index shape is invalid');
    }
    return index;
  }

  async _writeIndex(policy, index, { expectedVersion = null } = {}) {
    await ensureDir(policy.destinationRoot);
    if (expectedVersion !== null) {
      const onDisk = await this._readIndex(policy);
      const diskVersion = Number.isSafeInteger(onDisk.version) ? onDisk.version : 0;
      if (diskVersion !== expectedVersion) {
        throw new AppError('BACKUP_INVALID', 'backup index version conflict (CAS)', {
          details: { expectedVersion, diskVersion }
        });
      }
    }
    index.version = (Number.isSafeInteger(index.version) ? index.version : 0) + 1;
    index.updatedAt = nowIso(this.now);
    await atomicWriteJson(this._indexFile(policy), index);
  }

  /**
   * Serialized (in-process + cross-process file lock) index read-modify-write
   * with a version CAS; a concurrent writer triggers one CAS retry.
   */
  async _mutateIndex(policy, mutator, { attempts = 2 } = {}) {
    return this._withIndexLock(async () => {
      const token = await this._acquireIndexFileLock(policy);
      try {
        let lastError = null;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          const index = await this._readIndex(policy);
          const version = Number.isSafeInteger(index.version) ? index.version : 0;
          const result = await mutator(index);
          try {
            await this._writeIndex(policy, index, { expectedVersion: version });
            return result;
          } catch (error) {
            if (error.code !== 'BACKUP_INVALID' || error.details?.expectedVersion === undefined) throw error;
            lastError = error;
          }
        }
        throw lastError || new AppError('BACKUP_INVALID', 'backup index update conflict');
      } finally {
        await this._releaseIndexFileLock(policy, token);
      }
    });
  }

  async _requireHuman(humanContext, binding) {
    if (!this.humanProof) throw new AppError('TRUST_UNAVAILABLE', 'human proof verifier is not configured');
    return this.humanProof.assert(humanContext, binding);
  }

  async _assertGateForBackup() {
    const state = await this.store.getSnapshot();
    if (state.migration?.phase !== 'active') {
      throw new AppError('MIGRATION_BLOCKED', 'backup cannot create a point during migration');
    }
    if (['blocked'].includes(state.recovery?.phase)) {
      throw new AppError('RECOVERY_GAP', 'backup is blocked while recovery is blocked');
    }
    if (state.checkpointFence) {
      const fence = state.checkpointFence;
      const expired = Date.parse(fence.expiresAt || '') <= this.now().getTime();
      let sameOwner = false;
      let startUnknown = false;
      if (isProcessAlive(fence.ownerPid)) {
        const actualStart = getProcessStartMs(fence.ownerPid);
        const recordedStart = Date.parse(fence.processStartedAt || '');
        if (actualStart === null) startUnknown = true;
        else sameOwner = Number.isFinite(recordedStart) && Math.abs(actualStart - recordedStart) <= 5000;
      }
      if (!expired || sameOwner || startUnknown) {
        throw new AppError('BACKUP_INVALID', 'another checkpoint fence is active', { details: { fenceId: fence.id } });
      }
    }
    return state;
  }

  async _assertDestinationCapacity(policy, kind, state) {
    const stateBytes = Buffer.byteLength(JSON.stringify(state || {}));
    let mediaBytes = 0;
    if (kind === 'full') {
      for (const artifact of Object.values(state?.artifacts || {})) {
        if (Number.isSafeInteger(artifact.sizeBytes)) mediaBytes += artifact.sizeBytes;
      }
    }
    const requiredBytes = Math.ceil((stateBytes + mediaBytes) * 1.2) + 8 * 1024 * 1024;
    let stats = null;
    try {
      stats = await this.statfs(policy.destinationRoot);
    } catch {
      return true;
    }
    const freeBytes = Number(stats?.bavail) * Number(stats?.bsize);
    if (!Number.isFinite(freeBytes)) return true;
    if (freeBytes < requiredBytes) {
      throw new AppError('BACKUP_INVALID', 'backup destination does not have enough free space', {
        details: { freeBytes, requiredBytes, kind }
      });
    }
    return true;
  }

  async create({ kind = 'ledger', requestId }, humanContext) {
    return this._create({ kind, requestId, humanContext, scheduled: false });
  }

  /**
   * Internal scheduler entry. It is deliberately not exposed by
   * CommandService/CLI: only a policy explicitly enabled by the owner can cause
   * an automatic recovery point, and that policy is the human authorization.
   */
  async createScheduled({ kind = 'ledger', requestId } = {}) {
    return this._create({
      kind,
      requestId,
      humanContext: {
        principal: {
          id: 'system:backup-scheduler',
          kind: 'service',
          role: 'system',
          scopes: []
        }
      },
      scheduled: true
    });
  }

  async _create({ kind = 'ledger', requestId, humanContext = null, scheduled = false }) {
    if (!BACKUP_KINDS.includes(kind)) throw new AppError('CONFIG_INVALID', 'backup kind must be ledger or full');
    if (typeof requestId !== 'string' || requestId === '') throw new AppError('CONFIG_INVALID', 'requestId is required');
    const policy = await this._policy();
    if (scheduled !== true) {
      await this._requireHuman(humanContext, { action: 'backup.create', kind, requestId });
    } else if (policy.scheduleEnabled !== true) {
      throw new AppError('BACKUP_UNPROTECTED', 'scheduled backup requires an explicitly enabled policy');
    }
    const actor = scheduled ? 'system:backup-scheduler' : humanContext.principal.id;
    if (typeof this.prepareCapture === 'function') {
      // Complete provable multi-file commits before the capture boundary; the
      // hook is injected by the runtime and must be read-only outside recovery.
      await this.prepareCapture({ kind, requestId, scheduled });
    }
    await this._assertGateForBackup();
    const preCaptureState = await this.store.getSnapshot();
    await this._assertDestinationCapacity(policy, kind, preCaptureState);
    const index = await this._readIndex(policy);
    let effectiveRequestId = requestId;
    const existing = Object.values(index.backups).find((entry) => entry.requestId === requestId);
    if (existing) {
      if (existing.kind !== kind) throw new AppError('IDEMPOTENCY_CONFLICT', 'requestId was used for another backup kind');
      if (existing.status === 'verified' || scheduled !== true) {
        return { ...existing, deduplicated: true };
      }
      // A scheduled point can be invalidated by daily verify. Reusing the same
      // deterministic requestId would return that invalid entry forever, so the
      // scheduler gets a fresh attempt id instead.
      effectiveRequestId = `${requestId}:retry:${randomId('r').split('_').at(-1)}`;
    }
    const backupId = `backup_${randomId('b').split('_').at(-1)}`;
    const startedAt = nowIso(this.now);
    const checkpointTimeoutMs = policy.checkpointTimeoutMs;
    const capture = await this.store.transaction(async (draft, tx) => {
      await this._assertGateForBackupInTransaction(draft);
      const cutAt = nowIso(this.now);
      const sanitized = sanitizeStateForBackup(draft);
      const pendingExcluded = [
        ...Object.keys(sanitized.artifactPendingImports || {}).map((id) => `artifactPendingImport:${id}`),
        ...Object.values(sanitized.diaries || {})
          .filter((entry) => entry.pendingCommit)
          .map((entry) => `diaryPendingCommit:${entry.diaryId || entry.date || 'unknown'}`)
      ];
      const recoveryState = sanitized.recovery || null;
      const parentRecovery =
        recoveryState?.id
          ? {
              caseId: recoveryState.id,
              revision: recoveryState.revision || 0,
              phase: recoveryState.phase || null,
              parentBackupId: recoveryState.parent?.backupId || null,
              parentSnapshotHash: recoveryState.parent?.snapshotHash || null,
              evidenceRefs: (recoveryState.holds || [])
                .flatMap((hold) => hold.evidenceRefs || [])
                .map((ref) => (typeof ref === 'string' ? ref : ref?.id))
                .filter(Boolean)
            }
          : null;
      const fence = {
        id: `fence_${backupId}`,
        kind: 'backup',
        backupId,
        ownerPid: process.pid,
        processStartedAt: processStartIso(),
        startedAt: cutAt,
        expiresAt: new Date(this.now().getTime() + checkpointTimeoutMs).toISOString()
      };
      draft.checkpointFence = fence;
      draft.backups[backupId] = {
        backupId,
        requestId: effectiveRequestId,
        kind,
        status: 'capturing',
        cutAt,
        startedAt,
        ownerPid: process.pid
      };
      tx.appendEvent({
        type: 'backup.capture.started',
        actor,
        payload: { backupId, kind, cutAt }
      });
      return {
        state: sanitized,
        cutAt,
        fence,
        pendingExcluded,
        parentRecovery,
        sourceStateHash: computeSourceStateHash({ state: sanitized, cutAt }),
        configRevision: deepClone(sanitized.configRevision),
        timeZone: sanitized.timeZone || 'Asia/Shanghai',
        historyEpoch: sanitized.historyEpoch,
        eventSeq: sanitized.eventSeq
      };
    });
    await this.hooks.afterCapture?.({ backupId, capture });
    await this.store.transaction(async (draft, tx) => {
      if (draft.checkpointFence?.backupId === backupId) {
        draft.checkpointFence = null;
        tx.appendEvent({
          type: 'backup.capture.completed',
          actor: 'system',
          payload: { backupId, cutEventSeq: capture.eventSeq }
        });
      }
    });
    const root = path.join(policy.destinationRoot, 'backups');
    const tmpDir = path.join(policy.destinationRoot, '.tmp', backupId);
    const finalDir = path.join(root, backupId);
    try {
      await ensureDir(tmpDir);
      const files = [];
      const stateJson = `${JSON.stringify(capture.state, null, 2)}\n`;
      await atomicWriteFile(path.join(tmpDir, 'state.json'), stateJson);
      files.push({
        path: 'state.json',
        role: 'state',
        sizeBytes: Buffer.byteLength(stateJson),
        sha256: sha256Hex(stateJson),
        required: true
      });
      const currentSegments = Object.values(capture.state.journalSegments || {})
        .sort((a, b) => a.historyEpoch.localeCompare(b.historyEpoch) || a.startSeq - b.startSeq);
      for (const segment of currentSegments) {
        if (!isSafeRelativePath(segment.relativePath)) {
          throw new AppError('JOURNAL_CORRUPTED', 'journal segment path is unsafe');
        }
        const source = resolveInside(this.journalDir, segment.relativePath);
        if (!(await pathExists(source))) throw new AppError('JOURNAL_CORRUPTED', 'journal segment is missing');
        const entry = await writeFileEntry(tmpDir, path.posix.join('journal', segment.relativePath), source, {
          role: 'journal',
          required: true
        });
        files.push(entry);
      }
      const pendingCount = Object.keys(capture.state.journalPending || {}).length;
      const artifactIds = Object.keys(capture.state.artifacts || {});
      const includedArtifacts = [];
      const missingArtifacts = [];
      if (kind === 'full') {
        for (const artifactId of artifactIds) {
          const artifact = capture.state.artifacts[artifactId];
          if (!isSafeRelativePath(artifact.relativePath)) {
            throw new AppError('ARTIFACT_INVALID', 'artifact path is unsafe');
          }
          const source = resolveInside(this.artifactStore.rootDir, artifact.relativePath);
          if (!(await pathExists(source))) {
            throw new AppError('BACKUP_INVALID', `full backup is missing artifact bytes: ${artifactId}`);
          }
          await this.hooks.beforeArtifactCopy?.({ artifactId, source, tmpDir });
          const entry = await writeFileEntry(
            tmpDir,
            path.posix.join('artifacts', artifact.relativePath),
            source,
            { role: 'artifact', artifactId, required: true }
          );
          if (entry.sha256 !== artifact.sha256 || entry.sizeBytes !== artifact.sizeBytes) {
            throw new AppError('BACKUP_INVALID', 'artifact bytes do not match the ledger');
          }
          files.push(entry);
          includedArtifacts.push(artifactId);
        }
      } else {
        // A ledger point carries metadata and archive facts, not media bytes.
        for (const artifactId of artifactIds) {
          const artifact = capture.state.artifacts[artifactId];
          const source = resolveInside(this.artifactStore.rootDir, artifact.relativePath);
          const available = await pathExists(source);
          missingArtifacts.push(artifactId);
          if (!available) {
            artifact.availability = 'missing_at_cut';
          }
        }
      }
      const manifest = {
        schemaVersion: BACKUP_SCHEMA_VERSION,
        kind: 'backup',
        tier: kind,
        stateVersion: 3,
        backupId,
        workspaceId: capture.state.workspaceId,
        sourceInstanceId: (await this.store.getInstance())?.instanceId || null,
        sourceHistoryEpoch: capture.historyEpoch,
        cutEventSeq: capture.eventSeq,
        cutAt: capture.cutAt,
        configRevision: capture.configRevision,
        timeZone: capture.timeZone,
        sourceStateHash: capture.sourceStateHash,
        journalCoverage: {
          historyEpoch: capture.historyEpoch,
          eventSeq: capture.eventSeq,
          segments: currentSegments.length,
          journalPending: pendingCount
        },
        diaryCoverage: {
          mode: 'derived',
          reason: 'diary_bodies_rebuilt_from_archived_events'
        },
        mediaCoverage: {
          mode: kind,
          included: includedArtifacts,
          missing: missingArtifacts,
          rebuildable: pendingCount > 0 ? ['journalPending'] : [],
          complete: kind === 'full' ? missingArtifacts.length === 0 : false
        },
        excludedData: [
          'credentials',
          'approval_nonces',
          'migration_release_tickets',
          'local_path_authorizations',
          'host_session_secrets',
          'variable_diary_bodies'
        ],
        failureDomain: policy.failureDomain,
        failureDomainVerifiedBy: policy.verifiedBy,
        pendingExcluded: capture.pendingExcluded || [],
        parentRecovery: capture.parentRecovery || null,
        createdAt: startedAt,
        completedAt: nowIso(this.now),
        files
      };
      manifest.snapshotHash = computeSnapshotHash(manifest);
      await atomicWriteFile(path.join(tmpDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      await this.hooks.beforeManifestPublish?.({ backupId, tmpDir, manifest });
      await this.store.transaction(async (draft, tx) => {
        draft.backups[backupId] = {
          ...(draft.backups[backupId] || {}),
          status: 'copying',
          manifestHash: manifest.snapshotHash
        };
        tx.appendEvent({
          type: 'backup.copy.completed',
          actor: 'system',
          payload: {
            backupId,
            tier: kind,
            files: files.length,
            mediaCoverage: manifest.mediaCoverage
          }
        });
      });
      await this.hooks.beforeBackupPublish?.({ backupId, tmpDir, finalDir });
      await ensureDir(root);
      await fsp.rename(tmpDir, finalDir);
      const verified = await verifyBackupDirectory(finalDir, { now: this.now });
      const indexEntry = {
        backupId,
        requestId: effectiveRequestId,
        kind,
        status: 'verified',
        createdAt: startedAt,
        completedAt: manifest.completedAt,
        cutAt: manifest.cutAt,
        sourceHistoryEpoch: manifest.sourceHistoryEpoch,
        cutEventSeq: manifest.cutEventSeq,
        configRevision: manifest.configRevision,
        timeZone: manifest.timeZone,
        sourceStateHash: manifest.sourceStateHash,
        snapshotHash: manifest.snapshotHash,
        failureDomain: manifest.failureDomain,
        failureDomainVerifiedBy: manifest.failureDomainVerifiedBy,
        journalCoverage: manifest.journalCoverage,
        mediaCoverage: manifest.mediaCoverage,
        pendingExcluded: manifest.pendingExcluded || [],
        parentRecovery: manifest.parentRecovery || null,
        files: manifest.files.length,
        verifiedAt: nowIso(this.now),
        restoreTestedAt: null,
        pinned: false
      };
      const savedEntry = await this._mutateIndex(policy, (latestIndex) => {
        latestIndex.backups[backupId] = indexEntry;
        latestIndex.mediaUnprotected = latestIndex.mediaUnprotected === true;
        return latestIndex.backups[backupId];
      });
      await this.store.transaction(async (draft) => {
        draft.backups[backupId] = {
          ...(draft.backups[backupId] || {}),
          status: 'verified',
          verifiedAt: nowIso(this.now),
          mediaCoverage: manifest.mediaCoverage
        };
      });
      return { ...savedEntry, deduplicated: false, verify: verified };
    } catch (error) {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      await this.store.transaction(async (draft) => {
        if (draft.checkpointFence?.backupId === backupId) draft.checkpointFence = null;
        draft.backups[backupId] = {
          ...(draft.backups[backupId] || {}),
          status: 'failed',
          error: { code: error.code || 'BACKUP_INVALID', message: error.message }
        };
      }).catch(() => {});
      try {
        await this._mutateIndex(policy, (failedIndex) => {
          failedIndex.lastError = {
            backupId,
            at: nowIso(this.now),
            code: error.code || 'BACKUP_INVALID',
            message: error.message
          };
          return true;
        });
      } catch {
        // Keep the original error.
      }
      throw error;
    }
  }

  async _assertGateForBackupInTransaction(draft) {
    if (draft.migration?.phase !== 'active') {
      throw new AppError('MIGRATION_BLOCKED', 'backup cannot create a point during migration');
    }
    if (draft.checkpointFence) {
      const fence = draft.checkpointFence;
      const expired = Date.parse(fence.expiresAt || '') <= this.now().getTime();
      let sameOwner = false;
      let startUnknown = false;
      if (isProcessAlive(fence.ownerPid)) {
        const actualStart = getProcessStartMs(fence.ownerPid);
        const recordedStart = Date.parse(fence.processStartedAt || '');
        if (actualStart === null) startUnknown = true;
        else sameOwner = Number.isFinite(recordedStart) && Math.abs(actualStart - recordedStart) <= 5000;
      }
      if (!expired || sameOwner || startUnknown) {
        throw new AppError('BACKUP_INVALID', 'another checkpoint fence is active');
      }
    }
    if (['readonly', 'reconciling', 'blocked'].includes(draft.recovery?.phase)) {
      // Management-path backups of an already validated read-only copy are
      // allowed only via the recovery service; a normal store cannot claim a
      // fresh healthy point from suspicious data.
      throw new AppError('RECOVERY_GAP', 'normal backup is not allowed during this recovery phase');
    }
  }

  async verify(backupId) {
    const policy = await this._policy();
    const index = await this._readIndex(policy);
    if (!index.backups[backupId]) throw new AppError('BACKUP_INVALID', 'backup not found');
    const dir = path.join(policy.destinationRoot, 'backups', backupId);
    try {
      const result = await verifyBackupDirectory(dir, { now: this.now });
      const entry = await this._mutateIndex(policy, (latestIndex) => {
        const current = latestIndex.backups[backupId];
        if (!current) throw new AppError('BACKUP_INVALID', 'backup disappeared during verify');
        current.status = 'verified';
        current.verifiedAt = nowIso(this.now);
        current.mediaCoverage = result.manifest.mediaCoverage;
        latestIndex.lastError = null;
        latestIndex.mediaUnprotected = !Object.values(latestIndex.backups).some(
          (point) => point.status === 'verified' && point.kind === 'full'
        );
        return current;
      });
      return { ...entry, ...result, verified: true };
    } catch (error) {
      const entry = await this._mutateIndex(policy, (latestIndex) => {
        const current = latestIndex.backups[backupId];
        if (!current) return { backupId, status: 'invalid' };
        current.status = 'invalid';
        latestIndex.lastError = { backupId, at: nowIso(this.now), code: error.code, message: error.message };
        return current;
      });
      return { ...entry, verified: false, error: { code: error.code, message: error.message } };
    }
  }

  /**
   * Verify at most one latest ledger and one latest full point per UTC day.
   * The check is persisted in the destination index so a restart does not
   * hammer the same corrupted point every tick.
   */
  async dailyVerify() {
    const policy = await this._policy();
    const today = nowIso(this.now).slice(0, 10);
    let index = await this._readIndex(policy);
    if (index.lastDailyVerifyDate === today) {
      return { date: today, checked: [], skipped: true, reason: 'already_verified_today' };
    }
    const verified = Object.values(index.backups)
      .filter((entry) => entry.status === 'verified')
      .sort((a, b) => String(b.cutAt).localeCompare(String(a.cutAt)));
    const latestByKind = new Map();
    for (const entry of verified) {
      if (!latestByKind.has(entry.kind)) latestByKind.set(entry.kind, entry);
    }
    const checked = [];
    for (const kind of ['ledger', 'full']) {
      const entry = latestByKind.get(kind);
      if (!entry) continue;
      const result = await this.verify(entry.backupId);
      checked.push({
        backupId: entry.backupId,
        kind,
        verified: result.verified === true,
        error: result.error || null
      });
    }
    await this._mutateIndex(policy, (latestIndex) => {
      latestIndex.lastDailyVerifyDate = today;
      latestIndex.lastDailyVerifyAt = nowIso(this.now);
      return true;
    });
    return { date: today, checked, skipped: false };
  }

  async recordRestoreTest(
    { backupId, recoveryId, targetInstanceId, newHistoryEpoch, restoredAt = null },
    humanContext
  ) {
    await this._requireHuman(humanContext, { action: 'backup.record-restore', backupId, recoveryId });
    const result = await this.noteRestoreTest(
      { backupId, recoveryId, targetInstanceId, newHistoryEpoch, restoredAt },
      { recordedBy: humanContext.principal.id }
    );
    if (!result.recorded) {
      throw new AppError('BACKUP_INVALID', 'restore test backup was not found in this policy', {
        details: { reason: result.reason }
      });
    }
    return result;
  }

  /**
   * Called by the recovery service only after all restore files were written.
   * A point outside this policy's destination simply returns recorded=false.
   */
  async noteRestoreTest(
    { backupId, recoveryId, targetInstanceId, newHistoryEpoch, restoredAt = null },
    { recordedBy = 'system:recovery' } = {}
  ) {
    if (typeof backupId !== 'string' || backupId === '') {
      return { recorded: false, reason: 'unknown_backup' };
    }
    if (typeof recoveryId !== 'string' || recoveryId === '') {
      throw new AppError('CONFIG_INVALID', 'recoveryId is required for a restore test record');
    }
    const policy = await this._policy({ required: false });
    if (!policy) return { recorded: false, reason: 'policy_not_configured' };
    const testedAt = nowIso(this.now);
    const result = await this._mutateIndex(policy, (index) => {
      const entry = index.backups[backupId];
      if (!entry) return { recorded: false, reason: 'unknown_backup' };
      if (entry.status !== 'verified') {
        throw new AppError('BACKUP_INVALID', 'only a verified recovery point can record a restore test');
      }
      if (entry.restoreTestedAt && entry.restoreTest?.recoveryId === recoveryId) {
        return { recorded: true, deduplicated: true, backupId, restoreTestedAt: entry.restoreTestedAt };
      }
      entry.restoreTestedAt = testedAt;
      entry.restoreTest = {
        recoveryId,
        targetInstanceId: targetInstanceId || null,
        newHistoryEpoch: newHistoryEpoch || null,
        restoredAt: restoredAt || null,
        recordedAt: testedAt,
        recordedBy
      };
      return {
        recorded: true,
        deduplicated: false,
        backupId,
        restoreTestedAt: testedAt,
        restoreTest: entry.restoreTest
      };
    });
    if (!result.recorded || result.deduplicated) return result;
    if (this.store) {
      await this.store
        .transaction(async (draft, tx) => {
          if (!draft.backups[backupId]) return;
          draft.backups[backupId].restoreTestedAt = testedAt;
          draft.backups[backupId].restoreTest = result.restoreTest;
          tx.appendEvent({
            type: 'backup.restore_tested',
            actor: recordedBy,
            payload: {
              backupId,
              recoveryId,
              targetInstanceId: targetInstanceId || null,
              newHistoryEpoch: newHistoryEpoch || null
            }
          });
        })
        .catch((error) => {
          this.logger?.warn?.('backup restore test ledger note failed', { message: error.message });
        });
    }
    const { restoreTest, ...publicResult } = result;
    return publicResult;
  }

  async status() {
    const policy = await this._policy({ required: false });
    if (!policy) {
      return {
        configured: false,
        status: 'unprotected',
        reason: 'policy_not_configured',
        scheduleEnabled: false
      };
    }
    const index = await this._readIndex(policy);
    const points = Object.values(index.backups)
      .filter((entry) => ['verified', 'invalid', 'failed'].includes(entry.status))
      .sort((a, b) => String(b.cutAt).localeCompare(String(a.cutAt)));
    const latest = points.find((entry) => entry.status === 'verified') || null;
    const latestFull = points.find((entry) => entry.status === 'verified' && entry.kind === 'full') || null;
    return {
      configured: true,
      scheduleEnabled: policy.scheduleEnabled,
      destinationConfigured: true,
      failureDomain: policy.failureDomain,
      failureDomainVerifiedBy: policy.verifiedBy,
      intervalMinutes: policy.intervalMinutes,
      maxPointAgeMinutes: policy.maxPointAgeMinutes,
      fullIntervalHours: policy.fullIntervalHours,
      autoPrune: policy.autoPrune,
      points: points.length,
      latest: latest
        ? {
            backupId: latest.backupId,
            kind: latest.kind,
            cutAt: latest.cutAt,
            ageMs: Math.max(0, this.now().getTime() - Date.parse(latest.cutAt)),
            verifiedAt: latest.verifiedAt || null,
            restoreTestedAt: latest.restoreTestedAt || null,
            mediaCoverage: latest.mediaCoverage
          }
        : null,
      latestFull: latestFull
        ? {
            backupId: latestFull.backupId,
            cutAt: latestFull.cutAt,
            verifiedAt: latestFull.verifiedAt || null,
            restoreTestedAt: latestFull.restoreTestedAt || null,
            mediaCoverage: latestFull.mediaCoverage
          }
        : null,
      lastDailyVerifyDate: index.lastDailyVerifyDate || null,
      lastDailyVerifyAt: index.lastDailyVerifyAt || null,
      lastError: index.lastError || null,
      mediaUnprotected: latestFull === null,
      mediaUnprotectedReason: latestFull === null ? 'no_verified_full_recovery_point' : null
    };
  }

  async getProtection(scope = null) {
    try {
      const policy = await this._policy({ required: false });
      if (!policy || !policy.failureDomain || !policy.verifiedBy) {
        return { status: 'unprotected', reason: 'policy_not_configured' };
      }
      if (!(await pathExists(policy.destinationRoot))) {
        return { status: 'unprotected', reason: 'destination_unavailable' };
      }
      const index = await this._readIndex(policy);
      const points = Object.values(index.backups)
        .filter((entry) => entry.status === 'verified')
        .sort((a, b) => String(b.cutAt).localeCompare(String(a.cutAt)));
      if (points.length === 0) return { status: 'unprotected', reason: 'no_verified_recovery_point' };
      const latest = points[0];
      const latestFull = points.find((entry) => entry.kind === 'full') || null;
      const ageMs = Math.max(0, this.now().getTime() - Date.parse(latest.cutAt));
      const mediaStatus = {
        mediaUnprotected: latestFull === null,
        mediaUnprotectedReason: latestFull === null ? 'no_verified_full_recovery_point' : null,
        latestFullBackupId: latestFull?.backupId || null,
        latestFullCutAt: latestFull?.cutAt || null
      };
      if (ageMs > policy.maxPointAgeMinutes * 60 * 1000) {
        return {
          status: 'degraded',
          reason: 'recovery_point_stale',
          backupId: latest.backupId,
          cutAt: latest.cutAt,
          ageMs,
          maxPointAgeMinutes: policy.maxPointAgeMinutes,
          ...mediaStatus
        };
      }
      return {
        status: 'protected',
        backupId: latest.backupId,
        kind: latest.kind,
        cutAt: latest.cutAt,
        ageMs,
        tier: latest.kind,
        mediaCoverage: latest.mediaCoverage,
        ...mediaStatus
      };
    } catch (error) {
      return { status: 'invalid', reason: error.code || 'BACKUP_INVALID', message: error.message };
    }
  }

  async _activeRecoveryRefs() {
    const backupIds = new Set();
    let caseId = null;
    const candidates = [];
    if (this.recoveryDir) candidates.push(path.join(this.recoveryDir, 'recovery.json'));
    if (this.dataDir) candidates.push(path.join(this.dataDir, 'recovery', 'recovery.json'));
    for (const file of candidates) {
      if (!(await pathExists(file))) continue;
      let recoveryCase;
      try {
        recoveryCase = JSON.parse(await fsp.readFile(file, 'utf8'));
      } catch {
        continue;
      }
      if (!recoveryCase?.id) continue;
      caseId = recoveryCase.id;
      for (const backupId of [
        recoveryCase.backupRef?.backupId,
        recoveryCase.parentHistory?.backupId,
        ...(recoveryCase.evidenceRefs || []).map((ref) => ref.backupId),
        ...(recoveryCase.decisions || []).map((decision) => decision.recoveryPointBackupId),
        ...(recoveryCase.holds || []).flatMap((hold) => (hold.evidenceRefs || []).map((ref) => ref.backupId))
      ]) {
        if (typeof backupId === 'string' && backupId !== '') backupIds.add(backupId);
      }
      for (const evidence of recoveryCase.authorizationPreconditions || []) {
        if (typeof evidence.recoveryPointBackupId === 'string') backupIds.add(evidence.recoveryPointBackupId);
      }
    }
    return { caseId, backupIds };
  }

  async planPrune() {
    const policy = await this._policy();
    const index = await this._readIndex(policy);
    const verified = Object.values(index.backups)
      .filter((entry) => entry.status === 'verified')
      .sort((a, b) => String(b.cutAt).localeCompare(String(a.cutAt)));
    const keep = new Set();
    const recent = verified.slice(0, policy.keepRecent);
    for (const entry of recent) keep.add(entry.backupId);
    const daily = new Map();
    for (const entry of verified) {
      const date = String(entry.cutAt).slice(0, 10);
      if (!daily.has(date)) daily.set(date, entry);
    }
    for (const entry of [...daily.values()].slice(0, policy.keepDaily)) keep.add(entry.backupId);
    const weekly = new Map();
    for (const entry of verified) {
      const date = new Date(entry.cutAt);
      const first = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
      const week = Math.ceil(((date - first) / 86400000 + first.getUTCDay() + 1) / 7);
      const key = `${date.getUTCFullYear()}-${week}`;
      if (!weekly.has(key)) weekly.set(key, entry);
    }
    for (const entry of [...weekly.values()].slice(0, policy.keepWeekly)) keep.add(entry.backupId);
    const lastLedger = verified.find((entry) => entry.kind === 'ledger');
    const lastFull = verified.find((entry) => entry.kind === 'full');
    if (lastLedger) keep.add(lastLedger.backupId);
    if (lastFull) keep.add(lastFull.backupId);
    for (const entry of verified) {
      if (entry.pinned) keep.add(entry.backupId);
    }
    const activeRefs = await this._activeRecoveryRefs();
    for (const backupId of activeRefs.backupIds) {
      if (verified.some((entry) => entry.backupId === backupId)) keep.add(backupId);
    }
    const deleteEntries = verified.filter((entry) => !keep.has(entry.backupId));
    const retainedFulls = verified.filter((entry) => keep.has(entry.backupId) && entry.kind === 'full');
    const plan = {
      schemaVersion: 1,
      planId: null,
      createdAt: nowIso(this.now),
      policyRevision: jcsHash(policy),
      keep: [...keep].sort(),
      delete: deleteEntries.map((entry) => ({
        backupId: entry.backupId,
        kind: entry.kind,
        cutAt: entry.cutAt,
        cutEventSeq: entry.cutEventSeq
      })),
      protected: {
        lastLedger: lastLedger?.backupId || null,
        lastFull: lastFull?.backupId || null,
        pinned: verified.filter((entry) => entry.pinned).map((entry) => entry.backupId),
        recoveryCaseId: activeRefs.caseId,
        recoveryPins: [...activeRefs.backupIds].sort()
      },
      mediaAfterPrune: {
        fullRetained: retainedFulls.length > 0,
        retainedFullIds: retainedFulls.map((entry) => entry.backupId),
        completeCoverage: retainedFulls.some((entry) => entry.mediaCoverage?.complete === true)
      }
    };
    plan.planId = sha256Hex(
      JSON.stringify({
        policyRevision: plan.policyRevision,
        keep: plan.keep,
        delete: plan.delete,
        protected: plan.protected,
        mediaAfterPrune: plan.mediaAfterPrune
      })
    );
    const planDir = path.join(policy.destinationRoot, '.prune-plans');
    await ensureDir(planDir);
    await atomicWriteJson(path.join(planDir, `${plan.planId}.json`), plan);
    return plan;
  }

  async prune({ planId }, humanContext) {
    const policy = await this._policy();
    await this._requireHuman(humanContext, { action: 'backup.prune', planId });
    if (typeof planId !== 'string' || planId === '') throw new AppError('CONFIG_INVALID', 'planId is required');
    const planDir = path.join(policy.destinationRoot, '.prune-plans');
    const planFile = path.join(planDir, `${planId}.json`);
    if (!(await pathExists(planFile))) throw new AppError('BACKUP_INVALID', 'prune plan not found');
    const plan = JSON.parse(await fsp.readFile(planFile, 'utf8'));
    const recomputed = await this.planPrune();
    if (recomputed.planId !== planId) {
      throw new AppError('BACKUP_INVALID', 'prune plan is stale; re-plan before deleting');
    }
    return this._mutateIndex(policy, async (index) => {
      const activePins = new Set(plan.protected.recoveryPins || recomputed.protected.recoveryPins || []);
      const deleted = [];
      for (const entry of plan.delete) {
        const backup = index.backups[entry.backupId];
        if (!backup || backup.status !== 'verified') continue;
        if (entry.backupId === plan.protected.lastFull || entry.backupId === plan.protected.lastLedger) {
          throw new AppError('BACKUP_INVALID', 'prune plan attempted to delete a protected last point');
        }
        if (activePins.has(entry.backupId)) {
          throw new AppError('BACKUP_INVALID', 'prune plan attempted to delete a recovery-referenced point');
        }
        const dir = path.join(policy.destinationRoot, 'backups', entry.backupId);
        if (!ensureWithin(path.join(policy.destinationRoot, 'backups'), dir)) {
          throw new AppError('BACKUP_INVALID', 'prune target escapes the backup root');
        }
        await fsp.rm(dir, { recursive: true, force: true });
        delete index.backups[entry.backupId];
        deleted.push(entry.backupId);
      }
      const remainingVerified = Object.values(index.backups).filter((entry) => entry.status === 'verified');
      const retainedFulls = remainingVerified.filter((entry) => entry.kind === 'full');
      const mediaUnprotected = retainedFulls.length === 0;
      index.mediaUnprotected = mediaUnprotected;
      index.mediaUnprotectedReason = mediaUnprotected ? 'no_verified_full_recovery_point' : null;
      return {
        deleted,
        planId,
        kept: plan.keep.length,
        mediaCoverage: {
          fullRetained: retainedFulls.length > 0,
          retainedFullIds: retainedFulls.map((entry) => entry.backupId),
          mediaUnprotected
        }
      };
    });
  }
}

/* ------------------------------------------------------------------ *
 * Explicit backup scheduling (SPEC §27.1 / T20)
 * ------------------------------------------------------------------ */

export class BackupScheduler {
  constructor({
    backupService,
    policyService,
    now = () => new Date(),
    logger,
    tickMs = 60000
  } = {}) {
    if (!backupService || !policyService) {
      throw new AppError('CONFIG_INVALID', 'backup scheduler requires backup and policy services');
    }
    if (!Number.isSafeInteger(tickMs) || tickMs < 100) {
      throw new AppError('CONFIG_INVALID', 'backup scheduler tickMs must be an integer >= 100');
    }
    this.backupService = backupService;
    this.policyService = policyService;
    this.now = now;
    this.logger = logger;
    this.tickMs = tickMs;
    this.timer = null;
    this.started = false;
    this._tickPromise = null;
    this.lastTickAt = null;
    this.lastTickResult = null;
    this.lastError = null;
  }

  async _policy() {
    return this.policyService.load({ missingOk: true });
  }

  async start() {
    if (this.started) return { started: true, deduplicated: true, tickMs: this.tickMs };
    const policy = await this._policy();
    if (!policy || policy.scheduleEnabled !== true) {
      return { started: false, reason: 'schedule_disabled' };
    }
    this.started = true;
    this.timer = setInterval(() => {
      this.tick().catch((error) => {
        this.lastError = { code: error.code || 'DEPENDENCY_UNAVAILABLE', message: error.message };
        this.logger?.warn?.('backup scheduler tick failed', { message: error.message });
      });
    }, this.tickMs);
    this.timer.unref?.();
    return {
      started: true,
      deduplicated: false,
      tickMs: this.tickMs,
      nextTickAt: new Date(this.now().getTime() + this.tickMs).toISOString()
    };
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.started = false;
    if (this._tickPromise) {
      let timeout;
      const timer = new Promise((resolve) => {
        timeout = setTimeout(resolve, 5000);
        timeout.unref?.();
      });
      await Promise.race([this._tickPromise, timer]);
      clearTimeout(timeout);
    }
    return { stopped: true };
  }

  async status() {
    let policy = null;
    let policyError = null;
    try {
      policy = await this._policy();
    } catch (error) {
      policyError = { code: error.code || 'BACKUP_INVALID', message: error.message };
    }
    return {
      configured: Boolean(policy),
      scheduleEnabled: policy?.scheduleEnabled === true,
      started: this.started,
      tickMs: this.tickMs,
      lastTickAt: this.lastTickAt,
      lastTickResult: this.lastTickResult,
      lastError: this.lastError,
      policyError
    };
  }

  _requestId(kind, latest, intervalMs, nowMs) {
    if (kind === 'full' && !latest) return 'scheduled-full:initial';
    const slot = latest
      ? Date.parse(latest.cutAt) + intervalMs
      : Math.floor(nowMs / intervalMs) * intervalMs;
    return `scheduled-${kind}:${new Date(slot).toISOString()}`;
  }

  async tick() {
    if (!this.started) {
      return { skipped: true, reason: 'scheduler_stopped', ran: [], errors: [] };
    }
    if (this._tickPromise) return this._tickPromise;
    this._tickPromise = this._runTick().finally(() => {
      this._tickPromise = null;
    });
    return this._tickPromise;
  }

  async _runTick() {
    const startedAt = nowIso(this.now);
    this.lastTickAt = startedAt;
    const policy = await this._policy();
    if (!policy || policy.scheduleEnabled !== true) {
      this.lastTickResult = { skipped: true, reason: 'schedule_disabled', ran: [], errors: [] };
      return this.lastTickResult;
    }
    const nowMs = this.now().getTime();
    const intervalMs = policy.intervalMinutes * 60 * 1000;
    const fullMs = policy.fullIntervalHours * 60 * 60 * 1000;
    const status = await this.backupService.status();
    const latest = status.latest;
    const latestFull = status.latestFull;
    const dueLedger = !latest || nowMs - Date.parse(latest.cutAt) >= intervalMs;
    const dueFull = !latestFull || nowMs - Date.parse(latestFull.cutAt) >= fullMs;
    const ran = [];
    const errors = [];
    const run = async (kind, requestId) => {
      try {
        const record = await this.backupService.createScheduled({ kind, requestId });
        ran.push({
          kind,
          backupId: record.backupId,
          deduplicated: record.deduplicated === true,
          status: record.status
        });
        return record;
      } catch (error) {
        const entry = { kind, requestId, code: error.code || 'BACKUP_INVALID', message: error.message };
        errors.push(entry);
        this.lastError = entry;
        return null;
      }
    };
    if (dueLedger) {
      await run('ledger', this._requestId('ledger', latest, intervalMs, nowMs));
    }
    if (dueFull) {
      await run('full', this._requestId('full', latestFull, fullMs, nowMs));
    }
    let verify = null;
    try {
      verify = await this.backupService.dailyVerify();
    } catch (error) {
      const entry = { kind: 'verify', code: error.code || 'BACKUP_INVALID', message: error.message };
      errors.push(entry);
      this.lastError = entry;
    }
    const result = {
      skipped: false,
      ran,
      verify,
      errors,
      tickAt: startedAt,
      finishedAt: nowIso(this.now)
    };
    this.lastTickResult = result;
    return result;
  }
}

/* ------------------------------------------------------------------ *
 * Read-only disaster recovery (SPEC §27.4-§27.7)
 * ------------------------------------------------------------------ */

export const RECOVERY_CASE_PHASES = Object.freeze([
  'readonly',
  'reconciling',
  'restricted',
  'released',
  'blocked'
]);

const ALL_ACCOUNT_ACTIONS = Object.freeze(['comment', 'dm', 'publish', 'external_publish']);

export function capabilitiesForRecoveryScope(scope, workspaceId = null) {
  const normalized = normalizeScope(scope, workspaceId);
  const capabilities = new Set(['core:read']);
  if (normalized.kind === 'workspace') {
    for (const capability of [
      'core:write',
      'platform:bilibili',
      'production:local',
      'production:paid',
      'publish:manual',
      'publish:external',
      'im'
    ]) {
      capabilities.add(capability);
    }
  } else if (normalized.kind === 'account_action') {
    capabilities.add('platform:bilibili');
    if (normalized.action === 'publish' || normalized.action === '*') capabilities.add('publish:manual');
    if (normalized.action === 'external_publish' || normalized.action === '*') capabilities.add('publish:external');
  } else if (normalized.kind === 'provider_budget') {
    capabilities.add('production:paid');
  } else if (normalized.kind === 'im_conversation') {
    capabilities.add('im');
  }
  return [...capabilities].sort();
}

function recoveryHold({ caseId, scope, revision, createdAt }) {
  return makeRecoveryHold({
    id: `hold_${randomId('h').split('_').at(-1)}`,
    caseId,
    scope,
    revision,
    evidenceRefs: [],
    createdAt
  });
}

function scopeCandidateKey(scope) {
  return `${scope.kind}:${scope.platform || ''}:${scope.accountId || ''}:${scope.action || ''}:${scope.provider || ''}:${scope.budgetId || ''}:${scope.adapterId || ''}:${scope.botAccountId || ''}:${scope.conversationId || ''}`;
}

function operationRecoveryScope(operation, workspaceId) {
  if (operation.namespace === 'platform') {
    return normalizeScope({
      kind: 'account_action',
      workspaceId,
      platform: operation.accountRef?.platform || 'bilibili',
      accountId: operation.accountRef?.accountId || '0',
      action: operation.recoveryAction || operation.action
    });
  }
  if (operation.namespace === 'external') {
    return normalizeScope({
      kind: 'account_action',
      workspaceId,
      platform: operation.accountRef?.platform || 'bilibili',
      accountId: operation.accountRef?.accountId || '0',
      action: 'external_publish'
    });
  }
  if (operation.namespace === 'provider') {
    return normalizeScope({
      kind: 'provider_budget',
      workspaceId,
      provider: operation.budget?.provider || 'unknown',
      budgetId: operation.budget?.budgetId || 'default'
    });
  }
  if (operation.namespace === 'im') {
    return normalizeScope({
      kind: 'im_conversation',
      workspaceId,
      adapterId: operation.binding?.adapterId || 'dsh-im',
      botAccountId: operation.binding?.botAccountId || 'unknown',
      conversationId: operation.binding?.conversationId || 'unknown'
    });
  }
  return normalizeScope({ kind: 'workspace', workspaceId });
}

export class RecoveryService {
  constructor({
    store,
    configService,
    recoveryDir,
    humanProof,
    effectGateway = null,
    taskManager = null,
    restoreRecorder = null,
    now = () => new Date(),
    hooks = {},
    logger
  } = {}) {
    this.store = store;
    this.configService = configService;
    this.recoveryDir = recoveryDir;
    this.humanProof = humanProof;
    this.effectGateway = effectGateway;
    this.taskManager = taskManager;
    this.restoreRecorder = restoreRecorder;
    this.now = now;
    this.hooks = hooks;
    this.logger = logger;
  }

  _caseFile() {
    return path.join(this.recoveryDir, 'recovery.json');
  }

  async _readCase() {
    const file = this._caseFile();
    if (!(await pathExists(file))) throw new AppError('RECOVERY_REQUIRED', 'recovery.json is missing');
    let value;
    try {
      value = JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch (error) {
      throw new AppError('RECOVERY_GAP', 'recovery.json is not valid JSON', { cause: error });
    }
    if (!value || value.schemaVersion !== RECOVERY_SCHEMA_VERSION || !value.id) {
      throw new AppError('RECOVERY_GAP', 'recovery.json shape is invalid');
    }
    if (!RECOVERY_CASE_PHASES.includes(value.phase)) {
      throw new AppError('RECOVERY_GAP', 'recovery phase is invalid');
    }
    return value;
  }

  async _writeCase(value) {
    await ensureDir(this.recoveryDir);
    value.updatedAt = nowIso(this.now);
    await atomicWriteJson(this._caseFile(), value);
    return value;
  }

  async _verifyProjection() {
    const state = await this.store.getSnapshot();
    const instance = await this.store.getInstance();
    const recoveryCase = await this._readCase();
    const projection = state.recovery;
    if (
      !projection ||
      projection.id !== recoveryCase.id ||
      projection.revision !== recoveryCase.revision ||
      projection.phase !== recoveryCase.phase
    ) {
      throw new AppError('RECOVERY_FENCING_REQUIRED', 'recovery.json and state.recovery projection disagree');
    }
    if (!instance || instance.recoveryRevision !== recoveryCase.revision) {
      throw new AppError('RECOVERY_FENCING_REQUIRED', 'instance recoveryRevision is inconsistent');
    }
    return { state, instance, recoveryCase };
  }

  async _requireHuman(humanContext, binding) {
    if (!this.humanProof) throw new AppError('TRUST_UNAVAILABLE', 'human proof verifier is not configured');
    return this.humanProof.assert(humanContext, binding);
  }

  _normalizeCoveredRange(range) {
    if (range === null || range === undefined) return null;
    if (typeof range !== 'object') throw new AppError('RECOVERY_GAP', 'coveredRange must be an object');
    const startAt = range.startAt ?? null;
    const endAt = range.endAt ?? null;
    const startMs = startAt === null ? null : Date.parse(startAt);
    const endMs = endAt === null ? null : Date.parse(endAt);
    if (startAt !== null && !Number.isFinite(startMs)) {
      throw new AppError('RECOVERY_GAP', 'coveredRange.startAt must be an ISO timestamp');
    }
    if (endAt !== null && !Number.isFinite(endMs)) {
      throw new AppError('RECOVERY_GAP', 'coveredRange.endAt must be an ISO timestamp');
    }
    if (startMs !== null && endMs !== null && endMs < startMs) {
      throw new AppError('RECOVERY_GAP', 'coveredRange.endAt must not precede startAt');
    }
    return {
      startAt,
      endAt,
      startEventSeq: Number.isSafeInteger(range.startEventSeq) ? range.startEventSeq : null,
      endEventSeq: Number.isSafeInteger(range.endEventSeq) ? range.endEventSeq : null,
      historyEpoch: typeof range.historyEpoch === 'string' ? range.historyEpoch : null
    };
  }

  _rangeCovers(outer, inner) {
    if (!outer || !inner) return false;
    const outerStart = Date.parse(outer.startAt);
    const outerEnd = outer.endAt === null ? null : Date.parse(outer.endAt);
    const innerStart = Date.parse(inner.startAt);
    const innerEnd = inner.endAt === null ? null : Date.parse(inner.endAt);
    if (!Number.isFinite(outerStart) || !Number.isFinite(innerStart)) return false;
    if (outerStart > innerStart) return false;
    if (innerEnd === null) return false;
    if (outerEnd === null || outerEnd < innerEnd) return false;
    if (
      Number.isSafeInteger(outer.startEventSeq) &&
      Number.isSafeInteger(inner.startEventSeq) &&
      outer.startEventSeq > inner.startEventSeq
    ) {
      return false;
    }
    if (
      Number.isSafeInteger(outer.endEventSeq) &&
      Number.isSafeInteger(inner.endEventSeq) &&
      outer.endEventSeq < inner.endEventSeq
    ) {
      return false;
    }
    return true;
  }

  async _readEvidenceRecords(recoveryCase) {
    const records = [];
    for (const ref of recoveryCase.evidenceRefs || []) {
      const file = path.join(this.recoveryDir, ref.path);
      if (!(await pathExists(file))) continue;
      let record;
      try {
        record = JSON.parse(await fsp.readFile(file, 'utf8'));
      } catch {
        continue;
      }
      if (sha256Hex(JSON.stringify(record)) !== ref.sha256) continue;
      records.push({ ...record, revision: ref.revision ?? record.revision ?? 0 });
    }
    return records;
  }

  /**
   * FR-DR-008: a scope may only be authorized once the recovery point covers the
   * whole uncertainty interval and the owner recorded the repair/verification
   * preconditions for it.
   */
  async _assertAuthorizePreconditions({ recoveryCase, scope, evidenceRecord, candidateRecords = [] }) {
    const uncertainty = recoveryCase.uncertaintyRange || null;
    if (!uncertainty || !uncertainty.endAt || uncertainty.open !== false) {
      throw new AppError('RECOVERY_FENCING_REQUIRED', 'uncertainty range is still open; record isolation evidence first');
    }
    const allRecords = [evidenceRecord, ...candidateRecords].filter(Boolean);
    const coveringRecord = allRecords.find((record) => {
      const range = this._normalizeCoveredRange(record.coveredRange);
      return this._rangeCovers(range, uncertainty);
    });
    if (!coveringRecord) {
      throw new AppError('RECOVERY_FENCING_REQUIRED', 'authorization evidence does not cover the uncertainty range');
    }
    let preconditions = null;
    let preconditionsRecord = null;
    for (const record of [...allRecords].sort((a, b) => (b.revision || 0) - (a.revision || 0))) {
      const normalized = this._normalizePreconditions(record.preconditions);
      if (!normalized) continue;
      if (record.scope) {
        const recordScope = normalizeScope(record.scope, recoveryCase.workspaceId);
        if (!scopeCovers(recordScope, scope, recoveryCase.workspaceId) && !scopeCovers(scope, recordScope, recoveryCase.workspaceId)) {
          continue;
        }
      }
      preconditions = normalized;
      preconditionsRecord = record;
      break;
    }
    if (!preconditions) {
      throw new AppError(
        'RECOVERY_FENCING_REQUIRED',
        'authorization evidence must include repair/verification preconditions'
      );
    }
    if (preconditions.permanentKeysRepaired !== true) {
      throw new AppError('RECOVERY_FENCING_REQUIRED', 'permanent business keys were not conservatively repaired');
    }
    if (preconditions.budgetRepaired !== true) {
      throw new AppError('RECOVERY_FENCING_REQUIRED', 'budget/unknown exposure was not conservatively repaired');
    }
    if (preconditions.evidenceRevision !== undefined && preconditions.evidenceRevision !== preconditionsRecord.revision) {
      throw new AppError('RECOVERY_FENCING_REQUIRED', 'authorization preconditions are stale for this evidence revision');
    }
    const accountRevalidated = Array.isArray(preconditions.accountsReverified) && preconditions.accountsReverified.length > 0;
    if (!accountRevalidated) {
      throw new AppError('RECOVERY_FENCING_REQUIRED', 'accounts were not re-verified for authorization');
    }
    if (scope.kind === 'account_action') {
      const matches = preconditions.accountsReverified.some(
        (entry) =>
          entry &&
          entry.platform === scope.platform &&
          String(entry.accountId) === String(scope.accountId) &&
          (entry.action === undefined ||
            entry.action === null ||
            entry.action === '*' ||
            entry.action === scope.action) &&
          typeof entry.verifiedAt === 'string'
      );
      if (!matches) {
        throw new AppError('RECOVERY_FENCING_REQUIRED', 'requested account scope was not re-verified');
      }
    }
    if (typeof preconditions.recoveryPointBackupId !== 'string' || preconditions.recoveryPointBackupId === '') {
      throw new AppError('RECOVERY_FENCING_REQUIRED', 'a new independent verified recovery point is required');
    }
    if (typeof this.protection?.verify === 'function') {
      let result;
      try {
        result = await this.protection.verify(preconditions.recoveryPointBackupId);
      } catch (error) {
        throw new AppError('RECOVERY_FENCING_REQUIRED', 'the new recovery point could not be verified', {
          cause: error
        });
      }
      if (!result || result.verified !== true) {
        throw new AppError('RECOVERY_FENCING_REQUIRED', 'the new recovery point is not verified');
      }
    }
    return {
      ...preconditions,
      coverageEvidenceId: coveringRecord.id || null,
      preconditionsEvidenceId: preconditionsRecord.id || null
    };
  }

  _normalizePreconditions(preconditions) {
    if (!preconditions || typeof preconditions !== 'object') return null;
    return {
      permanentKeysRepaired: preconditions.permanentKeysRepaired === true,
      budgetRepaired: preconditions.budgetRepaired === true,
      accountsReverified: Array.isArray(preconditions.accountsReverified)
        ? preconditions.accountsReverified
            .filter((entry) => entry && typeof entry === 'object')
            .map((entry) => ({
              platform: String(entry.platform || ''),
              accountId: entry.accountId === undefined ? '' : String(entry.accountId),
              action: entry.action || null,
              verifiedAt: entry.verifiedAt || null
            }))
            .filter((entry) => entry.platform !== '' && entry.accountId !== '')
        : [],
      recoveryPointBackupId:
        typeof preconditions.recoveryPointBackupId === 'string' ? preconditions.recoveryPointBackupId : null,
      evidenceRevision: Number.isSafeInteger(preconditions.evidenceRevision)
        ? preconditions.evidenceRevision
        : undefined,
      note: preconditions.note ? normalizeText(preconditions.note).slice(0, 2000) : ''
    };
  }

  async restore({ from, to, requestId }, humanContext) {
    const startedMs = this.now().getTime();
    if (typeof requestId !== 'string' || requestId === '') throw new AppError('CONFIG_INVALID', 'requestId is required');
    await this._requireHuman(humanContext, { action: 'recovery.restore', requestId, from: String(from), to: String(to) });
    if (typeof from !== 'string' || from === '') throw new AppError('RECOVERY_REQUIRED', 'backup source is required');
    if (typeof to !== 'string' || !path.isAbsolute(to)) throw new AppError('CONFIG_INVALID', 'recovery target must be absolute');
    const sourceDir = path.resolve(from);
    const targetDir = path.resolve(to);
    await ensureDir(targetDir);
    let targetEntries = await fsp.readdir(targetDir);
    const existingCaseFile = path.join(targetDir, 'recovery', 'recovery.json');
    const restoreMarkerFile = path.join(targetDir, '.restore-in-progress.json');
    if (
      targetEntries.length > 0 &&
      !(await pathExists(existingCaseFile)) &&
      targetEntries.includes('.restore-in-progress.json')
    ) {
      // A previous restore crashed before publishing recovery.json. The marker
      // proves this target was owned by an incomplete restore, so remove the
      // partial tree before retrying.
      await clearRestoreTarget(targetDir);
      targetEntries = [];
    }
    if (targetEntries.length > 0) {
      if (await pathExists(existingCaseFile)) {
        const existing = JSON.parse(await fsp.readFile(existingCaseFile, 'utf8'));
        if (existing.requestId === requestId) {
          return {
            recoveryId: existing.id,
            workspaceId: existing.workspaceId,
            targetInstanceId: existing.targetInstanceId,
            newHistoryEpoch: existing.newHistoryEpoch,
            phase: existing.phase,
            holds: existing.holds,
            unknownExposures: existing.unknownExposures,
            missingMedia: existing.missingMedia || [],
            deduplicated: true,
            elapsedMs: this.now().getTime() - startedMs
          };
        }
      }
      throw new AppError('RECOVERY_REQUIRED', 'recovery target must be a new empty directory');
    }
    await atomicWriteJson(restoreMarkerFile, {
      requestId,
      startedAt: nowIso(this.now),
      targetDir
    });
    try {
    const verified = await verifyBackupDirectory(sourceDir, { now: this.now });
    if (verified.manifest.kind !== 'backup') throw new AppError('BACKUP_INVALID', 'only kind=backup can be restored');
    const sourceState = verified.state;
    const targetInstanceId = `instance_${randomId('i').split('_').at(-1)}`;
    const newHistoryEpoch = `epoch_${randomId('e').split('_').at(-1)}`;
    const recoveryId = `recovery_${randomId('r').split('_').at(-1)}`;
    const createdAt = nowIso(this.now);
    const holds = [];
    const seenScopes = new Set();
    const addHold = (scope) => {
      const normalized = normalizeScope(scope, sourceState.workspaceId);
      const key = scopeCandidateKey(normalized);
      if (seenScopes.has(key)) return;
      seenScopes.add(key);
      holds.push(recoveryHold({ caseId: recoveryId, scope: normalized, revision: 1, createdAt }));
    };
    for (const [key, account] of Object.entries(sourceState.accounts || {})) {
      const [platform, accountId] = key.split(':');
      for (const action of ALL_ACCOUNT_ACTIONS) {
        addHold({ kind: 'account_action', workspaceId: sourceState.workspaceId, platform, accountId, action });
      }
    }
    for (const budget of Object.values(sourceState.budgets || {})) {
      addHold({
        kind: 'provider_budget',
        workspaceId: sourceState.workspaceId,
        provider: budget.provider,
        budgetId: budget.budgetId
      });
    }
    const imConversations = new Map();
    for (const notification of Object.values(sourceState.outbox || {})) {
      if (!notification.adapterId || !notification.botAccountId || !notification.conversationId) continue;
      imConversations.set(
        `${notification.adapterId}:${notification.botAccountId}:${notification.conversationId}`,
        notification
      );
    }
    for (const notification of imConversations.values()) {
      addHold({
        kind: 'im_conversation',
        workspaceId: sourceState.workspaceId,
        adapterId: notification.adapterId,
        botAccountId: notification.botAccountId,
        conversationId: notification.conversationId
      });
    }
    for (const hold of sourceState.recovery?.holds || []) {
      if (hold.status !== 'released') addHold(hold.scope);
    }
    if (holds.length === 0) addHold({ kind: 'workspace', workspaceId: sourceState.workspaceId });

    const unknownExposures = {};
    for (const operation of Object.values(sourceState.operations || {})) {
      if (!['unknown', 'dispatching', 'reserved'].includes(operation.status)) continue;
      const scope = operationRecoveryScope(operation, sourceState.workspaceId);
      if (scope.kind === 'workspace') continue;
      const exposureId = `exposure_${randomId('x').split('_').at(-1)}`;
      const matchingHold = holds.find((hold) => {
        try {
          return scopeCovers(hold.scope, scope, sourceState.workspaceId);
        } catch {
          return false;
        }
      });
      unknownExposures[exposureId] = {
        id: exposureId,
        caseId: recoveryId,
        holdId: matchingHold?.id || null,
        scope,
        currency: operation.currency || null,
        maxMinor: Number.isSafeInteger(operation.amountMinor) ? operation.amountMinor : null,
        source:
          operation.status === 'reserved'
            ? 'operation_reserved_at_cut'
            : operation.status === 'dispatching'
              ? 'operation_dispatching_at_cut'
              : 'operation_unknown',
        operationRefs: [operation.id],
        operationStatusAtCut: operation.status,
        dispatchAtCut: operation.dispatchAt || null,
        evidenceRefs: [],
        status: 'active',
        revision: 1,
        createdAt,
        resolvedAt: null
      };
      if (matchingHold) {
        matchingHold.exposureId = matchingHold.exposureId || exposureId;
        matchingHold.exposureIds = [...new Set([...(matchingHold.exposureIds || []), exposureId])];
      }
    }

    const targetState = deepClone(sourceState);
    targetState.workspaceId = sourceState.workspaceId;
    for (const operation of Object.values(targetState.operations || {})) {
      if (['reserved', 'dispatching', 'unknown'].includes(operation.status)) {
        operation.recoveryAmbiguous = true;
        operation.recoveryCutStatus = operation.status;
      }
    }
    targetState.historyEpoch = newHistoryEpoch;
    // Facts that were still pending in the snapshot are preserved as the first
    // events of the new branch. They are never dropped just because the backup
    // was taken between archival flushes.
    const carriedPending = Object.values(sourceState.journalPending || {})
      .sort((a, b) => a.seq - b.seq || String(a.eventId).localeCompare(String(b.eventId)))
      .map((event, index) => ({
        ...event,
        historyEpoch: newHistoryEpoch,
        seq: index + 1,
        workspaceId: sourceState.workspaceId
      }));
    targetState.eventSeq = carriedPending.length;
    targetState.events = carriedPending.slice(-2000);
    targetState.journalPending = Object.fromEntries(
      carriedPending.map((event) => [event.eventId, event])
    );
    targetState.checkpointFence = null;
    targetState.backups = {};
    targetState.migration = { phase: 'active', id: null };
    targetState.recovery = {
      id: recoveryId,
      phase: 'readonly',
      revision: 1,
      holds,
      unknownExposures,
      parent: {
        backupId: verified.manifest.backupId,
        sourceHistoryEpoch: verified.manifest.sourceHistoryEpoch,
        cutEventSeq: verified.manifest.cutEventSeq,
        snapshotHash: verified.manifest.snapshotHash
      },
      uncertaintyRange: {
        startAt: verified.manifest.cutAt,
        endAt: null,
        open: true,
        sourceCutEventSeq: verified.manifest.cutEventSeq
      },
      missingMedia: []
    };
    targetState.approvals = Object.fromEntries(
      Object.entries(targetState.approvals || {}).map(([id, approval]) => [
        id,
        {
          ...approval,
          nonceHash: null,
          usableForAuthorization: false,
          invalidatedByRecovery: true
        }
      ])
    );
    targetState.bindings = {};
    targetState.principals = Object.fromEntries(
      Object.entries(targetState.principals || {}).map(([id, principal]) => [
        id,
        { ...principal, scopes: [], requiresReverification: true }
      ])
    );
    targetState.outbox = Object.fromEntries(
      Object.entries(targetState.outbox || {}).map(([id, notification]) => {
        const wasPending =
          ['pending', 'sending'].includes(notification.status) ||
          ['pending', 'sending'].includes(notification.capturedStatus);
        if (!wasPending) return [id, notification];
        return [
          id,
          {
            ...notification,
            capturedStatus: notification.capturedStatus || notification.status,
            status: 'suppressed',
            suppressionReason: 'recovery_readonly'
          }
        ];
      })
    );
    const ts = createdAt;
    for (const task of Object.values(targetState.tasks || {})) {
      if (['succeeded', 'cancelled'].includes(task.status)) continue;
      if (!Array.isArray(task.holds)) task.holds = [];
      const taskAction = { comment: 'comment', dm: 'dm', publish: 'publish', production: null }[task.kind];
      const taskScope =
        task.accountRef && taskAction
          ? {
              kind: 'account_action',
              workspaceId: targetState.workspaceId,
              platform: task.accountRef.platform,
              accountId: task.accountRef.accountId,
              action: taskAction
            }
          : { kind: 'workspace', workspaceId: targetState.workspaceId };
      task.holds.push(
        makeRecoveryHold({
          id: `hold_task_${task.id}`,
          caseId: recoveryId,
          scope: taskScope,
          revision: 1,
          evidenceRefs: [],
          createdAt: ts
        })
      );
      if (task.status === 'running' || task.status === 'queued') {
        task.status = 'interrupted';
        task.executionActive = false;
        task.finishedAt = null;
      }
      task.isSettled = false;
    }
    for (const execution of Object.values(targetState.executions || {})) {
      if (['accepted', 'running', 'cancel_requested'].includes(execution.status)) {
        execution.status = 'interrupted';
        execution.finishedAt = ts;
        execution.error = { code: 'RECOVERY_REQUIRED', message: 'restored instance has no active executor' };
      }
    }
    for (const production of Object.values(targetState.productions || {})) {
      if (production.readyForPublish) production.readyForPublish = false;
      production.recoveryHold = true;
    }
    // Diary bodies are variable projections and are not copied as backup bytes.
    // The index is retained for scope/date identity but every body is marked
    // for deterministic rebuild from archived facts.
    for (const diary of Object.values(targetState.diaries || {})) {
      diary.pendingCommit = null;
      diary.needsRebuild = true;
      diary.contentHash = null;
      diary.recoveryDerived = true;
    }
    targetState.artifacts = Object.fromEntries(
      Object.entries(targetState.artifacts || {}).map(([id, artifact]) => [
        id,
        { ...artifact, availability: 'unknown' }
      ])
    );

    const journalTarget = path.join(targetDir, 'journal');
    const artifactsTarget = path.join(targetDir, 'artifacts');
    const artifactsIncluded = new Set(verified.manifest.mediaCoverage?.included || []);
    const missingMedia = [];
    for (const entry of verified.manifest.files) {
      const source = resolveInside(sourceDir, entry.path);
      if (entry.role === 'journal') {
        const relative = entry.path.replace(/^journal\//, '');
        const target = resolveInside(journalTarget, relative);
        await ensureDir(path.dirname(target));
        const copied = await copyFileWithHash(source, target);
        if (copied.sha256 !== entry.sha256) throw new AppError('BACKUP_INVALID', 'journal copy hash mismatch');
      } else if (entry.role === 'artifact') {
        if (entry.artifactId && !artifactsIncluded.has(entry.artifactId)) continue;
        const relative = entry.path.replace(/^artifacts\//, '');
        const target = resolveInside(artifactsTarget, relative);
        await ensureDir(path.dirname(target));
        const copied = await copyFileWithHash(source, target);
        if (copied.sha256 !== entry.sha256) throw new AppError('BACKUP_INVALID', 'artifact copy hash mismatch');
        if (entry.artifactId && targetState.artifacts[entry.artifactId]) {
          targetState.artifacts[entry.artifactId].availability = 'available';
        }
      } else if (entry.role === 'state') {
        // The transformed state is written below.
      }
    }
    for (const artifactId of Object.keys(targetState.artifacts)) {
      if (targetState.artifacts[artifactId].availability !== 'available') {
        targetState.artifacts[artifactId].availability = 'unavailable';
        missingMedia.push(artifactId);
      }
    }
    targetState.recovery.missingMedia = missingMedia;
    const instance = {
      schemaVersion: 1,
      instanceId: targetInstanceId,
      workspaceId: sourceState.workspaceId,
      processStartedAt: null,
      createdAt: ts,
      bootstrapComplete: true,
      status: 'recovery-readonly',
      activationRevision: 1,
      allowedCapabilities: [],
      configRevision: sourceState.configRevision,
      recoveryRevision: 1,
      schedulerDisabled: true,
      previousInstanceId: verified.manifest.sourceInstanceId || null,
      recoveredFrom: {
        backupId: verified.manifest.backupId,
        snapshotHash: verified.manifest.snapshotHash
      }
    };
    const recoveryCase = {
      schemaVersion: RECOVERY_SCHEMA_VERSION,
      id: recoveryId,
      requestId,
      workspaceId: sourceState.workspaceId,
      targetInstanceId,
      backupRef: {
        backupId: verified.manifest.backupId,
        snapshotHash: verified.manifest.snapshotHash,
        sourceStateHash: verified.manifest.sourceStateHash,
        cutAt: verified.manifest.cutAt,
        tier: verified.manifest.tier,
        mediaCoverage: verified.manifest.mediaCoverage
      },
      parentHistory: {
        backupId: verified.manifest.backupId,
        sourceHistoryEpoch: verified.manifest.sourceHistoryEpoch,
        cutEventSeq: verified.manifest.cutEventSeq,
        snapshotHash: verified.manifest.snapshotHash
      },
      newHistoryEpoch,
      revision: 1,
      phase: 'readonly',
      holds,
      unknownExposures,
      evidenceRefs: [],
      fencingEvidence: null,
      uncertaintyRange: targetState.recovery.uncertaintyRange,
      decisions: [],
      missingMedia,
      pendingExcluded: verified.manifest.pendingExcluded || [],
      parentRecovery: verified.manifest.parentRecovery || null,
      createdAt,
      updatedAt: createdAt
    };
    await this.hooks.beforeStateWrite?.({ targetDir, recoveryId, targetState });
    await ensureDir(path.join(targetDir, 'recovery'));
    await atomicWriteJson(path.join(targetDir, 'state.json'), targetState);
    await atomicWriteJson(path.join(targetDir, 'instance.json'), instance);
    await ensureDir(path.join(targetDir, 'recovery'));
    await atomicWriteJson(path.join(targetDir, 'recovery', 'recovery.json'), recoveryCase);
    if (this.recoveryDir && path.resolve(this.recoveryDir) !== path.resolve(path.join(targetDir, 'recovery'))) {
      await ensureDir(this.recoveryDir);
      await atomicWriteJson(this._caseFile(), recoveryCase);
    }
    await ensureDir(path.join(targetDir, 'recovery', 'evidence'));
    await atomicWriteJson(path.join(targetDir, 'recovery', 'restore-record.json'), {
      schemaVersion: 1,
      recoveryId,
      requestId,
      backupId: verified.manifest.backupId,
      targetInstanceId,
      newHistoryEpoch,
      startedAt: new Date(startedMs).toISOString(),
      finishedAt: nowIso(this.now),
      elapsedMs: this.now().getTime() - startedMs,
      missingMedia,
      pendingExcluded: verified.manifest.pendingExcluded || [],
      sourceBytes: verified.manifest.files.reduce((sum, entry) => sum + entry.sizeBytes, 0)
    });
    let restoreTestRecord = null;
    if (this.restoreRecorder) {
      try {
        restoreTestRecord = await this.restoreRecorder({
          backupId: verified.manifest.backupId,
          recoveryId,
          targetInstanceId,
          newHistoryEpoch,
          restoredAt: nowIso(this.now)
        });
      } catch (error) {
        // The restored copy is already complete. A missing policy/index must not
        // turn a successful restore into a failed one.
        this.logger?.warn?.('failed to record restore test', { message: error.message });
      }
    }
    await fsp.rm(restoreMarkerFile, { force: true }).catch(() => {});
    return {
      recoveryId,
      workspaceId: sourceState.workspaceId,
      targetInstanceId,
      newHistoryEpoch,
      phase: 'readonly',
      holds,
      unknownExposures,
      missingMedia,
      pendingExcluded: verified.manifest.pendingExcluded || [],
      restoreTestRecord,
      deduplicated: false,
      elapsedMs: this.now().getTime() - startedMs
    };
    } catch (error) {
      await clearRestoreTarget(targetDir).catch(() => {});
      throw error;
    }
  }

  /**
   * Preserve the surviving evidence of a corrupt/lost source before any restore
   * (SPEC §27.4 / FR-DR-001/005). Copies provable state, journal segments and
   * recovery evidence into `<recoveryDir>/corrupt-<timestamp>/` with a hash
   * manifest; business data is never modified.
   */
  async preserveCorruptSource({ dataDir, note = '' }, humanContext) {
    await this._requireHuman(humanContext, { action: 'recovery.preserve', dataDir });
    if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) {
      throw new AppError('CONFIG_INVALID', 'dataDir must be an absolute path');
    }
    const sourceDir = path.resolve(dataDir);
    if (!(await pathExists(sourceDir))) {
      throw new AppError('RECOVERY_REQUIRED', 'source data directory does not exist');
    }
    const stamp = nowIso(this.now).replace(/[:.]/g, '-');
    const baseRecoveryDir = this.recoveryDir || path.join(sourceDir, 'recovery');
    const snapshotDir = path.join(baseRecoveryDir, `corrupt-${stamp}`);
    await ensureDir(snapshotDir);
    const files = [];
    const copyOne = async (relative) => {
      const source = path.join(sourceDir, relative);
      if (!(await pathExists(source))) return;
      const lstat = await fsp.lstat(source).catch(() => null);
      if (!lstat || !lstat.isFile() || lstat.isSymbolicLink()) return;
      const target = resolveInside(snapshotDir, relative);
      await ensureDir(path.dirname(target));
      const copied = await copyFileWithHash(source, target);
      files.push({ path: relative, sizeBytes: copied.sizeBytes, sha256: copied.sha256, role: 'corrupt_source' });
    };
    for (const relative of [
      'state.json',
      'instance.json',
      'migration-package.json',
      'migration-receipt.json',
      'config.json',
      'backup-policy.json',
      'recovery/recovery.json'
    ]) {
      await copyOne(relative);
    }
    const journalRoot = path.join(sourceDir, 'journal');
    if (await pathExists(journalRoot)) {
      for (const file of await listFiles(journalRoot)) {
        await copyOne(path.posix.join('journal', file.relativePath));
      }
    }
    const evidenceRoot = path.join(sourceDir, 'recovery', 'evidence');
    if (await pathExists(evidenceRoot)) {
      for (const file of await listFiles(evidenceRoot)) {
        await copyOne(path.posix.join('recovery', 'evidence', file.relativePath));
      }
    }
    const manifest = {
      schemaVersion: 1,
      kind: 'corrupt_source_snapshot',
      sourceDataDir: sourceDir,
      note: String(note || '').slice(0, 2000),
      capturedAt: nowIso(this.now),
      capturedBy: humanContext.principal.id,
      files
    };
    await atomicWriteJson(path.join(snapshotDir, 'manifest.json'), manifest);
    return {
      recoveredFrom: sourceDir,
      snapshotDir,
      files: files.length,
      note: manifest.note
    };
  }

  async inspect(recoveryId = null) {
    const recoveryCase = await this._readCase();
    if (recoveryId && recoveryId !== recoveryCase.id) throw new AppError('RECOVERY_REQUIRED', 'recovery case not found');
    const state = await this.store.getSnapshot();
    const instance = await this.store.getInstance();
    const projectionConsistent =
      state.recovery?.id === recoveryCase.id &&
      state.recovery?.revision === recoveryCase.revision &&
      state.recovery?.phase === recoveryCase.phase &&
      instance?.recoveryRevision === recoveryCase.revision;
    return {
      caseId: recoveryCase.id,
      phase: recoveryCase.phase,
      revision: recoveryCase.revision,
      workspaceId: recoveryCase.workspaceId,
      targetInstanceId: recoveryCase.targetInstanceId,
      newHistoryEpoch: recoveryCase.newHistoryEpoch,
      parentHistory: recoveryCase.parentHistory,
      uncertaintyRange: recoveryCase.uncertaintyRange,
      holds: (recoveryCase.holds || []).map((hold) => ({
        id: hold.id,
        scope: hold.scope,
        scopeKey: hold.scopeKey,
        status: hold.status,
        revision: hold.revision
      })),
      unknownExposures: Object.values(recoveryCase.unknownExposures || {}).map((exposure) => ({
        id: exposure.id,
        scope: exposure.scope,
        currency: exposure.currency,
        maxMinor: exposure.maxMinor,
        status: exposure.status
      })),
      evidenceRefs: (recoveryCase.evidenceRefs || []).map((ref) => ({
        id: ref.id,
        sha256: ref.sha256,
        revision: ref.revision,
        kind: ref.kind,
        createdAt: ref.createdAt
      })),
      fencingEvidence: recoveryCase.fencingEvidence
        ? {
            id: recoveryCase.fencingEvidence.id,
            sourceHash: recoveryCase.fencingEvidence.sourceHash,
            recordedAt: recoveryCase.fencingEvidence.recordedAt
          }
        : null,
      decisions: recoveryCase.decisions || [],
      authorizationPreconditions: recoveryCase.authorizationPreconditions || [],
      missingMedia: recoveryCase.missingMedia || [],
      pendingExcluded: recoveryCase.pendingExcluded || [],
      projectionConsistent,
      dispatchAllowed: false,
      availableCapabilities: instance?.allowedCapabilities || []
    };
  }

  async reconcile({ recoveryId, evidence }, humanContext) {
    if (!evidence || typeof evidence !== 'object') throw new AppError('RECOVERY_GAP', 'evidence is required');
    await this._requireHuman(humanContext, {
      action: 'recovery.reconcile',
      recoveryId,
      evidenceHash: jcsHash(evidence)
    });
    const recoveryCase = await this._readCase();
    if (recoveryId && recoveryId !== recoveryCase.id) throw new AppError('RECOVERY_REQUIRED', 'recovery case not found');
    if (!['readonly', 'reconciling', 'restricted'].includes(recoveryCase.phase)) {
      throw new AppError('RECOVERY_GAP', 'recovery case is not reconcilable');
    }
    await this._verifyProjection();
    const kind = evidence.kind || 'fact';
    if (!['fact', 'isolation'].includes(kind)) throw new AppError('RECOVERY_GAP', 'evidence kind is invalid');
    const coveredRange = this._normalizeCoveredRange(evidence.coveredRange);
    if (kind === 'isolation') {
      if (evidence.conclusion !== 'isolated') throw new AppError('RECOVERY_FENCING_REQUIRED', 'isolation evidence is inconclusive');
      if (!evidence.source || !evidence.sourceHash) {
        throw new AppError('RECOVERY_FENCING_REQUIRED', 'isolation evidence needs a trusted source and hash');
      }
      const range = coveredRange || (evidence.capturedAt
        ? this._normalizeCoveredRange({
            startAt: recoveryCase.uncertaintyRange?.startAt || evidence.capturedAt,
            endAt: evidence.capturedAt
          })
        : null);
      if (!range || !range.endAt) {
        throw new AppError(
          'RECOVERY_FENCING_REQUIRED',
          'isolation evidence must record the covered range up to the isolation time'
        );
      }
      evidence.coveredRange = range;
    }
    const normalizedEvidenceScope = evidence.scope
      ? normalizeScope(evidence.scope, recoveryCase.workspaceId)
      : null;
    let repair = null;
    if (evidence.repair !== undefined && evidence.repair !== null) {
      if (!this.effectGateway?._resolveRecoveredInTransaction) {
        throw new AppError('RECOVERY_GAP', 'operation repair requires the effect gateway');
      }
      if (typeof evidence.repair !== 'object') throw new AppError('RECOVERY_GAP', 'repair must be an object');
      const operationId = evidence.repair.operationId;
      if (typeof operationId !== 'string' || operationId === '') {
        throw new AppError('RECOVERY_GAP', 'repair.operationId is required');
      }
      if (!['confirmed', 'not_sent'].includes(evidence.repair.decision)) {
        throw new AppError('RECOVERY_GAP', 'repair.decision must be confirmed or not_sent');
      }
      if (evidence.repair.decision === 'not_sent') {
        const proofRange = this._normalizeCoveredRange(evidence.coveredRange);
        const hasProof =
          (evidence.repair.receipt && typeof evidence.repair.receipt === 'object') ||
          (proofRange && proofRange.endAt && evidence.source && evidence.source !== 'local_owner' && evidence.sourceHash);
        const noteText = normalizeText(evidence.repair.note || evidence.note || '').trim();
        if (!hasProof || noteText === '') {
          throw new AppError(
            'RECOVERY_GAP',
            'not_sent repair requires a verified receipt or covered evidence range plus a reviewed note'
          );
        }
      }
      if (!normalizedEvidenceScope) {
        throw new AppError('RECOVERY_GAP', 'operation repair evidence requires an explicit recovery scope');
      }
      const operationState = await this.store.getSnapshot();
      const operation = operationState.operations?.[operationId];
      if (!operation) {
        throw new AppError('RECOVERY_GAP', 'repair.operationId does not exist; record a recovered fact instead');
      }
      const operationScope = operationRecoveryScope(operation, recoveryCase.workspaceId);
      if (!scopeCovers(normalizedEvidenceScope, operationScope, recoveryCase.workspaceId)) {
        throw new AppError('RECOVERY_GAP', 'repair evidence scope does not cover the operation');
      }
      if (
        !(evidence.operationRefs || []).includes(operationId) &&
        !(evidence.businessKeys || []).includes(operation.businessKey)
      ) {
        throw new AppError('RECOVERY_GAP', 'repair evidence must reference the operation or its business key');
      }
      if (operation.status === evidence.repair.decision) {
        // Idempotent evidence may be recorded again; the transaction below
        // reports already_resolved and does not settle twice.
      } else if (!['unknown', 'reserved', 'dispatching'].includes(operation.status)) {
        throw new AppError('RECOVERY_GAP', 'operation is already settled with a conflicting result');
      }
      repair = {
        operationId,
        decision: evidence.repair.decision,
        receipt: evidence.repair.receipt || null,
        note: normalizeText(evidence.repair.note || evidence.note || '').slice(0, 1000)
      };
    }
    const evidenceId = `evidence_${randomId('e').split('_').at(-1)}`;
    const nextRevision = recoveryCase.revision + 1;
    const record = {
      schemaVersion: 1,
      id: evidenceId,
      caseId: recoveryCase.id,
      kind,
      scope: normalizedEvidenceScope,
      source: String(evidence.source || 'local_owner'),
      sourceHash: String(evidence.sourceHash || jcsHash(evidence)),
      coveredRange: evidence.coveredRange || null,
      conclusion: evidence.conclusion || 'recorded',
      operationRefs: [
        ...new Set([...(evidence.operationRefs || []), ...(repair ? [repair.operationId] : [])])
      ],
      taskRefs: evidence.taskRefs || [],
      businessKeys: evidence.businessKeys || [],
      repair: repair
        ? { operationId: repair.operationId, decision: repair.decision, receipt: repair.receipt }
        : null,
      note: evidence.note ? normalizeText(evidence.note).slice(0, 2000) : '',
      preconditions: evidence.preconditions !== undefined
        ? this._normalizePreconditions(evidence.preconditions)
        : null,
      reviewedBy: humanContext.principal.id,
      capturedAt: evidence.capturedAt || nowIso(this.now),
      recordedAt: nowIso(this.now),
      revision: nextRevision
    };
    await ensureDir(path.join(this.recoveryDir, 'evidence'));
    const evidenceRelative = path.posix.join('evidence', `${evidenceId}.json`);
    const evidenceFile = path.join(this.recoveryDir, evidenceRelative);
    await atomicWriteJson(evidenceFile, record);
    const sha = sha256Hex(JSON.stringify(record));
    recoveryCase.evidenceRefs = [
      ...(recoveryCase.evidenceRefs || []),
      { id: evidenceId, path: evidenceRelative, sha256: sha, revision: nextRevision, kind, createdAt: record.recordedAt }
    ];
    if (kind === 'isolation') {
      recoveryCase.fencingEvidence = {
        id: evidenceId,
        sourceHash: record.sourceHash,
        recordedAt: record.recordedAt,
        review: record.note,
        revision: nextRevision
      };
      const closedRange = this._normalizeCoveredRange(record.coveredRange);
      if (closedRange && closedRange.endAt) {
        recoveryCase.uncertaintyRange = {
          ...(recoveryCase.uncertaintyRange || {}),
          startAt: recoveryCase.uncertaintyRange?.startAt || closedRange.startAt,
          startEventSeq: recoveryCase.uncertaintyRange?.startEventSeq ?? closedRange.startEventSeq ?? null,
          endAt: closedRange.endAt,
          endEventSeq: closedRange.endEventSeq ?? recoveryCase.uncertaintyRange?.endEventSeq ?? null,
          open: false,
          closedAt: record.recordedAt,
          isolationEvidenceId: evidenceId
        };
      }
    }
    recoveryCase.revision = nextRevision;
    recoveryCase.phase = 'reconciling';
    let repairOutcome = null;
    try {
      repairOutcome = await this.store.transaction(async (draft, tx) => {
        draft.recovery.phase = 'reconciling';
        draft.recovery.revision = nextRevision;
        tx.appendEvent({
          type: 'recovery.evidence',
          actor: humanContext.principal.id,
          payload: {
            recoveryId: recoveryCase.id,
            evidenceId,
            kind,
            conclusion: record.conclusion,
            revision: nextRevision,
            sourceHash: record.sourceHash
          }
        });
        const outcome = repair
          ? this.effectGateway._resolveRecoveredInTransaction(tx, {
              operationId: repair.operationId,
              decision: repair.decision,
              receipt: repair.receipt,
              note: repair.note,
              principalId: humanContext.principal.id,
              evidenceId
            })
          : null;
        if (!repair && record.businessKeys.length > 0) {
          tx.appendEvent({
            type: 'recovery.recovered_fact',
            actor: humanContext.principal.id,
            payload: {
              recoveryId: recoveryCase.id,
              evidenceId,
              businessKeys: record.businessKeys.slice(0, 100),
              note: record.note.slice(0, 500)
            }
          });
        }
        return outcome;
      });
    } catch (error) {
      await fsp.rm(evidenceFile, { force: true }).catch(() => {});
      throw error;
    }
    await this.hooks.afterEvidenceWritten?.({ recoveryCase, record });
    const projected = await this.store.getSnapshot();
    if (projected.recovery?.id === recoveryCase.id && projected.recovery.revision === nextRevision) {
      recoveryCase.unknownExposures = deepClone(projected.recovery.unknownExposures || {});
      recoveryCase.holds = deepClone(projected.recovery.holds || recoveryCase.holds);
    }
    await this._writeCase(recoveryCase);
    await this.store.updateInstance((draft) => {
      draft.recoveryRevision = nextRevision;
    });
    return {
      recoveryId: recoveryCase.id,
      evidenceId,
      revision: nextRevision,
      phase: 'reconciling',
      fencingEvidence: Boolean(recoveryCase.fencingEvidence),
      repair: repairOutcome
        ? {
            operationId: repair.operationId,
            status: repairOutcome.status,
            operationStatus: repairOutcome.operation?.status || null,
            deduplicated: repairOutcome.deduplicated === true
          }
        : null,
      dispatchAllowed: false
    };
  }

  async _commitAuthorization(recoveryCase, decision, normalized, evidenceId, deduplicated = false) {
    let state = await this.store.getSnapshot();
    if (state.recovery?.id !== recoveryCase.id || state.recovery.revision !== decision.nextRevision) {
      throw new AppError('RECOVERY_FENCING_REQUIRED', 'state projection does not match the prepared decision');
    }
    recoveryCase = await this._readCase();
    if (recoveryCase.pendingDecision?.id !== decision.id) {
      throw new AppError('RECOVERY_GAP', 'authorization decision changed while committing');
    }
    const previousCommit = recoveryCase.pendingDecision?.state === 'committed'
      ? recoveryCase.pendingDecision.committedAt
      : null;
    recoveryCase.holds = deepClone(state.recovery.holds);
    recoveryCase.phase = state.recovery.phase;
    recoveryCase.revision = decision.nextRevision;
    recoveryCase.pendingDecision = {
      ...decision,
      state: 'committed',
      committedAt: previousCommit || nowIso(this.now)
    };
    if (!(recoveryCase.decisions || []).some((entry) => entry.id === decision.id)) {
      recoveryCase.decisions = [
        ...(recoveryCase.decisions || []),
        {
          id: decision.id,
          scope: normalized,
          scopeKey: decision.scopeKey,
          evidenceId,
          capabilities: decision.capabilities,
          revision: decision.nextRevision,
          committedAt: recoveryCase.pendingDecision.committedAt
        }
      ];
    }
    await this._writeCase(recoveryCase);
    await this.hooks.afterCommitted?.({ recoveryCase, decision });
    let instance = await this.store.getInstance();
    const nextCapabilities = [...new Set([...(instance.allowedCapabilities || []), ...decision.capabilities])].sort();
    const needsInstance =
      instance.status !== 'active' ||
      instance.recoveryRevision !== decision.nextRevision ||
      !decision.capabilities.every((capability) => instance.allowedCapabilities.includes(capability));
    if (needsInstance) {
      await this.hooks.beforeInstanceUpdate?.({ recoveryCase, decision, nextCapabilities });
      await this.store.updateInstance((draft) => {
        draft.allowedCapabilities = nextCapabilities;
        draft.status = 'active';
        draft.activationRevision = (draft.activationRevision || 0) + 1;
        draft.recoveryRevision = decision.nextRevision;
      });
    }
    return {
      recoveryId: recoveryCase.id,
      phase: recoveryCase.phase,
      revision: decision.nextRevision,
      scope: normalized,
      capabilities: decision.capabilities,
      deduplicated
    };
  }

  async _applyAuthorizationState(recoveryCase, state, decision, normalized, humanContext) {
    if (state.recovery?.id !== recoveryCase.id) {
      throw new AppError('RECOVERY_FENCING_REQUIRED', 'recovery case projection is inconsistent');
    }
    if (state.recovery.revision === decision.nextRevision) return false;
    if (state.recovery.revision > decision.nextRevision) {
      throw new AppError('RECOVERY_FENCING_REQUIRED', 'state revision is ahead of the authorization decision');
    }
    if (state.recovery.revision !== decision.nextRevision - 1) {
      throw new AppError('RECOVERY_FENCING_REQUIRED', 'state revision is not the immediate predecessor');
    }
    const holds = [];
    for (const hold of state.recovery.holds || []) {
      if (hold.status === 'released') {
        holds.push(hold);
        continue;
      }
      const same = hold.scopeKey === decision.scopeKey;
      const normalizedHold = normalizeScope(hold.scope, recoveryCase.workspaceId);
      if (same) {
        holds.push({
          ...hold,
          status: 'released',
          releasedAt: nowIso(this.now),
          releaseDecisionRef: decision.id,
          revision: decision.nextRevision
        });
        continue;
      }
      if (
        normalizedHold.kind === 'account_action' &&
        normalizedHold.action === '*' &&
        normalized.platform === normalizedHold.platform &&
        normalized.accountId === normalizedHold.accountId
      ) {
        holds.push({
          ...hold,
          status: 'released',
          releasedAt: nowIso(this.now),
          releaseDecisionRef: decision.id,
          revision: decision.nextRevision
        });
        for (const action of ALL_ACCOUNT_ACTIONS) {
          if (action === normalized.action) continue;
          holds.push(
            recoveryHold({
              caseId: recoveryCase.id,
              scope: { ...normalizedHold, action },
              revision: decision.nextRevision,
              createdAt: nowIso(this.now)
            })
          );
        }
        continue;
      }
      holds.push(hold);
    }
    const released = holds.some(
      (hold) => hold.status === 'released' && hold.releaseDecisionRef === decision.id
    );
    if (!released) throw new AppError('RECOVERY_GAP', 'no matching hold could be split/released for this scope');
    const phase = holds.some((hold) => hold.status !== 'released') ? 'restricted' : 'released';
    await this.store.transaction(async (draft, tx) => {
      if (draft.recovery.revision !== decision.nextRevision - 1) {
        throw new AppError('RECOVERY_FENCING_REQUIRED', 'state revision changed during authorization');
      }
      draft.recovery.phase = phase;
      draft.recovery.revision = decision.nextRevision;
      draft.recovery.holds = holds;
      if (this.taskManager) {
        for (const task of Object.values(draft.tasks || {})) {
          for (const hold of (task.holds || []).filter((entry) => entry.kind === 'recovery' && entry.status !== 'released')) {
            if (
              hold.caseId === recoveryCase.id &&
              scopeCovers(normalized, hold.scope, recoveryCase.workspaceId)
            ) {
              this.taskManager.releaseHold(tx, task, hold.id, decision.id);
            }
          }
        }
      }
      tx.appendEvent({
        type: 'recovery.scope.authorized',
        actor: humanContext.principal.id,
        payload: {
          recoveryId: recoveryCase.id,
          scope: normalized,
          decisionId: decision.id,
          revision: decision.nextRevision
        }
      });
    });
    await this.hooks.afterStateProjection?.({ recoveryCase, decision, stateUpdated: true });
    return true;
  }

  async authorize({ recoveryId, scope, evidenceId }, humanContext) {
    await this._requireHuman(humanContext, {
      action: 'recovery.authorize',
      recoveryId,
      scope: scope ? jcsHash(scope) : null,
      evidenceId: evidenceId || null
    });
    let recoveryCase = await this._readCase();
    if (recoveryId && recoveryId !== recoveryCase.id) throw new AppError('RECOVERY_REQUIRED', 'recovery case not found');
    const normalized = normalizeScope(scope, recoveryCase.workspaceId);
    const targetKey = scopeKeyFor(normalized);
    let state = await this.store.getSnapshot();
    let pending = recoveryCase.pendingDecision;

    // Resume any previously prepared/committed decision before applying the
    // strict projection check. A crash can leave the case file one revision
    // behind the ledger, or the instance one revision behind the case file.
    if (pending) {
      if (state.recovery?.id !== recoveryCase.id) {
        throw new AppError('RECOVERY_FENCING_REQUIRED', 'recovery case projection is inconsistent');
      }
      const sameDecision = pending.scopeKey === targetKey && pending.evidenceId === evidenceId;
      if (pending.state === 'committed') {
        if (state.recovery.revision !== pending.nextRevision) {
          throw new AppError('RECOVERY_FENCING_REQUIRED', 'committed decision is missing its ledger projection');
        }
        if (sameDecision) {
          const capabilities = pending.capabilities || capabilitiesForRecoveryScope(normalized, recoveryCase.workspaceId);
          return this._commitAuthorization(
            recoveryCase,
            { ...pending, capabilities },
            normalized,
            evidenceId,
            true
          );
        }
        const instance = await this.store.getInstance();
        const committedCaps = pending.capabilities || [];
        const instanceComplete =
          instance.recoveryRevision === pending.nextRevision &&
          instance.status === 'active' &&
          committedCaps.every((capability) => instance.allowedCapabilities.includes(capability));
        if (!instanceComplete) {
          await this._commitAuthorization(
            recoveryCase,
            { ...pending, capabilities: committedCaps },
            normalizeScope(pending.scope, recoveryCase.workspaceId),
            pending.evidenceId,
            true
          );
          recoveryCase = await this._readCase();
          state = await this.store.getSnapshot();
        }
        // A committed decision is history, not a lock on the next scope.
        recoveryCase.pendingDecision = null;
        await this._writeCase(recoveryCase);
        pending = null;
      } else {
        if (!sameDecision) {
          throw new AppError('RECOVERY_GAP', 'another authorization decision is pending; retry it first');
        }
        if (state.recovery.revision === pending.nextRevision) {
          const capabilities = pending.capabilities || capabilitiesForRecoveryScope(normalized, recoveryCase.workspaceId);
          return this._commitAuthorization(
            recoveryCase,
            { ...pending, capabilities },
            normalized,
            evidenceId,
            true
          );
        }
        if (state.recovery.revision > pending.nextRevision) {
          throw new AppError('RECOVERY_FENCING_REQUIRED', 'state revision is ahead of the pending decision');
        }
      }
    }
    if (!pending) {
      await this._verifyProjection();
      state = await this.store.getSnapshot();
    }

    if (!recoveryCase.fencingEvidence) {
      throw new AppError('RECOVERY_FENCING_REQUIRED', 'old writer isolation evidence has not been recorded');
    }
    if (!recoveryCase.evidenceRefs.some((ref) => ref.kind === 'isolation' && ref.id === recoveryCase.fencingEvidence.id)) {
      throw new AppError('RECOVERY_FENCING_REQUIRED', 'isolation evidence is not part of this case');
    }
    const evidenceRef = (recoveryCase.evidenceRefs || []).find((ref) => ref.id === evidenceId);
    if (!evidenceRef) throw new AppError('RECOVERY_GAP', 'authorization evidence is missing');
    if (evidenceRef.revision > recoveryCase.revision) {
      throw new AppError('RECOVERY_GAP', 'authorization evidence revision is stale');
    }
    if (evidenceRef.kind === 'isolation' && evidenceId !== recoveryCase.fencingEvidence.id) {
      throw new AppError('RECOVERY_GAP', 'authorization evidence is not the current isolation evidence');
    }
    const evidencePath = path.join(this.recoveryDir, evidenceRef.path);
    if (!(await pathExists(evidencePath))) {
      throw new AppError('RECOVERY_GAP', 'authorization evidence file is missing');
    }
    const evidenceRecord = JSON.parse(await fsp.readFile(evidencePath, 'utf8'));
    if (sha256Hex(JSON.stringify(evidenceRecord)) !== evidenceRef.sha256) {
      throw new AppError('RECOVERY_GAP', 'authorization evidence file hash does not match the case');
    }
    if (evidenceRecord.scope) {
      const evidenceScope = normalizeScope(evidenceRecord.scope, recoveryCase.workspaceId);
      if (!scopeCovers(evidenceScope, normalized) && !scopeCovers(normalized, evidenceScope)) {
        throw new AppError('RECOVERY_GAP', 'authorization evidence does not cover the requested scope');
      }
    }
    const evidenceRecords = await this._readEvidenceRecords(recoveryCase);
    const preconditions = await this._assertAuthorizePreconditions({
      recoveryCase,
      scope: normalized,
      evidenceRecord: { ...evidenceRecord, revision: evidenceRecord.revision ?? evidenceRef.revision },
      candidateRecords: evidenceRecords
    });
    recoveryCase.authorizationPreconditions = [
      ...(recoveryCase.authorizationPreconditions || []),
      {
        caseRevision: recoveryCase.revision,
        scope: normalized,
        scopeKey: targetKey,
        evidenceId,
        evidenceRevision: evidenceRecord.revision,
        recoveryPointBackupId: preconditions.recoveryPointBackupId,
        permanentKeysRepaired: preconditions.permanentKeysRepaired,
        budgetRepaired: preconditions.budgetRepaired,
        accountsReverified: preconditions.accountsReverified,
        recordedAt: nowIso(this.now)
      }
    ];
    const capabilities = pending?.capabilities || capabilitiesForRecoveryScope(normalized, recoveryCase.workspaceId);
    const nextRevision = pending?.nextRevision || recoveryCase.revision + 1;
    const decision = pending || {
      id: `decision_${randomId('d').split('_').at(-1)}`,
      state: 'prepared',
      scope: normalized,
      scopeKey: targetKey,
      evidenceId,
      nextRevision,
      capabilities,
      recoveryPointBackupId: preconditions.recoveryPointBackupId,
      preparedAt: nowIso(this.now),
      committedAt: null
    };
    if (!pending) {
      if (state.recovery.revision !== recoveryCase.revision) {
        throw new AppError('RECOVERY_FENCING_REQUIRED', 'state revision is not the case revision');
      }
      recoveryCase.pendingDecision = decision;
      await this._writeCase(recoveryCase);
      await this.hooks.afterPrepared?.({ recoveryCase, decision });
    }
    state = await this.store.getSnapshot();
    await this._applyAuthorizationState(recoveryCase, state, decision, normalized, humanContext);
    return this._commitAuthorization(recoveryCase, decision, normalized, evidenceId, Boolean(pending));
  }

  async refreeze({ recoveryId, scope, reason }, humanContext) {
    await this._requireHuman(humanContext, { action: 'recovery.refreeze', recoveryId, reason });
    const recoveryCase = await this._readCase();
    if (recoveryId && recoveryId !== recoveryCase.id) throw new AppError('RECOVERY_REQUIRED', 'recovery case not found');
    await this._verifyProjection();
    const normalized = normalizeScope(scope, recoveryCase.workspaceId);
    const hold = recoveryHold({
      caseId: recoveryCase.id,
      scope: normalized,
      revision: recoveryCase.revision + 1,
      createdAt: nowIso(this.now)
    });
    hold.evidenceRefs = [];
    hold.reason = reason;
    recoveryCase.holds = [...(recoveryCase.holds || []), hold];
    recoveryCase.revision += 1;
    recoveryCase.phase = 'restricted';
    if (recoveryCase.pendingDecision) {
      recoveryCase.lastInvalidatedDecision = {
        ...recoveryCase.pendingDecision,
        invalidatedByRefreezeAt: nowIso(this.now)
      };
      recoveryCase.pendingDecision = null;
    }
    await this._writeCase(recoveryCase);
    await this.store.transaction(async (draft, tx) => {
      draft.recovery.holds.push(hold);
      draft.recovery.revision = recoveryCase.revision;
      draft.recovery.phase = 'restricted';
      tx.appendEvent({
        type: 'recovery.scope.refrozen',
        actor: humanContext.principal.id,
        payload: { recoveryId: recoveryCase.id, holdId: hold.id, reason: String(reason || '').slice(0, 500) }
      });
    });
    await this.store.updateInstance((draft) => {
      draft.recoveryRevision = recoveryCase.revision;
    });
    return { recoveryId: recoveryCase.id, hold, revision: recoveryCase.revision, phase: 'restricted' };
  }

  async getStatus() {
    const recoveryCase = await this._readCase();
    const state = await this.store.getSnapshot();
    const instance = await this.store.getInstance();
    return {
      caseId: recoveryCase.id,
      phase: recoveryCase.phase,
      revision: recoveryCase.revision,
      holds: (recoveryCase.holds || []).filter((hold) => hold.status !== 'released').length,
      activeHolds: (state.recovery?.holds || []).filter((hold) => hold.status !== 'released').length,
      unknownExposures: Object.keys(recoveryCase.unknownExposures || {}).length,
      allowedCapabilities: instance?.allowedCapabilities || [],
      searchable: true
    };
  }
}

/* Enable read-only recovery backups from a verified restricted copy. */
export class RecoveryManagedBackupService extends BackupService {
  async createManagedCopy({ kind = 'ledger', requestId }, humanContext) {
    const state = await this.store.getSnapshot();
    if (!['restricted', 'released'].includes(state.recovery?.phase)) {
      throw new AppError('RECOVERY_GAP', 'managed recovery backups require a restricted/released copy');
    }
    // The normal backup gate rejects readonly/reconciling; a restricted copy is
    // already evidence-reviewed and may make a fresh point for the repaired scopes.
    return this.create({ kind, requestId }, humanContext);
  }
}
