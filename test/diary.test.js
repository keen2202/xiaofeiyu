import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHarness, bindMockAccount } from './helpers/harness.js';
import { DiaryModule } from '../src/modules/diary.js';
import { AppError } from '../src/errors.js';

async function setup({ diary = {}, hooks = {} } = {}) {
  const harness = await createHarness({
    overrides: {
      diary: {
        enabled: true,
        afterBrowse: true,
        daily: true,
        publicBook: true,
        privateBook: true,
        ...diary
      }
    }
  });
  const diaryModule = new DiaryModule({
    store: harness.store,
    journal: harness.journal,
    configService: harness.configService,
    identity: harness.identity,
    diaryDir: harness.paths.diaryDir,
    now: harness.now,
    hooks
  });
  return { harness, diary: diaryModule };
}

async function addEvent(harness, type, payload = {}, occurredAt = '2026-11-07T01:00:00.000Z') {
  await harness.store.transaction(async (draft, tx) => {
    tx.appendEvent({ type, payload, occurredAt });
  });
}

test('diary rebuilds from archived facts, is idempotent and increments revision on new facts', async () => {
  const { harness, diary } = await setup();
  try {
    await addEvent(harness, 'browse.round.completed', {
      selected: [{ contentRef: { platform: 'bilibili', contentId: 'BV1' } }],
      failed: []
    });
    const first = await diary.generate({ date: '2026-11-07', scope: 'workspace/workspace_test', principal: harness.owner });
    assert.equal(first.revision, 1);
    assert.match(first.content, /浏览/);
    assert.match(first.content, /选中内容：1/);
    const unchanged = await diary.generate({ date: '2026-11-07', scope: 'workspace/workspace_test', principal: harness.owner });
    assert.equal(unchanged.unchanged, true);
    assert.equal(unchanged.revision, 1);
    await addEvent(harness, 'operation.unknown', { operationId: 'op1', action: 'comment' });
    const second = await diary.generate({ date: '2026-11-07', scope: 'workspace/workspace_test', principal: harness.owner });
    assert.equal(second.revision, 2);
    assert.match(second.content, /unknown/);
    const read = await diary.read({
      date: '2026-11-07',
      scope: 'workspace/workspace_test',
      book: 'public',
      principal: harness.owner
    });
    assert.equal(read.revision, 2);
    assert.equal(read.contentHash, second.contentHash);
  } finally {
    await harness.cleanup();
  }
});

test('account and workspace diaries use isolated scope paths', async () => {
  const { harness, diary } = await setup();
  try {
    await bindMockAccount(harness);
    await addEvent(harness, 'operation.confirmed', { operationId: 'op1', action: 'dm' });
    const workspaceDiary = await diary.generate({
      date: '2026-11-07',
      scope: 'workspace/workspace_test',
      principal: harness.owner
    });
    const accountDiary = await diary.generate({
      date: '2026-11-07',
      scope: 'account/bilibili/1001',
      principal: harness.owner
    });
    assert.notEqual(workspaceDiary.path, accountDiary.path);
    assert.match(workspaceDiary.path, /^[a-f0-9]{64}\/public\/2026-11-07\.md$/);
    assert.match(accountDiary.path, /^[a-f0-9]{64}\/public\/2026-11-07\.md$/);
    assert.notEqual(workspaceDiary.path.split('/')[0], accountDiary.path.split('/')[0]);
  } finally {
    await harness.cleanup();
  }
});

test('private diary is restricted to a human owner and both off is rejected', async () => {
  const { harness, diary } = await setup();
  try {
    const agent = await harness.store.transaction(async (draft, tx) =>
      harness.identity.create(tx, { kind: 'agent', role: 'assistant', sourceKind: 'agent', scopes: ['diary.generate.own'] })
    );
    await assert.rejects(
      () =>
        diary.generate({
          date: '2026-11-07',
          scope: 'workspace/workspace_test',
          book: 'private',
          principal: agent
        }),
      (error) => error.code === 'FORBIDDEN'
    );
    const publicOnly = { ...harness.configService.get(), diary: { ...harness.configService.get().diary } };
    publicOnly.diary.publicBook = false;
    publicOnly.diary.privateBook = false;
    harness.configService.config.diary.publicBook = false;
    harness.configService.config.diary.privateBook = false;
    await assert.rejects(
      () => diary.generate({ date: '2026-11-07', scope: 'workspace/workspace_test', principal: harness.owner }),
      (error) => error.code === 'CONFIG_INVALID'
    );
  } finally {
    await harness.cleanup();
  }
});

test('a crash before diary rename leaves a recoverable pending commit', async () => {
  let fail = true;
  const { harness, diary } = await setup({
    hooks: {
      beforeDiaryRename() {
        if (fail) {
          fail = false;
          throw new Error('simulated crash');
        }
      }
    }
  });
  try {
    await addEvent(harness, 'browse.round.completed', { selected: [], failed: [] });
    await assert.rejects(
      () => diary.generate({ date: '2026-11-07', scope: 'workspace/workspace_test', principal: harness.owner }),
      /simulated crash/
    );
    const pending = (await harness.snapshot()).diaries;
    assert.equal(Object.values(pending)[0].pendingCommit.phase, 'pending');
    const recovered = await diary.generate({ date: '2026-11-07', scope: 'workspace/workspace_test', principal: harness.owner });
    assert.equal(recovered.revision, 1);
    assert.equal(Object.values((await harness.snapshot()).diaries)[0].pendingCommit, null);
  } finally {
    await harness.cleanup();
  }
});

test('a crash after rename is completed by recovery without a duplicate fact', async () => {
  let fail = true;
  const { harness, diary } = await setup({
    hooks: {
      beforeDiaryCommit() {
        if (fail) {
          fail = false;
          throw new Error('post-rename crash');
        }
      }
    }
  });
  try {
    await addEvent(harness, 'browse.round.completed', { selected: [], failed: [] });
    await assert.rejects(
      () => diary.generate({ date: '2026-11-07', scope: 'workspace/workspace_test', principal: harness.owner }),
      /post-rename crash/
    );
    const recovered = await diary.recoverPending({ principal: harness.owner });
    assert.equal(recovered.recovered, 1);
    const state = await harness.snapshot();
    const entry = Object.values(state.diaries)[0];
    assert.equal(entry.pendingCommit, null);
    assert.equal(entry.revision, 1);
    const eventTypes = state.events.map((event) => event.type);
    assert.equal(eventTypes.filter((type) => type === 'diary.commit.recovered').length, 1);
  } finally {
    await harness.cleanup();
  }
});

test('more than 2000 archived events still rebuild the requested date', async () => {
  const { harness, diary } = await setup();
  try {
    await harness.store.transaction(async (draft, tx) => {
      for (let i = 0; i < 2100; i += 1) {
        tx.appendEvent({ type: 'browse.round.completed', payload: { selected: [], failed: [] }, occurredAt: '2026-11-07T01:00:00.000Z' });
      }
    });
    await harness.journal.archiveAll();
    const result = await diary.generate({
      date: '2026-11-07',
      scope: 'workspace/workspace_test',
      principal: harness.owner
    });
    assert.equal(result.revision, 1);
    assert.match(result.content, /轮次：2100/);
  } finally {
    await harness.cleanup();
  }
});
