import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './helpers/harness.js';

async function waitingTask(harness) {
  return harness.store.transaction(async (draft, tx) => {
    const task = harness.taskManager.create(tx, {
      kind: 'comment',
      principalId: harness.owner.id,
      inputHash: 'jcs-sha256-v1:' + '1'.repeat(64)
    });
    harness.taskManager.transition(tx, task, 'waiting_approval');
    const challenge = harness.approvalService.create(tx, {
      task,
      action: 'comment.send',
      inputHash: task.inputHash,
      principalId: harness.owner.id,
      ttlSec: 600
    });
    return { task, challenge };
  });
}

test('approval bind, decide, idempotency and nonce replay', async () => {
  const harness = await createHarness();
  try {
    const { task, challenge } = await waitingTask(harness);
    const first = await harness.approvalService.decide(
      { approvalId: challenge.approval.id, decision: 'approve', nonce: challenge.nonce, mode: 'go' },
      harness.humanContext
    );
    assert.equal(first.task.status, 'running');
    assert.equal(first.approval.decision, 'approve');
    const replay = await harness.approvalService.decide(
      { approvalId: challenge.approval.id, decision: 'approve', nonce: 'again', mode: 'go' },
      harness.humanContext
    );
    assert.equal(replay.deduplicated, true);
    await assert.rejects(
      () =>
        harness.approvalService.decide(
          { approvalId: challenge.approval.id, decision: 'reject', nonce: challenge.nonce, mode: 'go' },
          harness.humanContext
        ),
      (error) => error.code === 'APPROVAL_STALE'
    );
    const state = await harness.snapshot();
    assert.equal(state.tasks[task.id].status, 'running');
  } finally {
    await harness.cleanup();
  }
});

test('dry decisions do not consume the challenge and wrong nonce/principal fail', async () => {
  const harness = await createHarness();
  try {
    const { challenge } = await waitingTask(harness);
    const dry = await harness.approvalService.decide(
      { approvalId: challenge.approval.id, decision: 'approve', nonce: '', mode: 'dry' },
      null
    );
    assert.equal(dry.consumed, false);
    assert.equal((await harness.snapshot()).approvals[challenge.approval.id].decision, 'pending');
    await assert.rejects(
      () =>
        harness.approvalService.decide(
          { approvalId: challenge.approval.id, decision: 'approve', nonce: 'wrong', mode: 'go' },
          harness.humanContext
        ),
      (error) => error.code === 'APPROVAL_STALE'
    );
    await assert.rejects(
      () =>
        harness.approvalService.decide(
          { approvalId: challenge.approval.id, decision: 'approve', nonce: challenge.nonce, mode: 'go' },
          { principal: { ...harness.owner, id: 'other' }, proof: { kind: 'test', ok: true } }
        ),
      (error) => error.code === 'FORBIDDEN'
    );
  } finally {
    await harness.cleanup();
  }
});

test('input changes and expiry invalidate approvals', async () => {
  const harness = await createHarness();
  try {
    const { task, challenge } = await waitingTask(harness);
    await harness.store.transaction(async (draft) => {
      draft.tasks[task.id].revision += 1;
    });
    await assert.rejects(
      () =>
        harness.approvalService.decide(
          { approvalId: challenge.approval.id, decision: 'approve', nonce: challenge.nonce, mode: 'go' },
          harness.humanContext
        ),
      (error) => error.code === 'APPROVAL_STALE'
    );
    const harness2 = await createHarness();
    try {
      const second = await waitingTask(harness2);
      await harness2.store.transaction(async (draft) => {
        draft.approvals[second.challenge.approval.id].expiresAt = new Date(harness2.now().getTime() - 1000).toISOString();
      });
      await assert.rejects(
        () =>
          harness2.approvalService.decide(
            { approvalId: second.challenge.approval.id, decision: 'approve', nonce: second.challenge.nonce, mode: 'go' },
            harness2.humanContext
          ),
        (error) => error.code === 'APPROVAL_STALE'
      );
    } finally {
      await harness2.cleanup();
    }
  } finally {
    await harness.cleanup();
  }
});

test('wrong human proof fails closed', async () => {
  const harness = await createHarness();
  try {
    const { challenge } = await waitingTask(harness);
    await assert.rejects(
      () =>
        harness.approvalService.decide(
          { approvalId: challenge.approval.id, decision: 'approve', nonce: challenge.nonce, mode: 'go' },
          { principal: harness.owner, proof: { kind: 'test', ok: false } }
        ),
      (error) => error.code === 'TRUST_UNAVAILABLE'
    );
  } finally {
    await harness.cleanup();
  }
});

async function approvedTask(harness) {
  const { task, challenge } = await waitingTask(harness);
  await harness.approvalService.decide(
    { approvalId: challenge.approval.id, decision: 'approve', nonce: challenge.nonce, mode: 'go' },
    harness.humanContext
  );
  return { task, challenge };
}

