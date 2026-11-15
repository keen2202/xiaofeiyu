import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setupBackup } from './helpers/backup.js';
import { bindMockAccount } from './helpers/harness.js';
import { makeReceipt } from '../src/contracts.js';
import { RecoveryService } from '../src/backup-recovery.js';
import { JsonStore } from '../src/store.js';
import { ConfigService } from '../src/config.js';
import { TaskManager } from '../src/task-manager.js';
import { IdentityService } from '../src/identity.js';
import { ApprovalService } from '../src/approval.js';
import { RateLimiter } from '../src/rate-limiter.js';
import { EffectGateway } from '../src/effect-gateway.js';
import { nowIso } from '../src/utils.js';

const accountRef = { platform: 'bilibili', accountId: '1001' };

async function makeUnknownOperation(harness) {
  const task = await harness.store.transaction(async (draft, tx) => {
    const created = harness.taskManager.create(tx, {
      kind: 'comment',
      principalId: harness.owner.id,
      accountRef,
      inputHash: 'jcs-sha256-v1:' + 'a'.repeat(64)
    });
    harness.taskManager.transition(tx, created, 'running', { approved: true });
    return created;
  });
  const businessKey = 'comment:bilibili:1001:BVrecover:after-cut';
  const result = await harness.effectGateway.executeOperation(
    {
      namespace: 'platform',
      action: 'comment',
      receiptAction: 'comment',
      recoveryAction: 'comment',
      accountRef,
      businessKey,
      taskIds: [task.id],
      inputHash: 'jcs-sha256-v1:' + 'b'.repeat(64),
      protected: false
    },
    async () => {
      throw new Error('network timeout after dispatch');
    }
  );
  assert.equal(result.operation.status, 'unknown');
  return { task, operation: result.operation, businessKey };
}

async function restoreForTest(setup, backupId, targetDir) {
  const restoreService = new RecoveryService({
    recoveryDir: path.join(targetDir, 'recovery'),
    humanProof: setup.harness.humanProof,
    now: setup.harness.now
  });
  const restored = await restoreService.restore(
    {
      from: path.join(setup.destinationRoot, 'backups', backupId),
      to: targetDir,
      requestId: 'restore-evidence'
    },
    setup.harness.humanContext
  );
  const store = new JsonStore({
    file: path.join(targetDir, 'state.json'),
    instanceFile: path.join(targetDir, 'instance.json'),
    now: setup.harness.now
  });
  await store.init({ bootstrap: false });
  const configService = new ConfigService({
    dataDir: targetDir,
    injected: setup.harness.config,
    env: {},
    now: setup.harness.now
  });
  await configService.load();
  const taskManager = new TaskManager({ store, now: setup.harness.now });
  const identity = new IdentityService({ store, now: setup.harness.now });
  const humanProof = setup.harness.humanProof;
  const approvalService = new ApprovalService({
    store,
    taskManager,
    identity,
    humanProof,
    now: setup.harness.now
  });
  const gateway = new EffectGateway({
    store,
    taskManager,
    approvalService,
    identity,
    humanProof,
    rateLimiter: new RateLimiter({ now: setup.harness.now, getTimeZone: () => 'Asia/Shanghai' }),
    configService,
    protection: { async getProtection() { return { status: 'protected' }; } },
    now: setup.harness.now
  });
  const recovery = new RecoveryService({
    store,
    configService,
    recoveryDir: path.join(targetDir, 'recovery'),
    humanProof,
    effectGateway: gateway,
    taskManager,
    now: setup.harness.now
  });
  return { store, gateway, recovery, restored };
}

