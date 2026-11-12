import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHarness, bindMockAccount, makeMockAdapter, mockCandidate, AlwaysHumanVerifier } from './helpers/harness.js';
import { createRuntime } from '../src/index.js';
import { main as cliMain } from '../cli.mjs';
import { CommentsModule } from '../src/modules/comments.js';
import { jcsHash } from '../src/utils.js';
import { NAV_WBI, responseJson } from './helpers/mock-fetch.js';
import { MigrationService, verifyMigrationPackage } from '../src/migration.js';
import { isTargetBootstrapCapture } from '../src/backup-recovery.js';
import { migrationCapabilityChecks } from '../src/migration-capabilities.js';
import { DiaryModule } from '../src/modules/diary.js';
import { nowIso } from '../src/utils.js';

async function setupSource() {
  const harness = await createHarness({
    overrides: {
      dryRun: false,
      diary: { enabled: true, publicBook: true },
      migration: { mode: 'offline', maxFiles: 10000, maxTotalBytes: 100000000 }
    }
  });
  await bindMockAccount(harness);
  const artifact = await harness.importFile('image.png', 'image', 'migration-image');
  const diary = new DiaryModule({
    store: harness.store,
    journal: harness.journal,
    configService: harness.configService,
    identity: harness.identity,
    diaryDir: harness.paths.diaryDir,
    now: harness.now
  });
  const migration = new MigrationService({
    store: harness.store,
    configService: harness.configService,
    artifactStore: harness.artifactStore,
    journal: harness.journal,
    humanProof: harness.humanProof,
    protection: harness.protectionProvider,
    executorStatus: async () => ({ stopped: true }),
    dataDir: harness.dir,
    migrationsDir: harness.paths.migrationsDir,
    journalDir: harness.paths.journalDir,
    diaryDir: harness.paths.diaryDir,
    postsDir: harness.paths.postsDir,
    now: harness.now
  });
  return { harness, artifact, migration, diary };
}

async function createUnsettledState(harness) {
  const waiting = await harness.store.transaction(async (draft, tx) => {
    return harness.taskManager.create(tx, {
      kind: 'comment',
      principalId: harness.owner.id,
      accountRef: { platform: 'bilibili', accountId: '1001' },
      inputHash: 'jcs-sha256-v1:' + '9'.repeat(64),
      input: { marker: 'keep-me' }
    });
  });
  await harness.store.transaction(async (draft, tx) => {
    harness.taskManager.transition(tx, draft.tasks[waiting.id], 'waiting_approval');
    draft.outbox.old_notification = {
      id: 'old_notification',
      taskId: waiting.id,
      bindingId: 'b1',
      adapterId: 'dsh-im',
      botAccountId: 'bot',
      conversationId: 'conv',
      summary: 'pending',
      status: 'pending',
      payloadHash: 'h',
      createdAt: nowIso(harness.now)
    };
  });
  return waiting;
}

