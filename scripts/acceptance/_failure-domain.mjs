import fs from 'node:fs';
import path from 'node:path';
import { validateBackupPolicy } from '../../src/backup-recovery.js';

export function readFailureDomainVerification(file, { dataDir, destinationRoot, failureDomain, verifiedBy }) {
  if (!file) throw new Error('--verification must name an owner-reviewed independent failure-domain JSON record');
  const verification = JSON.parse(fs.readFileSync(file, 'utf8'));
  validateBackupPolicy({ destinationRoot, failureDomain, verifiedBy, failureDomainVerification: verification },
    { dataDir, requireDestination: true });
  if (verification?.independent !== true || path.resolve(verification.sourceRoot) !== path.resolve(dataDir) ||
      path.resolve(verification.destinationRoot) !== path.resolve(destinationRoot) ||
      verification.verifiedBy !== verifiedBy || Date.parse(verification.verifiedAt) > Date.now()) {
    throw new Error('independent failure-domain verification is absent, future-dated or bound to different roots/owner');
  }
  return verification;
}
