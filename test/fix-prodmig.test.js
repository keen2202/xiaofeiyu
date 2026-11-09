import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHarness, bindMockAccount, approvalDecide } from './helpers/harness.js';
import { setupBackup } from './helpers/backup.js';
import { FakeExecutionBackend } from './helpers/fake-execution-backend.js';
import { LocalExecutionBackend } from '../src/adapters/execution/local.js';
import { ProductionModule } from '../src/modules/production.js';
import {
  LOCAL_SLIDESHOW_PROFILE,
  loadLocalSlideshowProfile
} from '../src/production/profiles/local-slideshow.js';
import { MigrationService, sanitizeStateForMigration } from '../src/migration.js';
import { RecoveryService, BackupService, BackupPolicyService, RecoveryManagedBackupService, DEFAULT_BACKUP_POLICY } from '../src/backup-recovery.js';
import { JsonStore } from '../src/store.js';
import { nowIso, processStartIso } from '../src/utils.js';

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

// Windows may report EBUSY while a just-exited child still holds the work dir.
async function removeDirWithRetry(target) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  await fs.rm(target, { recursive: true, force: true });
}

async function setupMigrationSource() {
  const harness = await createHarness({
    overrides: {
      dryRun: false,
      diary: { enabled: true, publicBook: true },
      migration: { mode: 'offline', maxFiles: 10000, maxTotalBytes: 100000000 }
    }
  });
  await bindMockAccount(harness);
  await harness.importFile('image.png', 'image', 'migration-image-bytes');
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
  return { harness, migration };
}

async function sealAndRelease(flow) {
  const prepared = await flow.migration.prepare({ targetInstanceId: 'target_intended' }, flow.harness.humanContext);
  const exported = await flow.migration.export({ migrationId: prepared.migration.id }, flow.harness.humanContext);
  const released = await flow.migration.release({ migrationId: prepared.migration.id }, flow.harness.humanContext);
  return { prepared, exported, released };
}

async function exportToTarget(flow, exported) {
  const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-fix-target-'));
  await fs.rm(targetDir, { recursive: true, force: true });
  const targetMigration = new MigrationService({
    store: flow.harness.store,
    configService: flow.harness.configService,
    humanProof: flow.harness.humanProof,
    protection: flow.harness.protectionProvider,
    activationChecks: async () => ({ capabilities: ['core:read', 'core:write'], blocked: ['platform_unverified'] }),
    now: flow.harness.now
  });
  const imported = await targetMigration.importPackage(
    { from: exported.packageDir, dataDir: targetDir },
    flow.harness.humanContext
  );
  const validated = await targetMigration.validate(
    { migrationId: exported.migrationId, dataDir: targetDir },
    flow.harness.humanContext
  );
  return { targetDir, targetMigration, imported, validated };
}

async function setupProduction() {
  const harness = await createHarness({
    allowedCapabilities: ['core:read', 'core:write', 'production:local'],
    overrides: {
      dryRun: false,
      security: { allowLocalProducer: true },
      production: {
        enabled: true,
        dryRun: false,
        requireApproval: true,
        limits: { wallTimeSec: 120, maxPaidCostMinor: 0, currency: 'CNY', maxOutputBytes: 1048576 }
      }
    }
  });
  const backend = new FakeExecutionBackend();
  const production = new ProductionModule({
    store: harness.store,
    taskManager: harness.taskManager,
    configService: harness.configService,
    artifactStore: harness.artifactStore,
    effectGateway: harness.effectGateway,
    approvalService: harness.approvalService,
    journal: harness.journal,
    backend,
    profileLoader: async () => ({
      ...structuredClone(LOCAL_SLIDESHOW_PROFILE),
      bound: true,
      blocked: [],
      tools: { ffmpeg: '/usr/bin/ffmpeg', ffprobe: '/usr/bin/ffprobe' }
    }),
    preflight: async () => ({ ok: true }),
    mediaValidator: async () => ({
      ok: true,
      media: { width: 320, height: 240, fps: 10, duration: 5, videoCodec: 'h264', sizeBytes: 16 }
    }),
    audioProbe: async () => ({ durationSec: 5 }),
    runTool: async () => ({ stdout: '', stderr: '' }),
    now: harness.now
  });
  const script = await harness.importFile('script.txt', 'script', '脚本内容第一段。\n\n第二段。');
  const image = await harness.importFile('image.png', 'image', 'image-bytes');
  const job = {
    requestId: 'fix-prod-1',
    profileId: 'local-slideshow-v1',
    brief: 'fix test',
    inputs: [{ artifactId: script.artifactId }, { artifactId: image.artifactId }],
    output: { container: 'mp4', width: 320, height: 240, fps: 10, maxDurationSec: 5 },
    mode: 'go',
    limits: { wallTimeSec: 60, maxPaidCostMinor: 0, currency: 'CNY' }
  };
  return { harness, backend, production, job };
}

/* ------------------------------------------------------------------ *
 * P-P1-1 [I5] sealed late write reopens the migration + release cut
 * ------------------------------------------------------------------ */