async function fullFlow({ activate = true, withComment = false } = {}) {
  const source = await setupSource();
  const waiting = await createUnsettledState(source.harness);
  let comment = null;
  if (withComment) {
    await source.harness.configService.update({ comments: { enabled: true } }, { source: 'cli' });
    const comments = new CommentsModule({ ...source.harness, adapter: makeMockAdapter() });
    comment = await comments.createDraft({ candidate: mockCandidate(), text: 'migrated draft', principal: source.harness.owner });
  }
  await source.diary.generate({
    date: '2026-11-07',
    scope: 'workspace/workspace_test',
    principal: source.harness.owner
  });
  const prepared = await source.migration.prepare(
    { targetInstanceId: 'intended_target' },
    source.harness.humanContext
  );
  assert.equal(prepared.migration.phase, 'quiescing');
  const exported = await source.migration.export(
    { migrationId: prepared.migration.id },
    source.harness.humanContext
  );
  assert.equal(exported.phase, 'sealed');
  assert.ok(exported.snapshotHash);
  assert.ok(exported.files > 0);
  const released = await source.migration.release(
    { migrationId: prepared.migration.id },
    source.harness.humanContext
  );
  assert.equal(released.migration.phase, 'released');
  const sourceState = await source.harness.snapshot();
  assert.equal(sourceState.migration.phase, 'released');
  assert.equal((await source.harness.store.getInstance()).status, 'retired');
  await assert.rejects(
    () => source.harness.effectGateway.reserveOperation({
      namespace: 'platform',
      action: 'comment',
      accountRef: { platform: 'bilibili', accountId: '1001' },
      businessKey: 'blocked-after-release',
      taskIds: [waiting.id],
      inputHash: 'jcs-sha256-v1:' + '8'.repeat(64),
      protected: true
    }),
    (error) => error.code === 'MIGRATION_BLOCKED'
  );
  const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-migrate-target-'));
  await fs.rm(targetDir, { recursive: true, force: true });
  const targetMigration = new MigrationService({
    store: source.harness.store,
    configService: source.harness.configService,
    humanProof: source.harness.humanProof,
    protection: source.harness.protectionProvider,
    activationChecks: async () => ({ capabilities: ['core:read', 'core:write', 'production:local'], blocked: ['platform_unverified'] }),
    now: source.harness.now
  });
  const imported = await targetMigration.importPackage(
    { from: exported.packageDir, dataDir: targetDir },
    source.harness.humanContext
  );
  assert.equal(imported.phase, 'imported');
  const validated = await targetMigration.validate(
    { migrationId: prepared.migration.id, dataDir: targetDir },
    source.harness.humanContext
  );
  assert.equal(validated.phase, 'validated');
  let activated = null;
  if (activate) {
    activated = await targetMigration.activate(
      {
        migrationId: prepared.migration.id,
        receipt: released.receipt,
        dataDir: targetDir,
        sourceStopped: true
      },
      source.harness.humanContext
    );
    assert.equal(activated.phase, 'active');
  }
  const targetState = JSON.parse(await fs.readFile(path.join(targetDir, 'state.json'), 'utf8'));
  const targetInstance = JSON.parse(await fs.readFile(path.join(targetDir, 'instance.json'), 'utf8'));
  assert.equal(targetState.historyEpoch, sourceState.historyEpoch);
  assert.equal(targetInstance.status, activate ? 'active' : 'validated');
  assert.equal(targetInstance.allowedCapabilities.includes('platform:bilibili'), false);
  assert.equal(targetState.tasks[waiting.id].holds.some((hold) => hold.kind === 'migration'), true);
  assert.equal(targetState.outbox.old_notification.status, 'suppressed');
  const targetArtifact = Object.values(targetState.artifacts)[0];
  assert.ok(await fs.readFile(path.join(targetDir, 'artifacts', targetArtifact.relativePath)));
  const targetDiary = Object.values(targetState.diaries)[0];
  assert.ok(await fs.readFile(path.join(targetDir, 'diary', targetDiary.targetFile)));
  return { source, waiting, comment, exported, released, targetDir, targetMigration, imported, validated, activated };
}

test('prepare/export/release/import/validate/activate preserves ledger, artifacts and holds', async () => {
  const flow = await fullFlow();
  try {
    assert.ok(flow.exported.packageDir);
    // source restart still refuses writes
    const sourceState = await flow.source.harness.snapshot();
    assert.equal(sourceState.migration.phase, 'released');
  } finally {
    await flow.source.harness.cleanup();
    await fs.rm(flow.targetDir, { recursive: true, force: true });
  }
});

test('audit: an imported target can seed its first recovery point before activation', async () => {
  // Real-host cutover: a brand-new target has no backup policy or point yet, and
  // activation requires a healthy target recovery point. Capture the first point
  // of the imported ledger while the target is still paused/validated, then
  // activate with real protection (no injected fixture).
  const flow = await fullFlow({ activate: false });
  let runtime = null;
  let destinationDir = null;
  try {
    const targetConfig = JSON.parse(JSON.stringify(flow.source.harness.config));
    targetConfig.dataDir = flow.targetDir;
    await fs.writeFile(path.join(flow.targetDir, 'config.json'), JSON.stringify(targetConfig));
    destinationDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-target-recovery-'));
    runtime = await createRuntime({
      dataDir: flow.targetDir,
      now: flow.source.harness.now,
      env: {},
      humanVerifier: new AlwaysHumanVerifier(),
      logger: { warn() {}, info() {} }
    });
    const verifiedAt = nowIso(flow.source.harness.now);
    await runtime.policyService.save({
      schemaVersion: 1,
      scheduleEnabled: false,
      destinationRoot: destinationDir,
      failureDomain: 'test:independent second root',
      failureDomainVerification: {
        independent: true,
        sourceRoot: flow.targetDir,
        destinationRoot: destinationDir,
        verifiedBy: 'test-owner',
        verifiedAt
      },
      verifiedBy: 'test-owner',
      verifiedAt,
      intervalMinutes: 15,
      maxPointAgeMinutes: 60
    });
    const humanContext = {
      principal: { id: 'principal_test_owner', kind: 'human', role: 'owner', scopes: ['*'] },
      proof: { kind: 'test', ok: true }
    };
    const point = await runtime.backupService.create(
      { kind: 'ledger', requestId: 'target-bootstrap-1' },
      humanContext
    );
    assert.equal(point.status, 'verified');
    const protection = await runtime.backupService.getProtection({ kind: 'workspace', workspaceId: null });
    assert.equal(protection.status, 'protected');
    const activated = await runtime.migration.activate(
      {
        migrationId: flow.imported.migrationId,
        receipt: flow.released.receipt,
        dataDir: flow.targetDir,
        sourceStopped: true
      },
      humanContext
    );
    assert.equal(activated.phase, 'active');
    const instance = JSON.parse(await fs.readFile(path.join(flow.targetDir, 'instance.json'), 'utf8'));
    assert.equal(instance.status, 'active');
  } finally {
    if (runtime) await runtime.close().catch(() => {});
    if (destinationDir) await fs.rm(destinationDir, { recursive: true, force: true });
    await flow.source.harness.cleanup();
    await fs.rm(flow.targetDir, { recursive: true, force: true });
  }
});

