import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, makeMockAdapter, mockCandidate, bindMockAccount } from './helpers/harness.js';
import { DirectMessagesModule } from '../src/modules/direct-messages.js';

async function setup({ dm = {}, adapterOverrides = {} } = {}) {
  const harness = await createHarness({
    overrides: {
      dryRun: false,
      directMessages: {
        enabled: true,
        allowedRecipientMids: [2002],
        requireMutual: true,
        perRound: 1,
        dailyLimit: 10,
        sameVideoDays: 7,
        maxLength: 300,
        ...dm
      }
    }
  });
  await bindMockAccount(harness);
  const adapter = makeMockAdapter();
  Object.assign(adapter, adapterOverrides);
  const directMessages = new DirectMessagesModule({
    store: harness.store,
    taskManager: harness.taskManager,
    adapter,
    configService: harness.configService,
    effectGateway: harness.effectGateway,
    now: harness.now
  });
  return { harness, adapter, directMessages };
}

test('whitelisted mutual DM sends once and records only a summary', async () => {
  const { harness, adapter, directMessages } = await setup();
  try {
    const result = await directMessages.send({
      content: mockCandidate('BV1'),
      recipientMid: 2002,
      text: '分享给你',
      mode: 'go',
      principal: harness.owner
    });
    assert.equal(result.operation.status, 'confirmed');
    assert.equal(result.task.status, 'succeeded');
    assert.equal(adapter.calls.sendDirectMessage.length, 1);
    assert.equal(adapter.calls.checkRecipient.length, 1);
    const state = await harness.snapshot();
    const event = state.events.find((entry) => entry.type === 'dm.task.created');
    assert.equal(event.payload.text, undefined);
    harness.now.advance(121000);
    await assert.rejects(
      () =>
        directMessages.send({
          content: mockCandidate('BV1'),
          recipientMid: 2002,
          text: '再次分享',
          mode: 'go',
          principal: harness.owner
        }),
      (error) => error.code === 'DUPLICATE_TARGET'
    );
  } finally {
    await harness.cleanup();
  }
});

test('arrays, non-whitelisted recipients and self are rejected before network', async () => {
  const { harness, adapter, directMessages } = await setup({
    dm: { allowedRecipientMids: [2002, 1001] }
  });
  try {
    await assert.rejects(
      () => directMessages.send({ recipientMid: [2002, 2003], text: 'x', mode: 'go', principal: harness.owner }),
      (error) => error.code === 'RECIPIENT_NOT_ALLOWED'
    );
    await assert.rejects(
      () => directMessages.send({ recipientMid: 9999, text: 'x', mode: 'go', principal: harness.owner }),
      (error) => error.code === 'RECIPIENT_NOT_ALLOWED'
    );
    await assert.rejects(
      () => directMessages.send({ recipientMid: 1001, text: 'x', mode: 'go', principal: harness.owner }),
      (error) => error.code === 'FORBIDDEN'
    );
    assert.equal(adapter.calls.sendDirectMessage.length, 0);
  } finally {
    await harness.cleanup();
  }
});

test('disabling mutual-follow still keeps the recipient whitelist', async () => {
  const { harness, adapter, directMessages } = await setup({ dm: { requireMutual: false } });
  try {
    await assert.rejects(
      () => directMessages.send({ recipientMid: 9999, text: 'x', mode: 'go', principal: harness.owner }),
      (error) => error.code === 'RECIPIENT_NOT_ALLOWED'
    );
    const result = await directMessages.send({
      content: mockCandidate('BV1'),
      recipientMid: 2002,
      text: 'hello',
      mode: 'go',
      principal: harness.owner
    });
    assert.equal(result.operation.status, 'confirmed');
    assert.equal(adapter.calls.relation.length, 0);
  } finally {
    await harness.cleanup();
  }
});

test('dry run does not call relation or send and creates an audited dry task', async () => {
  const { harness, adapter, directMessages } = await setup();
  try {
    const result = await directMessages.send({
      content: mockCandidate('BV1'),
      recipientMid: 2002,
      text: 'dry',
      mode: 'dry',
      principal: harness.owner
    });
    assert.equal(result.dryRun, true);
    assert.equal(result.task.status, 'succeeded');
    assert.equal(adapter.calls.sendDirectMessage.length, 0);
    assert.equal(adapter.calls.relation.length, 0);
  } finally {
    await harness.cleanup();
  }
});

test('mutual-follow requirement fails before any write', async () => {
  const { harness, adapter, directMessages } = await setup({
    adapterOverrides: {
      async checkRecipient() {
        throw Object.assign(new Error('not mutual'), { code: 'MUTUAL_FOLLOW_REQUIRED' });
      }
    }
  });
  try {
    await assert.rejects(
      () =>
        directMessages.send({
          content: mockCandidate('BV1'),
          recipientMid: 2002,
          text: 'hi',
          mode: 'go',
          principal: harness.owner
        }),
      (error) => error.code === 'MUTUAL_FOLLOW_REQUIRED'
    );
    assert.equal(adapter.calls.sendDirectMessage.length, 0);
  } finally {
    await harness.cleanup();
  }
});
