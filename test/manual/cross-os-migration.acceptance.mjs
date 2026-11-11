#!/usr/bin/env node
// Real filesystem/OS transfer, synthetic business data and test-only human/
// backup proof. This does not certify physical backup independence or live writes.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createHarness, bindMockAccount, makeMockAdapter, mockCandidate, approvalDecide } from '../helpers/harness.js';
import { MigrationService } from '../../src/migration.js';
import { CommentsModule } from '../../src/modules/comments.js';
import { createRuntime } from '../../src/index.js';
import { fileSha256 } from '../../src/utils.js';

const [phase, outputArg, inputArg] = process.argv.slice(2);
if (!['source', 'target', 'return'].includes(phase) || !outputArg || (phase !== 'source' && !inputArg)) {
  throw new Error('Usage: cross-os-migration.acceptance.mjs source|target|return <new-output-directory> [<input-transfer-directory>]');
}
const output = path.resolve(outputArg);
await fs.mkdir(output, { recursive: true });
if ((await fs.readdir(output)).length) throw new Error('Output directory must be empty');
const scratch = path.join(output, 'tmp');
await fs.mkdir(scratch);
process.env.TEMP = process.env.TMP = process.env.TMPDIR = scratch;
const evidence = { phase, platform: process.platform, os: os.release(), node: process.version,
  executedAt: new Date().toISOString(), proof: 'synthetic data; test-human verifier and injected backup protection; no platform calls', checks: [] };
const writeJson = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n');
const serviceFor = (h) => new MigrationService({ ...h, ...h.paths, protection: h.protectionProvider });

async function exportTransfer(migration, context, expectation) {
  const prepared = await migration.prepare({ targetInstanceId: `cross_os_${phase}_${Date.now()}` }, context);
  const exported = await migration.export({ migrationId: prepared.migration.id }, context);
  const released = await migration.release({ migrationId: prepared.migration.id }, context);
  const transfer = path.join(output, 'transfer');
  await fs.mkdir(transfer);
  await fs.cp(exported.packageDir, path.join(transfer, 'package'), { recursive: true });
  await writeJson(path.join(transfer, 'expectation.json'), { ...expectation, migrationId: prepared.migration.id,
    sourcePlatform: process.platform, receipt: released.receipt });
  assert.equal((await migration.store.getInstance()).status, 'retired');
  evidence.checks.push('export released; source instance retired');
  evidence.transfer = transfer;
}

async function main() {
  const h = await createHarness({ overrides: { dryRun: false, comments: { enabled: true } } });
  try {
    if (phase === 'source') {
      await bindMockAccount(h);
      const artifact = await h.importFile('cross-os-script.txt', 'script', 'Cross-OS migration fixture: 中文 UTF-8\n');
      const comments = new CommentsModule({ ...h, adapter: makeMockAdapter() });
      const draft = await comments.createDraft({ candidate: mockCandidate(), text: 'Cross-OS draft; never send', principal: h.owner });
      await approvalDecide(h, { approvalId: draft.approval.id, nonce: draft.nonce });
      const state = await h.snapshot();
      const expectation = { workspaceId: state.workspaceId, historyEpoch: state.historyEpoch, artifact,
        taskId: draft.task.id, approvalId: draft.approval.id, businessKeys: Object.keys(state.businessKeys).sort(),
        accountRef: state.activeAccountRef, originDataDir: h.dir, originPlatform: process.platform };
      await exportTransfer(serviceFor(h), h.humanContext, expectation);
      evidence.sourceDataDir = h.dir;
      evidence.checks.push('approved but undispatched task and artifact captured');
      // Preserve the retired source for the final return-side check.
      return;
    }
    const input = path.resolve(inputArg);
    const expected = JSON.parse(await fs.readFile(path.join(input, 'expectation.json'), 'utf8'));
    assert.notEqual(expected.sourcePlatform, process.platform, 'This acceptance requires two different operating systems');
    const targetDir = path.join(output, 'data');
    const importer = serviceFor(h);
    await importer.importPackage({ from: path.join(input, 'package'), dataDir: targetDir }, h.humanContext);
    await importer.validate({ migrationId: expected.migrationId, dataDir: targetDir }, h.humanContext);
    await importer.activate({ migrationId: expected.migrationId, receipt: expected.receipt, dataDir: targetDir, sourceStopped: true }, h.humanContext);
    const options = { dataDir: targetDir, env: {}, now: h.now, humanVerifier: h.humanProof.verifier,
      fetchImpl: async () => { throw new Error('Unexpected network call'); }, logger: { warn() {}, info() {} } };
    let runtime = await createRuntime(options);
    try {
      const state = await runtime.store.getSnapshot();
      const instance = await runtime.store.getInstance();
      assert.equal(state.workspaceId, expected.workspaceId);
      assert.equal(state.historyEpoch, expected.historyEpoch);
      assert.deepEqual(state.activeAccountRef, expected.accountRef);
      assert.deepEqual(Object.keys(state.businessKeys).sort(), expected.businessKeys);
      assert.ok(state.tasks[expected.taskId].holds.some(hold => hold.kind === 'migration' && hold.status !== 'released'));
      assert.equal(state.approvals[expected.approvalId].usableForAuthorization, false);
      const artifact = state.artifacts[expected.artifact.artifactId];
      assert.equal((await fileSha256(path.join(targetDir, 'artifacts', artifact.relativePath))).sha256, expected.artifact.sha256);
      assert.deepEqual(instance.allowedCapabilities, ['core:read', 'core:write']);
      await assert.rejects(runtime.effectGateway.assertLocalDispatch({ capability: 'platform:bilibili' }), { code: 'FORBIDDEN' });
      evidence.checks.push('identity/epoch/account/permanent keys/artifact digest preserved',
        'old approval unusable; task hold retained; unverified platform denied');
      await runtime.close();
      runtime = await createRuntime(options);
      assert.equal((await runtime.store.getInstance()).instanceId, instance.instanceId);
      evidence.checks.push('target restart retains its single active instance');
      evidence.targetDataDir = targetDir;
      if (phase === 'target') {
        const localOwner = runtime.identity.findLocalOwner(await runtime.store.getSnapshot());
        runtime.migration.protection = h.protectionProvider;
        await exportTransfer(runtime.migration, { principal: localOwner, proof: { kind: 'test', ok: true } }, expected);
      } else {
        assert.equal(process.platform, expected.originPlatform);
        const origin = JSON.parse(await fs.readFile(path.join(expected.originDataDir, 'instance.json'), 'utf8'));
        assert.equal(origin.status, 'retired');
        evidence.checks.push('round trip returned to original OS; original source remains retired');
      }
    } finally { await runtime.close(); }
  } finally {
    if (phase !== 'source') await h.cleanup();
  }
}

try {
  await main();
  evidence.passed = true;
} catch (error) {
  evidence.passed = false;
  evidence.error = { code: error.code || null, message: error.message, stack: error.stack };
  process.exitCode = 1;
}
await writeJson(path.join(output, 'evidence.json'), evidence);
console.log(JSON.stringify(evidence, null, 2));
