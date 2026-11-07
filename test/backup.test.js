import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setupBackup } from './helpers/backup.js';
import {
  computeSnapshotHash,
  computeSourceStateHash,
  verifyBackupDirectory
} from '../src/backup-recovery.js';
import { DEFAULT_CONFIG } from '../src/config.js';

test('ledger backup captures a consistent cut, verifies and protects dispatch', async () => {
  const { harness, backup, destinationRoot, cleanup } = await setupBackup();
  try {
    await harness.store.transaction(async (draft, tx) => {
      tx.appendEvent({ type: 'business.fact', payload: { ok: true } });
    });
    const record = await backup.create({ kind: 'ledger', requestId: 'req-ledger' }, harness.humanContext);
    assert.equal(record.status, 'verified');
    assert.equal(record.kind, 'ledger');
    assert.match(record.snapshotHash, /^jcs-sha256-v1:/);
    const backupDir = path.join(destinationRoot, 'backups', record.backupId);
    const manifest = JSON.parse(await fs.readFile(path.join(backupDir, 'manifest.json'), 'utf8'));
    const state = JSON.parse(await fs.readFile(path.join(backupDir, 'state.json'), 'utf8'));
    assert.equal(manifest.kind, 'backup');
    assert.equal(manifest.tier, 'ledger');
    assert.equal(manifest.stateVersion, 3);
    assert.equal(manifest.sourceHistoryEpoch, state.historyEpoch);
    assert.equal(manifest.cutEventSeq, state.eventSeq);
    assert.equal(manifest.configRevision.sha256, state.configRevision.sha256);
    assert.equal(manifest.timeZone, DEFAULT_CONFIG.timeZone);
    assert.equal(manifest.sourceStateHash, computeSourceStateHash({ state, cutAt: manifest.cutAt }));
    assert.equal(manifest.snapshotHash, computeSnapshotHash(manifest));
    assert.equal(manifest.mediaCoverage.complete, false);
    const verified = await verifyBackupDirectory(backupDir, { now: harness.now });
    assert.equal(verified.ok, true);
    const protection = await backup.getProtection({ kind: 'workspace', workspaceId: state.workspaceId });
    assert.equal(protection.status, 'protected');
    assert.equal(protection.backupId, record.backupId);
    const deduplicated = await backup.create({ kind: 'ledger', requestId: 'req-ledger' }, harness.humanContext);
    assert.equal(deduplicated.deduplicated, true);
  } finally {
    await cleanup();
  }
});

test('full backup includes artifact bytes and fails if a required object is missing', async () => {
  const { harness, backup, destinationRoot, cleanup } = await setupBackup();
  try {
    const artifact = await harness.importFile('image.png', 'image', 'image-bytes');
    const full = await backup.create({ kind: 'full', requestId: 'req-full' }, harness.humanContext);
    assert.equal(full.kind, 'full');
    assert.equal(full.mediaCoverage.complete, true);
    assert.equal(full.mediaCoverage.included.includes(artifact.artifactId), true);
    const backupDir = path.join(destinationRoot, 'backups', full.backupId);
    const manifest = JSON.parse(await fs.readFile(path.join(backupDir, 'manifest.json'), 'utf8'));
    const entry = manifest.files.find((file) => file.role === 'artifact' && file.artifactId === artifact.artifactId);
    assert.ok(entry);
    assert.equal(entry.sha256, artifact.sha256);
    const managed = path.join(harness.paths.artifactsDir, (await harness.artifactStore.getArtifact(artifact.artifactId)).relativePath);
    await fs.chmod(managed, 0o644);
    await fs.rm(managed);
    await assert.rejects(
      () => backup.create({ kind: 'full', requestId: 'req-full-missing' }, harness.humanContext),
      (error) => error.code === 'BACKUP_INVALID'
    );
  } finally {
    await cleanup();
  }
});

test('corrupt backup becomes invalid and does not count as protection', async () => {
  const { harness, backup, destinationRoot, cleanup } = await setupBackup();
  try {
    const record = await backup.create({ kind: 'ledger', requestId: 'req-corrupt' }, harness.humanContext);
    const backupDir = path.join(destinationRoot, 'backups', record.backupId);
    const manifest = JSON.parse(await fs.readFile(path.join(backupDir, 'manifest.json'), 'utf8'));
    const stateFile = manifest.files.find((file) => file.role === 'state');
    await fs.writeFile(path.join(backupDir, stateFile.path), '{"tampered":true}');
    const checked = await backup.verify(record.backupId);
    assert.equal(checked.verified, false);
    const protection = await backup.getProtection({ kind: 'workspace', workspaceId: 'w' });
    assert.equal(protection.status, 'unprotected');
  } finally {
    await cleanup();
  }
});

test('stale recovery points degrade protection', async () => {
  const { harness, backup, cleanup } = await setupBackup({
    policy: { maxPointAgeMinutes: 5, intervalMinutes: 1 }
  });
  try {
    await backup.create({ kind: 'ledger', requestId: 'req-stale' }, harness.humanContext);
    harness.now.advance(6 * 60 * 1000);
    const protection = await backup.getProtection({ kind: 'workspace', workspaceId: 'w' });
    assert.equal(protection.status, 'degraded');
    assert.equal(protection.reason, 'recovery_point_stale');
  } finally {
    await cleanup();
  }
});

test('a failed copy never replaces the last verified recovery point or leaves a fence', async () => {
  const { harness, backup, destinationRoot, cleanup } = await setupBackup();
  try {
    const first = await backup.create({ kind: 'ledger', requestId: 'req-good' }, harness.humanContext);
    const failing = await setupBackup;
    // Re-create a service with a hook that fails after capture but before publish.
    const { BackupService } = await import('../src/backup-recovery.js');
    const broken = new BackupService({
      store: harness.store,
      configService: harness.configService,
      policyService: backup.policyService,
      artifactStore: harness.artifactStore,
      journalDir: harness.paths.journalDir,
      dataDir: harness.dir,
      humanProof: harness.humanProof,
      now: harness.now,
      hooks: {
        beforeBackupPublish() {
          throw new Error('simulated copy failure');
        }
      }
    });
    await assert.rejects(
      () => broken.create({ kind: 'ledger', requestId: 'req-broken' }, harness.humanContext),
      /simulated copy failure/
    );
    const state = await harness.store.getSnapshot();
    assert.equal(state.checkpointFence, null);
    const protection = await backup.getProtection({ kind: 'workspace', workspaceId: state.workspaceId });
    assert.equal(protection.status, 'protected');
    assert.equal(protection.backupId, first.backupId);
    const pointDirs = await fs.readdir(path.join(destinationRoot, 'backups'));
    assert.deepEqual(pointDirs, [first.backupId]);
  } finally {
    await cleanup();
  }
});