// FR-DR-006/008: close the uncertainty range and record the repair/verification
// preconditions that authorize now requires.
async function recordIsolationAndPreconditions({ recovery, store }, setup, scope) {
  const state = await store.getSnapshot();
  const inspected = await recovery.inspect(state.recovery.id);
  const startAt = inspected.uncertaintyRange?.startAt || new Date().toISOString();
  const capturedAt = new Date(Date.parse(startAt) + 60_000).toISOString();
  const isolation = await recovery.reconcile(
    {
      recoveryId: state.recovery.id,
      evidence: {
        kind: 'isolation',
        source: 'owner:storage-isolation',
        sourceHash: 'sha256:' + 'f'.repeat(64),
        conclusion: 'isolated',
        capturedAt,
        scope
      }
    },
    setup.harness.humanContext
  );
  const preconditions = await recovery.reconcile(
    {
      recoveryId: state.recovery.id,
      evidence: {
        kind: 'fact',
        source: 'owner:repair-review',
        sourceHash: 'sha256:' + '9'.repeat(64),
        conclusion: 'recorded',
        scope,
        coveredRange: { startAt, endAt: capturedAt },
        preconditions: {
          permanentKeysRepaired: true,
          budgetRepaired: true,
          accountsReverified: [
            {
              platform: scope.platform || accountRef.platform,
              accountId: scope.accountId || accountRef.accountId,
              verifiedAt: capturedAt
            }
          ],
          recoveryPointBackupId: 'backup_new_verified'
        }
      }
    },
    setup.harness.humanContext
  );
  return { isolation, preconditions, startAt, capturedAt };
}

test('recovery evidence repairs an original unknown operation without inventing a second effect', async () => {
  const setup = await setupBackup();
  const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-evidence-'));
  await fs.rm(targetDir, { recursive: true, force: true });
  try {
    await bindMockAccount(setup.harness);
    const { task, operation, businessKey } = await makeUnknownOperation(setup.harness);
    const backup = await setup.backup.create({ kind: 'full', requestId: 'evidence-cut' }, setup.harness.humanContext);
    const { store, recovery } = await restoreForTest(setup, backup.backupId, targetDir);
    try {
      const before = await store.getSnapshot();
      assert.equal(before.operations[operation.id].status, 'unknown');
      assert.equal(['interrupted', 'unknown'].includes(before.tasks[task.id].status), true);
      const exposure = Object.values(before.recovery.unknownExposures).find((entry) =>
        entry.operationRefs.includes(operation.id)
      );
      assert.ok(exposure);

      const receipt = makeReceipt({
        platform: 'bilibili',
        accountId: '1001',
        action: 'comment',
        externalId: 'rpid-recovered',
        url: 'https://www.bilibili.com/video/BVrecover#reply',
        verification: 'platform_readback',
        receivedAt: nowIso(setup.harness.now)
      });
      const scope = { kind: 'account_action', workspaceId: before.workspaceId, ...accountRef, action: 'comment' };
      const result = await recovery.reconcile(
        {
          recoveryId: before.recovery.id,
          evidence: {
            kind: 'fact',
            scope,
            operationRefs: [operation.id],
            businessKeys: [businessKey],
            conclusion: 'confirmed',
            note: 'owner read back the comment',
            repair: { operationId: operation.id, decision: 'confirmed', receipt }
          }
        },
        setup.harness.humanContext
      );
      assert.equal(result.repair.status, 'repaired');
      assert.equal(result.repair.operationStatus, 'confirmed');
      const after = await store.getSnapshot();
      assert.equal(after.operations[operation.id].status, 'confirmed');
      assert.equal(after.operations[operation.id].resolution.recoveredFromEvidence, true);
      assert.equal(after.businessKeys[businessKey].status, 'confirmed');
      assert.equal(after.recovery.unknownExposures[exposure.id].status, 'confirmed');
      assert.equal(after.tasks[task.id].pendingOperationIds.length, 0);
      const inspected = await recovery.inspect(before.recovery.id);
      assert.equal(inspected.unknownExposures.find((entry) => entry.id === exposure.id).status, 'confirmed');

      const { isolation } = await recordIsolationAndPreconditions(
        { recovery, store },
        setup,
        { kind: 'workspace', workspaceId: before.workspaceId }
      );
      await recovery.authorize(
        { recoveryId: before.recovery.id, scope, evidenceId: isolation.evidenceId },
        setup.harness.humanContext
      );
      const authorized = await store.getSnapshot();
      assert.equal(authorized.tasks[task.id].holds.every((hold) => hold.status === 'released'), true);
      assert.equal(authorized.recovery.holds.some((hold) =>
        hold.scope.kind === 'account_action' && hold.scope.action === 'comment' && hold.status !== 'released'
      ), false);
      const dmHold = authorized.recovery.holds.find((hold) =>
        hold.scope.kind === 'account_action' && hold.scope.action === 'dm' && hold.status === 'active'
      );
      assert.ok(dmHold);
      const second = await recovery.authorize(
        { recoveryId: before.recovery.id, scope: dmHold.scope, evidenceId: isolation.evidenceId },
        setup.harness.humanContext
      );
      assert.equal(second.deduplicated, false);
      const afterSecond = await store.getSnapshot();
      assert.equal(afterSecond.recovery.holds.some((hold) =>
        hold.scope.kind === 'account_action' && hold.scope.action === 'dm' && hold.status !== 'released'
      ), false);
    } finally {
      await store.close();
    }
  } finally {
    await fs.rm(targetDir, { recursive: true, force: true });
    await setup.cleanup();
  }
});