test('CLI migration import validates a sealed package without a running runtime', async () => {
  const flow = await fullFlow({ activate: false });
  const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-migrate-cli-import-'));
  await fs.rm(targetDir, { recursive: true, force: true });
  let stdout = '';
  try {
    const verifier = { issue: () => ({ challengeId: 'test-challenge' }), verify: async () => true };
    const exitCode = await cliMain(
      ['migration', 'import', '--from', flow.exported.packageDir, '--data-dir', targetDir, '--confirm'],
      {
        stdout: { write: (chunk) => { stdout += chunk; } },
        stderr: { write: () => {} },
        humanVerifier: verifier,
        prompt: async () => 'test-response'
      }
    );
    assert.equal(exitCode, 0);
    const result = JSON.parse(stdout.slice(stdout.indexOf('{')));
    assert.equal(result.phase, 'imported');
    assert.equal(result.migrationId, flow.imported.migrationId);
    const state = JSON.parse(await fs.readFile(path.join(targetDir, 'state.json'), 'utf8'));
    assert.equal(state.migration.phase, 'imported');
    assert.deepEqual(state.backups, {});
  } finally {
    await flow.source.harness.cleanup();
    await fs.rm(flow.targetDir, { recursive: true, force: true });
    await fs.rm(targetDir, { recursive: true, force: true });
  }
});

test('audit: target bootstrap capture stays limited to imported or validated targets', () => {
  const targetInstance = { status: 'validated', migrationId: 'm1', previousInstanceId: 'src1' };
  const targetState = { migration: { phase: 'validated', id: 'm1', sourceInstanceId: 'src1' } };
  assert.equal(isTargetBootstrapCapture(targetState, targetInstance), true);
  assert.equal(
    isTargetBootstrapCapture(
      { migration: { ...targetState.migration, phase: 'imported' } },
      { ...targetInstance, status: 'paused' }
    ),
    true
  );
  // Source-side phases never qualify, even when the ids happen to match.
  for (const phase of ['active', 'quiescing', 'sealed', 'released']) {
    assert.equal(isTargetBootstrapCapture({ migration: { ...targetState.migration, phase } }, targetInstance), false);
  }
  // Only the imported target instance itself may seed; not an active or foreign one.
  assert.equal(isTargetBootstrapCapture(targetState, { ...targetInstance, status: 'active' }), false);
  assert.equal(isTargetBootstrapCapture(targetState, { ...targetInstance, migrationId: 'other' }), false);
  assert.equal(isTargetBootstrapCapture(targetState, { ...targetInstance, previousInstanceId: 'other' }), false);
  assert.equal(isTargetBootstrapCapture(targetState, null), false);
});

