import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setupBackup } from './helpers/backup.js';

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