async function prepareAuthorizationCrash(hookName) {
  const setup = await setupBackup();
  const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-auth-crash-'));
  await fs.rm(targetDir, { recursive: true, force: true });
  await bindMockAccount(setup.harness);
  const backup = await setup.backup.create({ kind: 'full', requestId: `auth-${hookName}` }, setup.harness.humanContext);
  const context = await restoreForTest(setup, backup.backupId, targetDir);
  const state = await context.store.getSnapshot();
  const commentHold = state.recovery.holds.find(
    (hold) => hold.scope.kind === 'account_action' && hold.scope.action === 'comment'
  );
  const { isolation } = await recordIsolationAndPreconditions(context, setup, commentHold.scope);
  const { RecoveryService: Service } = await import('../src/backup-recovery.js');
  const crashing = new Service({
    store: context.store,
    configService: context.recovery.configService,
    recoveryDir: path.join(targetDir, 'recovery'),
    humanProof: setup.harness.humanProof,
    effectGateway: context.gateway,
    taskManager: context.recovery.taskManager,
    now: setup.harness.now,
    hooks: {
      [hookName]() {
        throw new Error('simulated power cut');
      }
    }
  });
  await assert.rejects(
    () => crashing.authorize(
      { recoveryId: state.recovery.id, scope: commentHold.scope, evidenceId: isolation.evidenceId },
      setup.harness.humanContext
    ),
    /simulated power cut/
  );
  return { setup, targetDir, context, commentHold, isolation };
}

test('authorize resumes after a crash between ledger projection and committed case', async () => {
  const crash = await prepareAuthorizationCrash('afterStateProjection');
  try {
    const stateAfterCrash = await crash.context.store.getSnapshot();
    assert.equal(stateAfterCrash.recovery.revision, 4);
    const committed = await crash.context.recovery.authorize(
      {
        recoveryId: stateAfterCrash.recovery.id,
        scope: crash.commentHold.scope,
        evidenceId: crash.isolation.evidenceId
      },
      crash.setup.harness.humanContext
    );
    assert.equal(committed.deduplicated, true);
    assert.equal(committed.revision, 4);
    const instance = await crash.context.store.getInstance();
    assert.equal(instance.status, 'active');
    assert.equal(instance.recoveryRevision, 4);
    const inspected = await crash.context.recovery.inspect(stateAfterCrash.recovery.id);
    assert.equal(inspected.projectionConsistent, true);
    assert.equal(inspected.decisions.length, 1);
    const after = await crash.context.store.getSnapshot();
    assert.equal(after.recovery.holds.some((hold) =>
      hold.scope.kind === 'account_action' && hold.scope.action === 'comment' && hold.status !== 'released'
    ), false);
    assert.equal(instance.allowedCapabilities.includes('platform:bilibili'), true);
  } finally {
    await crash.context.store.close();
    await fs.rm(crash.targetDir, { recursive: true, force: true });
    await crash.setup.cleanup();
  }
});

test('authorize resumes after a crash between committed case and instance capabilities', async () => {
  const crash = await prepareAuthorizationCrash('beforeInstanceUpdate');
  try {
    const committed = await crash.context.recovery.authorize(
      {
        recoveryId: (await crash.context.store.getSnapshot()).recovery.id,
        scope: crash.commentHold.scope,
        evidenceId: crash.isolation.evidenceId
      },
      crash.setup.harness.humanContext
    );
    assert.equal(committed.deduplicated, true);
    const instance = await crash.context.store.getInstance();
    assert.equal(instance.status, 'active');
    assert.equal(instance.recoveryRevision, committed.revision);
    const inspected = await crash.context.recovery.inspect((await crash.context.store.getSnapshot()).recovery.id);
    assert.equal(inspected.projectionConsistent, true);
  } finally {
    await crash.context.store.close();
    await fs.rm(crash.targetDir, { recursive: true, force: true });
    await crash.setup.cleanup();
  }
});

