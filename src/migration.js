import fsp from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './errors.js';
import { segmentHash } from './event-journal.js';
import {
  assertNoMatchingHold,
  makeMigrationHold,
  normalizeScope,
  scopeKeyFor
} from './contracts.js';
import {
  atomicWriteJson,
  copyFileWithHash,
  deepClone,
  ensureDir,
  ensureWithin,
  fileSha256,
  isSafeRelativePath,
  jcsHash,
  nowIso,
  pathExists,
  platformPathCollision,
  randomId,
  resolveInside,
  sha256Hex
} from './utils.js';

export const MIGRATION_SCHEMA_VERSION = 1;
export const MIGRATION_STATE_VERSION = 3;

const SOURCE_PHASES = Object.freeze(['active', 'quiescing', 'sealed', 'released', 'aborted']);
const TARGET_PHASES = Object.freeze(['none', 'imported', 'validated', 'active', 'disabled']);

async function readJson(file, code = 'MIGRATION_BLOCKED') {
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (error) {
    throw new AppError(code, `cannot read ${path.basename(file)}`, { cause: error });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new AppError(code, `invalid JSON in ${path.basename(file)}`, { cause: error });
  }
}

async function listFiles(root, prefix = '') {
  if (!(await pathExists(root))) return [];
  const entries = await fsp.readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const rel = prefix ? path.posix.join(prefix, entry.name) : entry.name;
    const abs = path.join(root, entry.name);
    const lstat = await fsp.lstat(abs);
    if (lstat.isSymbolicLink()) throw new AppError('MIGRATION_BLOCKED', 'migration source contains a symbolic link');
    if (lstat.isDirectory()) files.push(...(await listFiles(abs, rel)));
    else if (lstat.isFile()) files.push({ relativePath: rel, absolute: abs, sizeBytes: lstat.size, role: 'file' });
  }
  return files;
}

export class MigrationService {
  constructor({
    store,
    configService,
    artifactStore,
    journal,
    humanProof,
    protection = null,
    executorStatus = async () => ({ stopped: true }),
    activationChecks = null,
    dataDir,
    migrationsDir,
    journalDir,
    diaryDir,
    postsDir,
    now = () => new Date(),
    hooks = {},
    logger
  } = {}) {
    this.store = store;
    this.configService = configService;
    this.artifactStore = artifactStore;
    this.journal = journal;
    this.humanProof = humanProof;
    this.protection = protection;
    this.executorStatus = executorStatus;
    this.activationChecks = activationChecks;
    this.dataDir = dataDir;
    this.migrationsDir = migrationsDir;
    this.journalDir = journalDir;
    this.diaryDir = diaryDir;
    this.postsDir = postsDir;
    this.now = now;
    this.hooks = hooks;
    this.logger = logger;
  }

  _config() {
    return this.configService.get();
  }

  async _requireHuman(humanContext, binding) {
    if (!this.humanProof) throw new AppError('TRUST_UNAVAILABLE', 'human proof verifier is not configured');
    return this.humanProof.assert(humanContext, binding);
  }

  async _requireProtection() {
    if (!this.protection?.getProtection) {
      throw new AppError('BACKUP_UNPROTECTED', 'no backup protection service is configured for migration');
    }
    const state = await this.store.getSnapshot();
    const result = await this.protection.getProtection({
      kind: 'workspace',
      workspaceId: state.workspaceId
    });
    if (result.status !== 'protected') {
      const code = result.status === 'degraded' ? 'BACKUP_STALE' : 'BACKUP_UNPROTECTED';
      throw new AppError(code, 'migration requires a healthy independent recovery point', {
        details: { status: result.status, reason: result.reason }
      });
    }
    return result;
  }

  async prepare({ targetInstanceId }, humanContext) {
    await this._requireHuman(humanContext, { action: 'migration.prepare', targetInstanceId });
    if (typeof targetInstanceId !== 'string' || targetInstanceId === '') {
      throw new AppError('CONFIG_INVALID', 'targetInstanceId is required');
    }
    const state = await this.store.getSnapshot();
    if (state.migration?.phase !== 'active') {
      throw new AppError('MIGRATION_BLOCKED', `migration is already ${state.migration?.phase}`);
    }
    const instance = await this.store.getInstance();
    if (targetInstanceId === instance.instanceId) throw new AppError('MIGRATION_BLOCKED', 'target equals source instance');
    assertNoMatchingHold(state, normalizeScope({ kind: 'workspace', workspaceId: state.workspaceId }));
    const protection = await this._requireProtection();
    const migrationId = `migration_${randomId('m').split('_').at(-1)}`;
    const executors = await this.executorStatus();
    const result = await this.store.transaction(async (draft, tx) => {
      draft.migration = {
        phase: 'quiescing',
        id: migrationId,
        targetInstanceId,
        sourceInstanceId: tx.instanceId,
        preparedAt: nowIso(this.now),
        protectionPoint: {
          backupId: protection.backupId || null,
          cutAt: protection.cutAt || null,
          status: protection.status
        },
        executors
      };
      tx.appendEvent({
        type: 'migration.prepare',
        actor: humanContext.principal.id,
        payload: {
          migrationId,
          targetInstanceId,
          phase: 'quiescing',
          protectionBackupId: protection.backupId || null
        }
      });
      return deepClone(draft.migration);
    });
    if (!executors.stopped) {
      throw new AppError('MIGRATION_BLOCKED', 'local executors have not provably stopped; export remains blocked', {
        details: { migrationId, executors }
      });
    }
    return { migration: result, sealed: false, protection };
  }

  async _packageDir(migrationId) {
    return resolveInside(this.migrationsDir, migrationId);
  }

