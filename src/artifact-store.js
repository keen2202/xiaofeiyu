import fsp from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './errors.js';
import { assertArtifactRef, assertNoMatchingHold, normalizeScope } from './contracts.js';
import {
  assertSafeRelativePath,
  copyFileWithHash,
  ensureDir,
  ensureWithin,
  fileSha256,
  getProcessStartMs,
  isProcessAlive,
  isSafeRelativePath,
  nowIso,
  pathExists,
  randomId,
  resolveInside,
  sha256Hex,
  truncateText
} from './utils.js';

const EXT_TYPES = new Map([
  ['.txt', 'text/plain'],
  ['.md', 'text/markdown'],
  ['.srt', 'application/x-subrip'],
  ['.vtt', 'text/vtt'],
  ['.ass', 'text/x-ass'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.mp4', 'video/mp4'],
  ['.mov', 'video/quicktime'],
  ['.webm', 'video/webm'],
  ['.flv', 'video/x-flv'],
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'],
  ['.m4a', 'audio/mp4'],
  ['.aac', 'audio/aac'],
  ['.flac', 'audio/flac'],
  ['.ogg', 'audio/ogg']
]);

const ROLE_EXTENSIONS = Object.freeze({
  script: ['.txt', '.md'],
  image: ['.png', '.jpg', '.jpeg', '.webp'],
  clip: ['.mp4', '.mov', '.webm'],
  audio: ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg'],
  subtitle: ['.srt', '.vtt', '.ass'],
  video: ['.mp4', '.mov', '.webm', '.flv'],
  cover: ['.png', '.jpg', '.jpeg', '.webp']
});

function mediaTypeFor(extension) {
  return EXT_TYPES.get(extension) || 'application/octet-stream';
}

function sanitizeBasename(name) {
  const base = path.basename(String(name || 'artifact'));
  const safe = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_');
  return safe === '' ? 'artifact' : safe.slice(0, 120);
}

export class ArtifactStore {
  constructor({ store, rootDir, workDir, configService, now = () => new Date(), hooks = {}, logger } = {}) {
    this.store = store;
    this.rootDir = rootDir;
    this.workDir = workDir;
    this.configService = configService;
    this.now = now;
    this.hooks = hooks;
    this.logger = logger;
  }

  _config() {
    return this.configService.get();
  }

  _assertLocalHuman(principal) {
    if (
      !principal ||
      principal.kind !== 'human' ||
      principal.revokedAt ||
      !['local_cli', 'host_human_challenge'].includes(principal.sourceKind)
    ) {
      throw new AppError('FORBIDDEN', 'artifact import requires a trusted local human');
    }
    if (!principal.scopes?.includes('*') && !principal.scopes?.includes('artifact.import')) {
      throw new AppError('FORBIDDEN', 'principal lacks artifact.import scope');
    }
  }

  async _assertWritable() {
    const state = await this.store.getSnapshot();
    if (state.migration?.phase !== 'active') {
      throw new AppError('MIGRATION_BLOCKED', 'artifact import is frozen during migration');
    }
    if (!['normal', 'restricted', 'released'].includes(state.recovery?.phase || 'normal')) {
      throw new AppError('RECOVERY_GAP', 'artifact import is blocked during recovery');
    }
    assertNoMatchingHold(state, normalizeScope({ kind: 'workspace', workspaceId: state.workspaceId }));
    const fence = state.checkpointFence;
    if (fence) {
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
        throw new AppError('BACKUP_UNPROTECTED', 'checkpoint fence blocks new artifact commits');
      }
    }
    const instance = await this.store.getInstance();
    if (!instance || instance.status !== 'active' || !instance.allowedCapabilities.includes('production:local')) {
      throw new AppError('MIGRATION_BLOCKED', 'instance is not active for local artifacts');
    }
    return state;
  }

  validateSource(sourcePath, role) {
    if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath)) {
      throw new AppError('ARTIFACT_INVALID', 'sourcePath must be an absolute path');
    }
    if (!ROLE_EXTENSIONS[role]) throw new AppError('ARTIFACT_INVALID', `unsupported artifact role: ${role}`);
    const config = this._config();
    const allowedRoots = (config.security.allowedSourceDirs || []).map((dir) => path.resolve(dir));
    if (allowedRoots.length === 0) {
      throw new AppError('ARTIFACT_INVALID', 'security.allowedSourceDirs is empty; external import is disabled');
    }
    return { allowedRoots, config };
  }

  async _inspectSource(sourcePath, role, { allowedRoots, config, allowRoots = null }) {
    const sourceLstat = await fsp.lstat(sourcePath).catch((error) => {
      throw new AppError('ARTIFACT_INVALID', 'source file does not exist', { cause: error });
    });
    if (sourceLstat.isSymbolicLink()) throw new AppError('ARTIFACT_INVALID', 'symbolic links are not importable');
    if (!sourceLstat.isFile()) throw new AppError('ARTIFACT_INVALID', 'source must be a regular file');
    if (sourceLstat.nlink > 1) throw new AppError('ARTIFACT_INVALID', 'hard-linked files are not importable');
    const realSource = await fsp.realpath(sourcePath);
    const roots = allowRoots || allowedRoots;
    if (!roots.some((root) => ensureWithin(root, realSource))) {
      throw new AppError('ARTIFACT_INVALID', 'source path is outside allowedSourceDirs');
    }
    const extension = path.extname(realSource).toLowerCase();
    if (!ROLE_EXTENSIONS[role].includes(extension)) {
      throw new AppError('ARTIFACT_INVALID', `extension ${extension} is not allowed for role ${role}`);
    }
    if (role === 'video' && !config.security.allowedVideoExtensions.map((e) => e.toLowerCase()).includes(extension)) {
      throw new AppError('ARTIFACT_INVALID', 'video extension is not in security.allowedVideoExtensions');
    }
    const stats = await fsp.stat(realSource);
    if (!stats.isFile()) throw new AppError('ARTIFACT_INVALID', 'source must be a regular file');
    const maxBytes =
      role === 'video'
        ? Math.min(config.artifacts.maxImportBytes, config.security.maxUploadBytes)
        : config.artifacts.maxImportBytes;
    if (stats.size <= 0) throw new AppError('ARTIFACT_INVALID', 'empty files are not importable');
    if (stats.size > maxBytes) throw new AppError('ARTIFACT_INVALID', 'source file exceeds the import size limit');
    return { realSource, extension, stats, maxBytes };
  }

  async _importInternal({ sourcePath, role, principal, sourceType, allowRoots = null, requestedVisibility = 'workspace' }) {
    if (sourceType === 'external') {
      this._assertLocalHuman(principal);
      const validated = this.validateSource(sourcePath, role);
      const inspected = await this._inspectSource(sourcePath, role, validated);
      return this._importValidated({
        sourcePath,
        role,
        principal,
        sourceType,
        requestedVisibility,
        ...validated,
        ...inspected
      });
    }
    const state = await this._assertWritable();
    if (!this.workDir) throw new AppError('ARTIFACT_INVALID', 'production workDir is not configured');
    const sourceLstat = await fsp.lstat(sourcePath).catch((error) => {
      throw new AppError('ARTIFACT_INVALID', 'output file does not exist', { cause: error });
    });
    if (sourceLstat.isSymbolicLink() || !sourceLstat.isFile()) {
      throw new AppError('ARTIFACT_INVALID', 'output must be a regular file');
    }
    const realSource = await fsp.realpath(sourcePath);
    if (!ensureWithin(this.workDir, realSource)) {
      throw new AppError('ARTIFACT_INVALID', 'output is outside the core work directory');
    }
    const extension = path.extname(realSource).toLowerCase();
    if (!ROLE_EXTENSIONS[role]?.includes(extension)) {
      throw new AppError('ARTIFACT_INVALID', `extension ${extension} is not allowed for role ${role}`);
    }
    const stats = await fsp.stat(realSource);
    const maxBytes = Math.min(this._config().artifacts.maxImportBytes, this._config().production.limits.maxOutputBytes);
    if (stats.size <= 0 || stats.size > maxBytes) {
      throw new AppError('ARTIFACT_INVALID', 'output size is outside the allowed range');
    }
    return this._importValidated({
      sourcePath: realSource,
      role,
      principal,
      sourceType,
      requestedVisibility,
      allowedRoots: [this.workDir],
      config: this._config(),
      extension,
      stats,
      maxBytes,
      state
    });
  }

  async _importValidated({ sourcePath, role, principal, sourceType, requestedVisibility, allowedRoots, config, extension, stats, maxBytes }) {
    await this._assertWritable();
    const artifactId = `artifact_${randomId('a').split('_').at(-1)}`;
    await ensureDir(this.rootDir);
    const tmpRel = path.posix.join('tmp', `${artifactId}.part`);
    const tempAbs = resolveInside(this.rootDir, tmpRel);
    await ensureDir(path.dirname(tempAbs));
    const sourceReal = await fsp.realpath(sourcePath);
    const copied = await copyFileWithHash(sourceReal, tempAbs, { maxBytes });
    if (copied.sizeBytes !== stats.size) {
      await fsp.rm(tempAbs, { force: true }).catch(() => {});
      throw new AppError('ARTIFACT_INVALID', 'source changed during import');
    }
    const after = await fsp.stat(sourceReal);
    if (after.size !== stats.size || after.mtimeMs !== stats.mtimeMs) {
      await fsp.rm(tempAbs, { force: true }).catch(() => {});
      throw new AppError('ARTIFACT_INVALID', 'source changed during import');
    }
    const originalName = sanitizeBasename(sourcePath);
    const finalRel = path.posix.join(artifactId, `${role}-${originalName}`);
    const finalAbs = resolveInside(this.rootDir, finalRel);
    const mediaType = mediaTypeFor(extension);
    const pending = {
      artifactId,
      sourceRealPath: sourceReal,
      tempFile: tmpRel,
      targetFile: finalRel,
      expectedSha256: copied.sha256,
      expectedBytes: copied.sizeBytes,
      expectedMode: sourceType === 'external' ? 'import' : 'derived',
      requestedRole: role,
      requestedVisibility,
      principalId: principal.id,
      sourceType,
      mediaType,
      phase: 'pending',
      createdAt: nowIso(this.now)
    };
    await this.store.transaction(async (draft, tx) => {
      if (draft.migration?.phase !== 'active') throw new AppError('MIGRATION_BLOCKED', 'artifact import froze');
      draft.artifactPendingImports[artifactId] = pending;
      tx.appendEvent({
        type: 'artifact.pending_import',
        actor: principal.id,
        payload: { artifactId, role, sha256: copied.sha256, sizeBytes: copied.sizeBytes, sourceType }
      });
    });
    await this.hooks.beforeArtifactRename?.({ artifactId, tempAbs, finalAbs });
    try {
      await fsp.mkdir(path.dirname(finalAbs), { recursive: true });
      await fsp.rename(tempAbs, finalAbs);
      await fsp.chmod(finalAbs, 0o444).catch(() => {});
      await this.hooks.afterArtifactRename?.({ artifactId, finalAbs });
    } catch (error) {
      await fsp.rm(tempAbs, { force: true }).catch(() => {});
      throw new AppError('ARTIFACT_INVALID', 'artifact finalize failed', { cause: error });
    }
    const record = await this.store.transaction(async (draft, tx) => {
      const current = draft.artifactPendingImports[artifactId];
      if (!current) throw new AppError('ARTIFACT_INVALID', 'pending import disappeared');
      if (current.expectedSha256 !== copied.sha256) {
        throw new AppError('ARTIFACT_INVALID', 'pending import hash changed');
      }
      const artifact = {
        artifactId,
        workspaceId: draft.workspaceId,
        sha256: copied.sha256,
        sizeBytes: copied.sizeBytes,
        mediaType,
        role,
        relativePath: finalRel,
        originalName,
        source: {
          type: sourceType,
          principalId: principal.id,
          sourceName: originalName,
          importedAt: nowIso(this.now)
        },
        visibility: requestedVisibility,
        createdRevision: draft.historyEpoch,
        createdAt: nowIso(this.now)
      };
      draft.artifacts[artifactId] = artifact;
      delete draft.artifactPendingImports[artifactId];
      tx.appendEvent({
        type: 'artifact.imported',
        actor: principal.id,
        payload: { artifactId, role, sha256: copied.sha256, sizeBytes: copied.sizeBytes }
      });
      return deepCloneArtifact(artifact);
    });
    return { ...publicRef(record), artifact: record };
  }

  async importFile({ sourcePath, role, principal, visibility = 'workspace' }) {
    if (!role) throw new AppError('ARTIFACT_INVALID', 'artifact role is required');
    return this._importInternal({ sourcePath, role, principal, sourceType: 'external', requestedVisibility: visibility });
  }

  async importManagedOutput({ sourcePath, role, principal, visibility = 'workspace' }) {
    if (!role) throw new AppError('ARTIFACT_INVALID', 'artifact role is required');
    return this._importInternal({ sourcePath, role, principal, sourceType: 'managed_output', requestedVisibility: visibility });
  }

  async allocateWorkDir({ taskId, executionId }) {
    if (!isSafeRelativePath(taskId) || !isSafeRelativePath(executionId)) {
      throw new AppError('ARTIFACT_INVALID', 'work directory identifiers are unsafe');
    }
    const dir = resolveInside(this.workDir, path.posix.join(taskId, executionId));
    await ensureDir(dir);
    return dir;
  }

  async getArtifact(artifactId) {
    const state = await this.store.getSnapshot();
    const artifact = state.artifacts[artifactId];
    if (!artifact) throw new AppError('ARTIFACT_INVALID', 'artifact not found');
    return deepCloneArtifact(artifact);
  }

  assertAccess(principal, artifact, { scope = 'workspace' } = {}) {
    if (!principal || principal.revokedAt) throw new AppError('FORBIDDEN', 'artifact access denied');
    if (artifact.workspaceId !== principal.workspaceId) {
      throw new AppError('FORBIDDEN', 'artifact belongs to another workspace');
    }
    if (artifact.visibility === 'private' && principal.kind !== 'human') {
      throw new AppError('FORBIDDEN', 'private artifact is restricted to a human principal');
    }
    if (scope !== 'workspace') throw new AppError('FORBIDDEN', 'artifact access scope is not authorized');
    return true;
  }

  async assertAccessById(artifactId, principal) {
    const artifact = await this.getArtifact(artifactId);
    this.assertAccess(principal, artifact);
    return artifact;
  }

  async resolveManagedPath(artifactId, { verify = false } = {}) {
    const artifact = await this.getArtifact(artifactId);
    if (!isSafeRelativePath(artifact.relativePath)) {
      throw new AppError('ARTIFACT_INVALID', 'artifact path is unsafe');
    }
    const absolute = resolveInside(this.rootDir, artifact.relativePath);
    const stat = await fsp.lstat(absolute).catch(() => null);
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
      throw new AppError('ARTIFACT_INVALID', 'artifact bytes are missing or not a regular file');
    }
    if (verify) {
      const { sha256, sizeBytes } = await fileSha256(absolute);
      if (sha256 !== artifact.sha256 || sizeBytes !== artifact.sizeBytes) {
        throw new AppError('ARTIFACT_INVALID', 'artifact digest does not match the ledger');
      }
    }
    return { artifact, absolute };
  }

  async verify(artifactId, { principal = null } = {}) {
    const artifact = await this.getArtifact(artifactId);
    if (principal) this.assertAccess(principal, artifact);
    const { absolute } = await this.resolveManagedPath(artifactId, { verify: true });
    return { ...publicRef(artifact), available: true, absolute };
  }

  async inspect(artifactId) {
    const artifact = await this.getArtifact(artifactId);
    try {
      await this.resolveManagedPath(artifactId, { verify: true });
      return { ...publicRef(artifact), available: true };
    } catch (error) {
      return { ...publicRef(artifact), available: false, reason: error.message };
    }
  }

  async pin(artifactIds) {
    await this.store.transaction(async (draft, tx) => {
      for (const artifactId of artifactIds) {
        if (!draft.artifacts[artifactId]) throw new AppError('ARTIFACT_INVALID', 'cannot pin a missing artifact');
        draft.artifactPins[artifactId] = (draft.artifactPins[artifactId] || 0) + 1;
      }
      tx.appendEvent({
        type: 'artifact.pinned',
        actor: 'system',
        payload: { artifactIds: [...artifactIds] }
      });
    });
  }

  async unpin(artifactIds) {
    await this.store.transaction(async (draft) => {
      for (const artifactId of artifactIds) {
        if (!draft.artifactPins[artifactId]) continue;
        draft.artifactPins[artifactId] -= 1;
        if (draft.artifactPins[artifactId] <= 0) delete draft.artifactPins[artifactId];
      }
    });
  }

  async exportArtifacts(artifactIds, destinationDir) {
    await ensureDir(destinationDir);
    const exported = [];
    for (const artifactId of artifactIds) {
      const artifact = await this.getArtifact(artifactId);
      const { absolute } = await this.resolveManagedPath(artifactId, { verify: true });
      const rel = path.posix.join('artifacts', artifact.artifactId, path.basename(artifact.relativePath));
      const target = resolveInside(destinationDir, rel);
      await ensureDir(path.dirname(target));
      await fsp.copyFile(absolute, target);
      const hash = await fileSha256(target);
      if (hash.sha256 !== artifact.sha256) throw new AppError('ARTIFACT_INVALID', 'artifact export hash mismatch');
      exported.push({
        artifactId,
        path: rel,
        sha256: artifact.sha256,
        sizeBytes: artifact.sizeBytes,
        role: artifact.role,
        required: true
      });
    }
    return exported;
  }

  async recoverPendingImports() {
    const state = await this.store.getSnapshot();
    let recovered = 0;
    for (const pending of Object.values(state.artifactPendingImports || {})) {
      if (!isSafeRelativePath(pending.tempFile) || !isSafeRelativePath(pending.targetFile)) {
        await this.store.transaction(async (draft) => {
          delete draft.artifactPendingImports[pending.artifactId];
        });
        continue;
      }
      const tempAbs = resolveInside(this.rootDir, pending.tempFile);
      const finalAbs = resolveInside(this.rootDir, pending.targetFile);
      let finalHash = null;
      if (await pathExists(finalAbs)) {
        finalHash = (await fileSha256(finalAbs)).sha256;
      }
      let tempHash = null;
      if (await pathExists(tempAbs)) tempHash = (await fileSha256(tempAbs)).sha256;
      if (finalHash === pending.expectedSha256 || tempHash === pending.expectedSha256) {
        if (finalHash !== pending.expectedSha256) {
          await ensureDir(path.dirname(finalAbs));
          await fsp.rename(tempAbs, finalAbs);
          await fsp.chmod(finalAbs, 0o444).catch(() => {});
        }
        await this.store.transaction(async (draft, tx) => {
          const current = draft.artifactPendingImports[pending.artifactId];
          if (!current) return;
          draft.artifacts[pending.artifactId] = {
            artifactId: pending.artifactId,
            workspaceId: draft.workspaceId,
            sha256: pending.expectedSha256,
            sizeBytes: pending.expectedBytes,
            mediaType: pending.mediaType,
            role: pending.requestedRole,
            relativePath: pending.targetFile,
            originalName: path.basename(pending.targetFile),
            source: {
              type: pending.sourceType,
              principalId: pending.principalId,
              importedAt: pending.createdAt
            },
            visibility: pending.requestedVisibility,
            createdAt: nowIso(this.now)
          };
          delete draft.artifactPendingImports[pending.artifactId];
          tx.appendEvent({
            type: 'artifact.import.recovered',
            actor: 'system',
            payload: { artifactId: pending.artifactId }
          });
        });
        recovered += 1;
      } else {
        // Only temp files inside the managed store may be reclaimed.
        if (await pathExists(tempAbs)) await fsp.rm(tempAbs, { force: true });
        await this.store.transaction(async (draft) => {
          delete draft.artifactPendingImports[pending.artifactId];
        });
      }
    }
    return { recovered };
  }

  async cleanupOrphanTemps() {
    const tmpDir = path.join(this.rootDir, 'tmp');
    const state = await this.store.getSnapshot();
    const pendingTemps = new Set(Object.values(state.artifactPendingImports || {}).map((entry) => entry.tempFile));
    if (!(await pathExists(tmpDir))) return { removed: 0 };
    const files = await fsp.readdir(tmpDir).catch(() => []);
    let removed = 0;
    for (const file of files) {
      const rel = path.posix.join('tmp', file);
      if (pendingTemps.has(rel)) continue;
      await fsp.rm(path.join(tmpDir, file), { force: true });
      removed += 1;
    }
    return { removed };
  }

  publicRef(artifactOrId) {
    if (typeof artifactOrId === 'string') {
      return this.getArtifact(artifactOrId).then(publicRef);
    }
    return publicRef(artifactOrId);
  }
}

function publicRef(artifact) {
  return {
    artifactId: artifact.artifactId,
    sha256: artifact.sha256,
    sizeBytes: artifact.sizeBytes,
    mediaType: artifact.mediaType,
    role: artifact.role
  };
}

function deepCloneArtifact(artifact) {
  return structuredClone(artifact);
}

export default ArtifactStore;
