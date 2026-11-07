import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, makeMockAdapter, mockCandidate, bindMockAccount, approvalDecide } from './helpers/harness.js';
import { BrowseModule } from '../src/modules/browse.js';
import { CommentsModule } from '../src/modules/comments.js';
import { DirectMessagesModule } from '../src/modules/direct-messages.js';
import { DiaryModule } from '../src/modules/diary.js';
import { Coordinator } from '../src/coordinator.js';

async function setup() {
  const harness = await createHarness({
    overrides: {
      dryRun: false,
      browse: { enabled: true, perRound: 2, minScore: 0, minSubtitleChars: 10 },
      comments: { enabled: true, mode: 'approval', perRound: 1, dailyLimit: 5, allowTemplate: true, maxLength: 300 },
      directMessages: { enabled: false },
      diary: { enabled: true, publicBook: true, privateBook: false }
    }
  });
  await bindMockAccount(harness);
  const adapter = makeMockAdapter({ candidates: [mockCandidate('BV1', { author: { accountId: '2002', name: 'author' } })] });
  const browse = new BrowseModule({ store: harness.store, taskManager: harness.taskManager, adapter, configService: harness.configService, now: harness.now });
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

test('browse -> comment approval -> send -> diary reflects the confirmed business fact', async () => {
  const { harness, adapter, coordinator, comments, diary } = await setup();
  try {
    await coordinator.start();
    const round = await coordinator.runBrowse({ trigger: 'manual' });
    assert.equal(round.task.status, 'succeeded');
    const interaction = round.interactions.comments[0];
    assert.equal(interaction.status, 'waiting_approval');
    const commentTask = (await harness.snapshot()).tasks[interaction.taskId];
    // Ask the comments module for a fresh challenge for the same pending target.
    const redraft = await comments.createDraft({
      candidate: {
        contentRef: commentTask.input.contentRef,
        platformData: commentTask.input.platformData,
        title: commentTask.input.title,
        author: commentTask.input.author
      },
      text: commentTask.input.text,
      principal: harness.owner
    });
    assert.equal(redraft.task.id, interaction.taskId);
    assert.ok(redraft.nonce);
    await approvalDecide(harness, { approvalId: redraft.approval.id, nonce: redraft.nonce });
    const sent = await comments.send({ taskId: redraft.task.id, mode: 'go', principal: harness.owner });
    assert.equal(sent.operation.status, 'confirmed');
    assert.equal(adapter.calls.writeComment.length, 1);
    const generated = await diary.generate({
      date: '2026-11-07',
      scope: 'workspace/workspace_test',
      principal: harness.owner
    });
    assert.match(generated.content, /评论确认：1/);
    assert.match(generated.content, /浏览/);
  } finally {
    await coordinator.stop();
    await harness.cleanup();
  }
});

test('coordinator browse and manual comment approval flow persists through diary generation', async () => {
  const { harness, adapter, comments, diary } = await setup();
  try {
    const task = await comments.createDraft({
      candidate: mockCandidate('BV1'),
      text: '集成测试评论',
      principal: harness.owner
    });
    await approvalDecide(harness, { approvalId: task.approval.id, nonce: task.nonce });
    const sent = await comments.send({ taskId: task.task.id, mode: 'go', principal: harness.owner });
    assert.equal(sent.operation.status, 'confirmed');
    const state = await harness.snapshot();
    assert.equal(state.tasks[task.task.id].status, 'succeeded');
    const generated = await diary.generate({
      date: '2026-11-07',
      scope: 'workspace/workspace_test',
      principal: harness.owner
    });
    assert.match(generated.content, /评论确认：1/);
    assert.equal(adapter.calls.writeComment.length, 1);
    assert.equal(adapter.calls.sendDirectMessage.length, 0);
  } finally {
    await harness.cleanup();
  }
});
