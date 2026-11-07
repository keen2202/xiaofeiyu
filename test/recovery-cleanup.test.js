import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setupBackup } from './helpers/backup.js';
import { RecoveryService } from '../src/backup-recovery.js';

test('a failed restore leaves no partial target and can be retried cleanly', async () => {
  const setup = await setupBackup();
  const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-restore-cleanup-'));
  await fs.rm(targetDir, { recursive: true, force: true });
  try {
    await setup.harness.importFile('image.png', 'image', 'cleanup-image');
    const backup = await setup.backup.create({ kind: 'full', requestId: 'cleanup-cut' }, setup.harness.humanContext);
    const source = path.join(setup.destinationRoot, 'backups', backup.backupId);
    const failing = new RecoveryService({
      recoveryDir: path.join(targetDir, 'recovery'),
      humanProof: setup.harness.humanProof,
      now: setup.harness.now,
      hooks: {
        beforeStateWrite() {
          throw new Error('simulated copy failure');
        }
      }
    });
    await assert.rejects(
      () => failing.restore(
        { from: source, to: targetDir, requestId: 'cleanup-failed' },
        setup.harness.humanContext
      ),
      /simulated copy failure/
    );
    assert.deepEqual(await fs.readdir(targetDir), []);

    const retry = new RecoveryService({
      recoveryDir: path.join(targetDir, 'recovery'),
      humanProof: setup.harness.humanProof,
      now: setup.harness.now,
      restoreRecorder: (info) => setup.backup.noteRestoreTest(info)
    });
    const restored = await retry.restore(
      { from: source, to: targetDir, requestId: 'cleanup-retry' },
      setup.harness.humanContext
    );
    assert.equal(restored.phase, 'readonly');
    assert.equal((await fs.readdir(targetDir)).includes('state.json'), true);
    assert.equal((await fs.readdir(targetDir)).includes('.restore-in-progress.json'), false);
    const status = await setup.backup.status();
    assert.equal(status.latest.restoreTestedAt !== null, true);
  } finally {
    await fs.rm(targetDir, { recursive: true, force: true });
    await setup.cleanup();
  }
});

test('an abandoned restore marker allows the next restore to clear the partial tree', async () => {
  const setup = await setupBackup();
  const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-restore-marker-'));
  try {
    const backup = await setup.backup.create({ kind: 'ledger', requestId: 'marker-cut' }, setup.harness.humanContext);
    await fs.mkdir(path.join(targetDir, 'journal'), { recursive: true });
    await fs.writeFile(path.join(targetDir, 'partial.txt'), 'partial');
    await fs.writeFile(
      path.join(targetDir, '.restore-in-progress.json'),
      JSON.stringify({ requestId: 'crashed', startedAt: new Date().toISOString() })
    );
    const recovery = new RecoveryService({
      recoveryDir: path.join(targetDir, 'recovery'),
      humanProof: setup.harness.humanProof,
      now: setup.harness.now
    });
    const restored = await recovery.restore(
      {
        from: path.join(setup.destinationRoot, 'backups', backup.backupId),
        to: targetDir,
        requestId: 'marker-retry'
      },
      setup.harness.humanContext
    );
    assert.equal(restored.phase, 'readonly');
    assert.equal((await fs.readdir(targetDir)).includes('partial.txt'), false);
    assert.equal((await fs.readdir(targetDir)).includes('state.json'), true);
  } finally {
    await fs.rm(targetDir, { recursive: true, force: true });
    await setup.cleanup();
  }
});
