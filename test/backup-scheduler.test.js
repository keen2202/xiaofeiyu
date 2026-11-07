import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setupBackup } from './helpers/backup.js';
import { BackupScheduler } from '../src/backup-recovery.js';

async function schedulerSetup({ policy = {}, tickMs = 60_000 } = {}) {
  const setup = await setupBackup({
    policy: { scheduleEnabled: true, ...policy }
  });
  const scheduler = new BackupScheduler({
    backupService: setup.backup,
    policyService: setup.policyService,
    now: setup.harness.now,
    tickMs
  });
  return { ...setup, scheduler };
}

test('scheduler is opt-in and creates due ledger/full points idempotently', async () => {
  const setup = await schedulerSetup();
  try {
    const started = await setup.scheduler.start();
    assert.equal(started.started, true);
    const first = await setup.scheduler.tick();
    assert.equal(first.skipped, false);
    assert.deepEqual(first.ran.map((entry) => entry.kind), ['ledger', 'full']);
    const status = await setup.backup.status();
    assert.equal(status.points, 2);
    assert.equal(Boolean(status.latest), true);
    assert.equal(Boolean(status.latestFull), true);
    assert.match(status.latestFull.backupId, /^backup_/);

    const second = await setup.scheduler.tick();
    assert.deepEqual(second.ran, []);

    setup.harness.now.advance(15 * 60 * 1000);
    const third = await setup.scheduler.tick();
    assert.deepEqual(third.ran.map((entry) => entry.kind), ['ledger']);
    assert.equal((await setup.backup.status()).points, 3);

    setup.harness.now.advance(24 * 60 * 60 * 1000);
    const fourth = await setup.scheduler.tick();
    assert.equal(fourth.ran.some((entry) => entry.kind === 'full'), true);
    assert.equal(fourth.ran.some((entry) => entry.kind === 'ledger'), true);
  } finally {
    await setup.scheduler.stop();
    await setup.cleanup();
  }
});

test('disabled scheduler start is a no-op and tick never creates a point', async () => {
  const setup = await schedulerSetup({ policy: { scheduleEnabled: false } });
  try {
    const started = await setup.scheduler.start();
    assert.equal(started.started, false);
    const result = await setup.scheduler.tick();
    assert.equal(result.skipped, true);
    assert.equal((await setup.backup.status()).points, 0);
    await assert.rejects(
      () => setup.backup.createScheduled({ kind: 'ledger', requestId: 'disabled-policy' }),
      (error) => error.code === 'BACKUP_UNPROTECTED'
    );
  } finally {
    await setup.scheduler.stop();
    await setup.cleanup();
  }
});

test('daily verify runs once per persisted UTC day and records restore tests only for verified points', async () => {
  const setup = await schedulerSetup();
  try {
    await setup.scheduler.start();
    await setup.scheduler.tick();
    const firstVerify = await setup.backup.dailyVerify();
    assert.equal(firstVerify.skipped, true);
    assert.equal((await setup.backup.status()).lastDailyVerifyDate !== null, true);

    const status = await setup.backup.status();
    const backupId = status.latest.backupId;
    const recorded = await setup.backup.recordRestoreTest(
      {
        backupId,
        recoveryId: 'recovery_test_1',
        targetInstanceId: 'instance_recovered',
        newHistoryEpoch: 'epoch_recovered',
        restoredAt: '2026-11-07T00:00:00.000Z'
      },
      setup.harness.humanContext
    );
    assert.equal(recorded.recorded, true);
    const after = await setup.backup.status();
    assert.equal(after.latest.restoreTestedAt !== null, true);
    const deduplicated = await setup.backup.recordRestoreTest(
      {
        backupId,
        recoveryId: 'recovery_test_1',
        targetInstanceId: 'instance_recovered',
        newHistoryEpoch: 'epoch_recovered'
      },
      setup.harness.humanContext
    );
    assert.equal(deduplicated.deduplicated, true);

    setup.harness.now.advance(24 * 60 * 60 * 1000);
    const nextDay = await setup.backup.dailyVerify();
    assert.equal(nextDay.skipped, false);
    assert.deepEqual(nextDay.checked.map((entry) => entry.kind).sort(), ['full', 'ledger']);
  } finally {
    await setup.scheduler.stop();
    await setup.cleanup();
  }
});