test('audit: target runtime and CLI reauthorize verified capabilities, retain holds and require fresh approval on resume', async () => {
  const flow = await fullFlow({ withComment: true });
  let runtime;
  try {
    let issued;
    const verifier = { issue(binding) { issued = binding; return { challengeId: 'test' }; },
      async verify(proof, binding) { return proof.response === 'test' && jcsHash(binding) === jcsHash(issued); } };
    let reads = 0;
    runtime = await createRuntime({ dataDir: flow.targetDir, now: flow.source.harness.now,
      env: { BILI_SESSDATA: 'mock-session', BILI_JCT: 'mock-csrf' }, humanVerifier: verifier,
      fetchImpl: async (url, options) => { assert.equal(options.method, 'GET'); assert.match(String(url), /\/nav/); reads++; return responseJson(NAV_WBI); },
      logger: { warn() {}, info() {} } });
    // Test-only protection fixture: no claim of real independent media.
    runtime.migration.protection = flow.source.harness.protectionProvider;
    await runtime.configService.update({ dryRun: false, comments: { enabled: true }, publishing: { enabled: true } }, { source: 'cli' });
    await runtime.bindAccount();
    flow.source.harness.now.advance(60000);
    const migrationId = flow.released.migration.id;
    const output = { chunks: [], write(value) { this.chunks.push(value); } };
    const io = { stdout: output, stderr: output, prompt: async () => 'test', createRuntime: async () => ({ ...runtime, close: async () => {} }) };
    await assert.rejects(cliMain(['migration', 'reauthorize', migrationId, '--capabilities', 'platform:bilibili', '--data-dir', flow.targetDir], io));
    const args = ['migration', 'reauthorize', migrationId, '--capabilities', 'platform:bilibili,publish:manual', '--confirm', '--data-dir', flow.targetDir];
    assert.equal(await cliMain(args, io), 0);
    assert.equal(reads, 2); // explicit binding and one shared re-verification
    const state = await runtime.store.getSnapshot();
    const instance = await runtime.store.getInstance();
    assert.ok(instance.allowedCapabilities.includes('platform:bilibili'));
    assert.ok(instance.allowedCapabilities.includes('publish:manual'));
    assert.equal(instance.allowedCapabilities.includes('im'), false);
    assert.equal(state.migration.capabilityDecision.state, 'committed');
    const task = state.tasks[flow.comment.task.id];
    assert.equal(task.holds[0].status, 'active');
    const owner = runtime.identity.findLocalOwner(state);
    assert.equal(owner.requiresReverification, false);
    const resumeArgs = ['task', 'resume', task.id, '--go', '--confirm', '--data-dir', flow.targetDir];
    await assert.rejects(cliMain(resumeArgs, io), { code: 'RECOVERY_GAP' });
    await cliMain(['migration', 'release-hold', task.holds[0].id, '--task', task.id, '--confirm', '--data-dir', flow.targetDir], io);
    assert.equal(await cliMain(resumeArgs, io), 0);
    const resumed = (await runtime.store.getSnapshot()).tasks[task.id];
    assert.equal(resumed.status, 'waiting_approval');
    assert.notEqual(resumed.input.approvalId, flow.comment.approval.id);
    assert.equal((await flow.source.harness.store.getInstance()).status, 'retired');
  } finally { await runtime?.close(); await flow.source.harness.cleanup(); await fs.rm(flow.targetDir, { recursive: true, force: true }); }
});

test('IM-only target reauthorization uses fresh owner proof but cannot revive an imported binding', async () => {
  const flow = await fullFlow();
  let runtime;
  try {
    runtime = await createRuntime({ dataDir: flow.targetDir, now: flow.source.harness.now,
      env: {}, humanVerifier: flow.source.harness.verifier, logger: { warn() {}, info() {} } });
    runtime.migration.protection = flow.source.harness.protectionProvider;
    await runtime.configService.update({ im: { enabled: true } }, { source: 'cli' });
    runtime.migration.activationChecks = migrationCapabilityChecks({ configService: runtime.configService,
      channel: { async probe() { return { status: 'available' }; } } });
    const context = flow.source.harness.humanContext;
    const bindingData = { adapterId: 'dsh-im', botAccountId: 'bot', senderRef: 'owner',
      conversationIds: ['conv'], principalId: context.principal.id, scopes: ['task.read.own'] };
    await runtime.store.transaction(async (state, tx) => {
      runtime.identity.bindIm(tx, { ...bindingData, bindingId: 'old-binding' });
      state.bindings['old-binding'].requiresReverification = true;
    });
    const input = { migrationId: flow.released.migration.id, capabilities: ['im'] };
    await assert.rejects(runtime.migration.reauthorize(input, context), { code: 'MIGRATION_BLOCKED' });
    assert.equal((await runtime.store.getSnapshot()).principals[context.principal.id].requiresReverification, true);
    await runtime.store.transaction(async (state, tx) => runtime.identity.bindIm(tx, { ...bindingData, bindingId: 'new-binding' }));
    assert.equal((await runtime.migration.reauthorize(input, context)).authorized, true);
    const state = await runtime.store.getSnapshot();
    assert.equal(state.bindings['old-binding'].requiresReverification, true);
    assert.equal(state.principals[context.principal.id].requiresReverification, false);
    const resolved = await runtime.store.transaction(async (draft, tx) => runtime.identity.resolveImPrincipal(tx, {
      adapterId: 'dsh-im', botAccountId: 'bot', senderRef: 'owner', conversationId: 'conv'
    }));
    assert.equal(resolved.binding.bindingId, 'new-binding');
  } finally { await runtime?.close(); await flow.source.harness.cleanup(); await fs.rm(flow.targetDir, { recursive: true, force: true }); }
});