test('a reserved operation at the cut is ambiguous, cannot dispatch, and can be proven not sent', async () => {
  const setup = await setupBackup();
  const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-reserved-'));
  await fs.rm(targetDir, { recursive: true, force: true });
  try {
    await bindMockAccount(setup.harness);
    const task = await setup.harness.store.transaction(async (draft, tx) => {
      const created = setup.harness.taskManager.create(tx, {
        kind: 'comment',
        principalId: setup.harness.owner.id,
        accountRef,
        inputHash: 'jcs-sha256-v1:' + '1'.repeat(64)
      });
      setup.harness.taskManager.transition(tx, created, 'running', { approved: true });
      return created;
    });
    const businessKey = 'comment:bilibili:1001:BVreserved:cut';
    const reserved = await setup.harness.effectGateway.reserveOperation({
      namespace: 'platform',
      action: 'comment',
      receiptAction: 'comment',
      recoveryAction: 'comment',
      accountRef,
      businessKey,
      taskIds: [task.id],
      inputHash: 'jcs-sha256-v1:' + '2'.repeat(64),
      protected: false
    });
    assert.equal(reserved.operation.status, 'reserved');
    const backup = await setup.backup.create({ kind: 'full', requestId: 'reserved-cut' }, setup.harness.humanContext);
    const context = await restoreForTest(setup, backup.backupId, targetDir);
    try {
      const state = await context.store.getSnapshot();
      assert.equal(state.operations[reserved.operation.id].recoveryAmbiguous, true);
      assert.equal(state.operations[reserved.operation.id].recoveryCutStatus, 'reserved');
      const exposure = Object.values(state.recovery.unknownExposures).find((entry) =>
        entry.operationRefs.includes(reserved.operation.id)
      );
      assert.equal(exposure.source, 'operation_reserved_at_cut');
      await assert.rejects(
        () => context.gateway.dispatchOperation(reserved.operation.id, async () => {
          throw new Error('must not dispatch');
        }),
        (error) => error.code === 'RECOVERY_GAP'
      );
      const repaired = await context.recovery.reconcile(
        {
          recoveryId: state.recovery.id,
          evidence: {
            kind: 'fact',
            scope: { kind: 'account_action', workspaceId: state.workspaceId, ...accountRef, action: 'comment' },
            operationRefs: [reserved.operation.id],
            businessKeys: [businessKey],
            source: 'owner:platform-log-review',
            sourceHash: 'sha256:' + '7'.repeat(64),
            coveredRange: {
              startAt: state.recovery.uncertaintyRange.startAt,
              endAt: new Date(Date.parse(state.recovery.uncertaintyRange.startAt) + 60_000).toISOString()
            },
            conclusion: 'not_sent',
            note: 'platform log shows no comment',
            repair: { operationId: reserved.operation.id, decision: 'not_sent', note: 'platform log shows no comment' }
          }
        },
        setup.harness.humanContext
      );
      assert.equal(repaired.repair.operationStatus, 'not_sent');
      const after = await context.store.getSnapshot();
      assert.equal(after.operations[reserved.operation.id].recoveryAmbiguous, false);
      assert.equal(after.recovery.unknownExposures[exposure.id].status, 'not_sent');
    } finally {
      await context.store.close();
    }
  } finally {
    await fs.rm(targetDir, { recursive: true, force: true });
    await setup.cleanup();
  }
});