test('restore test recording refuses an unknown point and never marks an invalid point', async () => {
  const setup = await schedulerSetup();
  try {
    await setup.scheduler.start();
    await setup.scheduler.tick();
    await assert.rejects(
      () => setup.backup.recordRestoreTest(
        {
          backupId: 'backup_unknown',
          recoveryId: 'recovery_unknown',
          targetInstanceId: 'i',
          newHistoryEpoch: 'e'
        },
        setup.harness.humanContext
      ),
      (error) => error.code === 'BACKUP_INVALID'
    );
    const status = await setup.backup.status();
    const backupId = status.latest.backupId;
    const backupDir = path.join(setup.destinationRoot, 'backups', backupId);
    const manifest = JSON.parse(await fs.readFile(path.join(backupDir, 'manifest.json'), 'utf8'));
    const stateFile = manifest.files.find((entry) => entry.role === 'state');
    await fs.writeFile(path.join(backupDir, stateFile.path), '{"tampered":true}');
    await setup.backup.verify(backupId);
    await assert.rejects(
      () => setup.backup.recordRestoreTest(
        {
          backupId,
          recoveryId: 'recovery_invalid',
          targetInstanceId: 'i',
          newHistoryEpoch: 'e'
        },
        setup.harness.humanContext
      ),
      (error) => error.code === 'BACKUP_INVALID'
    );
  } finally {
    await setup.scheduler.stop();
    await setup.cleanup();
  }
});

test('runtime starts and stops the backup scheduler only when the policy enables it', async () => {
  const { createRuntime } = await import('../src/index.js');
  const { DEFAULT_CONFIG } = await import('../src/config.js');
  const { DEFAULT_BACKUP_POLICY } = await import('../src/backup-recovery.js');
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-runtime-scheduler-'));
  const destinationRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-runtime-backup-'));
  let runtime = null;
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.dataDir = dataDir;
    runtime = await createRuntime({
      dataDir,
      config,
      env: {},
      logger: { warn() {} }
    });
    const disabled = await runtime.backupScheduler.start();
    assert.equal(disabled.started, false);
    await runtime.policyService.save({
      ...DEFAULT_BACKUP_POLICY,
      destinationRoot,
      failureDomain: 'test-independent',
      verifiedBy: 'test-owner',
      scheduleEnabled: true
    });
    const lifecycle = await runtime.start();
    assert.equal(lifecycle.backup.started, true);
    const status = await runtime.backupScheduler.status();
    assert.equal(status.started, true);
    assert.equal(status.scheduleEnabled, true);
    const stopped = await runtime.stop();
    assert.equal(stopped.backup.stopped, true);
    assert.equal((await runtime.backupScheduler.status()).started, false);
    runtime = null;
  } finally {
    if (runtime) await runtime.close();
    await fs.rm(dataDir, { recursive: true, force: true });
    await fs.rm(destinationRoot, { recursive: true, force: true });
  }
});

test('scheduler creates a replacement when its deterministic slot was invalidated', async () => {
  const setup = await schedulerSetup();
  try {
    await setup.scheduler.start();
    await setup.scheduler.tick();
    setup.harness.now.advance(15 * 60 * 1000);
    await setup.scheduler.tick();
    let status = await setup.backup.status();
    const invalidId = status.latest.backupId;
    assert.equal(status.latest.cutAt, '2026-11-07T00:15:00.000Z');
    const backupDir = path.join(setup.destinationRoot, 'backups', invalidId);
    const manifest = JSON.parse(await fs.readFile(path.join(backupDir, 'manifest.json'), 'utf8'));
    const stateEntry = manifest.files.find((entry) => entry.role === 'state');
    await fs.writeFile(path.join(backupDir, stateEntry.path), '{"tampered":true}');
    const verified = await setup.backup.verify(invalidId);
    assert.equal(verified.verified, false);

    setup.harness.now.advance(15 * 60 * 1000);
    const replacement = await setup.scheduler.tick();
    assert.equal(replacement.errors.length, 0);
    assert.equal(replacement.ran.some((entry) => entry.kind === 'ledger'), true);
    status = await setup.backup.status();
    assert.notEqual(status.latest.backupId, invalidId);
    assert.equal(status.latest.cutAt, '2026-11-07T00:30:00.000Z');
  } finally {
    await setup.scheduler.stop();
    await setup.cleanup();
  }
});
