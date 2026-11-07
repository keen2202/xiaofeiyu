import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './helpers/harness.js';

test('new historyEpoch can reuse bare seq numbers without overwriting old archives', async () => {
  const harness = await createHarness();
  try {
    await harness.store.transaction(async (draft, tx) => {
      tx.appendEvent({ type: 'epoch-one', payload: { same: 1 } });
    });
    await harness.journal.flush();
    const firstEpoch = (await harness.snapshot()).historyEpoch;
    await harness.store.transaction(async (draft, tx) => {
      draft.historyEpoch = 'epoch_recovery_branch';
      draft.eventSeq = 0;
      draft.events = [];
      draft.journalPending = {};
      tx.appendEvent({ type: 'epoch-two', payload: { same: 1 } });
    });
    await harness.journal.flush();
    const state = await harness.snapshot();
    assert.equal(state.historyEpoch, 'epoch_recovery_branch');
    assert.equal(state.eventSeq, 1);
    const oldEvents = await harness.journal.readEvents({ epoch: firstEpoch, upToSeq: 1 });
    assert.equal(oldEvents[0].type, 'epoch-one');
    const newEvents = await harness.journal.readEvents({ epoch: 'epoch_recovery_branch', upToSeq: 1 });
    assert.equal(newEvents[0].type, 'epoch-two');
    assert.notEqual(
      Object.values(state.journalSegments).find((segment) => segment.historyEpoch === firstEpoch).relativePath,
      Object.values(state.journalSegments).find((segment) => segment.historyEpoch === 'epoch_recovery_branch').relativePath
    );
    await harness.store.transaction(async (draft, tx) => {
      tx.appendEvent({ type: 'epoch-two-second', payload: {} });
    });
    const newEvents2 = await harness.journal.readEvents({ epoch: 'epoch_recovery_branch', upToSeq: 2 });
    assert.deepEqual(newEvents2.map((event) => event.type), ['epoch-two', 'epoch-two-second']);
    await assert.rejects(
      () => harness.journal.readEvents({ epoch: firstEpoch }),
      (error) => error.code === 'JOURNAL_CORRUPTED'
    );
  } finally {
    await harness.cleanup();
  }
});