test('P-P1-1 late ledger write reopens a sealed migration and re-export changes the snapshotHash', async () => {
  const flow = await setupMigrationSource();
  try {
    const prepared = await flow.migration.prepare({ targetInstanceId: 'target_late' }, flow.harness.humanContext);
    const first = await flow.migration.export({ migrationId: prepared.migration.id }, flow.harness.humanContext);
    assert.equal(first.phase, 'sealed');
    assert.equal(Number.isSafeInteger(first.manifest.cutEventSeq), true);

    const reopened = await flow.harness.store.transaction(async (draft, tx) =>
      flow.migration.noteLateLedgerWrite(draft, tx, { operationId: 'op_late', kind: 'receipt' })
    );
    assert.equal(reopened, true);
    const state = await flow.harness.snapshot();
    assert.equal(state.migration.phase, 'quiescing');
    assert.equal(state.migration.lateReceipts.length, 1);
    assert.equal(state.migration.lateReceipts[0].operationId, 'op_late');
    assert.equal(state.migration.sealedPackage, null);
    assert.equal(state.migration.snapshotHash, null);

    const second = await flow.migration.export({ migrationId: prepared.migration.id }, flow.harness.humanContext);
    assert.equal(second.phase, 'sealed');
    assert.notEqual(second.snapshotHash, first.snapshotHash);
    const released = await flow.migration.release({ migrationId: prepared.migration.id }, flow.harness.humanContext);
    assert.equal(released.receipt.cutEventSeq, second.manifest.cutEventSeq);
    assert.equal(released.receipt.sourceHistoryEpoch, second.manifest.sourceHistoryEpoch);
    assert.equal(released.receipt.snapshotHash, second.snapshotHash);
    assert.equal((await flow.harness.store.getInstance()).status, 'retired');
  } finally {
    await flow.harness.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * P-P1-2 [I9] migration task hold release
 * ------------------------------------------------------------------ */

test('P-P1-2 releaseTaskHold releases only kind=migration task holds with audit', async () => {
  const flow = await setupMigrationSource();
  let targetDir = null;
  let targetStore = null;
  try {
    await flow.harness.store.transaction(async (draft, tx) => {
      const task = flow.harness.taskManager.create(tx, {
        kind: 'comment',
        principalId: flow.harness.owner.id,
        accountRef: { platform: 'bilibili', accountId: '1001' },
        inputHash: 'jcs-sha256-v1:' + '1'.repeat(64)
      });
      flow.harness.taskManager.transition(tx, task, 'waiting_approval');
    });
    const { exported } = await sealAndRelease(flow);
    const target = await exportToTarget(flow, exported);
    targetDir = target.targetDir;
    targetStore = new JsonStore({
      file: path.join(targetDir, 'state.json'),
      instanceFile: path.join(targetDir, 'instance.json'),
      now: flow.harness.now
    });
    await targetStore.init({ bootstrap: false });
    const targetMigration = new MigrationService({
      store: targetStore,
      humanProof: flow.harness.humanProof,
      now: flow.harness.now
    });
    const targetState = await targetStore.getSnapshot();
    const task = Object.values(targetState.tasks)[0];
    const hold = task.holds.find((entry) => entry.kind === 'migration');
    assert.ok(hold);
    const released = await targetMigration.releaseTaskHold(
      { holdId: hold.id, taskId: task.id, note: 'owner verified the old task' },
      flow.harness.humanContext
    );
    assert.equal(released.deduplicated, false);
    assert.equal(released.hold.status, 'released');
    const after = await targetStore.getSnapshot();
    assert.equal(after.tasks[task.id].holds.find((entry) => entry.id === hold.id).status, 'released');
    assert.equal(
      Object.values(after.events).some((event) => event.type === 'task.hold.released'),
      true
    );
  } finally {
    if (targetStore) await targetStore.close();
    if (targetDir) await fs.rm(targetDir, { recursive: true, force: true });
    await flow.harness.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * P-P1-5 / MIG-002 prepare executor stop proof
 * ------------------------------------------------------------------ */

test('P-P1-5 prepare blocks live execution owners and records explicit stop evidence', async () => {
  const flow = await setupMigrationSource();
  try {
    await flow.harness.store.transaction(async (draft) => {
      draft.executions.exec_live = {
        executionId: 'exec_live',
        taskId: 'task_x',
        stageId: 'render',
        attempt: 1,
        status: 'running',
        ownerPid: process.pid,
        processStartedAt: processStartIso()
      };
    });
    await assert.rejects(
      () => flow.migration.prepare({ targetInstanceId: 'target_stop' }, flow.harness.humanContext),
      (error) => error.code === 'MIGRATION_BLOCKED' && error.details?.liveExecutions?.length === 1
    );
    const stateBefore = await flow.harness.snapshot();
    assert.equal(stateBefore.migration.phase, 'active');

    await flow.harness.store.transaction(async (draft) => {
      draft.executions.exec_live.status = 'running';
      draft.executions.exec_live.ownerPid = 999999;
      draft.executions.exec_live.processStartedAt = processStartIso();
    });
    await assert.rejects(
      () => flow.migration.prepare({ targetInstanceId: 'target_stop' }, flow.harness.humanContext),
      (error) => error.code === 'MIGRATION_BLOCKED' && error.details?.requiresExecutorStopEvidence === true
    );
    const prepared = await flow.migration.prepare(
      {
        targetInstanceId: 'target_stop',
        executorStopEvidence: { source: 'owner:process-list', note: 'all ffmpeg children exited', refs: ['ps-audit'] }
      },
      flow.harness.humanContext
    );
    assert.equal(prepared.migration.phase, 'quiescing');
    assert.equal(prepared.migration.executorStopEvidence.source, 'owner:process-list');
    assert.ok(prepared.migration.executorStopEvidenceHash);
  } finally {
    await flow.harness.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * P-P1-6 [I4] ExecutionDispatchContext
 * ------------------------------------------------------------------ */

test('P-P1-6 local backend verifies/consumes an ExecutionDispatchContext and rejects id reuse', async () => {
  const calls = { verify: 0, consume: 0 };
  const verifier = {
    verify(context) {
      calls.verify += 1;
      if (context?.permit !== 'dispatch-once') throw new Error('bad permit');
    },
    consume(context) {
      calls.consume += 1;
      assert.equal(context.permit, 'dispatch-once');
    }
  };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-exec-ctx-'));
  let backend = null;
  let realBackend = null;
  const baseRequest = {
    executionId: 'exec_ctx',
    taskId: 'task_ctx',
    stageId: 'render',
    attempt: 1,
    requestId: 'req_ctx',
    workspaceId: 'ws_ctx',
    instanceId: 'inst_ctx',
    inputHash: 'jcs-sha256-v1:' + '2'.repeat(64),
    profileId: 'local-slideshow-v1',
    tools: { ffmpeg: '/usr/bin/ffmpeg', ffprobe: '/usr/bin/ffprobe' },
    workDir: dir,
    allowedInputRoots: [dir],
    limits: { wallTimeSec: 5 },
    plan: { width: 320, height: 240, fps: 10, durationSec: 1, segments: [], videoFile: 'render.mp4' }
  };
  try {
    backend = new LocalExecutionBackend({ executionContextVerifier: verifier });
    await assert.rejects(
      () => backend.submit({ ...baseRequest, dispatchContext: null }),
      (error) => error.code === 'FORBIDDEN'
    );
    // Verify + consume happen before the spawn attempt; the sandbox rejects the
    // real spawn with EPERM, which is environment-specific and not asserted here.
    await backend.submit({ ...baseRequest, dispatchContext: { permit: 'dispatch-once' } }).catch(() => {});
    assert.equal(calls.verify >= 1, true);
    assert.equal(calls.consume >= 1, true);

    backend.records.set('exec_ctx', {
      executionId: 'exec_ctx',
      status: 'running',
      requestId: 'req_other',
      inputHash: baseRequest.inputHash
    });
    await assert.rejects(
      () => backend.submit({ ...baseRequest, dispatchContext: { permit: 'dispatch-once' } }),
      (error) => error.code === 'IDEMPOTENCY_CONFLICT'
    );

    // Real I4 verifier from fix-gateway: one context can be consumed only once.
    const harness = await createHarness({});
    try {
      const context = harness.effectGateway.issueExecutionContext({
        executionId: 'exec_real_ctx',
        taskId: 'task_real_ctx',
        stageId: 'render',
        attempt: 1,
        inputHash: baseRequest.inputHash,
        instanceId: 'inst_real_ctx',
        profileId: 'local-slideshow-v1'
      });
      realBackend = new LocalExecutionBackend({
        executionContextVerifier: harness.effectGateway.executionContextVerifier
      });
      await realBackend
        .submit({ ...baseRequest, executionId: 'exec_real_ctx', dispatchContext: context })
        .catch(() => {});
      await assert.rejects(
        () => realBackend.submit({ ...baseRequest, executionId: 'exec_real_ctx2', dispatchContext: context }),
        (error) => error.code === 'FORBIDDEN'
      );
    } finally {
      await harness.cleanup();
    }
  } finally {
    await backend?.close?.().catch(() => {});
    await realBackend?.close?.().catch(() => {});
    await removeDirWithRetry(dir);
  }
});

/* ------------------------------------------------------------------ *
 * P-P1-7 pending capture hook + pendingExcluded manifest
 * ------------------------------------------------------------------ */

test('P-P1-7 prepareCapture hook runs before the cut and pending imports are recorded', async () => {
  let hookCalls = 0;
  const setup = await setupBackup({
    backupServiceOptions: {
      prepareCapture: async () => {
        hookCalls += 1;
      }
    }
  });
  try {
    await setup.backup.create({ kind: 'ledger', requestId: 'pending-cut' }, setup.harness.humanContext);
    assert.equal(hookCalls, 1);
    const index = JSON.parse(await fs.readFile(path.join(setup.destinationRoot, 'index.json'), 'utf8'));
    const entry = Object.values(index.backups)[0];
    assert.deepEqual(entry.pendingExcluded, []);
  } finally {
    await setup.cleanup();
  }

  const pendingSetup = await setupBackup();
  try {
    await pendingSetup.harness.store.transaction(async (draft) => {
      draft.artifactPendingImports.artifact_pending = {
        artifactId: 'artifact_pending',
        tempFile: 'tmp/artifact_pending.part',
        targetFile: 'artifact_pending/x.png',
        expectedSha256: 'a'.repeat(64),
        expectedBytes: 10,
        phase: 'pending'
      };
    });
    const backup = await pendingSetup.backup.create(
      { kind: 'ledger', requestId: 'pending-cut-2' },
      pendingSetup.harness.humanContext
    );
    const manifest = JSON.parse(
      await fs.readFile(path.join(pendingSetup.destinationRoot, 'backups', backup.backupId, 'manifest.json'), 'utf8')
    );
    assert.equal(manifest.pendingExcluded.some((entry) => entry.includes('artifact_pending')), true);
  } finally {
    await pendingSetup.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * P-P1-8 prune pinning / media coverage / capacity precheck
 * ------------------------------------------------------------------ */

test('P-P1-8 prune keeps recovery-referenced points and verifies media coverage', async () => {
  const setup = await setupBackup({
    policy: { keepRecent: 1, keepDaily: 1, keepWeekly: 1 }
  });
  try {
    const first = await setup.backup.create({ kind: 'ledger', requestId: 'p1' }, setup.harness.humanContext);
    await setup.harness.now.advance?.(1000);
    await setup.backup.create({ kind: 'ledger', requestId: 'p2' }, setup.harness.humanContext);
    await setup.backup.create({ kind: 'full', requestId: 'p3' }, setup.harness.humanContext);
    const recoveryDir = path.join(setup.harness.dir, 'recovery');
    await fs.mkdir(recoveryDir, { recursive: true });
    await fs.writeFile(
      path.join(recoveryDir, 'recovery.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'recovery_test',
        phase: 'readonly',
        revision: 1,
        backupRef: { backupId: first.backupId },
        parentHistory: { backupId: first.backupId },
        evidenceRefs: [],
        holds: []
      })
    );
    const plan = await setup.backup.planPrune();
    assert.equal(plan.protected.recoveryPins.includes(first.backupId), true);
    assert.equal(plan.keep.includes(first.backupId), true);
    const media = await setup.backup.getProtection({ kind: 'workspace', workspaceId: null });
    assert.equal(media.mediaUnprotected, false);
    assert.ok(media.latestFullBackupId);
  } finally {
    await setup.cleanup();
  }

  const tiny = await setupBackup({
    backupServiceOptions: { statfs: async () => ({ bavail: 1, bsize: 4096 }) }
  });
  try {
    await assert.rejects(
      () => tiny.backup.create({ kind: 'ledger', requestId: 'no-space' }, tiny.harness.humanContext),
      (error) => error.code === 'BACKUP_INVALID' && error.details?.requiredBytes > 0
    );
  } finally {
    await tiny.cleanup();
  }
});

test('P-P1-8 status reports media_unprotected until a verified full point exists', async () => {
  const setup = await setupBackup();
  try {
    await setup.backup.create({ kind: 'ledger', requestId: 'ledger-only' }, setup.harness.humanContext);
    const before = await setup.backup.status();
    assert.equal(before.mediaUnprotected, true);
    assert.equal(before.mediaUnprotectedReason, 'no_verified_full_recovery_point');
    await setup.backup.create({ kind: 'full', requestId: 'full-now' }, setup.harness.humanContext);
    const after = await setup.backup.status();
    assert.equal(after.mediaUnprotected, false);
  } finally {
    await setup.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * P-P1-9 backup index version CAS + cross-process file lock
 * ------------------------------------------------------------------ */

test('P-P1-9 backup index mutations use a version file lock and preserve concurrent updates', async () => {
  const one = await setupBackup();
  let secondService = null;
  try {
    const backup = await one.backup.create({ kind: 'ledger', requestId: 'cas-cut' }, one.harness.humanContext);
    const indexFile = path.join(one.destinationRoot, 'index.json');
    const before = JSON.parse(await fs.readFile(indexFile, 'utf8'));
    assert.ok(Number.isSafeInteger(before.version));
    secondService = new BackupService({
      store: one.harness.store,
      configService: one.harness.configService,
      policyService: one.policyService,
      artifactStore: one.harness.artifactStore,
      journalDir: one.harness.paths.journalDir,
      dataDir: one.harness.dir,
      humanProof: one.harness.humanProof,
      now: one.harness.now
    });
    const [restoreTest, verified] = await Promise.all([
      secondService.noteRestoreTest({
        backupId: backup.backupId,
        recoveryId: 'recovery_cas',
        targetInstanceId: 'target_cas',
        newHistoryEpoch: 'epoch_cas'
      }),
      one.backup.verify(backup.backupId)
    ]);
    assert.equal(restoreTest.recorded, true);
    assert.equal(verified.verified, true);
    const after = JSON.parse(await fs.readFile(indexFile, 'utf8'));
    assert.ok(after.version >= before.version + 2);
    assert.ok(after.backups[backup.backupId].restoreTestedAt);
    await assert.rejects(() => fs.stat(path.join(one.destinationRoot, '.index.lock')), /ENOENT/);
  } finally {
    if (secondService) await secondService.verify;
    await one.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * P-P1-10 ART-006 pending import mode + migration recovery
 * ------------------------------------------------------------------ */

test('P-P1-10 artifact pending imports carry fileMode and are recovered before export', async () => {
  const flow = await setupMigrationSource();
  try {
    await flow.harness.store.transaction(async (draft) => {
      draft.artifactPendingImports.artifact_pending = {
        artifactId: 'artifact_pending',
        sourceRealPath: '/tmp/none',
        tempFile: 'tmp/artifact_pending.part',
        targetFile: 'artifact_pending/x.png',
        expectedSha256: 'b'.repeat(64),
        expectedBytes: 10,
        expectedMode: 'import',
        requestedRole: 'image',
        requestedVisibility: 'workspace',
        principalId: flow.harness.owner.id,
        sourceType: 'external',
        mediaType: 'image/png',
        phase: 'pending',
        createdAt: nowIso(flow.harness.now)
      };
    });
    const prepared = await flow.migration.prepare({ targetInstanceId: 'target_recover' }, flow.harness.humanContext);
    // recoverPendingImports runs first and removes the unresolvable pending entry
    const exported = await flow.migration.export({ migrationId: prepared.migration.id }, flow.harness.humanContext);
    assert.equal(exported.phase, 'sealed');
    const state = await flow.harness.snapshot();
    assert.equal(Object.keys(state.artifactPendingImports).length, 0);
  } finally {
    await flow.harness.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * P-P1-11 production protocol fields, restartSafe and resume linkage
 * ------------------------------------------------------------------ */

test('P-P1-11 stageRequest carries protocol fields and checkpoints carry stage identity', async () => {
  const { harness, backend, production, job } = await setupProduction();
  try {
    const created = await production.create(job, harness.owner);
    await approvalDecide(harness, { approvalId: created.approval.id, nonce: created.nonce });
    const result = await production.run({ taskId: created.task.id, mode: 'go', principal: harness.owner });
    assert.equal(result.task.status, 'succeeded');
    const request = backend.requests.find((entry) => entry.stageId === 'render');
    assert.equal(request.workspaceId, (await harness.snapshot()).workspaceId);
    assert.equal(request.requestId, 'fix-prod-1');
    assert.ok(request.instanceId);
    assert.equal(request.inputArtifactRefs.length, 2);
    assert.equal(request.restartSafe, false);
    assert.equal(request.dispatchContext.permit, 'dispatch-once');
    assert.equal(request.dispatchContext.executionId, request.executionId);
    const render = result.task.stages.find((entry) => entry.stage === 'render');
    assert.equal(render.checkpoint.stageId, 'render');
    assert.equal(render.checkpoint.lastConfirmedSeq, 2);
    assert.equal(result.task.stages.every((entry) => entry.checkpoint.stageId === entry.stage), true);
    const validate = result.task.stages.find((entry) => entry.stage === 'validate');
    assert.match(validate.checkpoint.manifestHash, /^jcs-sha256-v1:[a-f0-9]{64}$/);
  } finally {
    await harness.cleanup();
  }
});

test('P-P1-11 resume records previousExecutionId and rejects duplicate requestId/inputHash reuse', async () => {
  const { harness, backend, production, job } = await setupProduction();
  try {
    backend.status = 'failed';
    const created = await production.create(job, harness.owner);
    await approvalDecide(harness, { approvalId: created.approval.id, nonce: created.nonce });
    const failed = await production.run({ taskId: created.task.id, mode: 'go', principal: harness.owner });
    assert.equal(failed.task.status, 'failed');
    backend.status = 'succeeded';
    const resumed = await production.resume({ taskId: created.task.id, mode: 'go', principal: harness.owner });
    await approvalDecide(harness, { approvalId: resumed.approval.id, nonce: resumed.nonce });
    const result = await production.run({ taskId: created.task.id, mode: 'go', principal: harness.owner });
    assert.equal(result.task.status, 'succeeded');
    const state = await harness.snapshot();
    const renders = Object.values(state.executions)
      .filter((execution) => execution.taskId === created.task.id && execution.stageId === 'render')
      .sort((a, b) => a.attempt - b.attempt);
    assert.equal(renders.length, 2);
    assert.equal(renders[1].previousExecutionId, renders[0].executionId);
    assert.ok(renders[1].requestId);
  } finally {
    await harness.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * P-P1-11 runner 1MiB + P-P2-7 profile declarations
 * ------------------------------------------------------------------ */

test('P-P1-11 runner protocol bounds a single message to 1MiB and P-P2-7 validates profile declarations', async () => {
  const runnerSource = await fs.readFile(new URL('../src/production/runner.mjs', import.meta.url), 'utf8');
  assert.match(runnerSource, /MAX_REQUEST_BYTES = 1024 \* 1024/);
  assert.doesNotMatch(runnerSource, /4 \* 1024 \* 1024/);
  assert.deepEqual([...LOCAL_SLIDESHOW_PROFILE.requiredOutputs].sort(), ['cover', 'video']);
  assert.ok(LOCAL_SLIDESHOW_PROFILE.restartSafe.render === false);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-profile-'));
  try {
    const badFile = path.join(dir, 'bad.json');
    await fs.writeFile(
      badFile,
      JSON.stringify({
        schemaVersion: 1,
        profiles: { 'local-slideshow-v1': { version: 'x', requiredInputs: { script: 0, visual: 1 } } }
      })
    );
    await assert.rejects(
      () => loadLocalSlideshowProfile({ profilesFile: badFile, config: { production: { enabled: true } } }),
      (error) => error.code === 'CONFIG_INVALID'
    );
    const goodFile = path.join(dir, 'good.json');
    await fs.writeFile(
      goodFile,
      JSON.stringify({
        schemaVersion: 1,
        profiles: {
          'local-slideshow-v1': {
            version: 'x',
            providerRefs: { text: { providerId: 'mock-provider' } },
            restartSafe: { render: false }
          }
        }
      })
    );
    const profile = await loadLocalSlideshowProfile({
      profilesFile: goodFile,
      config: { production: { enabled: true, profilesFile: goodFile }, security: { allowLocalProducer: true } }
    });
    assert.equal(profile.providerRefs.text.providerId, 'mock-provider');
    assert.equal(profile.restartSafe.render, false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * P-P2-1 preserveCorruptSource
 * ------------------------------------------------------------------ */

test('P-P2-1 preserveCorruptSource copies surviving source evidence with a hash manifest', async () => {
  const harness = await createHarness({});
  try {
    const recovery = new RecoveryService({
      recoveryDir: harness.paths.recoveryDir,
      humanProof: harness.humanProof,
      now: harness.now
    });
    const preserved = await recovery.preserveCorruptSource(
      { dataDir: harness.dir, note: 'state corrupted before restore' },
      harness.humanContext
    );
    assert.match(path.basename(preserved.snapshotDir), /^corrupt-/);
    assert.ok(preserved.files >= 2);
    const manifest = JSON.parse(await fs.readFile(path.join(preserved.snapshotDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.kind, 'corrupt_source_snapshot');
    assert.equal(manifest.files.some((file) => file.path === 'state.json'), true);
    assert.equal(manifest.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)), true);
  } finally {
    await harness.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * P-P2-2 exposureId / P-P2-3 not_sent tightening
 * ------------------------------------------------------------------ */

test('P-P2-2 unknown exposures are linked to their holds; note-only not_sent repairs fail closed', async () => {
  const setup = await setupBackup();
  const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-exposure-'));
  await fs.rm(targetDir, { recursive: true, force: true });
  let store = null;
  try {
    await bindMockAccount(setup.harness);
    const task = await setup.harness.store.transaction(async (draft, tx) => {
      const created = setup.harness.taskManager.create(tx, {
        kind: 'comment',
        principalId: setup.harness.owner.id,
        accountRef: { platform: 'bilibili', accountId: '1001' },
        inputHash: 'jcs-sha256-v1:' + '3'.repeat(64)
      });
      setup.harness.taskManager.transition(tx, created, 'running', { approved: true });
      return created;
    });
    const reserved = await setup.harness.effectGateway.reserveOperation({
      namespace: 'platform',
      action: 'comment',
      receiptAction: 'comment',
      recoveryAction: 'comment',
      accountRef: { platform: 'bilibili', accountId: '1001' },
      businessKey: 'comment:bilibili:1001:BVexposure:cut',
      taskIds: [task.id],
      inputHash: 'jcs-sha256-v1:' + '4'.repeat(64),
      protected: false
    });
    const backup = await setup.backup.create({ kind: 'full', requestId: 'exposure-cut' }, setup.harness.humanContext);
    const restore = new RecoveryService({
      recoveryDir: path.join(targetDir, 'recovery'),
      humanProof: setup.harness.humanProof,
      now: setup.harness.now
    });
    const restored = await restore.restore(
      { from: path.join(setup.destinationRoot, 'backups', backup.backupId), to: targetDir, requestId: 'exposure-restore' },
      setup.harness.humanContext
    );
    store = new JsonStore({
      file: path.join(targetDir, 'state.json'),
      instanceFile: path.join(targetDir, 'instance.json'),
      now: setup.harness.now
    });
    await store.init({ bootstrap: false });
    const state = await store.getSnapshot();
    const exposure = Object.values(state.recovery.unknownExposures).find((entry) =>
      entry.operationRefs.includes(reserved.operation.id)
    );
    assert.ok(exposure);
    const linkedHold = state.recovery.holds.find((hold) => hold.exposureIds?.includes(exposure.id));
    assert.ok(linkedHold);
    assert.equal(exposure.holdId, linkedHold.id);

    const recovery = new RecoveryService({
      store,
      recoveryDir: path.join(targetDir, 'recovery'),
      humanProof: setup.harness.humanProof,
      now: setup.harness.now
    });
    await assert.rejects(
      () => recovery.reconcile(
        {
          recoveryId: restored.recoveryId,
          evidence: {
            kind: 'fact',
            scope: { kind: 'account_action', workspaceId: state.workspaceId, platform: 'bilibili', accountId: '1001', action: 'comment' },
            operationRefs: [reserved.operation.id],
            businessKeys: ['comment:bilibili:1001:BVexposure:cut'],
            conclusion: 'not_sent',
            note: 'owner clicked confirm',
            repair: { operationId: reserved.operation.id, decision: 'not_sent', note: 'owner clicked confirm' }
          }
        },
        setup.harness.humanContext
      ),
      (error) => error.code === 'RECOVERY_GAP'
    );
  } finally {
    if (store) await store.close();
    await fs.rm(targetDir, { recursive: true, force: true });
    await setup.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * P-P2-4 migration import hardening
 * ------------------------------------------------------------------ */

test('P-P2-4 import enforces package size/capacity, sanitizes old PIDs and activate re-verifies bytes', async () => {
  const sanitized = sanitizeStateForMigration({
    workspaceId: 'ws',
    historyEpoch: 'epoch',
    executions: {
      exec_old: {
        executionId: 'exec_old',
        status: 'running',
        ownerPid: 4242,
        processStartedAt: '2026-01-01T00:00:00.000Z'
      }
    },
    approvals: {},
    bindings: {},
    principals: {}
  });
  assert.equal(sanitized.executions.exec_old.status, 'interrupted');
  assert.equal(sanitized.executions.exec_old.ownerPid, null);
  assert.equal(sanitized.executions.exec_old.sourceOwnerPid, 4242);

  const flow = await setupMigrationSource();
  let targetDir = null;
  try {
    const { exported, released } = await sealAndRelease(flow);
    const target = await exportToTarget(flow, exported);
    targetDir = target.targetDir;
    const migration = target.targetMigration;
    await assert.rejects(
      () => migration.activate(
        { migrationId: exported.migrationId, receipt: released.receipt, dataDir: targetDir },
        flow.harness.humanContext
      ),
      (error) => error.code === 'MIGRATION_BLOCKED' && error.details?.requiresSourceStopped === true
    );
    const importedManifest = JSON.parse(
      await fs.readFile(path.join(targetDir, 'migration-package.json'), 'utf8')
    );
    const state = JSON.parse(await fs.readFile(path.join(targetDir, 'state.json'), 'utf8'));
    const firstArtifact = Object.values(state.artifacts)[0];
    const artifactFile = path.join(targetDir, 'artifacts', firstArtifact.relativePath);
    await fs.chmod(artifactFile, 0o644);
    await fs.writeFile(artifactFile, 'tampered');
    const storedReceipt = JSON.parse(await fs.readFile(path.join(targetDir, 'migration-receipt.json'), 'utf8'));
    await assert.rejects(
      () => migration.activate(
        {
          migrationId: importedManifest.migrationId,
          receipt: storedReceipt,
          dataDir: targetDir,
          sourceStopped: true
        },
        flow.harness.humanContext
      ),
      (error) => error.code === 'MIGRATION_BLOCKED'
    );
    await assert.rejects(
      () => migration._assertTargetCapacity(targetDir, 10 ** 12),
      (error) => error.code === 'MIGRATION_BLOCKED'
    );
    assert.ok(importedManifest.profileDependencies);
  } finally {
    if (targetDir) await fs.rm(targetDir, { recursive: true, force: true });
    await flow.harness.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * P-P1-3 / P-P1-4 authorize fail-closed coverage + preconditions,
 * and P-P2-5 recovery-copy backup parent chain.
 * ------------------------------------------------------------------ */

test('P-P1-3/P-P1-4 authorize is fail-closed until the range and preconditions are covered', async () => {
  const setup = await setupBackup();
  const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-auth-gates-'));
  await fs.rm(targetDir, { recursive: true, force: true });
  let store = null;
  let policyService = null;
  try {
    await bindMockAccount(setup.harness);
    const backup = await setup.backup.create({ kind: 'full', requestId: 'auth-gate-cut' }, setup.harness.humanContext);
    const restore = new RecoveryService({
      recoveryDir: path.join(targetDir, 'recovery'),
      humanProof: setup.harness.humanProof,
      now: setup.harness.now
    });
    const restored = await restore.restore(
      { from: path.join(setup.destinationRoot, 'backups', backup.backupId), to: targetDir, requestId: 'auth-gate-restore' },
      setup.harness.humanContext
    );
    store = new JsonStore({
      file: path.join(targetDir, 'state.json'),
      instanceFile: path.join(targetDir, 'instance.json'),
      now: setup.harness.now
    });
    await store.init({ bootstrap: false });
    const recovery = new RecoveryService({
      store,
      recoveryDir: path.join(targetDir, 'recovery'),
      humanProof: setup.harness.humanProof,
      now: setup.harness.now
    });
    const state = await store.getSnapshot();
    const commentHold = state.recovery.holds.find(
      (hold) => hold.scope.kind === 'account_action' && hold.scope.action === 'comment'
    );
    assert.ok(commentHold);
    // (a) range still open -> fail closed.
    await assert.rejects(
      () => recovery.authorize({ recoveryId: restored.recoveryId, scope: commentHold.scope, evidenceId: 'none' }, setup.harness.humanContext),
      (error) => error.code === 'RECOVERY_FENCING_REQUIRED'
    );
    const startAt = state.recovery.uncertaintyRange.startAt;
    const capturedAt = new Date(Date.parse(startAt) + 60_000).toISOString();
    const isolation = await recovery.reconcile(
      {
        recoveryId: restored.recoveryId,
        evidence: {
          kind: 'isolation',
          source: 'owner:storage-isolation',
          sourceHash: 'sha256:' + 'd'.repeat(64),
          conclusion: 'isolated',
          capturedAt,
          scope: { kind: 'workspace', workspaceId: state.workspaceId }
        }
      },
      setup.harness.humanContext
    );
    // (b) range closed but no repair/verification preconditions -> fail closed.
    await assert.rejects(
      () => recovery.authorize({ recoveryId: restored.recoveryId, scope: commentHold.scope, evidenceId: isolation.evidenceId }, setup.harness.humanContext),
      (error) => error.code === 'RECOVERY_FENCING_REQUIRED'
    );
    // (c) preconditions recorded for the scope -> authorize succeeds.
    await recovery.reconcile(
      {
        recoveryId: restored.recoveryId,
        evidence: {
          kind: 'fact',
          source: 'owner:repair-review',
          sourceHash: 'sha256:' + 'e'.repeat(64),
          conclusion: 'recorded',
          scope: { kind: 'workspace', workspaceId: state.workspaceId },
          coveredRange: { startAt, endAt: capturedAt },
          preconditions: {
            permanentKeysRepaired: true,
            budgetRepaired: true,
            accountsReverified: [{ platform: 'bilibili', accountId: '1001', verifiedAt: capturedAt }],
            recoveryPointBackupId: 'backup_new_verified'
          }
        }
      },
      setup.harness.humanContext
    );
    const authorized = await recovery.authorize(
      { recoveryId: restored.recoveryId, scope: commentHold.scope, evidenceId: isolation.evidenceId },
      setup.harness.humanContext
    );
    assert.equal(authorized.phase, 'restricted');

    // P-P2-5: a recovery-copy backup carries the parent case/point reference.
    const policyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-auth-policy-'));
    const destinationRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-auth-dest-'));
    try {
      policyService = new BackupPolicyService({
        file: path.join(policyDir, 'policy.json'),
        dataDir: targetDir,
        now: setup.harness.now
      });
      await policyService.save({
        ...DEFAULT_BACKUP_POLICY,
        destinationRoot,
        failureDomain: 'test-independent',
        verifiedBy: 'test-owner'
      });
      const managed = new RecoveryManagedBackupService({
        store,
        policyService,
        dataDir: targetDir,
        journalDir: path.join(targetDir, 'journal'),
        humanProof: setup.harness.humanProof,
        now: setup.harness.now
      });
      const copy = await managed.createManagedCopy({ kind: 'ledger', requestId: 'recovery-copy' }, setup.harness.humanContext);
      const manifest = JSON.parse(
        await fs.readFile(path.join(destinationRoot, 'backups', copy.backupId, 'manifest.json'), 'utf8')
      );
      assert.equal(manifest.parentRecovery.caseId, restored.recoveryId);
      assert.ok(manifest.parentRecovery.parentBackupId);
    } finally {
      await fs.rm(policyDir, { recursive: true, force: true });
      await fs.rm(destinationRoot, { recursive: true, force: true });
    }
  } finally {
    if (store) await store.close();
    await fs.rm(targetDir, { recursive: true, force: true });
    await setup.cleanup();
  }
});

test('P-P2-8 backup and restore preserve the captured outbox delivery status', async () => {
  const setup = await setupBackup();
  const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-outbox-capture-'));
  await fs.rm(targetDir, { recursive: true, force: true });
  let store = null;
  try {
    await setup.harness.store.transaction(async (draft, tx) => {
      draft.bindings.binding_x = {
        bindingId: 'binding_x',
        adapterId: 'dsh-im',
        botAccountId: 'bot',
        senderRef: 'sender',
        conversationIds: ['conv_x'],
        principalId: setup.harness.owner.id,
        scopes: [],
        createdAt: nowIso(setup.harness.now),
        revokedAt: null
      };
      setup.harness.effectGateway.appendNotification(tx, {
        notificationId: 'notification_pending',
        taskId: null,
        taskRevision: 1,
        bindingId: 'binding_x',
        conversationId: 'conv_x',
        summary: 'pending delivery at cut',
        deferred: true
      });
    });
    const backup = await setup.backup.create({ kind: 'ledger', requestId: 'outbox-cut' }, setup.harness.humanContext);
    const restore = new RecoveryService({
      recoveryDir: path.join(targetDir, 'recovery'),
      humanProof: setup.harness.humanProof,
      now: setup.harness.now
    });
    await restore.restore(
      { from: path.join(setup.destinationRoot, 'backups', backup.backupId), to: targetDir, requestId: 'outbox-restore' },
      setup.harness.humanContext
    );
    store = new JsonStore({
      file: path.join(targetDir, 'state.json'),
      instanceFile: path.join(targetDir, 'instance.json'),
      now: setup.harness.now
    });
    await store.init({ bootstrap: false });
    const state = await store.getSnapshot();
    const notification = Object.values(state.outbox)[0];
    assert.equal(notification.capturedStatus, 'pending');
    assert.equal(notification.status, 'suppressed');
    assert.equal(notification.suppressionReason, 'recovery_readonly');
  } finally {
    if (store) await store.close();
    await fs.rm(targetDir, { recursive: true, force: true });
    await setup.cleanup();
  }
});