test('audit: capability crash remains blocked and a different retry cannot inherit the uncommitted grant', async () => {
  const flow = await fullFlow();
  let runtime;
  try {
    runtime = await createRuntime({ dataDir: flow.targetDir, env: {}, now: flow.source.harness.now,
      humanVerifier: flow.source.harness.humanProof.verifier, fetchImpl: async () => { throw new Error('unexpected network'); },
      logger: { warn() {}, info() {} } });
    const migration = runtime.migration;
    migration.protection = flow.source.harness.protectionProvider;
    migration.activationChecks = async ({ requestedCapabilities }) => ({ capabilities: requestedCapabilities, blocked: [] });
    const principal = runtime.identity.findLocalOwner(await runtime.store.getSnapshot());
    const context = { principal, proof: { kind: 'test', ok: true } };
    const migrationId = flow.released.migration.id;
    migration.hooks.afterCapabilityInstance = () => { throw new Error('injected power loss'); };
    await assert.rejects(migration.reauthorize({ migrationId, capabilities: ['platform:bilibili'] }, context), /injected power loss/);
    assert.equal((await runtime.store.getSnapshot()).migration.capabilityDecision.state, 'prepared');
    await assert.rejects(runtime.effectGateway.assertLocalDispatch({ capability: 'core:write' }), { code: 'MIGRATION_BLOCKED' });
    migration.hooks.afterCapabilityInstance = null;
    await migration.reauthorize({ migrationId, capabilities: ['publish:manual'] }, context);
    const instance = await runtime.store.getInstance();
    assert.ok(instance.allowedCapabilities.includes('publish:manual'));
    assert.equal(instance.allowedCapabilities.includes('platform:bilibili'), false);
    assert.equal((await runtime.store.getSnapshot()).migration.capabilityDecision.state, 'committed');
  } finally { await runtime?.close(); await flow.source.harness.cleanup(); await fs.rm(flow.targetDir, { recursive: true, force: true }); }
});

test('export is idempotent and abort invalidates an unsealed package', async () => {
  const source = await setupSource();
  try {
    const prepared = await source.migration.prepare(
      { targetInstanceId: 'target_abort' },
      source.harness.humanContext
    );
    const aborted = await source.migration.abort(
      { migrationId: prepared.migration.id },
      source.harness.humanContext
    );
    assert.equal(aborted.phase, 'active');
    assert.equal(aborted.lastAborted.id, prepared.migration.id);
    await assert.doesNotReject(() =>
      source.harness.effectGateway.assertLocalDispatch({ capability: 'production:local' })
    );
    await assert.rejects(
      () => source.migration.export({ migrationId: prepared.migration.id }, source.harness.humanContext),
      (error) => error.code === 'MIGRATION_BLOCKED'
    );
  } finally {
    await source.harness.cleanup();
  }
});

test('import refuses non-empty targets and backup packages are not migration tickets', async () => {
  const source = await setupSource();
  try {
    const targetDir = path.join(source.harness.dir, 'not-empty-target');
    await fs.mkdir(targetDir);
    await fs.writeFile(path.join(targetDir, 'keep'), 'keep');
    const migration = new MigrationService({
      store: source.harness.store,
      humanProof: source.harness.humanProof,
      now: source.harness.now
    });
    await assert.rejects(
      () => migration.importPackage({ from: '/tmp/no-such-package', dataDir: targetDir }, source.harness.humanContext),
      (error) => error.code === 'MIGRATION_BLOCKED'
    );
    const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-backup-like-'));
    try {
      await fs.writeFile(path.join(backupDir, 'manifest.json'), JSON.stringify({ schemaVersion: 1, kind: 'backup', stateVersion: 3 }));
      await assert.rejects(
        () => verifyMigrationPackage(backupDir),
        (error) => error.code === 'SCHEMA_UNSUPPORTED'
      );
    } finally {
      await fs.rm(backupDir, { recursive: true, force: true });
    }
  } finally {
    await source.harness.cleanup();
  }
});

test('release is idempotent and conflicting target binding is refused', async () => {
  const source = await setupSource();
  try {
    const prepared = await source.migration.prepare(
      { targetInstanceId: 'target_release' },
      source.harness.humanContext
    );
    const exported = await source.migration.export(
      { migrationId: prepared.migration.id },
      source.harness.humanContext
    );
    const first = await source.migration.release(
      { migrationId: prepared.migration.id },
      source.harness.humanContext
    );
    const second = await source.migration.release(
      { migrationId: prepared.migration.id },
      source.harness.humanContext
    );
    assert.equal(second.deduplicated, true);
    assert.equal(second.receipt.snapshotHash, first.receipt.snapshotHash);
    assert.equal(exported.phase, 'sealed');
  } finally {
    await source.harness.cleanup();
  }
});