test('decided approvals with invalidation flags are rejected on re-decide and at dispatch', async () => {
  const harness = await createHarness();
  try {
    const { task, challenge } = await approvedTask(harness);
    const decidedAt = new Date().toISOString();
    const invalidState = {
      approvals: {
        invalid_one: {
          id: 'invalid_one',
          taskId: task.id,
          action: 'comment.send',
          decision: 'approve',
          decidedAt,
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          inputHash: task.inputHash,
          usableForAuthorization: false,
          invalidatedByMigration: true,
          requiresReverification: true
        }
      }
    };
    assert.throws(
      () =>
        harness.approvalService.assertApproved(invalidState, {
          taskId: task.id,
          action: 'comment.send',
          inputHash: task.inputHash
        }),
      (error) => error.code === 'APPROVAL_STALE' && /invalidated/.test(error.message)
    );
    await harness.store.transaction(async (draft) => {
      draft.approvals[challenge.approval.id].usableForAuthorization = false;
      draft.approvals[challenge.approval.id].invalidatedByMigration = true;
    });
    // The decided challenge recorded in the ledger is rejected at dispatch time.
    const afterFlags = await harness.snapshot();
    assert.throws(
      () =>
        harness.approvalService.assertApproved(
          { approvals: { [challenge.approval.id]: afterFlags.approvals[challenge.approval.id] } },
          { taskId: task.id, action: 'comment.send', inputHash: task.inputHash }
        ),
      (error) => error.code === 'APPROVAL_STALE'
    );
    // A pending challenge invalidated by migration cannot be decided either.
    const second = await waitingTask(harness);
    await harness.store.transaction(async (draft) => {
      draft.approvals[second.challenge.approval.id].invalidatedByMigration = true;
    });
    await assert.rejects(
      () =>
        harness.approvalService.decide(
          { approvalId: second.challenge.approval.id, decision: 'approve', nonce: second.challenge.nonce, mode: 'go' },
          harness.humanContext
        ),
      (error) => error.code === 'APPROVAL_STALE' && /invalidated/.test(error.message)
    );
    await assert.rejects(
      () =>
        harness.approvalService.decide(
          { approvalId: second.challenge.approval.id, decision: 'approve', nonce: second.challenge.nonce, mode: 'dry' },
          harness.humanContext
        ),
      (error) => error.code === 'APPROVAL_STALE'
    );
  } finally {
    await harness.cleanup();
  }
});

test('assertApproved consumes usable approvals and rejects consumed ones', async () => {
  const harness = await createHarness();
  try {
    const { task, challenge } = await approvedTask(harness);
    const state = await harness.snapshot();
    const approval = harness.approvalService.assertApproved(state, {
      taskId: task.id,
      action: 'comment.send',
      inputHash: task.inputHash
    });
    assert.equal(approval.id, challenge.approval.id);
    await harness.store.transaction(async (draft, tx) => {
      harness.approvalService.consume(tx, approval, 'op_1');
    });
    const afterConsume = await harness.snapshot();
    assert.throws(
      () =>
        harness.approvalService.assertApproved(afterConsume, {
          taskId: task.id,
          action: 'comment.send',
          inputHash: task.inputHash,
          operationId: 'op_2'
        }),
      (error) => error.code === 'APPROVAL_STALE' && /consumed/.test(error.message)
    );
  } finally {
    await harness.cleanup();
  }
});

test('revising task input bumps revision, supersedes challenges and blocks the old decision', async () => {
  const harness = await createHarness();
  try {
    const { task, challenge } = await waitingTask(harness);
    const revisedHash = 'jcs-sha256-v1:' + '9'.repeat(64);
    await harness.store.transaction(async (draft, tx) => {
      harness.taskManager.reviseInput(
        tx,
        draft.tasks[task.id],
        { input: { text: 'revised' }, inputHash: revisedHash },
        { actor: harness.owner.id }
      );
    });
    const state = await harness.snapshot();
    assert.equal(state.tasks[task.id].revision, 2);
    assert.equal(state.tasks[task.id].inputHash, revisedHash);
    assert.ok(state.approvals[challenge.approval.id].supersededAt);
    assert.ok(state.approvals[challenge.approval.id].supersededByRevision >= 2);
    await assert.rejects(
      () =>
        harness.approvalService.decide(
          { approvalId: challenge.approval.id, decision: 'approve', nonce: challenge.nonce, mode: 'go' },
          harness.humanContext
        ),
      (error) => error.code === 'APPROVAL_STALE'
    );
    // A challenge created for the new revision is valid again.
    const fresh = await harness.store.transaction(async (draft, tx) =>
      harness.approvalService.create(tx, {
        task: draft.tasks[task.id],
        action: 'comment.send',
        inputHash: revisedHash,
        principalId: harness.owner.id
      })
    );
    assert.equal(fresh.approval.taskRevision, 2);
    const decided = await harness.approvalService.decide(
      { approvalId: fresh.approval.id, decision: 'approve', nonce: fresh.nonce, mode: 'go' },
      harness.humanContext
    );
    assert.equal(decided.approval.decision, 'approve');
  } finally {
    await harness.cleanup();
  }
});

