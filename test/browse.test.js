import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, makeMockAdapter, mockCandidate, bindMockAccount } from './helpers/harness.js';
import { BrowseModule } from '../src/modules/browse.js';

async function setup({ candidates = [], overrides = {}, adapterOverrides = {} } = {}) {
  const harness = await createHarness({
    overrides: {
      browse: { enabled: true, sources: ['popular'], perRound: 3, candidatePool: 10, minSubtitleChars: 10, minScore: 0 },
      ...overrides
    }
  });
  await bindMockAccount(harness);
  const adapter = makeMockAdapter({ candidates });
  Object.assign(adapter, adapterOverrides);
  const browse = new BrowseModule({
    store: harness.store,
    taskManager: harness.taskManager,
    adapter,
    configService: harness.configService,
    now: harness.now
  });
  return { harness, adapter, browse };
}

test('browse deduplicates sources, filters self/seen/failure, scores and never writes', async () => {
  const candidates = [
    mockCandidate('BV_SELF', { author: { accountId: '1001', name: 'self' } }),
    mockCandidate('BV1'),
    mockCandidate('BV1', { source: 'search' }),
    mockCandidate('BV_LONG', { durationSec: 99999 }),
    mockCandidate('BV2', { title: 'very short' })
  ];
  const { harness, adapter, browse } = await setup({ candidates });
  try {
    const task = await browse.createTask({ principal: harness.owner });
    const first = await browse.run({ taskId: task.id, principal: harness.owner });
    assert.equal(first.task.status, 'succeeded');
    assert.equal(first.result.selected.length, 2);
    assert.deepEqual(new Set(first.result.selected.map((entry) => entry.contentRef.contentId)), new Set(['BV1', 'BV2']));
    assert.ok(first.result.skipped.some((entry) => entry.reason === 'own_content'));
    assert.ok(first.result.skipped.some((entry) => entry.reason === 'too_long'));
    assert.ok(first.result.selected[0].score > 0);
    assert.equal(adapter.calls.writeComment.length, 0);
    assert.equal(adapter.calls.sendDirectMessage.length, 0);
    const second = await browse.run({ taskId: (await browse.createTask({ principal: harness.owner })).id });
    assert.ok(second.result.skipped.some((entry) => entry.reason === 'already_processed'));
  } finally {
    await harness.cleanup();
  }
});

test('single detail failure is isolated and a no-subtitle candidate is skipped', async () => {
  const candidates = [mockCandidate('BV_FAIL'), mockCandidate('BV_NOSUB')];
  const harness = await createHarness({
    overrides: {
      browse: { enabled: true, perRound: 3, minSubtitleChars: 10, minScore: 0 },
      comments: { enabled: false }
    }
  });
  await bindMockAccount(harness);
  const base = makeMockAdapter({ candidates });
  const adapter = {
    ...base,
    async readContent(candidate) {
      if (candidate.contentRef.contentId === 'BV_FAIL') throw Object.assign(new Error('detail down'), { code: 'BILI_API_ERROR' });
      if (candidate.contentRef.contentId === 'BV_NOSUB') {
        return { ...candidate, subtitle: { text: '' }, platformData: { aid: 1, cid: 2 } };
      }
      return base.readContent(candidate);
    }
  };
  const browse = new BrowseModule({
    store: harness.store,
    taskManager: harness.taskManager,
    adapter,
    configService: harness.configService,
    now: harness.now
  });
  try {
    const task = await browse.createTask({ principal: harness.owner });
    const result = await browse.run({ taskId: task.id, principal: harness.owner });
    assert.equal(result.task.status, 'partial');
    assert.equal(result.result.failed.length, 1);
    assert.ok(result.result.skipped.some((entry) => entry.reason === 'insufficient_subtitle'));
    const state = await harness.snapshot();
    const nextCandidate = mockCandidate('BV_FAIL');
    const next = await browse.run({ taskId: (await browse.createTask({ principal: harness.owner })).id });
    assert.ok(next.result.skipped.some((entry) => entry.reason === 'failure_cooldown'));
  } finally {
    await harness.cleanup();
  }
});

test('discovery failure marks the whole round failed without leaking a write', async () => {
  const { harness, adapter, browse } = await setup({});
  adapter.discover = async () => {
    throw Object.assign(new Error('popular down'), { code: 'BILI_API_ERROR' });
  };
  try {
    const task = await browse.createTask({ principal: harness.owner });
    const result = await browse.run({ taskId: task.id, principal: harness.owner });
    assert.equal(result.task.status, 'failed');
    assert.equal(result.result.status, 'partial');
    assert.equal(adapter.calls.writeComment.length, 0);
  } finally {
    await harness.cleanup();
  }
});