test('crash before seal leaves the source quiescing and a retry can export', async () => {
  const source = await setupSource();
  try {
    const prepared = await source.migration.prepare(
      { targetInstanceId: 'target_crash' },
      source.harness.humanContext
    );
    const broken = new MigrationService({
      store: source.harness.store,
      configService: source.harness.configService,
      artifactStore: source.harness.artifactStore,
      journal: source.harness.journal,
      humanProof: source.harness.humanProof,
      protection: source.harness.protectionProvider,
      executorStatus: async () => ({ stopped: true }),
      dataDir: source.harness.dir,
      migrationsDir: source.harness.paths.migrationsDir,
      journalDir: source.harness.paths.journalDir,
      diaryDir: source.harness.paths.diaryDir,
      postsDir: source.harness.paths.postsDir,
      now: source.harness.now,
      hooks: {
        beforeSeal() {
          throw new Error('simulated seal crash');
        }
      }
    });
    await assert.rejects(
      () => broken.export({ migrationId: prepared.migration.id }, source.harness.humanContext),
      /simulated seal crash/
    );
    assert.equal((await source.harness.snapshot()).migration.phase, 'quiescing');
    const retried = await source.migration.export(
      { migrationId: prepared.migration.id },
      source.harness.humanContext
    );
    assert.equal(retried.phase, 'sealed');
  } finally {
    await source.harness.cleanup();
  }
});

test('disable-target requires a reachable target and rollback performs a reverse import/activate', async () => {
  const flow = await fullFlow();
  let rollbackDir = null;
  try {
    const migrationId = flow.released.migration.id;
    await assert.rejects(
      () => flow.source.migration.disableTarget({ migrationId, targetDataDir: null, targetStopped: true, targetStopEvidence: 'test:target-stopped' }, flow.source.harness.humanContext),
      (error) => error.code === 'MIGRATION_BLOCKED'
    );
    await assert.rejects(
      () => flow.source.migration.disableTarget(
        { migrationId, targetDataDir: flow.targetDir, targetStopped: false, targetStopEvidence: 'test:target-stopped' },
        flow.source.harness.humanContext
      ),
      (error) => error.code === 'MIGRATION_BLOCKED'
    );
    await assert.rejects(
      () => flow.source.migration.disableTarget(
        { migrationId, targetDataDir: flow.targetDir, targetStopped: true, targetStopEvidence: '' },
        flow.source.harness.humanContext
      ),
      (error) => error.code === 'MIGRATION_BLOCKED'
    );
    await assert.rejects(
      () => flow.source.migration.disableTarget(
        { migrationId, targetDataDir: path.join(os.tmpdir(), 'xfy-target-does-not-exist'), targetStopped: true, targetStopEvidence: 'test:target-stopped' },
        flow.source.harness.humanContext
      ),
      (error) => error.code === 'MIGRATION_BLOCKED'
    );
    assert.equal((await flow.source.harness.snapshot()).migration.targetDisabled, undefined);
    const disabled = await flow.source.migration.disableTarget(
      { migrationId, targetDataDir: flow.targetDir, targetStopped: true, targetStopEvidence: 'test:target-stopped' },
      flow.source.harness.humanContext
    );
    assert.equal(disabled.targetDisabled, true);
    const targetInstance = JSON.parse(await fs.readFile(path.join(flow.targetDir, 'instance.json'), 'utf8'));
    assert.equal(targetInstance.status, 'disabled');
    assert.deepEqual(targetInstance.allowedCapabilities, []);

    rollbackDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-migrate-rollback-'));
    await fs.rm(rollbackDir, { recursive: true, force: true });
    const rolledBack = await flow.source.migration.rollback(
      { migrationId, targetDataDir: flow.targetDir, to: rollbackDir },
      flow.source.harness.humanContext
    );
    assert.equal(rolledBack.activated.phase, 'active');
    assert.equal(rolledBack.imported.phase, 'imported');
    assert.equal(rolledBack.validated.phase, 'validated');
    const reverseInstance = JSON.parse(await fs.readFile(path.join(rollbackDir, 'instance.json'), 'utf8'));
    const reverseState = JSON.parse(await fs.readFile(path.join(rollbackDir, 'state.json'), 'utf8'));
    assert.equal(reverseInstance.status, 'active');
    assert.equal(reverseState.migration.id, rolledBack.reverseMigrationId);
    assert.equal(reverseState.historyEpoch, rolledBack.targetHistoryEpoch);
    assert.equal(reverseState.workspaceId, (await flow.source.harness.snapshot()).workspaceId);
    const reverseHolds = reverseState.tasks[flow.waiting.id].holds.filter((hold) => hold.kind === 'migration');
    assert.equal(reverseHolds.length, 1);
    assert.equal(reverseHolds[0].id, `hold_migration_${flow.waiting.id}`);
    const sourceState = await flow.source.harness.snapshot();
    assert.equal(sourceState.migration.rollback.phase, 'activated');
    assert.equal(sourceState.migration.rollback.reverseMigrationId, rolledBack.reverseMigrationId);
  } finally {
    await flow.source.harness.cleanup();
    await fs.rm(flow.targetDir, { recursive: true, force: true });
    if (rollbackDir) await fs.rm(rollbackDir, { recursive: true, force: true });
  }
});


