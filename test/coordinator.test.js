import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, makeMockAdapter, mockCandidate, bindMockAccount } from './helpers/harness.js';
import { BrowseModule } from '../src/modules/browse.js';
import { CommentsModule } from '../src/modules/comments.js';
import { DirectMessagesModule } from '../src/modules/direct-messages.js';
import { DiaryModule } from '../src/modules/diary.js';
import { Coordinator } from '../src/coordinator.js';

async function setup({ overrides = {}, candidates = [mockCandidate('BV1')] } = {}) {
  const harness = await createHarness({
    overrides: {
      dryRun: false,
      browse: { enabled: true, perRound: 2, minScore: 0, minSubtitleChars: 10 },
      comments: { enabled: true, mode: 'approval', perRound: 1, dailyLimit: 5, allowTemplate: true },
      directMessages: { enabled: false },
      diary: { enabled: true, publicBook: true },
      scheduler: { enabled: false, tickSeconds: 30, browseIntervalMinutes: 60, diaryTime: '23:00' },
      ...overrides
    }
  });
  await bindMockAccount(harness);
  const adapter = makeMockAdapter({ candidates });
  const browse = new BrowseModule({
    store: harness.store,
    taskManager: harness.taskManager,
    adapter,
    configService: harness.configService,
    now: harness.now
  });
  const comments = new CommentsModule({
    store: harness.store,
    taskManager: harness.taskManager,
    approvalService: harness.approvalService,
    adapter,
    configService: harness.configService,
    effectGateway: harness.effectGateway,
    now: harness.now
  });
  const directMessages = new DirectMessagesModule({
    store: harness.store,
    taskManager: harness.taskManager,
    adapter,
    configService: harness.configService,
    effectGateway: harness.effectGateway,
    now: harness.now
  });
  const diary = new DiaryModule({
    store: harness.store,
    journal: harness.journal,
    configService: harness.configService,
    identity: harness.identity,
    diaryDir: harness.paths.diaryDir,
    now: harness.now
  });
  const coordinator = new Coordinator({
    store: harness.store,
    taskManager: harness.taskManager,
    identity: harness.identity,
    configService: harness.configService,
    browse,
    comments,
    directMessages,
    diary,
    now: harness.now
  });
  return { harness, adapter, coordinator, comments, diary };
}

test('start/stop are idempotent and waiting approval does not block the next browse round', async () => {
  const { harness, coordinator } = await setup();
  try {
    const firstStart = await coordinator.start();
    const secondStart = await coordinator.start();
    assert.equal(secondStart.deduplicated, true);
    const round = await coordinator.runBrowse({ trigger: 'manual' });
    assert.equal(round.task.status, 'succeeded');
    assert.equal(round.interactions.comments.length, 1);
    const commentTask = (await harness.snapshot()).tasks[round.interactions.comments[0].taskId];
    assert.equal(commentTask.status, 'waiting_approval');
    const second = await coordinator.runBrowse({ trigger: 'manual' });
    assert.equal(second.task.status, 'succeeded');
    const stop = await coordinator.stop();
    assert.equal(stop.stopped, true);
    const again = await coordinator.stop();
    assert.equal(again.deduplicated, true);
    assert.equal(coordinator.active.size, 0);
  } finally {
    await harness.cleanup();
  }
});

test('auto comments are sent only with explicit template policy and configured auto mode', async () => {
  const { harness, coordinator } = await setup({
    overrides: {
      comments: { enabled: true, mode: 'auto', perRound: 1, dailyLimit: 5, allowTemplate: true, maxLength: 300 }
    }
  });
  try {
    await coordinator.start();
    const round = await coordinator.runBrowse({ trigger: 'manual' });
    assert.equal(round.interactions.comments.length, 1);
    assert.equal(round.interactions.comments[0].sent, 'confirmed');
    const state = await harness.snapshot();
    const task = state.tasks[round.interactions.comments[0].taskId];
    assert.equal(task.status, 'succeeded');
  } finally {
    await coordinator.stop();
    await harness.cleanup();
  }
});

test('scheduler tick runs browse/diary once per configured window', async () => {
  const { harness, coordinator, diary } = await setup({
    overrides: {
      scheduler: { enabled: true, tickSeconds: 15, browseIntervalMinutes: 60, diaryTime: '00:00' },
      comments: { enabled: false }
    }
  });
  try {
    await coordinator.start();
    const first = await coordinator.tick();
    assert.ok(first.ran.includes('browse'));
    assert.ok(first.ran.includes('diary'));
    const second = await coordinator.tick();
    assert.deepEqual(second.ran, []);
    const state = await harness.snapshot();
    assert.ok(state.cursors.scheduler.browseLastRunAt);
    assert.equal(state.cursors.scheduler.diaryLastDate, '2026-11-07');
    assert.ok(Object.keys(state.diaries).length > 0);
  } finally {
    await coordinator.stop();
    await harness.cleanup();
  }
});
