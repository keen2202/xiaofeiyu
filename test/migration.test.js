import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHarness, bindMockAccount } from './helpers/harness.js';
import { MigrationService, verifyMigrationPackage } from '../src/migration.js';
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

async function fullFlow({ activate = true } = {}) {
  const source = await setupSource();
  const waiting = await createUnsettledState(source.harness);
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
        dataDir: targetDir
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
  return { source, waiting, exported, released, targetDir, targetMigration, imported, validated, activated };
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
        { migrationId, receipt: flow.released.receipt, dataDir: flow.targetDir },
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
      { migrationId, receipt: flow.released.receipt, dataDir: flow.targetDir },
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