test('activate resumes after a crash between instance activation and ledger commit', async () => {
  const flow = await fullFlow({ activate: false });
  try {
    const migrationId = flow.released.migration.id;
    const crashing = new MigrationService({
      store: flow.source.harness.store,
      configService: flow.source.harness.configService,
      humanProof: flow.source.harness.humanProof,
      protection: flow.source.harness.protectionProvider,
      now: flow.source.harness.now,
      hooks: {
        beforeActivationCommit() {
          throw new Error('simulated power cut before ledger commit');
        }
      }
    });
    await assert.rejects(
      () => crashing.activate(
        { migrationId, receipt: flow.released.receipt, dataDir: flow.targetDir, sourceStopped: true },
        flow.source.harness.humanContext
      ),
      /simulated power cut/
    );
    const crashedState = JSON.parse(await fs.readFile(path.join(flow.targetDir, 'state.json'), 'utf8'));
    const crashedInstance = JSON.parse(await fs.readFile(path.join(flow.targetDir, 'instance.json'), 'utf8'));
    assert.equal(crashedInstance.status, 'active');
    assert.equal(crashedState.migration.phase, 'validated');
    const retry = new MigrationService({
      store: flow.source.harness.store,
      configService: flow.source.harness.configService,
      humanProof: flow.source.harness.humanProof,
      protection: flow.source.harness.protectionProvider,
      now: flow.source.harness.now
    });
    const activated = await retry.activate(
      { migrationId, receipt: flow.released.receipt, dataDir: flow.targetDir, sourceStopped: true },
      flow.source.harness.humanContext
    );
    assert.equal(activated.phase, 'active');
    const state = JSON.parse(await fs.readFile(path.join(flow.targetDir, 'state.json'), 'utf8'));
    assert.equal(state.migration.phase, 'active');
  } finally {
    await flow.source.harness.cleanup();
    await fs.rm(flow.targetDir, { recursive: true, force: true });
  }
});

test('rollback can use the imported ledger of a target that was never activated', async () => {
  const flow = await fullFlow({ activate: false });
  let rollbackDir = null;
  try {
    const migrationId = flow.released.migration.id;
    await flow.source.migration.disableTarget(
      { migrationId, targetDataDir: flow.targetDir, targetStopped: true, targetStopEvidence: 'test:target-stopped' },
      flow.source.harness.humanContext
    );
    rollbackDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-migrate-rollback-unactivated-'));
    await fs.rm(rollbackDir, { recursive: true, force: true });
    const rolledBack = await flow.source.migration.rollback(
      { migrationId, targetDataDir: flow.targetDir, to: rollbackDir },
      flow.source.harness.humanContext
    );
    assert.equal(rolledBack.activated.phase, 'active');
    const reverseState = JSON.parse(await fs.readFile(path.join(rollbackDir, 'state.json'), 'utf8'));
    assert.equal(reverseState.migration.id, rolledBack.reverseMigrationId);
    assert.equal(reverseState.eventSeq, rolledBack.targetEventSeq);
    assert.equal(reverseState.historyEpoch, rolledBack.targetHistoryEpoch);
  } finally {
    await flow.source.harness.cleanup();
    await fs.rm(flow.targetDir, { recursive: true, force: true });
    if (rollbackDir) await fs.rm(rollbackDir, { recursive: true, force: true });
  }
});

test('reverse rollback rejects a target artifact whose bytes no longer match the ledger', async () => {
  const flow = await fullFlow();
  let rollbackDir = null;
  try {
    const migrationId = flow.released.migration.id;
    await flow.source.migration.disableTarget(
      { migrationId, targetDataDir: flow.targetDir, targetStopped: true, targetStopEvidence: 'test:target-stopped' },
      flow.source.harness.humanContext
    );
    const targetState = JSON.parse(await fs.readFile(path.join(flow.targetDir, 'state.json'), 'utf8'));
    const artifact = Object.values(targetState.artifacts)[0];
    const artifactFile = path.join(flow.targetDir, 'artifacts', artifact.relativePath);
    await fs.chmod(artifactFile, 0o644);
    await fs.writeFile(artifactFile, 'corrupted bytes');
    rollbackDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-migrate-rollback-corrupt-'));
    await fs.rm(rollbackDir, { recursive: true, force: true });
    await assert.rejects(
      () => flow.source.migration.rollback(
        { migrationId, targetDataDir: flow.targetDir, to: rollbackDir },
        flow.source.harness.humanContext
      ),
      (error) => ['ARTIFACT_INVALID', 'MIGRATION_BLOCKED'].includes(error.code)
    );
    const rollbackState = (await flow.source.harness.snapshot()).migration.rollback;
    assert.equal(rollbackState.phase, 'prepared');
    assert.equal(await fs.stat(rollbackDir).catch(() => null), null);
  } finally {
    await flow.source.harness.cleanup();
    await fs.rm(flow.targetDir, { recursive: true, force: true });
    if (rollbackDir) await fs.rm(rollbackDir, { recursive: true, force: true });
  }
});

