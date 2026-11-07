import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, bindMockAccount } from './helpers/harness.js';
import { makePrincipal } from '../src/identity.js';
import { makeMockChannel } from './helpers/mock-channel.js';

async function setup({ protection = 'protected', notifications = { enabled: true, minGapMs: 1000, perMinute: 2 } } = {}) {
  const harness = await createHarness({
    protection,
    overrides: {
      im: {
        enabled: true,
        adapterId: 'dsh-im',
        maxMessageAgeSec: 600,
        approvalTtlSec: 600,
        groupReplies: 'summary',
        notifications
      }
    }
  });
  await bindMockAccount(harness);
  const binding = await harness.store.transaction(async (draft, tx) => {
    const principal = makePrincipal({
      id: 'im_user',
      kind: 'human',
      role: 'user',
      sourceKind: 'host_human_challenge',
      scopes: [],
      workspaceId: draft.workspaceId
    });
    draft.principals[principal.id] = principal;
    return harness.identity.bindIm(tx, {
      adapterId: 'dsh-im',
      botAccountId: 'bot1',
      senderRef: 'sender1',
      conversationIds: ['conv1'],
      principalId: principal.id,
      scopes: ['task.read.own']
    });
  });
  return { harness, binding };
}

async function enqueue(harness, binding, summary = 'reply') {
  await harness.effectGateway.assertNotificationProtection(binding, 'conv1');
  return harness.store.transaction(async (draft, tx) =>
    harness.effectGateway.appendNotification(tx, {
      bindingId: binding.bindingId,
      conversationId: 'conv1',
      summary,
      taskId: null
    })
  );
}

test('notification dispatch is separate from business settlement and settles sent', async () => {
  const { harness, binding } = await setup();
  const channel = makeMockChannel();
  try {
    const notification = await enqueue(harness, binding);
    const result = await harness.effectGateway.dispatchNotification(notification.id, channel);
    assert.equal(result.notification.status, 'sent');
    assert.equal(channel.calls.send.length, 1);
    assert.equal(channel.calls.send[0].context.notificationId, notification.id);
    const state = await harness.snapshot();
    assert.equal(state.outbox[notification.id].status, 'sent');
    assert.equal(state.tasks && Object.keys(state.tasks).length, 0);
  } finally {
    await harness.cleanup();
  }
});

test('delivery query revives unknown without rerunning the task; human resolve works', async () => {
  const { harness, binding } = await setup();
  const channel = makeMockChannel({ sendStatus: 'unknown', queryStatus: 'sent' });
  try {
    const notification = await enqueue(harness, binding);
    const first = await harness.effectGateway.dispatchNotification(notification.id, channel);
    assert.equal(first.notification.status, 'unknown');
    const queried = await harness.effectGateway.queryNotificationDelivery(notification.id, channel);
    assert.equal(queried.status, 'sent');
    assert.equal(channel.calls.query.length, 1);
  } finally {
    await harness.cleanup();
  }
  const second = await setup();
  const unknownChannel = makeMockChannel({ sendStatus: 'unknown' });
  try {
    const notification = await enqueue(second.harness, second.binding);
    await second.harness.effectGateway.dispatchNotification(notification.id, unknownChannel);
    const resolved = await second.harness.effectGateway.resolveNotification(
      { notificationId: notification.id, decision: 'confirmed', receipt: { externalId: 'x' }, note: 'delivered' },
      second.harness.humanContext
    );
    assert.equal(resolved.status, 'sent');
  } finally {
    await second.harness.cleanup();
  }
});

test('revoked bindings are suppressed and unprotected sends are blocked before dispatch', async () => {
  const { harness, binding } = await setup();
  try {
    await harness.store.transaction(async (draft, tx) => harness.identity.revokeIm(tx, binding.bindingId));
    await assert.rejects(
      () => enqueue(harness, binding),
      (error) => error.code === 'FORBIDDEN'
    );
    const unprotected = await setup({ protection: 'unprotected' });
    try {
      await assert.rejects(
        () => enqueue(unprotected.harness, unprotected.binding),
        (error) => error.code === 'BACKUP_UNPROTECTED'
      );
    } finally {
      await unprotected.harness.cleanup();
    }
  } finally {
    await harness.cleanup();
  }
});

test('notification budget is independent and enforced per minute', async () => {
  const { harness, binding } = await setup({ notifications: { enabled: true, minGapMs: 1000, perMinute: 1 } });
  try {
    await enqueue(harness, binding, 'first');
    harness.now.advance(1500);
    await assert.rejects(
      () => enqueue(harness, binding, 'second'),
      (error) => error.code === 'QUOTA_EXCEEDED'
    );
    harness.now.advance(60000);
    const third = await enqueue(harness, binding, 'third');
    assert.ok(third.id);
  } finally {
    await harness.cleanup();
  }
});
