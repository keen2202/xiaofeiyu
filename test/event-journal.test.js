import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHarness } from './helpers/harness.js';
import { EventJournal } from '../src/event-journal.js';

test('more than 2000 events remain fully readable from archive + pending', async () => {
  const harness = await createHarness();
  try {
    await harness.store.transaction(async (draft, tx) => {
      for (let i = 0; i < 2500; i += 1) {
        tx.appendEvent({ type: 'test.event', payload: { i } });
      }
    });
    const pending = await harness.snapshot();
    assert.equal(Object.keys(pending.journalPending).length, 2500);
    assert.equal(pending.events.length, 2000);
    const archived = await harness.journal.archiveAll();
    assert.equal(archived.archived, 2500);
    const after = await harness.snapshot();
    assert.equal(Object.keys(after.journalPending).length, 0);
    assert.ok(Object.keys(after.journalSegments).length >= 5);
    const events = await harness.journal.readEvents();
    assert.equal(events.length, 2500);
    assert.deepEqual(events.map((event) => event.seq).slice(0, 3), [1, 2, 3]);
    assert.deepEqual(events.map((event) => event.seq).slice(-1), [2500]);
  } finally {
    await harness.cleanup();
  }
});

test('missing or corrupted journal segments fail closed', async () => {
  const harness = await createHarness();
  try {
    await harness.store.transaction(async (draft, tx) => {
      for (let i = 0; i < 10; i += 1) tx.appendEvent({ type: 'x', payload: { i } });
    });
    await harness.journal.flush();
    const state = await harness.snapshot();
    const segment = Object.values(state.journalSegments)[0];
    const file = `${harness.paths.journalDir}/${segment.relativePath}`;
    const original = await fs.readFile(file, 'utf8');
    await fs.writeFile(file, original.replace('"x"', '"tampered"'));
    await assert.rejects(() => harness.journal.readEvents(), (error) => error.code === 'JOURNAL_CORRUPTED');
    await fs.writeFile(file, original);
    await fs.rm(file);
    await assert.rejects(() => harness.journal.readEvents(), (error) => error.code === 'JOURNAL_CORRUPTED');
  } finally {
    await harness.cleanup();
  }
});

test('a crash before segment confirmation leaves pending facts and no registered segment', async () => {
  const harness = await createHarness();
  try {
    const journal = new EventJournal({
      store: harness.store,
      dir: harness.paths.journalDir,
      now: harness.now,
      hooks: {
        beforeSegmentRename() {
          throw new Error('simulated crash before journal rename');
        }
      }
    });
    await harness.store.transaction(async (draft, tx) => {
      for (let i = 0; i < 3; i += 1) tx.appendEvent({ type: 'x', payload: { i } });
    });
    await assert.rejects(() => journal.flush(), /simulated crash/);
    const state = await harness.snapshot();
    assert.equal(Object.keys(state.journalPending).length, 3);
    assert.equal(Object.keys(state.journalSegments).length, 0);
  } finally {
    await harness.cleanup();
  }
});

test('different history epochs never share segment paths or cursors', async () => {
  const harness = await createHarness();
  try {
    await harness.store.transaction(async (draft, tx) => {
      tx.appendEvent({ type: 'a', payload: {} });
    });
    await harness.journal.flush();
    await harness.store.transaction(async (draft, tx) => {
      draft.historyEpoch = 'epoch_second';
      draft.eventSeq = 0;
      draft.events = [];
      draft.journalPending = {};
      tx.appendEvent({ type: 'b', payload: {} });
    });
    await harness.journal.flush();
    const state = await harness.snapshot();
    assert.equal(Object.keys(state.journalSegments).length, 2);
    const epochs = new Set(Object.values(state.journalSegments).map((segment) => segment.historyEpoch));
    assert.deepEqual([...epochs].sort(), ['epoch_second', 'epoch_test']);
    const oldEvents = await harness.journal.readEvents({ epoch: 'epoch_test', upToSeq: 1 });
    assert.equal(oldEvents[0].type, 'a');
    const newEvents = await harness.journal.readEvents({ epoch: 'epoch_second', upToSeq: 1 });
    assert.equal(newEvents[0].type, 'b');
  } finally {
    await harness.cleanup();
  }
});