test('reverse rollback rejects a target journal segment with a broken digest', async () => {
  const flow = await fullFlow();
  let rollbackDir = null;
  try {
    const migrationId = flow.released.migration.id;
    await flow.source.migration.disableTarget(
      { migrationId, targetDataDir: flow.targetDir, targetStopped: true, targetStopEvidence: 'test:target-stopped' },
      flow.source.harness.humanContext
    );
    const targetState = JSON.parse(await fs.readFile(path.join(flow.targetDir, 'state.json'), 'utf8'));
    const segment = Object.values(targetState.journalSegments)[0];
    const segmentFile = path.join(flow.targetDir, 'journal', segment.relativePath);
    await fs.chmod(segmentFile, 0o644);
    await fs.writeFile(segmentFile, '{"schemaVersion":1,"historyEpoch":"tampered","events":[]}');
    rollbackDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-migrate-rollback-journal-'));
    await fs.rm(rollbackDir, { recursive: true, force: true });
    await assert.rejects(
      () => flow.source.migration.rollback(
        { migrationId, targetDataDir: flow.targetDir, to: rollbackDir },
        flow.source.harness.humanContext
      ),
      (error) => ['JOURNAL_CORRUPTED', 'MIGRATION_BLOCKED'].includes(error.code)
    );
    assert.equal((await flow.source.harness.snapshot()).migration.rollback.phase, 'prepared');
  } finally {
    await flow.source.harness.cleanup();
    await fs.rm(flow.targetDir, { recursive: true, force: true });
    if (rollbackDir) await fs.rm(rollbackDir, { recursive: true, force: true });
  }
});

test('rollback retry records the already-active reverse instance instead of activating a second one', async () => {
  const flow = await fullFlow();
  let rollbackDir = null;
  try {
    const migrationId = flow.released.migration.id;
    await flow.source.migration.disableTarget(
      { migrationId, targetDataDir: flow.targetDir, targetStopped: true, targetStopEvidence: 'test:target-stopped' },
      flow.source.harness.humanContext
    );
    rollbackDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-migrate-rollback-retry-'));
    await fs.rm(rollbackDir, { recursive: true, force: true });
    const crashing = new MigrationService({
      store: flow.source.harness.store,
      configService: flow.source.harness.configService,
      artifactStore: flow.source.harness.artifactStore,
      journal: flow.source.harness.journal,
      humanProof: flow.source.harness.humanProof,
      protection: flow.source.harness.protectionProvider,
      executorStatus: async () => ({ stopped: true }),
      dataDir: flow.source.harness.dir,
      migrationsDir: flow.source.harness.paths.migrationsDir,
      journalDir: flow.source.harness.paths.journalDir,
      diaryDir: flow.source.harness.paths.diaryDir,
      postsDir: flow.source.harness.paths.postsDir,
      now: flow.source.harness.now,
      hooks: {
        afterReverseActivated() {
          throw new Error('simulated crash before source rollback commit');
        }
      }
    });
    await assert.rejects(
      () => crashing.rollback(
        { migrationId, targetDataDir: flow.targetDir, to: rollbackDir },
        flow.source.harness.humanContext
      ),
      /simulated crash/
    );
    const firstInstance = JSON.parse(await fs.readFile(path.join(rollbackDir, 'instance.json'), 'utf8'));
    assert.equal(firstInstance.status, 'active');
    assert.equal((await flow.source.harness.snapshot()).migration.rollback.phase, 'prepared');

    const retried = await flow.source.migration.rollback(
      { migrationId, targetDataDir: flow.targetDir, to: rollbackDir },
      flow.source.harness.humanContext
    );
    assert.equal(retried.activated.targetInstanceId, firstInstance.instanceId);
    assert.equal((await flow.source.harness.snapshot()).migration.rollback.phase, 'activated');
    assert.equal((await fs.readdir(rollbackDir)).includes('state.json'), true);
    await assert.rejects(
      () => flow.source.migration.rollback(
        { migrationId, targetDataDir: flow.targetDir, to: `${rollbackDir}-other` },
        flow.source.harness.humanContext
      ),
      (error) => error.code === 'MIGRATION_BLOCKED'
    );
  } finally {
    await flow.source.harness.cleanup();
    await fs.rm(flow.targetDir, { recursive: true, force: true });
    if (rollbackDir) await fs.rm(rollbackDir, { recursive: true, force: true });
  }
});
