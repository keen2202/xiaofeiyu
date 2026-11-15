import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setupBackup } from './helpers/backup.js';
import { verifyBackupDirectory } from '../src/backup-recovery.js';
import { fileSha256 } from '../src/utils.js';

test('retention plan protects the last ledger and last full even beyond recent sets', async () => {
  const { harness, backup, destinationRoot, cleanup } = await setupBackup({
    policy: { keepRecent: 2, keepDaily: 2, keepWeekly: 2, intervalMinutes: 1, maxPointAgeMinutes: 60 }
  });
  try {
    const records = [];
    for (let i = 0; i < 7; i += 1) {
      records.push(await backup.create({ kind: 'ledger', requestId: `r${i}` }, harness.humanContext));
      harness.now.advance(15 * 60 * 1000);
    }
    const full = await backup.create({ kind: 'full', requestId: 'full' }, harness.humanContext);
    harness.now.advance(15 * 60 * 1000);
    const plan = await backup.planPrune();
    assert.equal(plan.protected.lastFull, full.backupId);
    assert.equal(plan.delete.some((entry) => entry.backupId === full.backupId), false);
    assert.equal(plan.keep.includes(records.at(-1).backupId), true);
    const result = await backup.prune({ planId: plan.planId }, harness.humanContext);
    assert.ok(result.deleted.length > 0);
    const remaining = await fs.readdir(path.join(destinationRoot, 'backups'));
    assert.ok(remaining.includes(full.backupId));
    assert.ok(remaining.includes(records.at(-1).backupId));
    const protection = await backup.getProtection({ kind: 'workspace', workspaceId: 'w' });
    assert.equal(protection.status, 'protected');
  } finally {
    await cleanup();
  }
});

test('re-planning is required if the index changed', async () => {
  const { harness, backup, cleanup } = await setupBackup({
    policy: { keepRecent: 1, keepDaily: 1, keepWeekly: 1, intervalMinutes: 1, maxPointAgeMinutes: 60 }
  });
  try {
    for (let i = 0; i < 3; i += 1) {
      await backup.create({ kind: 'ledger', requestId: `c${i}` }, harness.humanContext);
      harness.now.advance(15 * 60 * 1000);
    }
    const plan = await backup.planPrune();
    await backup.create({ kind: 'ledger', requestId: 'new' }, harness.humanContext);
    await assert.rejects(
      () => backup.prune({ planId: plan.planId }, harness.humanContext),
      (error) => error.code === 'BACKUP_INVALID'
    );
  } finally {
    await cleanup();
  }
});

test('pruning an older full keeps the retained full media bytes and coverage', async () => {
  const { harness, backup, destinationRoot, cleanup } = await setupBackup({
    policy: { keepRecent: 1, keepDaily: 1, keepWeekly: 1, intervalMinutes: 1, maxPointAgeMinutes: 120 }
  });
  try {
    const artifact = await harness.importFile('cover.png', 'image', 'image-bytes');
    harness.now.advance(15 * 60 * 1000);
    const older = await backup.create({ kind: 'full', requestId: 'full-old' }, harness.humanContext);
    harness.now.advance(15 * 60 * 1000);
    const ledger = await backup.create({ kind: 'ledger', requestId: 'ledger-mid' }, harness.humanContext);
    harness.now.advance(15 * 60 * 1000);
    const newer = await backup.create({ kind: 'full', requestId: 'full-new' }, harness.humanContext);
    const plan = await backup.planPrune();
    assert.equal(plan.protected.lastFull, newer.backupId);
    assert.equal(plan.delete.some((entry) => entry.backupId === older.backupId), true);
    const result = await backup.prune({ planId: plan.planId }, harness.humanContext);
    assert.equal(result.deleted.includes(older.backupId), true);
    const remaining = await fs.readdir(path.join(destinationRoot, 'backups'));
    assert.equal(remaining.includes(newer.backupId), true);
    assert.equal(remaining.includes(ledger.backupId), true);
    assert.equal(remaining.includes(older.backupId), false);
    // The retained full still owns complete media bytes; pruning the older
    // point must never strip objects the retained point references.
    const retainedDir = path.join(destinationRoot, 'backups', newer.backupId);
    const verified = await verifyBackupDirectory(retainedDir);
    assert.equal(verified.manifest.tier, 'full');
    assert.equal(verified.manifest.mediaCoverage.complete, true);
    const artifactEntry = verified.manifest.files.find((file) => file.role === 'artifact');
    assert.ok(artifactEntry);
    const retainedHash = await fileSha256(path.join(retainedDir, artifactEntry.path));
    assert.equal(retainedHash.sha256, artifactEntry.sha256);
    assert.equal(retainedHash.sizeBytes, artifactEntry.sizeBytes);
    assert.equal(retainedHash.sha256, artifact.sha256);
    const index = JSON.parse(await fs.readFile(path.join(destinationRoot, 'index.json'), 'utf8'));
    assert.equal(index.backups[older.backupId], undefined);
    assert.equal(index.mediaUnprotected, false);
    const protection = await backup.getProtection({ kind: 'workspace', workspaceId: (await harness.snapshot()).workspaceId });
    assert.equal(protection.status, 'protected');
  } finally {
    await cleanup();
  }
});
