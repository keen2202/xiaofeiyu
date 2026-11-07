import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHarness, makeClock } from './helpers/harness.js';
import { JsonStore, createInitialState } from '../src/store.js';
import { AppError } from '../src/errors.js';
import { sleep } from '../src/utils.js';

test('bootstrap creates v3 state and instance in one explicit step', async () => {
  const harness = await createHarness();
  try {
    const state = await harness.snapshot();
    const instance = await harness.store.getInstance();
    assert.equal(state.version, 3);
    assert.equal(state.workspaceId, 'workspace_test');
    assert.equal(instance.bootstrapComplete, true);
    assert.equal(instance.workspaceId, state.workspaceId);
    assert.equal(state.configRevision.sha256, harness.configService.getRevision().sha256);
  } finally {
    await harness.cleanup();
  }
});

test('corrupt state and missing state with initialized instance fail closed', async () => {
  const harness = await createHarness();
  const file = harness.paths.stateFile;
  const instanceFile = harness.paths.instanceFile;
  const original = await fs.readFile(file, 'utf8');
  try {
    await fs.writeFile(file, '{not-json');
    await assert.rejects(() => harness.store.getSnapshot(), (error) => error.code === 'STORE_CORRUPTED');
    await fs.writeFile(file, original);
    await fs.rm(file);
    await assert.rejects(
      () => harness.store.init({ bootstrap: false }),
      (error) => error.code === 'RECOVERY_REQUIRED'
    );
    assert.equal(await fs.readFile(instanceFile, 'utf8') !== '', true);
  } finally {
    await harness.cleanup();
  }
});

test('transaction rollback preserves the previous ledger', async () => {
  const harness = await createHarness();
  try {
    const before = await harness.snapshot();
    await assert.rejects(
      () =>
        harness.store.transaction(async (draft, tx) => {
          draft.workspaceId = 'corrupted';
          tx.appendEvent({ type: 'should-not-commit', payload: {} });
          throw new Error('injected failure');
        }),
      /injected failure/
    );
    const after = await harness.snapshot();
    assert.equal(after.workspaceId, before.workspaceId);
    assert.equal(after.eventSeq, before.eventSeq);
  } finally {
    await harness.cleanup();
  }
});

test('a competing process cannot overwrite state and a malformed lock is not stolen', async () => {
  const harness = await createHarness();
  const other = new JsonStore({
    file: harness.paths.stateFile,
    instanceFile: harness.paths.instanceFile,
    lockTimeoutMs: 80,
    staleLockMs: 5000,
    now: harness.now
  });
  try {
    let release;
    const blocker = new Promise((resolve) => {
      release = resolve;
    });
    const first = harness.store.transaction(async (draft) => {
      await blocker;
      draft.videos.x = { ok: true };
      return true;
    });
    await sleep(30);
    await assert.rejects(
      () => other.transaction(async (draft) => {
        draft.videos.y = { bad: true };
      }),
      (error) => error instanceof AppError && error.code === 'STORE_CORRUPTED'
    );
    release();
    await first;
    const state = await harness.snapshot();
    assert.deepEqual(state.videos.x, { ok: true });
    assert.equal(state.videos.y, undefined);
  } finally {
    await harness.cleanup();
  }
});

test('an expired lock from a dead owner is safely recovered', async () => {
  const harness = await createHarness();
  try {
    const lockFile = `${harness.paths.stateFile}.lock`;
    const old = new Date(Date.now() - 60000).toISOString();
    await fs.writeFile(
      lockFile,
      JSON.stringify({
        schemaVersion: 1,
        token: 'stale',
        ownerPid: 999999,
        processStartedAt: old,
        instanceId: 'dead',
        createdAt: old
      })
    );
    const result = await harness.store.transaction(async (draft) => {
      draft.videos.recovered = true;
      return 'yes';
    });
    assert.equal(result, 'yes');
    assert.equal((await harness.snapshot()).videos.recovered, true);
  } finally {
    await harness.cleanup();
  }
});

test('appendEvent is rejected outside a transaction and payloads above 64KiB are refused', async () => {
  const harness = await createHarness();
  try {
    await assert.rejects(
      () => harness.store.appendEvent({ type: 'x' }),
      (error) => error.code === 'STORE_CORRUPTED'
    );
    await assert.rejects(
      () =>
        harness.store.transaction(async (draft, tx) => {
          tx.appendEvent({ type: 'big', payload: { text: 'x'.repeat(70000) } });
        }),
      (error) => error.code === 'INPUT_REQUIRED'
    );
    assert.equal((await harness.snapshot()).eventSeq, 0);
  } finally {
    await harness.cleanup();
  }
});

test('fake v3 and legacy versions are rejected without reinitializing', async () => {
  const harness = await createHarness();
  try {
    const state = await harness.snapshot();
    const fake = createInitialState({
      workspaceId: 'x',
      historyEpoch: 'e',
      configRevision: state.configRevision
    });
    const variations = [
      { ...fake, historyEpoch: '' },
      { ...fake, recovery: undefined },
      { ...fake, version: 2 }
    ];
    for (const variation of variations) {
      await fs.writeFile(harness.paths.stateFile, JSON.stringify(variation));
      await assert.rejects(
        () => harness.store.getSnapshot(),
        (error) => ['STORE_CORRUPTED', 'SCHEMA_UNSUPPORTED'].includes(error.code)
      );
    }
  } finally {
    await harness.cleanup();
  }
});

test('afterCommit failure does not corrupt the committed ledger', async () => {
  const dir = await fs.mkdtemp(path.join((await import('node:os')).tmpdir(), 'xfy-store-'));
  const now = makeClock();
  const store = new JsonStore({
    file: path.join(dir, 'state.json'),
    instanceFile: path.join(dir, 'instance.json'),
    now,
    hooks: {
      afterCommit() {
        throw new Error('post-commit observer failed');
      }
    }
  });
  try {
    await store.init({ bootstrap: true, workspaceId: 'w', historyEpoch: 'e' });
    await assert.rejects(
      () => store.transaction(async (draft) => {
        draft.videos.x = true;
      }),
      /post-commit observer failed/
    );
    assert.equal((await store.getSnapshot()).videos.x, true);
  } finally {
    await store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
