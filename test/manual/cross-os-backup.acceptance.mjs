#!/usr/bin/env node
// Offsite copy/readonly restore drill. Synthetic data and test-human proof;
// owner authorization to use a directory does not assert physical independence.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { setupBackup } from '../helpers/backup.js';
import { createHarness, bindMockAccount } from '../helpers/harness.js';
import { RecoveryService, verifyBackupDirectory } from '../../src/backup-recovery.js';
import { JsonStore } from '../../src/store.js';
import { fileSha256 } from '../../src/utils.js';

const [phase, outputArg, inputArg] = process.argv.slice(2);
if (!['source', 'fault', 'restore'].includes(phase) || !outputArg || (phase === 'restore' && !inputArg)) {
  throw new Error('Usage: cross-os-backup.acceptance.mjs source|fault|restore <output-directory> [<input-transfer-directory>]');
}
const output = path.resolve(outputArg);
const write = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n');
const now = () => new Date();
if (phase !== 'fault') {
  await fs.mkdir(output, { recursive: true });
  if ((await fs.readdir(output)).length) throw new Error('Output directory must be empty');
  await fs.mkdir(path.join(output, 'tmp'));
}
process.env.TEMP = process.env.TMP = process.env.TMPDIR = path.join(output, 'tmp');
const evidence = { phase, platform: process.platform, node: process.version, executedAt: now().toISOString(),
  syntheticData: true, physicalIndependence: 'not attested', humanProof: 'test verifier', checks: [] };

async function main() {
  if (phase === 'source') {
    const b = await setupBackup({ harnessOptions: { now }, policy: { failureDomainVerification: null,
      failureDomain: 'local staging; not independent; offsite copy is verified separately' } });
    await bindMockAccount(b.harness);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64');
    const artifact = await b.harness.importFile('cover.png', 'image', png);
    await b.harness.store.transaction(async (state, tx) => {
      tx.appendEvent({ type: 'acceptance.before_cut', actor: b.harness.owner.id, payload: { fixture: true } });
    });
    const backup = await b.backup.create({ kind: 'full', requestId: 'cross-os-full' }, b.harness.humanContext);
    const point = path.join(b.destinationRoot, 'backups', backup.backupId);
    const verified = await verifyBackupDirectory(point);
    assert.equal((await b.backup.getProtection()).status, 'unprotected');
    const transfer = path.join(output, 'transfer');
    await fs.mkdir(transfer);
    await fs.cp(point, path.join(transfer, 'point'), { recursive: true });
    const expected = { kind: 'cross-os-backup-fixture', workspaceId: (await b.harness.snapshot()).workspaceId,
      sourceEpoch: verified.manifest.sourceHistoryEpoch, sourcePlatform: process.platform,
      sourceDataDir: b.harness.dir, backupId: backup.backupId, cutAt: verified.manifest.cutAt,
      snapshotHash: verified.manifest.snapshotHash, artifact };
    await write(path.join(transfer, 'expectation.json'), expected);
    evidence.checks.push('full created and verified; local staging remains unprotected');
    evidence.backupId = backup.backupId;
    evidence.cutAt = expected.cutAt;
    evidence.transfer = transfer;
    return; // Keep source until the offsite package has been verified.
  }
  if (phase === 'fault') {
    const transfer = path.join(output, 'transfer');
    const expected = JSON.parse(await fs.readFile(path.join(transfer, 'expectation.json'), 'utf8'));
    assert.equal(expected.kind, 'cross-os-backup-fixture');
    const source = path.resolve(expected.sourceDataDir);
    assert.ok(source.startsWith(path.join(output, 'tmp') + path.sep), 'Only this drill may be faulted');
    const store = new JsonStore({ file: path.join(source, 'state.json'), instanceFile: path.join(source, 'instance.json'), now });
    await store.init({ bootstrap: false });
    await store.transaction(async (state, tx) => tx.appendEvent({ type: 'acceptance.after_cut', actor: 'test', payload: { fixture: true } }));
    await store.close();
    const lostAt = now().toISOString();
    await fs.rename(path.join(source, 'state.json'), path.join(source, 'state.simulated-lost.json'));
    const fault = { lostAt, cutAt: expected.cutAt, observedCutToLossMs: Date.parse(lostAt) - Date.parse(expected.cutAt),
      note: 'synthetic source ledger preserved under a new name after offsite verification; no real account data affected' };
    await write(path.join(transfer, 'fault.json'), fault);
    evidence.fault = fault;
    evidence.checks.push('post-cut synthetic fact recorded; only isolated source ledger made unavailable');
    return;
  }
  const input = path.resolve(inputArg);
  const expected = JSON.parse(await fs.readFile(path.join(input, 'expectation.json'), 'utf8'));
  const fault = JSON.parse(await fs.readFile(path.join(input, 'fault.json'), 'utf8'));
  assert.notEqual(expected.sourcePlatform, process.platform);
  const h = await createHarness({ now });
  const target = path.join(output, 'data');
  const started = performance.now();
  const recovery = new RecoveryService({ recoveryDir: path.join(target, 'recovery'), humanProof: h.humanProof, now });
  const restored = await recovery.restore({ from: path.join(input, 'point'), to: target, requestId: 'cross-os-restore' }, h.humanContext);
  const store = new JsonStore({ file: path.join(target, 'state.json'), instanceFile: path.join(target, 'instance.json'), now });
  await store.init({ bootstrap: false });
  try {
    const state = await store.getSnapshot();
    const instance = await store.getInstance();
    assert.equal(state.workspaceId, expected.workspaceId);
    assert.notEqual(state.historyEpoch, expected.sourceEpoch);
    assert.equal(state.recovery.parent.backupId, expected.backupId);
    assert.equal(state.recovery.phase, 'readonly');
    assert.equal(instance.status, 'recovery-readonly');
    assert.deepEqual(instance.allowedCapabilities, []);
    assert.ok(state.recovery.holds.length > 0);
    const artifact = state.artifacts[expected.artifact.artifactId];
    assert.equal((await fileSha256(path.join(target, 'artifacts', artifact.relativePath))).sha256, expected.artifact.sha256);
    assert.equal(JSON.stringify(state).includes('acceptance.after_cut'), false);
    const inspect = new RecoveryService({ store, recoveryDir: path.join(target, 'recovery'), humanProof: h.humanProof, now });
    const status = await inspect.inspect(restored.recoveryId);
    assert.equal(status.dispatchAllowed, false);
    evidence.readonlyRestoreMs = Math.round(performance.now() - started);
    evidence.observedCutToLossMs = fault.observedCutToLossMs;
    evidence.measurementScope = 'single small full point; local package available to verified readonly inspection; excludes network transfer and human diagnosis; not a sustained RPO/RTO guarantee';
    evidence.checks.push('full bytes/hash recovered on another OS; new epoch and readonly hold retained',
      'post-cut synthetic fact absent rather than invented; dispatch remains denied');
    evidence.recoveryId = restored.recoveryId;
    evidence.artifact = expected.artifact;
  } finally { await store.close(); await h.cleanup(); }
}

try { await main(); evidence.passed = true; }
catch (error) { evidence.passed = false; evidence.error = { code: error.code || null, message: error.message, stack: error.stack }; process.exitCode = 1; }
await write(path.join(output, `${phase}-evidence.json`), evidence);
console.log(JSON.stringify(evidence, null, 2));
