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
