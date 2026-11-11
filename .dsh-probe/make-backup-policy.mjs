import fs from 'node:fs';
import path from 'node:path';
import { validateBackupPolicy } from '../src/backup-recovery.js';

const dataDir = 'C:\\Users\\22338\\.dsh\\dsh-bili-unified';
const destinationRoot = '\\\\172.30.28.135\\dsh-bili-backups';
const verifiedBy = '白阑王';
const now = new Date().toISOString();
const verification = { independent: true, sourceRoot: dataDir, destinationRoot, verifiedBy, verifiedAt: now };
const policy = {
  schemaVersion: 1,
  scheduleEnabled: false,
  destinationRoot,
  failureDomain: 'remote-host:42.193.20.17 (Tencent Cloud VM-0-5-ubuntu; independent physical host via WSL2 SSHFS + Samba mount; local host has a single NVMe Disk0)',
  failureDomainVerification: verification,
  verifiedBy,
  verifiedAt: now,
  intervalMinutes: 15,
  maxPointAgeMinutes: 20,
  fullIntervalHours: 24,
  keepRecent: 8,
  keepDaily: 7,
  keepWeekly: 4,
  autoPrune: false,
  checkpointTimeoutMs: 5000
};

validateBackupPolicy(policy, { dataDir, requireDestination: true });
if (policy.failureDomainVerification.independent !== true ||
    path.resolve(verification.sourceRoot) !== path.resolve(dataDir) ||
    path.resolve(verification.destinationRoot) !== path.resolve(policy.destinationRoot)) {
  throw new Error('verification roots do not match');
}
fs.mkdirSync('.dsh-probe', { recursive: true });
fs.writeFileSync('.dsh-probe/backup-policy.remote.json', `${JSON.stringify(policy, null, 2)}\n`);
fs.writeFileSync('.dsh-probe/verification.remote.json', `${JSON.stringify(verification, null, 2)}\n`);
fs.writeFileSync('.dsh-probe/backup-protection-expectation.json', `${JSON.stringify({
  expectedStatus: 'protected',
  dataDir,
  destinationRoot,
  failureDomain: policy.failureDomain,
  verifiedBy,
  generatedAt: now,
  note: 'owner-attested independent failure domain; software does not infer independence from drive letters'
}, null, 2)}\n`);
console.log('policy valid; destinationRoot =', policy.destinationRoot);
console.log('dataDir =', dataDir);
console.log('independent =', policy.failureDomainVerification.independent);
