import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHarness } from './harness.js';
import {
  BackupPolicyService,
  BackupService,
  DEFAULT_BACKUP_POLICY
} from '../../src/backup-recovery.js';

export async function setupBackup({ harnessOptions = {}, policy = {}, backupServiceOptions = {} } = {}) {
  const harness = await createHarness(harnessOptions);
  const destinationRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-backup-'));
  const policyService = new BackupPolicyService({
    file: harness.paths.backupPolicyFile,
    dataDir: harness.dir,
    now: harness.now
  });
  const policyValue = await policyService.save({
    ...DEFAULT_BACKUP_POLICY,
    destinationRoot,
    failureDomain: 'test-independent-filesystem',
    verifiedBy: 'test-owner',
    ...policy
  });
  const backup = new BackupService({
    store: harness.store,
    configService: harness.configService,
    policyService,
    artifactStore: harness.artifactStore,
    journalDir: harness.paths.journalDir,
    dataDir: harness.dir,
    humanProof: harness.humanProof,
    now: harness.now,
    ...backupServiceOptions
  });
  const cleanup = async () => {
    await harness.cleanup();
    await fs.rm(destinationRoot, { recursive: true, force: true });
  };
  return { harness, policyService, backup, destinationRoot, policy: policyValue, cleanup };
}