test('refreeze invalidates a prepared authorization instead of letting it commit falsely', async () => {
  const crash = await prepareAuthorizationCrash('afterPrepared');
  try {
    const before = await crash.context.store.getSnapshot();
    const refrozen = await crash.context.recovery.refreeze(
      {
        recoveryId: before.recovery.id,
        scope: crash.commentHold.scope,
        reason: 'new conflicting evidence'
      },
      crash.setup.harness.humanContext
    );
    assert.equal(refrozen.phase, 'restricted');
    const caseAfterRefreeze = await crash.context.recovery._readCase();
    assert.equal(caseAfterRefreeze.pendingDecision, null);
    const authorized = await crash.context.recovery.authorize(
      {
        recoveryId: before.recovery.id,
        scope: crash.commentHold.scope,
        evidenceId: crash.isolation.evidenceId
      },
      crash.setup.harness.humanContext
    );
    assert.equal(authorized.deduplicated, false);
    const state = await crash.context.store.getSnapshot();
    assert.equal(state.recovery.holds.some((hold) =>
      hold.scope.kind === 'account_action' && hold.scope.action === 'comment' && hold.status !== 'released'
    ), false);
  } finally {
    await crash.context.store.close();
    await fs.rm(crash.targetDir, { recursive: true, force: true });
    await crash.setup.cleanup();
  }
});

test('a late receipt from the pre-recovery epoch is refused without replaying the task', async () => {
  const setup = await setupBackup();
  const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-late-receipt-'));
  await fs.rm(targetDir, { recursive: true, force: true });
  try {
    await bindMockAccount(setup.harness);
    const unknown = await makeUnknownOperation(setup.harness);
    await setup.harness.journal.flush();
    const sourceBefore = await setup.harness.snapshot();
    const oldEpoch = sourceBefore.historyEpoch;
    const oldEventsBefore = await setup.harness.journal.readEvents({
      epoch: oldEpoch,
      upToSeq: sourceBefore.eventSeq
    });
    const backup = await setup.backup.create({ kind: 'full', requestId: 'late-receipt-cut' }, setup.harness.humanContext);
    const context = await restoreForTest(setup, backup.backupId, targetDir);
    try {
      const before = await context.store.getSnapshot();
      assert.notEqual(before.historyEpoch, oldEpoch);
      assert.equal(before.recovery.phase, 'readonly');
      assert.equal(before.operations[unknown.operation.id].status, 'unknown');
      const taskCount = Object.keys(before.tasks).length;
      const outboxCount = Object.keys(before.outbox || {}).length;
      const inspected = await context.recovery.inspect(before.recovery.id);
      assert.equal(inspected.dispatchAllowed, false);
      const receipt = makeReceipt({
        platform: 'bilibili',
        accountId: '1001',
        action: 'comment',
        externalId: 'late-receipt-1',
        url: 'https://www.bilibili.com/x',
        verification: 'platform_readback',
        receivedAt: new Date().toISOString()
      });
      // The late receipt arrives for an operation created in the previous epoch.
      // The restored epoch keeps an active hold, so the receipt cannot be
      // applied as a fresh result; it must go through evidence review first.
      await assert.rejects(
        () => context.gateway.resolve(
          {
            operationId: unknown.operation.id,
            decision: 'confirmed',
            receipt,
            note: 'late receipt from the previous epoch'
          },
          setup.harness.humanContext
        ),
        (error) => error.code === 'RECOVERY_GAP'
      );
      const after = await context.store.getSnapshot();
      assert.equal(after.operations[unknown.operation.id].status, 'unknown');
      assert.equal(after.operations[unknown.operation.id].resolvedAt, undefined);
      // Nothing is replayed as a new task, operation or outbound notification.
      assert.equal(Object.keys(after.tasks).length, taskCount);
      assert.equal(Object.keys(after.outbox || {}).length, outboxCount);
      assert.deepEqual(
        Object.values(after.operations).filter((op) => op.id !== unknown.operation.id),
        []
      );
      assert.equal(after.recovery.phase, 'readonly');
      assert.equal((await context.store.getInstance()).status, 'recovery-readonly');
      // Old epoch archives and cursor stay untouched; the rejected receipt did
      // not advance the new epoch's event sequence either.
      const oldEventsAfter = await setup.harness.journal.readEvents({
        epoch: oldEpoch,
        upToSeq: sourceBefore.eventSeq
      });
      assert.equal(oldEventsAfter.length, oldEventsBefore.length);
      assert.equal((await setup.harness.snapshot()).historyEpoch, oldEpoch);
      assert.equal(after.eventSeq, before.eventSeq);
    } finally {
      await context.store.close();
    }
  } finally {
    await fs.rm(targetDir, { recursive: true, force: true });
    await setup.harness.cleanup();
  }
});
