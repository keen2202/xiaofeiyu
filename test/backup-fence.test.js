import test from 'node:test';
import assert from 'node:assert/strict';
import { setupBackup } from './helpers/backup.js';

test('an active checkpoint fence blocks a second backup and is cleared after capture', async () => {
  const { harness, backup, cleanup } = await setupBackup();
  try {
    await harness.store.transaction(async (draft) => {
      draft.checkpointFence = {
        id: 'fence-test',
        kind: 'backup',
        ownerPid: process.pid,
        processStartedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString()
      };
    });
    await assert.rejects(
      () => backup.create({ kind: 'ledger', requestId: 'blocked' }, harness.humanContext),
      (error) => error.code === 'BACKUP_INVALID'
    );
    await harness.store.transaction(async (draft) => {
      draft.checkpointFence = null;
    });
    await backup.create({ kind: 'ledger', requestId: 'allowed' }, harness.humanContext);
    assert.equal((await harness.snapshot()).checkpointFence, null);
  } finally {
    await cleanup();
  }
});
