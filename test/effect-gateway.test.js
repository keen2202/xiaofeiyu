import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, bindMockAccount } from './helpers/harness.js';
import { makeRecoveryHold, normalizeScope } from '../src/contracts.js';
import { nowIso } from '../src/utils.js';

const accountRef = { platform: 'bilibili', accountId: '1001' };

async function makeTask(harness, kind = 'comment') {
  return harness.store.transaction(async (draft, tx) => {
    const task = harness.taskManager.create(tx, {
      kind,
      principalId: harness.owner.id,
      accountRef,
      inputHash: 'jcs-sha256-v1:' + '2'.repeat(64)
    });
    harness.taskManager.transition(tx, task, 'running', { approved: true });
    return task;
  });
}

function receipt(action = 'comment') {
  return {
    platform: 'bilibili',
    accountId: '1001',
    action,
    externalId: 'external-1',
    url: 'https://example.test/1',
    verification: 'platform_readback',
    receivedAt: nowIso()
  };
}

function reservation(harness, task, overrides = {}) {
  return {
    namespace: 'platform',
    action: 'comment',
    receiptAction: 'comment',
    recoveryAction: 'comment',
    accountRef,
    businessKey: `comment:${Math.random()}`,
    taskIds: [task.id],
    inputHash: task.inputHash,
    quota: { key: 'bilibili:1001', action: 'comment', actionQuota: { perDay: 3, perHour: 3 } },
    protected: true,
    ...overrides
  };
}

test('successful dispatch writes confirmation, receipt and business key', async () => {
  const harness = await createHarness();
  try {
    const task = await makeTask(harness);
    const result = await harness.effectGateway.executeOperation(
      reservation(harness, task),
      async (context) => {
        assert.equal(context.permit, 'dispatch-once');
        return receipt();
      },
      {
        applyResult: (tx) => {
          harness.taskManager.transition(tx, tx.state.tasks[task.id], 'succeeded', { result: { ok: true } });
        }
      }
    );
    assert.equal(result.operation.status, 'confirmed');
    const state = await harness.snapshot();
    const record = state.businessKeys[result.operation.businessKey];
    assert.equal(record.status, 'confirmed');
    assert.equal(state.tasks[task.id].status, 'succeeded');
    assert.equal(state.tasks[task.id].isSettled, true);
  } finally {
    await harness.cleanup();
  }
});

test('thrown adapter errors become unknown, freeze the key and are not retried', async () => {
  const harness = await createHarness();
  try {
    const task = await makeTask(harness);
    const request = reservation(harness, task);
    const result = await harness.effectGateway.executeOperation(request, async () => {
      throw new Error('socket hang up');
    });
    assert.equal(result.operation.status, 'unknown');
    const state = await harness.snapshot();
    assert.equal(state.businessKeys[request.businessKey].status, 'unknown');
    assert.equal(state.tasks[task.id].status, 'unknown');
    assert.equal(state.tasks[task.id].isSettled, false);
    await assert.rejects(
      () => harness.effectGateway.executeOperation(request, async () => receipt()),
      (error) => ['DUPLICATE_OPERATION', 'OPERATION_UNKNOWN'].includes(error.code)
    );
    assert.equal(state.operations[result.operation.id].attempts, 1);
  } finally {
    await harness.cleanup();
  }
});

test('proven pre-dispatch failure settles as failed', async () => {
  const harness = await createHarness();
  try {
    const task = await makeTask(harness);
    const result = await harness.effectGateway.executeOperation(reservation(harness, task), async () => {
      throw Object.assign(new Error('spawn ENOENT'), { notSent: true, code: 'DEPENDENCY_UNAVAILABLE' });
    });
    assert.equal(result.operation.status, 'failed');
    assert.equal((await harness.snapshot()).businessKeys[result.operation.businessKey].status, 'failed');
  } finally {
    await harness.cleanup();
  }
});

