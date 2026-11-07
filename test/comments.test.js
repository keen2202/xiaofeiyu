import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, makeMockAdapter, mockCandidate, bindMockAccount, approvalDecide } from './helpers/harness.js';
import { CommentsModule } from '../src/modules/comments.js';

async function setup({ comments = {}, adapterOverrides = {} } = {}) {
  const harness = await createHarness({
    overrides: {
      dryRun: false,
      owner: { mid: 0, name: 'owner' },
      comments: {
        enabled: true,
        mode: 'approval',
        perRound: 3,
        dailyLimit: 10,
        sameVideoDays: 7,
        maxLength: 300,
        allowTemplate: false,
        ...comments
      }
    }
  });
  await bindMockAccount(harness);
  const adapter = makeMockAdapter();
  Object.assign(adapter, adapterOverrides);
  const commentsModule = new CommentsModule({
    store: harness.store,
    taskManager: harness.taskManager,
    approvalService: harness.approvalService,
    adapter,
    configService: harness.configService,
    effectGateway: harness.effectGateway,
    now: harness.now
  });
  return { harness, adapter, comments: commentsModule };
}

test('approval mode creates a draft, approval returns the same task, and send is confirmed once', async () => {
  const { harness, adapter, comments } = await setup();
  try {
    const candidate = mockCandidate('BV1');
    const draft = await comments.createDraft({ candidate, text: '很棒的视频', principal: harness.owner });
    assert.equal(draft.task.status, 'waiting_approval');
    assert.ok(draft.nonce);
    const duplicate = await comments.createDraft({ candidate, text: '很棒的视频', principal: harness.owner });
    assert.equal(duplicate.reused, true);
    assert.equal(duplicate.task.id, draft.task.id);
    assert.equal(Object.keys((await harness.snapshot()).tasks).length, 1);
    await approvalDecide(harness, { approvalId: duplicate.approval.id, nonce: duplicate.nonce });
    const sent = await comments.send({ taskId: draft.task.id, mode: 'go', principal: harness.owner });
    assert.equal(sent.operation.status, 'confirmed');
    assert.equal(sent.task.status, 'succeeded');
    assert.equal(adapter.calls.writeComment.length, 1);
    const state = await harness.snapshot();
    assert.equal(state.tasks[draft.task.id].result.receipt.externalId, 'rpid_1');
    harness.now.advance(121000);
    await assert.rejects(
      () => comments.createDraft({ candidate, text: '换一条正文', principal: harness.owner }),
      (error) => error.code === 'DUPLICATE_TARGET'
    );
  } finally {
    await harness.cleanup();
  }
});

test('identical normalized text cannot be reused on a different video', async () => {
  const { harness, comments } = await setup();
  try {
    const first = await comments.createDraft({ candidate: mockCandidate('BV1'), text: '同一句评论', principal: harness.owner });
    await approvalDecide(harness, { approvalId: first.approval.id, nonce: first.nonce });
    await comments.send({ taskId: first.task.id, mode: 'go', principal: harness.owner });
    harness.now.advance(121000);
    await assert.rejects(
      () => comments.createDraft({ candidate: mockCandidate('BV2'), text: '同一句评论', principal: harness.owner }),
      (error) => error.code === 'DUPLICATE_TARGET'
    );
  } finally {
    await harness.cleanup();
  }
});

test('dry run writes no operation, no sent key and leaves approval flow intact', async () => {
  const { harness, comments } = await setup();
  try {
    const draft = await comments.createDraft({ candidate: mockCandidate('BV1'), text: 'dry only', principal: harness.owner });
    const dry = await comments.send({ taskId: draft.task.id, mode: 'dry', principal: harness.owner });
    assert.equal(dry.dryRun, true);
    const state = await harness.snapshot();
    assert.equal(state.operations && Object.keys(state.operations).length, 0);
    assert.equal(state.businessKeys[draft.task.input.primaryKey], undefined);
    assert.equal(state.tasks[draft.task.id].status, 'waiting_approval');
  } finally {
    await harness.cleanup();
  }
});

test('unknown result is kept, never resent automatically, and the task stays unsettled', async () => {
  const { harness, comments } = await setup({
    adapterOverrides: {
      async writeComment() {
        throw new Error('network timeout');
      }
    }
  });
  try {
    const draft = await comments.createDraft({ candidate: mockCandidate('BV1'), text: 'unknown text', principal: harness.owner });
    await approvalDecide(harness, { approvalId: draft.approval.id, nonce: draft.nonce });
    const sent = await comments.send({ taskId: draft.task.id, mode: 'go', principal: harness.owner });
    assert.equal(sent.operation.status, 'unknown');
    assert.equal(sent.task.status, 'unknown');
    assert.equal(sent.task.isSettled, false);
    const again = await comments.send({ taskId: draft.task.id, mode: 'go', principal: harness.owner });
    assert.equal(again.skipped, true);
  } finally {
    await harness.cleanup();
  }
});

