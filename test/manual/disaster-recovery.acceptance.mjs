#!/usr/bin/env node
// Isolated disaster-recovery drill (SPEC §19.5 row 14 / T22).
// Synthetic ledger and test human verifier only: no real account data, no
// platform call, no user directory. Records cut age, metadata bytes, read-only
// restore duration, media coverage and still-frozen scopes into one JSON file.
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setupBackup } from '../helpers/backup.js';
import { bindMockAccount } from '../helpers/harness.js';
import { verifyBackupDirectory, RecoveryService } from '../../src/backup-recovery.js';
import { JsonStore } from '../../src/store.js';
import { fileSha256 } from '../../src/utils.js';

const outputArg = process.argv[2];
if (!outputArg) throw new Error('Usage: disaster-recovery.acceptance.mjs <output-directory>');
const output = path.resolve(outputArg);
await fs.mkdir(output, { recursive: true });
if ((await fs.readdir(output)).length) throw new Error('Output directory must be empty');
await fs.mkdir(path.join(output, 'tmp'));
process.env.TEMP = process.env.TMP = process.env.TMPDIR = path.join(output, 'tmp');

const now = () => new Date();
const evidence = {
  kind: 'disaster-recovery-drill',
  platform: process.platform,
  node: process.version,
  executedAt: now().toISOString(),
  syntheticData: true,
  humanProof: 'test verifier',
  physicalIndependence: 'not attested',
  checks: []
};

async function main() {
  const setup = await setupBackup({ harnessOptions: { now } });
  try {
    await bindMockAccount(setup.harness);
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',
      'base64'
    );
    const artifact = await setup.harness.importFile('cover.png', 'image', png);
    await setup.harness.store.transaction(async (draft, tx) => {
      tx.appendEvent({ type: 'drill.before_cut', actor: setup.harness.owner.id, payload: { fixture: true } });
    });
    await setup.harness.journal.flush();
    const source = await setup.harness.snapshot();
    const point = await setup.backup.create({ kind: 'full', requestId: 'drill-full' }, setup.harness.humanContext);
    const pointDir = path.join(setup.destinationRoot, 'backups', point.backupId);
    const verified = await verifyBackupDirectory(pointDir);
    const metadataBytes = verified.manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0);
    // A post-cut fact exists only in the lost source and must not appear in the
    // restored copy; the source itself is never destroyed.
    await setup.harness.store.transaction(async (draft, tx) => {
      tx.appendEvent({ type: 'drill.after_cut', actor: setup.harness.owner.id, payload: { fixture: true } });
    });
    await setup.harness.journal.flush();

    const target = path.join(output, 'restored-data');
    const started = performance.now();
    const recovery = new RecoveryService({
      recoveryDir: path.join(target, 'recovery'),
      humanProof: setup.harness.humanProof,
      now
    });
    const restored = await recovery.restore(
      { from: pointDir, to: target, requestId: 'drill-restore' },
      setup.harness.humanContext
    );
    const restoreMs = Math.round(performance.now() - started);
    const store = new JsonStore({
      file: path.join(target, 'state.json'),
      instanceFile: path.join(target, 'instance.json'),
      now
    });
    await store.init({ bootstrap: false });
    try {
      const state = await store.getSnapshot();
      const instance = await store.getInstance();
      const inspectService = new RecoveryService({
        store,
        recoveryDir: path.join(target, 'recovery'),
        humanProof: setup.harness.humanProof,
        now
      });
      const inspected = await inspectService.inspect(restored.recoveryId);
      const restoredArtifact = state.artifacts[artifact.artifactId];
      const restoredHash = await fileSha256(path.join(target, 'artifacts', restoredArtifact.relativePath));
      const holds = (state.recovery.holds || []).map((hold) => ({
        kind: hold.kind,
        scope: hold.scope,
        status: hold.status
      }));
      evidence.cutAt = verified.manifest.cutAt;
      evidence.cutAgeMs = Date.parse(evidence.executedAt) - Date.parse(verified.manifest.cutAt);
      evidence.backupId = point.backupId;
      evidence.snapshotHash = verified.manifest.snapshotHash;
      evidence.sourceHistoryEpoch = state.recovery.parent?.sourceHistoryEpoch || null;
      evidence.restoredHistoryEpoch = state.historyEpoch;
      evidence.eventSeq = state.eventSeq;
      evidence.fileCount = verified.manifest.files.length;
      evidence.metadataBytes = metadataBytes;
      evidence.mediaCoverage = verified.manifest.mediaCoverage;
      evidence.restoredArtifact = { artifactId: artifact.artifactId, sha256: restoredHash.sha256 };
      evidence.recoveryId = restored.recoveryId;
      evidence.recoveryPhase = state.recovery.phase;
      evidence.instanceStatus = instance.status;
      evidence.allowedCapabilities = instance.allowedCapabilities;
      evidence.frozenScopes = holds;
      evidence.dispatchAllowed = inspected.dispatchAllowed;
      evidence.readonlyRestoreMs = restoreMs;
      evidence.measurementScope =
        'single synthetic full point on one host; local package available; excludes network transfer and human diagnosis; not a sustained RPO/RTO guarantee and not physical media independence';
      if (state.recovery.phase !== 'readonly') throw new Error('restored epoch is not read-only');
      if (instance.status !== 'recovery-readonly') throw new Error('restored instance is not read-only');
      if (inspected.dispatchAllowed !== false) throw new Error('restored epoch still allows dispatch');
      if (!holds.length) throw new Error('restored epoch has no frozen scopes');
      if (verified.manifest.mediaCoverage?.complete !== true) throw new Error('full point lost media coverage');
      if (restoredHash.sha256 !== artifact.sha256) throw new Error('restored media hash mismatch');
      if (JSON.stringify(state).includes('drill.after_cut')) throw new Error('post-cut fact leaked into the restore');
      if (state.historyEpoch === verified.manifest.sourceHistoryEpoch) throw new Error('history epoch was not branched');
      evidence.checks.push(
        'read-only epoch branched from the full point',
        'dispatch denied and frozen scopes retained',
        'media bytes recovered with matching hash',
        'post-cut fact absent instead of invented'
      );
    } finally {
      await store.close();
    }
  } finally {
    await setup.harness.cleanup();
  }
}

let failure = null;
try {
  await main();
  evidence.passed = true;
} catch (error) {
  failure = error;
  evidence.passed = false;
  evidence.error = { code: error.code || null, message: error.message, stack: error.stack };
  process.exitCode = 1;
}
await fs.writeFile(path.join(output, 'disaster-recovery-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence, null, 2));
if (failure) throw failure;