test('human resolve updates the original operation and permits no duplicate success', async () => {
  const harness = await createHarness();
  try {
    const task = await makeTask(harness);
    const request = reservation(harness, task);
    const unknown = await harness.effectGateway.executeOperation(request, async () => {
      throw new Error('timeout');
    });
    const resolved = await harness.effectGateway.resolve(
      { operationId: unknown.operation.id, decision: 'confirmed', receipt: receipt(), note: 'platform readback' },
      harness.humanContext
    );
    assert.equal(resolved.operation.status, 'confirmed');
    const state = await harness.snapshot();
    assert.equal(state.businessKeys[request.businessKey].status, 'confirmed');
    assert.equal(state.tasks[task.id].status, 'succeeded');
    const again = await harness.effectGateway.resolve(
      { operationId: unknown.operation.id, decision: 'confirmed', receipt: receipt(), note: '' },
      harness.humanContext
    );
    assert.equal(again.deduplicated, true);
    await assert.rejects(
      () =>
        harness.effectGateway.resolve(
          { operationId: unknown.operation.id, decision: 'not_sent', note: 'changed' },
          harness.humanContext
        ),
      (error) => error.code === 'OPERATION_UNKNOWN'
    );
  } finally {
    await harness.cleanup();
  }
});

test('unprotected, degraded and recovery-held scopes block new dispatch', async () => {
  const unprotected = await createHarness({ protection: 'unprotected' });
  try {
    const task = await makeTask(unprotected);
    await assert.rejects(
      () => unprotected.effectGateway.reserveOperation(reservation(unprotected, task)),
      (error) => error.code === 'BACKUP_UNPROTECTED'
    );
  } finally {
    await unprotected.cleanup();
  }
  const degraded = await createHarness({ protection: 'degraded' });
  try {
    const task = await makeTask(degraded);
    await assert.rejects(
      () => degraded.effectGateway.reserveOperation(reservation(degraded, task)),
      (error) => error.code === 'BACKUP_STALE'
    );
  } finally {
    await degraded.cleanup();
  }
  const held = await createHarness();
  try {
    const scope = normalizeScope({
      kind: 'account_action',
      workspaceId: (await held.snapshot()).workspaceId,
      platform: 'bilibili',
      accountId: '1001',
      action: 'comment'
    });
    await held.store.transaction(async (draft) => {
      draft.recovery.holds.push(
        makeRecoveryHold({
          id: 'hold1',
          caseId: 'case1',
          scope,
          revision: 1,
          createdAt: nowIso()
        })
      );
    });
    const task = await makeTask(held);
    await assert.rejects(
      () => held.effectGateway.reserveOperation(reservation(held, task)),
      (error) => error.code === 'RECOVERY_GAP'
    );
  } finally {
    await held.cleanup();
  }
});

test('migration phase, checkpoint fence and stale config revision block reservation', async () => {
  const harness = await createHarness();
  try {
    const task = await makeTask(harness);
    const request = reservation(harness, task);
    await harness.store.transaction(async (draft) => {
      draft.migration = { phase: 'quiescing', id: 'm1' };
    });
    await assert.rejects(
      () => harness.effectGateway.reserveOperation(request),
      (error) => error.code === 'MIGRATION_BLOCKED'
    );
    await harness.store.transaction(async (draft) => {
      draft.migration = { phase: 'active', id: null };
      draft.checkpointFence = {
        id: 'f1',
        kind: 'backup',
        ownerPid: process.pid,
        processStartedAt: nowIso(),
        startedAt: nowIso(),
        expiresAt: new Date(Date.now() + 60000).toISOString()
      };
    });
    await assert.rejects(
      () => harness.effectGateway.reserveOperation(request),
      (error) => error.code === 'BACKUP_UNPROTECTED'
    );
    await harness.store.transaction(async (draft) => {
      draft.checkpointFence = null;
    });
    harness.configService.config.dryRun = false;
    await assert.rejects(
      () => harness.effectGateway.reserveOperation(request),
      (error) => error.code === 'CONFIG_INVALID'
    );
  } finally {
    await harness.cleanup();
  }
});