  async export({ migrationId, out = null }, humanContext = null) {
    if (humanContext) await this._requireHuman(humanContext, { action: 'migration.export', migrationId });
    const state = await this.store.getSnapshot();
    const migration = state.migration;
    if (!migration || migration.id !== migrationId) throw new AppError('MIGRATION_BLOCKED', 'migration not found');
    if (migration.phase !== 'quiescing') throw new AppError('MIGRATION_BLOCKED', `cannot export from ${migration.phase}`);
    const executors = await this.executorStatus();
    if (!executors.stopped) {
      throw new AppError('MIGRATION_BLOCKED', 'local executors have not provably stopped', { details: { executors } });
    }
    if (Object.keys(state.artifactPendingImports || {}).length > 0) {
      throw new AppError('MIGRATION_BLOCKED', 'artifact imports are still pending');
    }
    if (Object.values(state.diaries || {}).some((entry) => entry.pendingCommit)) {
      throw new AppError('MIGRATION_BLOCKED', 'diary commits are still pending');
    }
    const inFlight = Object.values(state.operations || {}).filter((operation) =>
      ['reserved', 'dispatching'].includes(operation.status)
    );
    if (inFlight.length > 0) {
      throw new AppError('MIGRATION_BLOCKED', 'in-flight operations must settle before export', {
        details: { operations: inFlight.map((operation) => operation.id) }
      });
    }
    await this.journal.archiveAll({ maxRounds: 1000 }).catch((error) => {
      throw new AppError('JOURNAL_CORRUPTED', 'journal must be archived before export', { cause: error });
    });
    const refreshed = await this.store.getSnapshot();
    const config = this._config();
    const packageDir = await this._packageDir(migrationId);
    const tempDir = `${packageDir}.tmp.${randomId('t')}`;
    const targetOut = out ? path.resolve(out) : packageDir;
    if (out) {
      if (!path.isAbsolute(out)) throw new AppError('CONFIG_INVALID', 'export out directory must be absolute');
      if (ensureWithin(this.dataDir, targetOut)) {
        throw new AppError('MIGRATION_BLOCKED', 'export output must not be inside the active data directory');
      }
      if (await pathExists(targetOut)) {
        const existing = await fsp.readdir(targetOut);
        if (existing.length > 0) throw new AppError('MIGRATION_BLOCKED', 'export output directory is not empty');
      }
    }
    try {
      await ensureDir(tempDir);
      const files = [];
      const addFile = async (relative, source, role) => {
        if (!isSafeRelativePath(relative)) throw new AppError('MIGRATION_BLOCKED', 'unsafe export path');
        const target = resolveInside(tempDir, relative);
        await ensureDir(path.dirname(target));
        const copied = await copyFileWithHash(source, target);
        files.push({ path: relative, role, sizeBytes: copied.sizeBytes, sha256: copied.sha256, required: true });
      };
      const sanitized = sanitizeStateForMigration(refreshed);
      const stateJson = `${JSON.stringify(sanitized, null, 2)}\n`;
      await fsp.writeFile(path.join(tempDir, 'state.json'), stateJson, { mode: 0o600 });
      files.push({
        path: 'state.json',
        role: 'state',
        sizeBytes: Buffer.byteLength(stateJson),
        sha256: sha256Hex(stateJson),
        required: true
      });
      for (const segment of Object.values(refreshed.journalSegments || {})) {
        const source = resolveInside(this.journalDir, segment.relativePath);
        if (!(await pathExists(source))) throw new AppError('JOURNAL_CORRUPTED', 'journal segment is missing');
        const packageRelative = path.posix.join('journal', segment.relativePath);
        await addFile(packageRelative, source, 'journal');
        const copiedSegment = JSON.parse(
          await fsp.readFile(resolveInside(tempDir, packageRelative), 'utf8')
        );
        if (
          copiedSegment.historyEpoch !== segment.historyEpoch ||
          copiedSegment.startSeq !== segment.startSeq ||
          copiedSegment.endSeq !== segment.endSeq ||
          copiedSegment.segmentHash !== segment.hash ||
          segmentHash(copiedSegment.historyEpoch, copiedSegment.events) !== segment.hash
        ) {
          throw new AppError('JOURNAL_CORRUPTED', 'target journal segment integrity check failed');
        }
      }
      for (const entry of Object.values(refreshed.diaries || {})) {
        if (!entry.targetFile || entry.pendingCommit) continue;
        const source = resolveInside(this.diaryDir, entry.targetFile);
        if (!(await pathExists(source))) {
          throw new AppError('MIGRATION_BLOCKED', 'diary body listed in the index is missing');
        }
        await addFile(path.posix.join('diary', entry.targetFile), source, 'diary');
        if (entry.contentHash && sha256Hex(await fsp.readFile(source, 'utf8')) !== entry.contentHash) {
          throw new AppError('MIGRATION_BLOCKED', 'target diary digest does not match its ledger');
        }
      }
      for (const artifact of Object.values(refreshed.artifacts || {})) {
        if (!isSafeRelativePath(artifact.relativePath)) throw new AppError('ARTIFACT_INVALID', 'artifact path is unsafe');
        const source = resolveInside(this.artifactStore.rootDir, artifact.relativePath);
        if (!(await pathExists(source))) {
          throw new AppError('MIGRATION_BLOCKED', 'artifact bytes are missing', { details: { artifactId: artifact.artifactId } });
        }
        const copied = await copyFileWithHash(source, resolveInside(tempDir, path.posix.join('artifacts', artifact.relativePath)));
        if (copied.sha256 !== artifact.sha256 || copied.sizeBytes !== artifact.sizeBytes) {
          throw new AppError('ARTIFACT_INVALID', 'artifact digest changed during export');
        }
        files.push({
          path: path.posix.join('artifacts', artifact.relativePath),
          role: 'artifact',
          artifactId: artifact.artifactId,
          sizeBytes: copied.sizeBytes,
          sha256: copied.sha256,
          required: true
        });
      }
      if (this.postsDir && (await pathExists(this.postsDir))) {
        const posts = await listFiles(this.postsDir);
        for (const file of posts) {
          await addFile(path.posix.join('posts', file.relativePath), file.absolute, 'bundle');
        }
      }
      if (files.length > config.migration.maxFiles) {
        throw new AppError('MIGRATION_BLOCKED', 'migration package exceeds maxFiles');
      }
      const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
      if (totalBytes > config.migration.maxTotalBytes) {
        throw new AppError('MIGRATION_BLOCKED', 'migration package exceeds maxTotalBytes');
      }
      const collisions = platformPathCollision(files.map((file) => file.path));
      if (collisions) throw new AppError('MIGRATION_BLOCKED', 'migration package has a path collision', { details: collisions });
      const manifest = {
        schemaVersion: MIGRATION_SCHEMA_VERSION,
        kind: 'migration',
        stateVersion: MIGRATION_STATE_VERSION,
        migrationId,
        workspaceId: refreshed.workspaceId,
        sourceInstanceId: migration.sourceInstanceId,
        targetInstanceId: migration.targetInstanceId,
        historyEpoch: refreshed.historyEpoch,
        configRevision: deepClone(refreshed.configRevision),
        timeZone: refreshed.timeZone || 'Asia/Shanghai',
        stableAccountRefs: Object.values(refreshed.accounts || {}).map((account) => account.accountRef),
        recoveryRefs: {
          holds: refreshed.recovery?.holds || [],
          caseId: refreshed.recovery?.id || null
        },
        createdAt: migration.preparedAt || nowIso(this.now),
        sealedAt: nowIso(this.now),
        fileCount: files.length,
        totalBytes,
        files
      };
      manifest.snapshotHash = jcsHash({ manifestWithoutSnapshotHash: manifest, files });
      await atomicWriteJson(path.join(tempDir, 'manifest.json'), manifest);
      await this.hooks.beforeSeal?.({ migrationId, tempDir, manifest });
      const latest = await this.store.getSnapshot();
      if (latest.eventSeq !== refreshed.eventSeq || latest.migration?.id !== migrationId) {
        throw new AppError('MIGRATION_BLOCKED', 'ledger changed during export; retry');
      }
      if (out) {
        const target = path.resolve(out);
        await ensureDir(path.dirname(target));
        await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
        await fsp.rename(tempDir, target);
      } else {
        await fsp.rm(packageDir, { recursive: true, force: true }).catch(() => {});
        await fsp.rename(tempDir, packageDir);
      }
      const finalDir = out ? path.resolve(out) : packageDir;
      await this.store.transaction(async (draft, tx) => {
        if (draft.migration?.id !== migrationId || draft.migration.phase !== 'quiescing') {
          throw new AppError('MIGRATION_BLOCKED', 'migration phase changed during export');
        }
        draft.migration = {
          ...draft.migration,
          phase: 'sealed',
          sealedAt: manifest.sealedAt,
          packageDir: finalDir,
          snapshotHash: manifest.snapshotHash,
          manifest
        };
        tx.appendEvent({
          type: 'migration.sealed',
          actor: 'system',
          payload: { migrationId, snapshotHash: manifest.snapshotHash, files: files.length }
        });
      });
      return {
        migrationId,
        phase: 'sealed',
        packageDir: finalDir,
        snapshotHash: manifest.snapshotHash,
        files: files.length,
        totalBytes,
        manifest
      };
    } catch (error) {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async release({ migrationId }, humanContext) {
    await this._requireHuman(humanContext, { action: 'migration.release', migrationId });
    const state = await this.store.getSnapshot();
    const migration = state.migration;
    if (!migration || migration.id !== migrationId) throw new AppError('MIGRATION_BLOCKED', 'migration not found');
    if (migration.phase === 'released') {
      const currentInstance = await this.store.getInstance();
      if (currentInstance.status !== 'retired') {
        await this.store.updateInstance((instance) => {
          instance.status = 'retired';
          instance.allowedCapabilities = [];
          instance.retiredAt = migration.releasedAt || nowIso(this.now);
          instance.retiredMigrationId = migrationId;
          instance.activationRevision = (instance.activationRevision || 0) + 1;
        });
      }
      if (migration.releaseReceipt) return { migration: deepClone(migration), receipt: deepClone(migration.releaseReceipt), deduplicated: true };
      throw new AppError('MIGRATION_BLOCKED', 'released migration has no receipt');
    }
    if (migration.phase !== 'sealed') throw new AppError('MIGRATION_BLOCKED', `cannot release from ${migration.phase}`);
    const packageDir = migration.packageDir;
    if (!packageDir || !(await pathExists(path.join(packageDir, 'manifest.json')))) {
      throw new AppError('MIGRATION_BLOCKED', 'sealed package is missing');
    }
    const manifest = await readJson(path.join(packageDir, 'manifest.json'));
    if (manifest.snapshotHash !== migration.snapshotHash) {
      throw new AppError('MIGRATION_BLOCKED', 'sealed package hash does not match the ledger');
    }
    const receipt = {
      schemaVersion: 1,
      kind: 'migration_receipt',
      migrationId,
      workspaceId: state.workspaceId,
      sourceInstanceId: migration.sourceInstanceId,
      targetInstanceId: migration.targetInstanceId,
      snapshotHash: migration.snapshotHash,
      sourceHistoryEpoch: state.historyEpoch,
      cutEventSeq: state.eventSeq,
      releasedAt: nowIso(this.now),
      releasedBy: humanContext.principal.id
    };
    await atomicWriteJson(path.join(packageDir, 'receipt.json'), receipt);
    const released = await this.store.transaction(async (draft, tx) => {
      if (draft.migration?.id !== migrationId || draft.migration.phase !== 'sealed') {
        throw new AppError('MIGRATION_BLOCKED', 'migration phase changed during release');
      }
      draft.migration = {
        ...draft.migration,
        phase: 'released',
        releasedAt: receipt.releasedAt,
        releaseReceipt: receipt
      };
      tx.appendEvent({
        type: 'migration.released',
        actor: humanContext.principal.id,
        payload: {
          migrationId,
          snapshotHash: receipt.snapshotHash,
          targetInstanceId: receipt.targetInstanceId
        }
      });
      return deepClone(draft.migration);
    });
    await this.store.updateInstance((instance) => {
      instance.status = 'retired';
      instance.allowedCapabilities = [];
      instance.retiredAt = receipt.releasedAt;
      instance.retiredMigrationId = migrationId;
      instance.activationRevision = (instance.activationRevision || 0) + 1;
    });
    return { migration: released, receipt, deduplicated: false };
  }

  async importPackage({ from, dataDir }, humanContext) {
    await this._requireHuman(humanContext, { action: 'migration.import', from, dataDir });
    return this._importPackage({ from, dataDir });
  }

  async _importPackage({ from, dataDir }) {
    if (!path.isAbsolute(from) || !path.isAbsolute(dataDir)) {
      throw new AppError('CONFIG_INVALID', 'import source and target must be absolute paths');
    }
    const manifest = await readJson(path.join(from, 'manifest.json'), 'MIGRATION_BLOCKED');
    if (manifest.schemaVersion !== MIGRATION_SCHEMA_VERSION || manifest.kind !== 'migration') {
      throw new AppError('SCHEMA_UNSUPPORTED', 'only kind=migration schemaVersion=1 packages can be imported');
    }
    if (manifest.stateVersion !== MIGRATION_STATE_VERSION) {
      throw new AppError('SCHEMA_UNSUPPORTED', 'migration stateVersion must be 3');
    }
    const targetStateFile = path.join(dataDir, 'state.json');
    if (await pathExists(targetStateFile)) throw new AppError('MIGRATION_BLOCKED', 'target data directory is not empty');
    const targetExisted = await pathExists(dataDir);
    await ensureDir(dataDir);
    const existing = await fsp.readdir(dataDir);
    if (existing.length > 0) throw new AppError('MIGRATION_BLOCKED', 'target data directory is not empty');
    try {
      const verified = await verifyMigrationPackage(from);
      const sourceState = verified.state;
      const targetState = deepClone(sourceState);
      const targetInstanceId = `instance_${randomId('i').split('_').at(-1)}`;
      targetState.migration = {
        phase: 'imported',
        id: manifest.migrationId,
        sourceInstanceId: manifest.sourceInstanceId,
        targetInstanceId,
        importedAt: nowIso(this.now),
        snapshotHash: manifest.snapshotHash,
        sourceHistoryEpoch: manifest.historyEpoch
      };
      targetState.configRevision = deepClone(manifest.configRevision);
      for (const approval of Object.values(targetState.approvals || {})) {
        approval.nonceHash = null;
        approval.usableForAuthorization = false;
        approval.invalidatedByMigration = true;
      }
      for (const binding of Object.values(targetState.bindings || {})) {
        binding.requiresReverification = true;
      }
      for (const task of Object.values(targetState.tasks || {})) {
        if (['succeeded', 'cancelled'].includes(task.status)) continue;
        if (!Array.isArray(task.holds)) task.holds = [];
        const migrationHold = makeMigrationHold({
          id: `hold_migration_${task.id}`,
          scope: { kind: 'workspace', workspaceId: targetState.workspaceId },
          revision: 1,
          evidenceRefs: [],
          createdAt: nowIso(this.now)
        });
        const existingHoldIndex = task.holds.findIndex((hold) => hold.id === migrationHold.id);
        if (existingHoldIndex >= 0) task.holds[existingHoldIndex] = migrationHold;
        else task.holds.push(migrationHold);
        task.isSettled = false;
      }
      for (const notification of Object.values(targetState.outbox || {})) {
        if (['pending', 'sending'].includes(notification.status)) {
          notification.status = 'suppressed';
          notification.suppressionReason = 'migration_import';
        }
      }
      for (const production of Object.values(targetState.productions || {})) {
        production.readyForPublish = false;
        production.migrationHold = true;
      }
      const instance = {
        schemaVersion: 1,
        instanceId: targetInstanceId,
        workspaceId: sourceState.workspaceId,
        processStartedAt: null,
        createdAt: nowIso(this.now),
        bootstrapComplete: true,
        status: 'paused',
        activationRevision: 0,
        allowedCapabilities: [],
        configRevision: deepClone(manifest.configRevision),
        recoveryRevision: sourceState.recovery?.revision || 0,
        schedulerDisabled: true,
        previousInstanceId: manifest.sourceInstanceId,
        migrationId: manifest.migrationId,
        intendedTargetInstanceId: manifest.targetInstanceId
      };
      for (const file of manifest.files) {
        if (!isSafeRelativePath(file.path)) throw new AppError('MIGRATION_BLOCKED', 'unsafe package path');
        if (file.role === 'state') continue;
        const source = resolveInside(from, file.path);
        const relative = file.path.replace(/^(journal|diary|artifacts|posts)\//, '');
        const rootName =
          file.role === 'journal'
            ? 'journal'
            : file.role === 'diary'
              ? 'diary'
              : file.role === 'artifact'
                ? 'artifacts'
                : file.role === 'bundle'
                  ? 'posts'
                  : null;
        if (!rootName) continue;
        const target = resolveInside(dataDir, path.posix.join(rootName, relative));
        await ensureDir(path.dirname(target));
        const copied = await copyFileWithHash(source, target);
        if (copied.sha256 !== file.sha256) throw new AppError('MIGRATION_BLOCKED', 'copied file hash mismatch');
      }
      await atomicWriteJson(path.join(dataDir, 'state.json'), targetState);
      await atomicWriteJson(path.join(dataDir, 'instance.json'), instance);
      await atomicWriteJson(path.join(dataDir, 'migration-package.json'), manifest);
      const receiptSource = path.join(from, 'receipt.json');
      if (await pathExists(receiptSource)) {
        const receipt = await readJson(receiptSource);
        if (receipt.snapshotHash !== manifest.snapshotHash || receipt.targetInstanceId !== manifest.targetInstanceId) {
          throw new AppError('MIGRATION_BLOCKED', 'release receipt does not match the package target');
        }
        await atomicWriteJson(path.join(dataDir, 'migration-receipt.json'), receipt);
      }
      return {
        migrationId: manifest.migrationId,
        targetInstanceId,
        phase: 'imported',
        files: manifest.files.length,
        snapshotHash: manifest.snapshotHash,
        dataDir
      };
    } catch (error) {
      if (targetExisted) {
        const entries = await fsp.readdir(dataDir).catch(() => []);
        for (const entry of entries) await fsp.rm(path.join(dataDir, entry), { recursive: true, force: true });
      } else {
        await fsp.rm(dataDir, { recursive: true, force: true }).catch(() => {});
      }
      throw error;
    }
    }

  async validate({ migrationId, dataDir }, humanContext = null) {
    if (humanContext) await this._requireHuman(humanContext, { action: 'migration.validate', migrationId });
    const state = await readJson(path.join(dataDir, 'state.json'), 'MIGRATION_BLOCKED');
    const instance = await readJson(path.join(dataDir, 'instance.json'), 'MIGRATION_BLOCKED');
    const manifest = await readJson(path.join(dataDir, 'migration-package.json'), 'MIGRATION_BLOCKED');
    if (state.migration?.id !== migrationId || !['imported', 'validated'].includes(state.migration.phase)) {
      throw new AppError('MIGRATION_BLOCKED', 'target migration state is not importable/validated');
    }
    if (instance.status !== 'paused' && instance.status !== 'validated') {
      throw new AppError('MIGRATION_BLOCKED', 'target instance is not paused');
    }
    if (manifest.migrationId !== migrationId || manifest.targetInstanceId !== instance.intendedTargetInstanceId) {
      throw new AppError('MIGRATION_BLOCKED', 'manifest target does not match the imported instance');
    }
    const activation = this.activationChecks
      ? await this.activationChecks({ state, instance, dataDir, manifest })
      : { capabilities: ['core:read', 'core:write'], blocked: ['platform_unverified'] };
    const capabilities = [...new Set(activation.capabilities || ['core:read', 'core:write'])].sort();
    for (const capability of capabilities) {
      if (!['core:read', 'core:write', 'production:local', 'publish:manual'].includes(capability)) {
        throw new AppError('MIGRATION_BLOCKED', `activation check claimed an unverified capability ${capability}`);
      }
    }
    state.migration = {
      ...state.migration,
      phase: 'validated',
      validatedAt: nowIso(this.now),
      capabilities,
      blockedCapabilities: activation.blocked || []
    };
    instance.status = 'validated';
    instance.allowedCapabilities = capabilities;
    instance.activationRevision = 1;
    instance.migrationValidation = {
      validatedAt: nowIso(this.now),
      capabilities,
      blocked: activation.blocked || []
    };
    await atomicWriteJson(path.join(dataDir, 'state.json'), state);
    await atomicWriteJson(path.join(dataDir, 'instance.json'), instance);
    return {
      migrationId,
      phase: 'validated',
      capabilities,
      blocked: activation.blocked || [],
      targetInstanceId: instance.instanceId
    };
  }

  async _targetProtection() {
    if (!this.protection?.getProtection) {
      throw new AppError('BACKUP_UNPROTECTED', 'no backup protection service is configured for activation');
    }
    const result = await this.protection.getProtection({ kind: 'workspace', workspaceId: null });
    if (result.status !== 'protected') {
      throw new AppError(result.status === 'degraded' ? 'BACKUP_STALE' : 'BACKUP_UNPROTECTED', 'activate requires a healthy target recovery point');
    }
    return result;
  }

  async activate({ migrationId, receipt, dataDir }, humanContext) {
    await this._requireHuman(humanContext, { action: 'migration.activate', migrationId, snapshotHash: receipt?.snapshotHash });
    return this._activate({ migrationId, receipt, dataDir });
  }

  async _activate({ migrationId, receipt, dataDir }) {
    const state = await readJson(path.join(dataDir, 'state.json'), 'MIGRATION_BLOCKED');
    const instance = await readJson(path.join(dataDir, 'instance.json'), 'MIGRATION_BLOCKED');
    const manifest = await readJson(path.join(dataDir, 'migration-package.json'), 'MIGRATION_BLOCKED');
    if (state.migration?.id !== migrationId) throw new AppError('MIGRATION_BLOCKED', 'target migration record mismatch');
    if (state.migration.phase === 'active' && instance.status === 'active') {
      return { migrationId, phase: 'active', targetInstanceId: instance.instanceId, deduplicated: true };
    }
    if (state.migration.phase !== 'validated') {
      throw new AppError('MIGRATION_BLOCKED', `target is ${state.migration.phase}, not validated`);
    }
    if (!receipt || receipt.kind !== 'migration_receipt' || receipt.migrationId !== migrationId) {
      throw new AppError('MIGRATION_BLOCKED', 'source release receipt is missing or mismatched');
    }
    if (receipt.snapshotHash !== manifest.snapshotHash || receipt.targetInstanceId !== manifest.targetInstanceId) {
      throw new AppError('MIGRATION_BLOCKED', 'release receipt does not bind the package/target');
    }
    const diskReceipt = path.join(dataDir, 'migration-receipt.json');
    const storedReceipt = await readJson(diskReceipt, 'MIGRATION_BLOCKED');
    if (storedReceipt.snapshotHash !== receipt.snapshotHash) {
      throw new AppError('MIGRATION_BLOCKED', 'stored release receipt differs from the presented receipt');
    }
    await this._targetProtection();
    assertNoMatchingHold(
      state,
      normalizeScope({ kind: 'workspace', workspaceId: state.workspaceId })
    );
    const decision = {
      id: `activation_${randomId('a').split('_').at(-1)}`,
      state: 'prepared',
      migrationId,
      snapshotHash: receipt.snapshotHash,
      targetInstanceId: instance.instanceId,
      capabilities: instance.allowedCapabilities,
      preparedAt: nowIso(this.now)
    };
    state.migration = { ...state.migration, phase: 'validated', activationDecision: decision };
    await atomicWriteJson(path.join(dataDir, 'state.json'), state);
    await this.hooks.afterActivationPrepared?.({ state, instance, decision });
    instance.status = 'active';
    instance.activationRevision = (instance.activationRevision || 0) + 1;
    instance.allowedCapabilities = [...new Set(instance.allowedCapabilities || [])].sort();
    instance.activatedAt = nowIso(this.now);
    instance.migrationActivation = { migrationId, snapshotHash: receipt.snapshotHash };
    await atomicWriteJson(path.join(dataDir, 'instance.json'), instance);
    await this.hooks.beforeActivationCommit?.({ state, instance, decision });
    state.migration = {
      ...state.migration,
      phase: 'active',
      activatedAt: nowIso(this.now),
      activationDecision: { ...decision, state: 'committed', committedAt: nowIso(this.now) }
    };
    await atomicWriteJson(path.join(dataDir, 'state.json'), state);
    return {
      migrationId,
      phase: 'active',
      targetInstanceId: instance.instanceId,
      capabilities: instance.allowedCapabilities,
      deduplicated: false
    };
  }

  async status({ dataDir = this.dataDir } = {}) {
    if (this.store) {
      const state = await this.store.getSnapshot();
      return {
        source: deepClone(state.migration),
        target: null
      };
    }
    if (dataDir && (await pathExists(path.join(dataDir, 'state.json')))) {
      const state = await readJson(path.join(dataDir, 'state.json'));
      const instance = await readJson(path.join(dataDir, 'instance.json'));
      return { source: null, target: { migration: state.migration, instance: { instanceId: instance.instanceId, status: instance.status } } };
    }
    return { source: null, target: null };
  }

  async abort({ migrationId }, humanContext) {
    await this._requireHuman(humanContext, { action: 'migration.abort', migrationId });
    const state = await this.store.getSnapshot();
    if (state.migration?.id !== migrationId) throw new AppError('MIGRATION_BLOCKED', 'migration not found');
    if (!['quiescing', 'sealed'].includes(state.migration.phase)) {
      throw new AppError('MIGRATION_BLOCKED', 'only a pre-release migration can be aborted');
    }
    const packageDir = state.migration.packageDir;
    const result = await this.store.transaction(async (draft, tx) => {
      const abortedAt = nowIso(this.now);
      draft.migration = {
        phase: 'active',
        id: null,
        lastAborted: { id: migrationId, abortedAt }
      };
      tx.appendEvent({
        type: 'migration.aborted',
        actor: humanContext.principal.id,
        payload: { migrationId, abortedAt }
      });
      return deepClone(draft.migration);
    });
    if (packageDir && (await pathExists(packageDir))) {
      await fsp.rm(packageDir, { recursive: true, force: true }).catch(() => {});
    }
    return result;
  }

  async disableTarget(
    { migrationId, targetDataDir = null, targetStopped = false, targetStopEvidence = null },
    humanContext
  ) {
    await this._requireHuman(humanContext, { action: 'migration.disable-target', migrationId });
    const state = await this.store.getSnapshot();
    if (state.migration?.id !== migrationId || state.migration.phase !== 'released') {
      throw new AppError('MIGRATION_BLOCKED', 'only a released source can disable its target');
    }
    if (targetStopped !== true) {
      throw new AppError('MIGRATION_BLOCKED', 'target writer stop must be explicitly attested before disable-target');
    }
    if (typeof targetStopEvidence !== 'string' || targetStopEvidence.trim() === '') {
      throw new AppError('MIGRATION_BLOCKED', 'target stop evidence is required before disable-target');
    }
    if (typeof targetDataDir !== 'string' || !path.isAbsolute(targetDataDir)) {
      throw new AppError('MIGRATION_BLOCKED', 'targetDataDir is required and must be absolute; source remains blocked until the target is reachable');
    }
    const targetDir = path.resolve(targetDataDir);
    if (targetDir === path.resolve(this.dataDir || '')) {
      throw new AppError('MIGRATION_BLOCKED', 'targetDataDir must not be the active source data directory');
    }
    const targetStateFile = path.join(targetDir, 'state.json');
    const targetInstanceFile = path.join(targetDir, 'instance.json');
    if (!(await pathExists(targetStateFile)) || !(await pathExists(targetInstanceFile))) {
      throw new AppError('MIGRATION_BLOCKED', 'target latest ledger is unavailable; disable-target remains blocked');
    }
    const targetState = await readJson(targetStateFile);
    const targetInstance = await readJson(targetInstanceFile);
    if (targetState.migration?.id !== migrationId) {
      throw new AppError('MIGRATION_BLOCKED', 'target data directory does not belong to this migration');
    }
    if (targetState.workspaceId !== state.workspaceId) {
      throw new AppError('MIGRATION_BLOCKED', 'target workspace does not match the source');
    }
    if (!['active', 'validated', 'paused', 'disabled'].includes(targetInstance.status)) {
      throw new AppError('MIGRATION_BLOCKED', `target instance status ${targetInstance.status} cannot be disabled`);
    }
    if (targetInstance.status !== 'disabled' || targetState.migration.phase !== 'disabled') {
      targetState.migration = {
        ...targetState.migration,
        phase: 'disabled',
        disabledAt: nowIso(this.now)
      };
      targetInstance.status = 'disabled';
      targetInstance.allowedCapabilities = [];
      targetInstance.activationRevision = (targetInstance.activationRevision || 0) + 1;
      await atomicWriteJson(targetStateFile, targetState);
      await atomicWriteJson(targetInstanceFile, targetInstance);
    }
    const readbackState = await readJson(targetStateFile);
    const readbackInstance = await readJson(targetInstanceFile);
    if (
      readbackInstance.status !== 'disabled' ||
      readbackState.migration?.phase !== 'disabled' ||
      (readbackInstance.allowedCapabilities || []).length !== 0
    ) {
      throw new AppError('MIGRATION_BLOCKED', 'target did not persist the disabled state; source remains blocked');
    }
    const stopEvidenceHash = sha256Hex(targetStopEvidence);
    const result = await this.store.transaction(async (draft, tx) => {
      draft.migration = {
        ...draft.migration,
        targetDisabledAt: nowIso(this.now),
        targetDisabled: true,
        targetDataDir: targetDir,
        targetStopEvidenceHash: stopEvidenceHash,
        targetStopEvidence: targetStopEvidence.trim().slice(0, 1000)
      };
      tx.appendEvent({
        type: 'migration.target.disabled',
        actor: humanContext.principal.id,
        payload: { migrationId, targetDataDir: targetDir, targetStopEvidenceHash: stopEvidenceHash }
      });
      return deepClone(draft.migration);
    });
    return result;
  }

  async _buildReversePackage({
    migrationId,
    targetDataDir,
    reverseMigrationId,
    reverseTargetInstanceId,
    targetState,
    targetInstance,
    humanContext
  }) {
    const config = this._config();
    if (targetState.version !== 3) throw new AppError('MIGRATION_BLOCKED', 'target state is not v3');
    if (targetState.migration?.id !== migrationId) {
      throw new AppError('MIGRATION_BLOCKED', 'target state does not belong to this migration');
    }
    if (targetInstance.status !== 'disabled') {
      throw new AppError('MIGRATION_BLOCKED', 'target must be disabled before reverse packaging');
    }
    if (Object.keys(targetState.artifactPendingImports || {}).length > 0) {
      throw new AppError('MIGRATION_BLOCKED', 'target has pending artifact imports');
    }
    if (Object.values(targetState.diaries || {}).some((entry) => entry.pendingCommit)) {
      throw new AppError('MIGRATION_BLOCKED', 'target has pending diary commits');
    }
    const inFlight = Object.values(targetState.operations || {}).filter((operation) =>
      ['reserved', 'dispatching'].includes(operation.status)
    );
    if (inFlight.length > 0) {
      throw new AppError('MIGRATION_BLOCKED', 'target has in-flight operations; resolve them before reverse migration', {
        details: { operations: inFlight.map((operation) => operation.id) }
      });
    }
    const packageDir = resolveInside(this.migrationsDir, reverseMigrationId);
    const tempDir = `${packageDir}.tmp.${randomId('t')}`;
    const createdAt = nowIso(this.now);
    try {
      await ensureDir(tempDir);
      const files = [];
      const addFile = async (relative, source, role, artifactId = null) => {
        if (!isSafeRelativePath(relative)) throw new AppError('MIGRATION_BLOCKED', 'unsafe reverse package path');
        const target = resolveInside(tempDir, relative);
        await ensureDir(path.dirname(target));
        const copied = await copyFileWithHash(source, target);
        const entry = {
          path: relative,
          role,
          artifactId,
          sizeBytes: copied.sizeBytes,
          sha256: copied.sha256,
          required: true
        };
        files.push(entry);
        return entry;
      };
      const sanitized = sanitizeStateForMigration(targetState);
      const stateJson = `${JSON.stringify(sanitized, null, 2)}\n`;
      await fsp.writeFile(path.join(tempDir, 'state.json'), stateJson, { mode: 0o600 });
      files.push({
        path: 'state.json',
        role: 'state',
        sizeBytes: Buffer.byteLength(stateJson),
        sha256: sha256Hex(stateJson),
        required: true
      });
      const targetJournalDir = path.join(targetDataDir, 'journal');
      for (const segment of Object.values(targetState.journalSegments || {})) {
        if (!isSafeRelativePath(segment.relativePath)) {
          throw new AppError('JOURNAL_CORRUPTED', 'target journal segment path is unsafe');
        }
        const source = resolveInside(targetJournalDir, segment.relativePath);
        if (!(await pathExists(source))) {
          throw new AppError('JOURNAL_CORRUPTED', 'target journal segment is missing');
        }
        const packageRelative = path.posix.join('journal', segment.relativePath);
        await addFile(packageRelative, source, 'journal');
        const copiedSegment = JSON.parse(
          await fsp.readFile(resolveInside(tempDir, packageRelative), 'utf8')
        );
        if (
          copiedSegment.historyEpoch !== segment.historyEpoch ||
          copiedSegment.startSeq !== segment.startSeq ||
          copiedSegment.endSeq !== segment.endSeq ||
          copiedSegment.segmentHash !== segment.hash ||
          segmentHash(copiedSegment.historyEpoch, copiedSegment.events) !== segment.hash
        ) {
          throw new AppError('JOURNAL_CORRUPTED', 'target journal segment integrity check failed');
        }
      }
      const targetDiaryDir = path.join(targetDataDir, 'diary');
      for (const entry of Object.values(targetState.diaries || {})) {
        if (!entry.targetFile) continue;
        if (!isSafeRelativePath(entry.targetFile)) {
          throw new AppError('MIGRATION_BLOCKED', 'target diary path is unsafe');
        }
        const source = resolveInside(targetDiaryDir, entry.targetFile);
        if (!(await pathExists(source))) {
          throw new AppError('MIGRATION_BLOCKED', 'target diary body is missing');
        }
        await addFile(path.posix.join('diary', entry.targetFile), source, 'diary');
        if (entry.contentHash && sha256Hex(await fsp.readFile(source, 'utf8')) !== entry.contentHash) {
          throw new AppError('MIGRATION_BLOCKED', 'target diary digest does not match its ledger');
        }
      }
      const targetArtifactDir = path.join(targetDataDir, 'artifacts');
      for (const artifact of Object.values(targetState.artifacts || {})) {
        if (!isSafeRelativePath(artifact.relativePath)) {
          throw new AppError('ARTIFACT_INVALID', 'target artifact path is unsafe');
        }
        const source = resolveInside(targetArtifactDir, artifact.relativePath);
        if (!(await pathExists(source))) {
          throw new AppError('MIGRATION_BLOCKED', 'target artifact bytes are missing', {
            details: { artifactId: artifact.artifactId }
          });
        }
        const copied = await addFile(
          path.posix.join('artifacts', artifact.relativePath),
          source,
          'artifact',
          artifact.artifactId
        );
        if (copied.sha256 !== artifact.sha256 || copied.sizeBytes !== artifact.sizeBytes) {
          throw new AppError('ARTIFACT_INVALID', 'target artifact digest does not match its ledger');
        }
      }
      const targetPostsDir = path.join(targetDataDir, 'posts');
      if (await pathExists(targetPostsDir)) {
        for (const file of await listFiles(targetPostsDir)) {
          await addFile(path.posix.join('posts', file.relativePath), file.absolute, 'bundle');
        }
      }
      if (files.length > config.migration.maxFiles) {
        throw new AppError('MIGRATION_BLOCKED', 'reverse migration package exceeds maxFiles');
      }
      const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
      if (totalBytes > config.migration.maxTotalBytes) {
        throw new AppError('MIGRATION_BLOCKED', 'reverse migration package exceeds maxTotalBytes');
      }
      const collisions = platformPathCollision(files.map((file) => file.path));
      if (collisions) throw new AppError('MIGRATION_BLOCKED', 'reverse migration package has a path collision');
      const manifest = {
        schemaVersion: MIGRATION_SCHEMA_VERSION,
        kind: 'migration',
        stateVersion: MIGRATION_STATE_VERSION,
        migrationId: reverseMigrationId,
        workspaceId: targetState.workspaceId,
        sourceInstanceId: targetInstance.instanceId,
        targetInstanceId: reverseTargetInstanceId,
        historyEpoch: targetState.historyEpoch,
        configRevision: deepClone(targetState.configRevision),
        timeZone: targetState.timeZone || 'Asia/Shanghai',
        stableAccountRefs: Object.values(targetState.accounts || {}).map((account) => account.accountRef),
        recoveryRefs: {
          holds: targetState.recovery?.holds || [],
          caseId: targetState.recovery?.id || null
        },
        createdAt,
        sealedAt: nowIso(this.now),
        fileCount: files.length,
        totalBytes,
        files,
        reverseOf: migrationId
      };
      manifest.snapshotHash = jcsHash({ manifestWithoutSnapshotHash: manifest, files });
      await atomicWriteJson(path.join(tempDir, 'manifest.json'), manifest);
      const receipt = {
        schemaVersion: 1,
        kind: 'migration_receipt',
        migrationId: reverseMigrationId,
        workspaceId: targetState.workspaceId,
        sourceInstanceId: targetInstance.instanceId,
        targetInstanceId: reverseTargetInstanceId,
        snapshotHash: manifest.snapshotHash,
        sourceHistoryEpoch: targetState.historyEpoch,
        cutEventSeq: targetState.eventSeq,
        releasedAt: nowIso(this.now),
        releasedBy: humanContext.principal.id
      };
      await atomicWriteJson(path.join(tempDir, 'receipt.json'), receipt);
      await fsp.rm(packageDir, { recursive: true, force: true }).catch(() => {});
      await fsp.rename(tempDir, packageDir);
      return {
        reverseMigrationId,
        reverseTargetInstanceId,
        packageDir,
        manifest,
        receipt,
        targetStateHash: jcsHash(targetState),
        targetHistoryEpoch: targetState.historyEpoch,
        targetEventSeq: targetState.eventSeq
      };
    } catch (error) {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async rollback({ migrationId, targetDataDir, to = null }, humanContext) {
    await this._requireHuman(humanContext, {
      action: 'migration.rollback',
      migrationId,
      targetDataDir,
      to
    });
    const state = await this.store.getSnapshot();
    if (state.migration?.id !== migrationId || state.migration.phase !== 'released') {
      throw new AppError('MIGRATION_BLOCKED', 'rollback requires a released source migration');
    }
    if (!state.migration.targetDisabled) {
      throw new AppError('MIGRATION_BLOCKED', 'disable-target must succeed before rollback');
    }
    if (typeof targetDataDir !== 'string' || !path.isAbsolute(targetDataDir)) {
      throw new AppError('MIGRATION_BLOCKED', 'target latest ledger location is required for rollback');
    }
    if (typeof to !== 'string' || !path.isAbsolute(to)) {
      throw new AppError('CONFIG_INVALID', 'rollback destination data directory must be absolute');
    }
    const targetDir = path.resolve(targetDataDir);
    const rollbackDir = path.resolve(to);
    if (targetDir === rollbackDir) {
      throw new AppError('MIGRATION_BLOCKED', 'rollback destination must be a new directory, not the disabled target');
    }
    if (this.dataDir && (ensureWithin(this.dataDir, rollbackDir) || ensureWithin(rollbackDir, this.dataDir))) {
      throw new AppError('MIGRATION_BLOCKED', 'rollback destination must be outside the source data directory');
    }
    if (ensureWithin(targetDir, rollbackDir) || ensureWithin(rollbackDir, targetDir)) {
      throw new AppError('MIGRATION_BLOCKED', 'rollback destination must be outside the target data directory');
    }
    const targetStateFile = path.join(targetDir, 'state.json');
    const targetInstanceFile = path.join(targetDir, 'instance.json');
    if (!(await pathExists(targetStateFile)) || !(await pathExists(targetInstanceFile))) {
      throw new AppError('MIGRATION_BLOCKED', 'target latest ledger is unavailable; blocking rollback');
    }
    const targetState = await readJson(targetStateFile);
    const targetInstance = await readJson(targetInstanceFile);
    if (targetState.migration?.id !== migrationId) {
      throw new AppError('MIGRATION_BLOCKED', 'target ledger does not belong to this migration');
    }
    if (targetInstance.status !== 'disabled') {
      throw new AppError('MIGRATION_BLOCKED', 'target must be disabled before reverse handover');
    }
    if (state.workspaceId !== targetState.workspaceId) {
      throw new AppError('MIGRATION_BLOCKED', 'target workspace does not match the source');
    }
    const targetStateHash = jcsHash(targetState);
    const existingRollback = state.migration.rollback;
    let prepared = null;
    if (existingRollback) {
      if (existingRollback.phase === 'activated') {
        if (
          existingRollback.rollbackDataDir === rollbackDir &&
          existingRollback.targetDataDir === targetDir
        ) {
          return {
            migration: deepClone(state.migration),
            reverseMigrationId: existingRollback.reverseMigrationId,
            reverseTargetInstanceId: existingRollback.reverseTargetInstanceId,
            rollbackDataDir: existingRollback.rollbackDataDir,
            packageDir: existingRollback.reversePackageDir,
            targetStateHash: existingRollback.targetStateHash,
            targetHistoryEpoch: existingRollback.targetHistoryEpoch,
            targetEventSeq: existingRollback.targetEventSeq,
            imported: null,
            validated: null,
            activated: {
              migrationId: existingRollback.reverseMigrationId,
              phase: 'active',
              targetInstanceId: existingRollback.reverseTargetInstanceId,
              deduplicated: true
            },
            deduplicated: true
          };
        }
        throw new AppError('MIGRATION_BLOCKED', 'rollback was already activated at a different destination');
      }
      if (existingRollback.phase !== 'prepared') {
        throw new AppError('MIGRATION_BLOCKED', `rollback is already ${existingRollback.phase}`);
      }
      if (
        existingRollback.rollbackDataDir !== rollbackDir ||
        existingRollback.targetDataDir !== targetDir
      ) {
        throw new AppError('MIGRATION_BLOCKED', 'a prepared rollback exists for another destination; retry that destination');
      }
      if (existingRollback.targetStateHash !== targetStateHash) {
        throw new AppError('MIGRATION_BLOCKED', 'target ledger changed after the rollback was prepared');
      }
      prepared = existingRollback;
    } else {
      if (await pathExists(rollbackDir)) {
        const entries = await fsp.readdir(rollbackDir);
        if (entries.length > 0) throw new AppError('MIGRATION_BLOCKED', 'rollback destination must be empty');
      }
      const reverseMigrationId = `migration_${randomId('r').split('_').at(-1)}`;
      const reverseTargetInstanceId = `reverse_target_${randomId('i').split('_').at(-1)}`;
      prepared = await this.store.transaction(async (draft, tx) => {
        if (draft.migration?.id !== migrationId || draft.migration.phase !== 'released') {
          throw new AppError('MIGRATION_BLOCKED', 'source migration changed before rollback preparation');
        }
        if (draft.migration.rollback) {
          throw new AppError('MIGRATION_BLOCKED', 'another rollback is already prepared');
        }
        const value = {
          phase: 'prepared',
          reverseMigrationId,
          reverseTargetInstanceId,
          rollbackDataDir: rollbackDir,
          targetDataDir: targetDir,
          targetStateHash,
          targetInstanceId: targetInstance.instanceId,
          targetHistoryEpoch: targetState.historyEpoch,
          targetEventSeq: targetState.eventSeq,
          preparedAt: nowIso(this.now),
          reversePackageDir: null,
          packageSnapshotHash: null
        };
        draft.migration = { ...draft.migration, rollback: value };
        tx.appendEvent({
          type: 'migration.rollback.prepared',
          actor: humanContext.principal.id,
          payload: {
            migrationId,
            reverseMigrationId,
            targetStateHash,
            targetDataDir: targetDir,
            rollbackDataDir: rollbackDir
          }
        });
        return deepClone(value);
      });
    }

    let built = null;
    if (
      prepared.packageSnapshotHash &&
      prepared.reversePackageDir &&
      (await pathExists(path.join(prepared.reversePackageDir, 'manifest.json')))
    ) {
      const verified = await verifyMigrationPackage(prepared.reversePackageDir);
      if (
        verified.manifest.migrationId !== prepared.reverseMigrationId ||
        verified.manifest.snapshotHash !== prepared.packageSnapshotHash
      ) {
        throw new AppError('MIGRATION_BLOCKED', 'prepared reverse package does not match the source record');
      }
      const receipt = await readJson(path.join(prepared.reversePackageDir, 'receipt.json'), 'MIGRATION_BLOCKED');
      built = {
        reverseMigrationId: prepared.reverseMigrationId,
        reverseTargetInstanceId: prepared.reverseTargetInstanceId,
        packageDir: prepared.reversePackageDir,
        manifest: verified.manifest,
        receipt,
        targetStateHash: prepared.targetStateHash,
        targetHistoryEpoch: prepared.targetHistoryEpoch,
        targetEventSeq: prepared.targetEventSeq
      };
    } else {
      built = await this._buildReversePackage({
        migrationId,
        targetDataDir: targetDir,
        reverseMigrationId: prepared.reverseMigrationId,
        reverseTargetInstanceId: prepared.reverseTargetInstanceId,
        targetState,
        targetInstance,
        humanContext
      });
      prepared = await this.store.transaction(async (draft) => {
        const current = draft.migration?.rollback;
        if (!current || current.reverseMigrationId !== prepared.reverseMigrationId || current.phase !== 'prepared') {
          throw new AppError('MIGRATION_BLOCKED', 'rollback preparation changed before package publication');
        }
        draft.migration.rollback = {
          ...current,
          reversePackageDir: built.packageDir,
          packageSnapshotHash: built.manifest.snapshotHash
        };
        return deepClone(draft.migration.rollback);
      });
    }

    let imported = null;
    let validated = null;
    let activated = null;
    const rollbackStateFile = path.join(rollbackDir, 'state.json');
    const rollbackInstanceFile = path.join(rollbackDir, 'instance.json');
    if (await pathExists(rollbackStateFile)) {
      const rollbackState = await readJson(rollbackStateFile);
      const rollbackInstance = await readJson(rollbackInstanceFile);
      if (
        rollbackState.migration?.id !== prepared.reverseMigrationId ||
        rollbackInstance.intendedTargetInstanceId !== prepared.reverseTargetInstanceId
      ) {
        throw new AppError('MIGRATION_BLOCKED', 'rollback destination contains a different reverse migration');
      }
      validated = {
        migrationId: prepared.reverseMigrationId,
        phase: rollbackState.migration.phase,
        targetInstanceId: rollbackInstance.instanceId
      };
      if (rollbackInstance.status === 'active') {
        activated = {
          migrationId: prepared.reverseMigrationId,
          phase: 'active',
          targetInstanceId: rollbackInstance.instanceId,
          capabilities: rollbackInstance.allowedCapabilities || [],
          deduplicated: true
        };
      } else if (rollbackInstance.status === 'validated') {
        activated = await this._activate({
          migrationId: prepared.reverseMigrationId,
          receipt: built.receipt,
          dataDir: rollbackDir
        });
      } else if (rollbackState.migration.phase === 'imported' && rollbackInstance.status === 'paused') {
        validated = await this.validate({ migrationId: prepared.reverseMigrationId, dataDir: rollbackDir });
        activated = await this._activate({
          migrationId: prepared.reverseMigrationId,
          receipt: built.receipt,
          dataDir: rollbackDir
        });
      } else {
        throw new AppError('MIGRATION_BLOCKED', 'rollback destination is in an unsupported partial state');
      }
    } else {
      if (await pathExists(rollbackDir)) {
        const entries = await fsp.readdir(rollbackDir);
        if (entries.length > 0) throw new AppError('MIGRATION_BLOCKED', 'rollback destination has unowned partial data');
      }
      try {
        imported = await this._importPackage({ from: built.packageDir, dataDir: rollbackDir });
        validated = await this.validate({ migrationId: prepared.reverseMigrationId, dataDir: rollbackDir });
        activated = await this._activate({
          migrationId: prepared.reverseMigrationId,
          receipt: built.receipt,
          dataDir: rollbackDir
        });
      } catch (error) {
        throw new AppError(error.code || 'MIGRATION_BLOCKED', `reverse migration failed: ${error.message}`, {
          cause: error,
          details: {
            reverseMigrationId: prepared.reverseMigrationId,
            packageDir: built.packageDir,
            rollbackDir
          }
        });
      }
    }
    await this.hooks.afterReverseActivated?.({ migrationId, prepared, built, rollbackDir, activated });
    const result = await this.store.transaction(async (draft, tx) => {
      const current = draft.migration?.rollback;
      if (!current || current.reverseMigrationId !== prepared.reverseMigrationId) {
        throw new AppError('MIGRATION_BLOCKED', 'rollback preparation disappeared before activation commit');
      }
      draft.migration = {
        ...draft.migration,
        rollback: {
          ...current,
          reverseTargetInstanceId: activated.targetInstanceId,
          reversePackageDir: built.packageDir,
          rollbackDataDir: rollbackDir,
          targetStateHash: built.targetStateHash,
          targetInstanceId: targetInstance.instanceId,
          targetHistoryEpoch: built.targetHistoryEpoch,
          targetEventSeq: built.targetEventSeq,
          packageSnapshotHash: built.manifest.snapshotHash,
          rolledBackAt: nowIso(this.now),
          phase: 'activated'
        }
      };
      tx.appendEvent({
        type: 'migration.rollback.activated',
        actor: humanContext.principal.id,
        payload: {
          migrationId,
          reverseMigrationId: prepared.reverseMigrationId,
          reverseTargetInstanceId: activated.targetInstanceId,
          rollbackDataDir: rollbackDir,
          packageSnapshotHash: built.manifest.snapshotHash
        }
      });
      return deepClone(draft.migration);
    });
    return {
      migration: result,
      reverseMigrationId: prepared.reverseMigrationId,
      reverseTargetInstanceId: activated.targetInstanceId,
      rollbackDataDir: rollbackDir,
      packageDir: built.packageDir,
      targetStateHash: built.targetStateHash,
      targetHistoryEpoch: built.targetHistoryEpoch,
      targetEventSeq: built.targetEventSeq,
      imported,
      validated,
      activated
    };
  }
}

export function sanitizeStateForMigration(state) {
  const clone = deepClone(state);
  delete clone.checkpointFence;
  delete clone.backups;
  for (const approval of Object.values(clone.approvals || {})) {
    approval.nonceHash = null;
    approval.usableForAuthorization = false;
  }
  for (const binding of Object.values(clone.bindings || {})) {
    binding.requiresReverification = true;
  }
  for (const principal of Object.values(clone.principals || {})) {
    principal.requiresReverification = true;
  }
  if (clone.migration) {
    clone.migration = {
      phase: clone.migration.phase,
      id: clone.migration.id,
      targetInstanceId: clone.migration.targetInstanceId,
      sourceInstanceId: clone.migration.sourceInstanceId,
      preparedAt: clone.migration.preparedAt,
      sealedAt: clone.migration.sealedAt,
      snapshotHash: clone.migration.snapshotHash || null,
      receipt: null
    };
  }
  clone.secretsExcluded = true;
  return clone;
}

export async function verifyMigrationPackage(dir) {
  const manifest = await readJson(path.join(dir, 'manifest.json'), 'MIGRATION_BLOCKED');
  if (manifest.schemaVersion !== MIGRATION_SCHEMA_VERSION || manifest.kind !== 'migration') {
    throw new AppError('SCHEMA_UNSUPPORTED', 'migration manifest kind/schema is unsupported');
  }
  if (manifest.stateVersion !== MIGRATION_STATE_VERSION) {
    throw new AppError('SCHEMA_UNSUPPORTED', 'migration manifest stateVersion must be 3');
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new AppError('MIGRATION_BLOCKED', 'migration file manifest is empty');
  }
  const seen = new Set();
  const collisions = platformPathCollision(manifest.files.map((file) => file.path));
  if (collisions) throw new AppError('MIGRATION_BLOCKED', 'migration file paths collide');
  for (const file of manifest.files) {
    if (!file || !isSafeRelativePath(file.path) || seen.has(file.path)) {
      throw new AppError('MIGRATION_BLOCKED', 'migration file entry is unsafe or duplicated');
    }
    seen.add(file.path);
    const absolute = resolveInside(dir, file.path);
    const stat = await fsp.lstat(absolute).catch(() => null);
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
      throw new AppError('MIGRATION_BLOCKED', 'migration file is missing or not a regular file', {
        details: { path: file.path }
      });
    }
    if (stat.size !== file.sizeBytes) throw new AppError('MIGRATION_BLOCKED', 'migration file size mismatch');
    const hash = (await fileSha256(absolute)).sha256;
    if (hash !== file.sha256) throw new AppError('MIGRATION_BLOCKED', 'migration file hash mismatch');
  }
  const manifestWithoutSnapshotHash = { ...manifest };
  delete manifestWithoutSnapshotHash.snapshotHash;
  const expectedHash = jcsHash({ manifestWithoutSnapshotHash, files: manifest.files });
  if (expectedHash !== manifest.snapshotHash) {
    throw new AppError('MIGRATION_BLOCKED', 'migration snapshotHash is invalid');
  }
  const actualFiles = await listFiles(dir);
  const allowedPaths = new Set([...manifest.files.map((file) => file.path), 'manifest.json', 'receipt.json']);
  for (const file of actualFiles) {
    if (!allowedPaths.has(file.relativePath)) {
      throw new AppError('MIGRATION_BLOCKED', 'migration package contains an unlisted file', {
        details: { path: file.relativePath }
      });
    }
  }
  const stateEntry = manifest.files.find((file) => file.path === 'state.json');
  if (!stateEntry) throw new AppError('MIGRATION_BLOCKED', 'migration package has no state.json');
  const state = await readJson(path.join(dir, 'state.json'), 'MIGRATION_BLOCKED');
  if (state.version !== 3) throw new AppError('SCHEMA_UNSUPPORTED', 'migration state is not v3');
  if (state.workspaceId !== manifest.workspaceId || state.historyEpoch !== manifest.historyEpoch) {
    throw new AppError('MIGRATION_BLOCKED', 'migration state does not match the manifest');
  }
  return { manifest, state };
}

export default MigrationService;
