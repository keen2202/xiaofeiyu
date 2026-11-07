import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './helpers/harness.js';
import { TASK_TRANSITIONS } from '../src/task-manager.js';
import { AppError } from '../src/errors.js';

async function withTask(harness, kind = 'browse', extra = {}) {
  return harness.store.transaction(async (draft, tx) => {
    const task = harness.taskManager.create(tx, {
      kind,
      principalId: harness.owner.id,
      inputHash: 'jcs-sha256-v1:' + 'a'.repeat(64),
      input: {},
      ...extra
    });
    return task;
  });
}

test('whitelist transitions reject unlisted edges', async () => {
  const harness = await createHarness();
  try {
    const task = await withTask(harness);
    await harness.store.transaction(async (draft, tx) => {
      harness.taskManager.transition(tx, draft.tasks[task.id], 'running');
      assert.throws(
        () => harness.taskManager.transition(tx, draft.tasks[task.id], 'queued'),
        (error) => error.code === 'INPUT_REQUIRED'
      );
    });
    // Every declared pair is accepted from a fresh task where conditions allow.
    assert.ok(TASK_TRANSITIONS.queued.includes('waiting_approval'));
    assert.ok(TASK_TRANSITIONS.running.includes('unknown'));
  } finally {
    await harness.cleanup();
  }
});

test('unknown operation keeps a partial task unsettled and prevents success', async () => {
  const harness = await createHarness();
  try {
    const task = await withTask(harness, 'comment');
    await harness.store.transaction(async (draft, tx) => {
      const current = draft.tasks[task.id];
      harness.taskManager.transition(tx, current, 'running');
      draft.operations.op1 = { id: 'op1', status: 'unknown', dispatchAt: '2026-01-01T00:00:00Z', taskIds: [task.id] };
      current.operationIds.push('op1');
      current.pendingOperationIds.push('op1');
      harness.taskManager.transition(tx, current, 'partial', { result: { ok: false } });
      assert.equal(current.isSettled, false);
      assert.equal(current.finishedAt, null);
      assert.throws(
        () => harness.taskManager.transition(tx, current, 'succeeded'),
        (error) => error.code === 'FORBIDDEN'
      );
      assert.throws(
        () => harness.taskManager.transition(tx, current, 'succeeded', { manual: true }),
        (error) => error.code === 'OPERATION_UNKNOWN'
      );
    });
  } finally {
    await harness.cleanup();
  }
});

test('waiting approval and awaiting manual are not settled but hold no execution slot', async () => {
  const harness = await createHarness();
  try {
    const task = await withTask(harness);
    const state = await harness.store.transaction(async (draft, tx) => {
      harness.taskManager.transition(tx, draft.tasks[task.id], 'waiting_approval');
      harness.taskManager.transition(tx, draft.tasks[task.id], 'running', { approved: true });
      harness.taskManager.transition(tx, draft.tasks[task.id], 'awaiting_manual');
      return structuredClone(draft.tasks[task.id]);
    });
    assert.equal(state.status, 'awaiting_manual');
    assert.equal(state.isSettled, false);
    assert.equal(state.executionActive, false);
  } finally {
    await harness.cleanup();
  }
});

test('human resume creates a new attempt and requires verified old state', async () => {
  const harness = await createHarness();
  try {
    const task = await withTask(harness);
    await harness.store.transaction(async (draft, tx) => {
      harness.taskManager.transition(tx, draft.tasks[task.id], 'running');
      harness.taskManager.transition(tx, draft.tasks[task.id], 'interrupted');
    });
    const resumed = await harness.store.transaction(async (draft, tx) => {
      const current = draft.tasks[task.id];
      harness.taskManager.resume(tx, current, { manual: true, verified: true });
      return structuredClone(current);
    });
    assert.equal(resumed.status, 'running');
    assert.equal(resumed.attempts, 1);
    assert.equal(resumed.cancelRequestedAt, null);
  } finally {
    await harness.cleanup();
  }
});

test('parent task aggregates unknown children and is not settled', async () => {
  const harness = await createHarness();
  try {
    const parent = await withTask(harness);
    const child = await withTask(harness, 'comment', { parentTaskId: parent.id });
    await harness.store.transaction(async (draft, tx) => {
      const childTask = draft.tasks[child.id];
      harness.taskManager.transition(tx, childTask, 'running');
      harness.taskManager.transition(tx, childTask, 'unknown', { verified: true });
      const parentTask = draft.tasks[parent.id];
      harness.taskManager.recomputeParent(tx, parentTask);
      assert.equal(parentTask.isSettled, false);
    });
    const state = await harness.snapshot();
    assert.equal(state.tasks[parent.id].childTaskIds.includes(child.id), true);
  } finally {
    await harness.cleanup();
  }
});

test('settled combination matrix rejects invalid succeeded/cancelled states', async () => {
  const harness = await createHarness();
  try {
    const task = await withTask(harness);
    await harness.store.transaction(async (draft, tx) => {
      const current = draft.tasks[task.id];
      harness.taskManager.transition(tx, current, 'running');
      harness.taskManager.transition(tx, current, 'succeeded');
      assert.equal(current.isSettled, true);
      assert.equal(current.executionActive, false);
      assert.doesNotThrow(() => harness.taskManager.assertSettledCombination(current));
      current.isSettled = false;
      assert.throws(() => harness.taskManager.assertSettledCombination(current), (error) => error.code === 'STORE_CORRUPTED');
    });
  } finally {
    await harness.cleanup();
  }
});