test('business keys stay unique until a human-authorized retry', async () => {
  const harness = await createHarness();
  try {
    const task = await makeTask(harness);
    const request = reservation(harness, task);
    await harness.effectGateway.executeOperation(request, async () => {
      throw Object.assign(new Error('no'), { notSent: true });
    });
    await assert.rejects(
      () => harness.effectGateway.reserveOperation(request),
      (error) => error.code === 'DUPLICATE_OPERATION'
    );
    harness.now.advance(121000);
    const retried = await harness.effectGateway.reserveOperation({
      ...request,
      allowRetry: true,
      humanAuthorized: true
    });
    assert.equal(retried.operation.status, 'reserved');
  } finally {
    await harness.cleanup();
  }
});

test('paid budgets are reserved, confirmed and frozen on unknown', async () => {
  const harness = await createHarness({
    allowedCapabilities: ['core:read', 'core:write', 'platform:bilibili', 'production:paid', 'production:local']
  });
  try {
    const task = await makeTask(harness, 'production');
    const base = {
      namespace: 'provider',
      action: 'provider_call',
      recoveryAction: 'provider_call',
      accountRef: null,
      businessKey: `provider:${Math.random()}`,
      taskIds: [task.id],
      inputHash: task.inputHash,
      protected: true,
      budget: { provider: 'mock', budgetId: 'b1', currency: 'CNY', amountMinor: 100, capMinor: 150 }
    };
    const first = await harness.effectGateway.executeOperation(base, async () => ({
      status: 'confirmed',
      receipt: {
        platform: 'provider',
        accountId: 'mock',
        action: 'provider_call',
        externalId: 'call-1',
        verification: 'publisher_receipt',
        receivedAt: nowIso()
      }
    }));
    assert.equal(first.operation.status, 'confirmed');
    let state = await harness.snapshot();
    const budget = Object.values(state.budgets)[0];
    assert.equal(budget.spentMinor, 100);
    await assert.rejects(
      () =>
        harness.effectGateway.reserveOperation({
          ...base,
          businessKey: `provider:${Math.random()}`,
          budget: { ...base.budget, amountMinor: 100 }
        }),
      (error) => error.code === 'BUDGET_EXCEEDED'
    );
    const unknown = await harness.effectGateway.executeOperation(
      {
        ...base,
        businessKey: `provider:${Math.random()}`,
        budget: { ...base.budget, amountMinor: 0, capMinor: 150 }
      },
      async () => {
        throw new Error('provider timeout');
      }
    );
    assert.equal(unknown.operation.status, 'unknown');
    state = await harness.snapshot();
    assert.equal(Object.values(state.budgets)[0].unknownMinor, 0);
  } finally {
    await harness.cleanup();
  }
});

test('approvals are consumed once at the dispatch boundary', async () => {
  const harness = await createHarness();
  try {
    const { task, challenge } = await harness.store.transaction(async (draft, tx) => {
      const current = harness.taskManager.create(tx, {
        kind: 'comment',
        principalId: harness.owner.id,
        accountRef,
        inputHash: 'jcs-sha256-v1:' + '3'.repeat(64)
      });
      harness.taskManager.transition(tx, current, 'waiting_approval');
      return {
        task: current,
        challenge: harness.approvalService.create(tx, {
          task: current,
          action: 'comment.send',
          inputHash: current.inputHash,
          principalId: harness.owner.id
        })
      };
    });
    await harness.approvalService.decide(
      { approvalId: challenge.approval.id, decision: 'approve', nonce: challenge.nonce, mode: 'go' },
      harness.humanContext
    );
    const request = reservation(harness, task, {
      approvalId: challenge.approval.id,
      approvalAction: 'comment.send'
    });
    const result = await harness.effectGateway.executeOperation(request, async () => receipt());
    assert.equal(result.operation.status, 'confirmed');
    const state = await harness.snapshot();
    assert.equal(state.approvals[challenge.approval.id].usedByOperationId, result.operation.id);
  } finally {
    await harness.cleanup();
  }
});

