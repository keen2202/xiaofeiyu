#!/usr/bin/env node
// Offline integration probe: run the real BackupService against the cosfs-mounted
// COS destination with a temporary data directory and a test human verifier.
// Not a real acceptance: the policy attestation and human proof are test fixtures.
// Writes only under /cos-backup/dsh-bili-backups/.probe-<ts> and removes it afterwards.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRuntime } from '../src/index.js';

const repoRoot = path.resolve(import.meta.dirname, '..');
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-bili-probe-'));
const destRoot = `/cos-backup/dsh-bili-backups/.probe-${Date.now()}`;
const verifier = { verify: async (proof) => proof?.kind === 'test' && proof.ok === true };
const humanContext = {
  principal: { id: 'probe-owner', kind: 'human', role: 'owner', scopes: ['*'] },
  proof: { kind: 'test', ok: true }
};
let runtime = null;
let output = { ok: false };
try {
  runtime = await createRuntime({ dataDir, humanVerifier: verifier, env: {}, logger: { warn() {}, info() {} } });
  const verifiedAt = new Date().toISOString();
  await runtime.policyService.save({
    schemaVersion: 1,
    scheduleEnabled: false,
    destinationRoot: destRoot,
    failureDomain: 'probe fixture: COS bucket claw-cos-data-1407061106 prefix /claw2 (not a real owner attestation)',
    failureDomainVerification: {
      independent: true,
      sourceRoot: dataDir,
      destinationRoot: destRoot,
      verifiedBy: 'probe-owner',
      verifiedAt
    },
    verifiedBy: 'probe-owner',
    verifiedAt,
    intervalMinutes: 15,
    maxPointAgeMinutes: 60
  });
  const t0 = Date.now();
  const created = await runtime.backupService.create({ kind: 'ledger', requestId: `probe-${Date.now()}` }, humanContext);
  const createMs = Date.now() - t0;
  const protection = await runtime.backupService.getProtection({ kind: 'workspace', workspaceId: null });
  let verifyResult;
  try {
    verifyResult = await runtime.backupService.verify(created.backupId);
  } catch (error) {
    verifyResult = { error: error.code || error.message };
  }
  const finalDir = path.join(destRoot, 'backups', created.backupId);
  const listing = await fs.readdir(finalDir).catch(() => []);
  output = {
    ok: created?.status === 'verified' && protection.status === 'protected' && !verifyResult?.error,
    allowedCapabilities: 'probe only',
    dataDir,
    destRoot,
    backupId: created?.backupId || null,
    createStatus: created?.status || null,
    createMs,
    filesInPoint: listing.length,
    protectionStatus: protection.status,
    verifyOk: !verifyResult?.error,
    verifyError: verifyResult?.error || null
  };
} catch (error) {
  output = { ok: false, dataDir, destRoot, error: error.code || error.message, stack: String(error.stack || '').split('\n').slice(0, 4) };
} finally {
  await fs.rm(destRoot, { recursive: true, force: true }).catch(() => {});
  if (runtime) await runtime.close().catch(() => {});
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
}
console.log(JSON.stringify(output, null, 2));
