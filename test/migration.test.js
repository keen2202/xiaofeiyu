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

async function fullFlow() {
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
  const activated = await targetMigration.activate(
    {
      migrationId: prepared.migration.id,
      receipt: released.receipt,
      dataDir: targetDir
    },
    source.harness.humanContext
  );
  assert.equal(activated.phase, 'active');
  const targetState = JSON.parse(await fs.readFile(path.join(targetDir, 'state.json'), 'utf8'));
  const targetInstance = JSON.parse(await fs.readFile(path.join(targetDir, 'instance.json'), 'utf8'));
  assert.equal(targetState.historyEpoch, sourceState.historyEpoch);
  assert.equal(targetInstance.status, 'active');
  assert.equal(targetInstance.allowedCapabilities.includes('platform:bilibili'), false);
  assert.equal(targetState.tasks[waiting.id].holds.some((hold) => hold.kind === 'migration'), true);
  assert.equal(targetState.outbox.old_notification.status, 'suppressed');
  const targetArtifact = Object.values(targetState.artifacts)[0];
  assert.ok(await fs.readFile(path.join(targetDir, 'artifacts', targetArtifact.relativePath)));
  const targetDiary = Object.values(targetState.diaries)[0];
  assert.ok(await fs.readFile(path.join(targetDir, 'diary', targetDiary.targetFile)));
  return { source, waiting, exported, released, targetDir };
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