test('free local reservation needs no backup point but still checks migration holds', async () => {
  const harness = await createHarness({ protection: 'unprotected' });
  try {
    const task = await makeTask(harness, 'production');
    const reserved = await harness.effectGateway.reserveOperation({
      namespace: 'local',
      action: 'local_stage',
      accountRef: null,
      businessKey: 'local:free:1',
      taskIds: [task.id],
      inputHash: task.inputHash,
      protected: false
    });
    assert.equal(reserved.operation.status, 'reserved');
    await harness.store.transaction(async (draft) => {
      draft.migration = { phase: 'quiescing', id: 'm1' };
    });
    await assert.rejects(
      () => harness.effectGateway.reserveOperation({
        namespace: 'local',
        action: 'local_stage',
        accountRef: null,
        businessKey: 'local:free:2',
        taskIds: [task.id],
        inputHash: task.inputHash,
        protected: false
      }),
      (error) => error.code === 'MIGRATION_BLOCKED'
    );
  } finally {
    await harness.cleanup();
  }
});

test('restart recovery cancels never-dispatched reserved and freezes dispatching as unknown', async () => {
  const harness = await createHarness();
  try {
    const task = await makeTask(harness);
    const reserved = await harness.effectGateway.reserveOperation({
      namespace: 'platform',
      action: 'comment',
      receiptAction: 'comment',
      accountRef,
      businessKey: 'restart:reserved',
      taskIds: [task.id],
      inputHash: task.inputHash,
      protected: true
    });
    await harness.store.transaction(async (draft) => {
      draft.operations[reserved.operation.id].ownerPid = 999999;
      draft.operations[reserved.operation.id].processStartedAt = new Date(0).toISOString();
    });
    const second = await harness.effectGateway.reserveOperation({
      namespace: 'platform',
      action: 'comment',
      receiptAction: 'comment',
      accountRef,
      businessKey: 'restart:dispatching',
      taskIds: [task.id],
      inputHash: task.inputHash,
      protected: true
    });
    await harness.store.transaction(async (draft) => {
      const op = draft.operations[second.operation.id];
      op.status = 'dispatching';
      op.dispatchAt = new Date().toISOString();
      op.ownerPid = 999999;
      op.processStartedAt = new Date(0).toISOString();
    });
    const recovered = await harness.effectGateway.recoverOrphanedOperations();
    assert.equal(recovered.recovered.length, 2);
    const state = await harness.snapshot();
    assert.equal(state.operations[reserved.operation.id].status, 'cancelled');
    assert.equal(state.operations[second.operation.id].status, 'unknown');
    assert.equal(state.businessKeys['restart:reserved'].status, 'cancelled');
    assert.equal(state.businessKeys['restart:dispatching'].status, 'unknown');
    assert.equal(state.tasks[task.id].status, 'unknown');
    assert.equal(state.tasks[task.id].isSettled, false);
  } finally {
    await harness.cleanup();
  }
});

test('restart recovery does not steal an operation from the live current process', async () => {
  const harness = await createHarness();
  try {
    const task = await makeTask(harness);
    const reserved = await harness.effectGateway.reserveOperation({
      namespace: 'platform',
      action: 'comment',
      receiptAction: 'comment',
      accountRef,
      businessKey: 'restart:live-owner',
      taskIds: [task.id],
      inputHash: task.inputHash,
      protected: true
    });
    const recovered = await harness.effectGateway.recoverOrphanedOperations();
    assert.equal(recovered.recovered.length, 0);
    assert.equal((await harness.snapshot()).operations[reserved.operation.id].status, 'reserved');
  } finally {
    await harness.cleanup();
  }
});
