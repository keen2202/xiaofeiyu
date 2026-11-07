import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './helpers/harness.js';
import { nowIso } from '../src/utils.js';

const accountRef = { platform: 'bilibili', accountId: '1001' };

function receipt() {
  return {
    platform: 'bilibili',
    accountId: '1001',
    action: 'comment',
    externalId: 'rpid-1',
    url: 'https://example.test/1',
    verification: 'platform_readback',
    receivedAt: nowIso()
  };
}

async function makeTask(harness) {
  return harness.store.transaction(async (draft, tx) => {
    const task = harness.taskManager.create(tx, {
      kind: 'comment',
      principalId: harness.owner.id,
      accountRef,
      inputHash: 'jcs-sha256-v1:' + 'c'.repeat(64)
    });
    harness.taskManager.transition(tx, task, 'running', { approved: true });
    return task;
  });
}

test('protection status is rechecked at dispatch and in-flight receipts still settle', async () => {
  let status = 'protected';
  const harness = await createHarness({
    protection: async () => (status === 'protected' ? { status: 'protected', backupId: 'b', cutAt: nowIso() } : { status, reason: 'test' })
  });
  try {
    const task = await makeTask(harness);
    const result = await harness.effectGateway.executeOperation(
      {
        namespace: 'platform',
        action: 'comment',
        receiptAction: 'comment',
        recoveryAction: 'comment',
        accountRef,
        businessKey: 'after-dispatch-protection-change',
        taskIds: [task.id],
        inputHash: task.inputHash,
        protected: true
      },
      async () => {
        status = 'unprotected';
        return receipt();
      }
    );
    assert.equal(result.operation.status, 'confirmed');
    await assert.rejects(
      () => harness.effectGateway.reserveOperation({
        namespace: 'platform',
        action: 'comment',
        receiptAction: 'comment',
        recoveryAction: 'comment',
        accountRef,
        businessKey: 'new-while-unprotected',
        taskIds: [task.id],
        inputHash: task.inputHash,
        protected: true
      }),
      (error) => error.code === 'BACKUP_UNPROTECTED'
    );
    status = 'degraded';
    await assert.rejects(
      () => harness.effectGateway.reserveOperation({
        namespace: 'platform',
        action: 'comment',
        receiptAction: 'comment',
        recoveryAction: 'comment',
        accountRef,
        businessKey: 'new-while-stale',
        taskIds: [task.id],
        inputHash: task.inputHash,
        protected: true
      }),
      (error) => error.code === 'BACKUP_STALE'
    );
  } finally {
    await harness.cleanup();
  }
});

test('local free work needs no backup point but still obeys migration/recovery fences', async () => {
  const harness = await createHarness({ protection: 'unprotected' });
  try {
    await assert.doesNotReject(() => harness.effectGateway.assertLocalDispatch({ capability: 'production:local' }));
    await harness.store.transaction(async (draft) => {
      draft.migration = { phase: 'quiescing', id: 'm1' };
    });
    await assert.rejects(
      () => harness.effectGateway.assertLocalDispatch({ capability: 'production:local' }),
      (error) => error.code === 'MIGRATION_BLOCKED'
    );
    await harness.store.transaction(async (draft) => {
      draft.migration = { phase: 'active', id: null };
      draft.recovery.phase = 'readonly';
    });
    await assert.rejects(
      () => harness.effectGateway.assertLocalDispatch({ capability: 'production:local' }),
      (error) => error.code === 'RECOVERY_GAP'
    );
  } finally {
    await harness.cleanup();
  }
});
