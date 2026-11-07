import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHarness } from './helpers/harness.js';
import { BackupPolicyService, DEFAULT_BACKUP_POLICY } from '../src/backup-recovery.js';

test('policy defaults are safe and destination cannot be inside the data directory', async () => {
  const harness = await createHarness();
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-policy-'));
  const service = new BackupPolicyService({ file: harness.paths.backupPolicyFile, dataDir: harness.dir });
  try {
    assert.equal(DEFAULT_BACKUP_POLICY.scheduleEnabled, false);
    assert.equal(DEFAULT_BACKUP_POLICY.autoPrune, false);
    await assert.rejects(
      () => service.save({ ...DEFAULT_BACKUP_POLICY, destinationRoot: path.join(harness.dir, 'nested') }),
      (error) => error.code === 'CONFIG_INVALID'
    );
    await assert.rejects(
      () => service.save({
        ...DEFAULT_BACKUP_POLICY,
        destinationRoot: destination,
        failureDomain: 'd',
        verifiedBy: 'o',
        intervalMinutes: 30,
        maxPointAgeMinutes: 20
      }),
      (error) => error.code === 'CONFIG_INVALID'
    );
    const saved = await service.save({
      ...DEFAULT_BACKUP_POLICY,
      destinationRoot: destination,
      failureDomain: 'd',
      verifiedBy: 'o',
      scheduleEnabled: true
    });
    assert.equal(saved.scheduleEnabled, true);
  } finally {
    await harness.cleanup();
    await fs.rm(destination, { recursive: true, force: true });
  }
});