test('auto mode refuses missing text unless templates are explicitly allowed', async () => {
  const strict = await setup({ comments: { mode: 'auto', allowTemplate: false } });
  try {
    await assert.rejects(
      () => strict.comments.createDraft({ candidate: mockCandidate('BV1'), text: null, principal: strict.harness.owner }),
      (error) => error.code === 'AGENT_DISABLED'
    );
  } finally {
    await strict.harness.cleanup();
  }
  const allowed = await setup({ comments: { mode: 'auto', allowTemplate: true, maxLength: 300 } });
  try {
    const draft = await allowed.comments.createDraft({ candidate: mockCandidate('BV1'), text: null, principal: allowed.harness.owner });
    assert.equal(draft.task.status, 'queued');
    assert.match(draft.task.input.text, /感谢分享/);
    const sent = await allowed.comments.send({ taskId: draft.task.id, mode: 'go', principal: allowed.harness.owner });
    assert.equal(sent.operation.status, 'confirmed');
  } finally {
    await allowed.harness.cleanup();
  }
});

test('self comments, max length and duplicate @owner are rejected', async () => {
  const { harness, comments } = await setup({
    comments: { mentionOwner: true },
  });
  harness.configService.config.owner.name = 'owner';
  try {
    await harness.store.transaction(async (draft) => {
      draft.configRevision = { ...draft.configRevision };
    });
    harness.configService.config.owner.name = 'owner';
    await assert.rejects(
      () =>
        comments.createDraft({
          candidate: mockCandidate('BV1', { author: { accountId: '1001', name: 'me' } }),
          text: 'x',
          principal: harness.owner
        }),
      (error) => error.code === 'FORBIDDEN'
    );
    await assert.rejects(
      () => comments.createDraft({ candidate: mockCandidate('BV2'), text: 'x'.repeat(400), principal: harness.owner }),
      (error) => error.code === 'INPUT_REQUIRED'
    );
    await assert.rejects(
      () => comments.createDraft({ candidate: mockCandidate('BV3'), text: '@owner @owner', principal: harness.owner }),
      (error) => error.code === 'INPUT_REQUIRED'
    );
  } finally {
    await harness.cleanup();
  }
});

test('human resume of a rejected comment creates a fresh approval and sends only once', async () => {
  const { harness, adapter, comments } = await setup();
  try {
    const draft = await comments.createDraft({
      candidate: mockCandidate('BVresume'),
      text: 'resume me',
      principal: harness.owner
    });
    await approvalDecide(harness, {
      approvalId: draft.approval.id,
      nonce: draft.nonce,
      decision: 'reject'
    });
    assert.equal((await harness.snapshot()).tasks[draft.task.id].status, 'failed');
    const resumed = await comments.resume({
      taskId: draft.task.id,
      mode: 'go',
      principal: harness.owner
    });
    assert.equal(resumed.task.status, 'waiting_approval');
    assert.ok(resumed.approval.id);
    assert.notEqual(resumed.approval.id, draft.approval.id);
    assert.equal(adapter.calls.writeComment.length, 0);
    await approvalDecide(harness, { approvalId: resumed.approval.id, nonce: resumed.nonce });
    const sent = await comments.send({ taskId: draft.task.id, mode: 'go', principal: harness.owner });
    assert.equal(sent.operation.status, 'confirmed');
    assert.equal(sent.task.status, 'succeeded');
    assert.equal(adapter.calls.writeComment.length, 1);
    const state = await harness.snapshot();
    assert.equal(Object.keys(state.tasks).length, 1);
    assert.equal(state.tasks[draft.task.id].attempts, 1);
  } finally {
    await harness.cleanup();
  }
});

test('comment resume refuses an unresolved unknown operation', async () => {
  const { harness, comments } = await setup({
    adapterOverrides: {
      async writeComment() {
        throw new Error('timeout');
      }
    }
  });
  try {
    const draft = await comments.createDraft({
      candidate: mockCandidate('BVunknown'),
      text: 'unknown resume',
      principal: harness.owner
    });
    await approvalDecide(harness, { approvalId: draft.approval.id, nonce: draft.nonce });
    const sent = await comments.send({ taskId: draft.task.id, mode: 'go', principal: harness.owner });
    assert.equal(sent.operation.status, 'unknown');
    await assert.rejects(
      () => comments.resume({ taskId: draft.task.id, mode: 'go', principal: harness.owner }),
      (error) => error.code === 'OPERATION_UNKNOWN'
    );
  } finally {
    await harness.cleanup();
  }
});
