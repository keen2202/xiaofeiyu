import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './helpers/harness.js';
import { makePrincipal } from '../src/identity.js';
import { DshImChannelAdapter, ImBridge } from '../src/adapters/channels/dsh-im.js';
import { makeMockImHost } from './helpers/mock-channel.js';

async function setup({ im = {}, commandService = null, host = null, channel = null } = {}) {
  const harness = await createHarness({
    overrides: {
      im: {
        enabled: true,
        adapterId: 'dsh-im',
        maxMessageAgeSec: 600,
        approvalTtlSec: 600,
        groupReplies: 'summary',
        notifications: { enabled: true, minGapMs: 1000, perMinute: 10 },
        ...im
      }
    }
  });
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
      scopes: ['production.create', 'task.read.own', 'task.cancel.own', 'approval.decide.own']
    });
  });
  const calls = [];
  const service =
    commandService ||
    {
      async execute(envelope, principal, options) {
        calls.push({ envelope, principal, options });
        return {
          accepted: true,
          taskId: 'task_im_1',
          status: 'queued',
          executionMode: 'dry',
          result: { dryRun: true }
        };
      }
    };
  const adapter = new DshImChannelAdapter({
    host: host || makeMockImHost(),
    config: harness.configService.get(),
    now: harness.now
  });
  const bridge = new ImBridge({
    store: harness.store,
    identity: harness.identity,
    commandService: service,
    effectGateway: harness.effectGateway,
    configService: harness.configService,
    channel: channel || adapter,
    now: harness.now
  });
  return { harness, binding, calls, service, adapter, bridge };
}

const event = (overrides = {}) => ({
  adapterId: 'dsh-im',
  botAccountId: 'bot1',
  conversationId: 'conv1',
  senderRef: 'sender1',
  eventId: 'evt1',
  occurredAt: new Date('2026-11-06T23:59:00.000Z').toISOString(),
  command: {
    action: 'production.create',
    input: { requestId: 'p1' },
    mode: 'dry'
  },
  ...overrides
});

const trusted = {
  trusted: true,
  humanAssurance: 'verified',
  hostProof: { kind: 'test', ok: true }
};

test('adapter probe is read-only and unavailable without a host', async () => {
  const none = new DshImChannelAdapter({ host: null });
  const unavailable = await none.probe();
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.verified, false);
  const host = makeMockImHost();
  const adapter = new DshImChannelAdapter({ host, config: { im: { adapterId: 'dsh-im' } } });
  const capabilities = await adapter.probe();
  assert.equal(capabilities.status, 'available');
  assert.equal(capabilities.delivery.query, true);
  assert.equal(host.calls.probe, 1);
  assert.equal(host.calls.send.length, 0);
  assert.equal(host.calls.start, 0);
});

test('trusted IM event creates one task, replays dedupe and rejects body identity', async () => {
  const { harness, bridge, calls } = await setup();
  try {
    const first = await bridge.ingest(event(), trusted);
    assert.equal(first.accepted, true);
    assert.equal(calls.length, 1);
    const replay = await bridge.ingest(event(), trusted);
    assert.equal(replay.deduplicated, true);
    assert.equal(calls.length, 1);
    await assert.rejects(
      () => bridge.ingest(event({ command: { action: 'task.get', input: {}, mode: 'dry' } }), trusted),
      (error) => error.code === 'IDEMPOTENCY_CONFLICT'
    );
    await assert.rejects(
      () => bridge.ingest({ ...event({ eventId: 'evt-body' }), raw: { principal: 'owner', approved: true } }, trusted),
      (error) => error.code === 'FORBIDDEN'
    );
    await assert.rejects(
      () => bridge.ingest(event({ eventId: 'evt-untrusted' }), { trusted: false }),
      (error) => error.code === 'TRUST_UNAVAILABLE'
    );
  } finally {
    await harness.cleanup();
  }
});

test('revoked binding, stale/future messages and disallowed actions fail closed', async () => {
  const { harness, bridge, binding } = await setup();
  try {
    await assert.rejects(
      () => bridge.ingest(event({ eventId: 'future', occurredAt: new Date('2026-11-07T03:00:00.000Z').toISOString() }), trusted),
      (error) => error.code === 'FORBIDDEN'
    );
    await assert.rejects(
      () => bridge.ingest(event({ eventId: 'old', occurredAt: '2020-01-01T00:00:00.000Z' }), trusted),
      (error) => error.code === 'FORBIDDEN'
    );
    await assert.rejects(
      () => bridge.ingest(event({ eventId: 'dm', command: { action: 'dm.send', input: {}, mode: 'dry' } }), trusted),
      (error) => error.code === 'FORBIDDEN'
    );
    await harness.store.transaction(async (draft, tx) => harness.identity.revokeIm(tx, binding.bindingId));
    await assert.rejects(
      () => bridge.ingest(event({ eventId: 'revoked' }), trusted),
      (error) => error.code === 'FORBIDDEN'
    );
  } finally {
    await harness.cleanup();
  }
});

test('natural language only yields a candidate and no task', async () => {
  const { harness, bridge, calls } = await setup();
  try {
    const result = await bridge.ingest(event({ eventId: 'nl', command: '帮我做一个视频' }), trusted);
    assert.equal(result.accepted, false);
    assert.equal(result.candidate, true);
    assert.equal(result.taskId, null);
    assert.equal(calls.length, 0);
  } finally {
    await harness.cleanup();
  }
});

test('accepted command enqueues a reply outbox and delivery unknown never reruns the task', async () => {
  const host = makeMockImHost({ sendStatus: 'unknown', queryStatus: 'unknown' });
  const { harness, bridge, calls } = await setup({ host });
  try {
    const started = await bridge.start();
    assert.equal(started.started, true);
    const result = await bridge.ingest(event({ command: { action: 'production.create', input: { requestId: 'p-outbox' }, mode: 'dry' } }), trusted);
    assert.equal(result.accepted, true);
    assert.ok(result.notificationId);
    const dispatched = await bridge.dispatchOutbox(result.notificationId);
    assert.equal(dispatched.notification.status, 'unknown');
    const after = await harness.snapshot();
    assert.equal(after.outbox[result.notificationId].status, 'unknown');
    assert.equal(calls.length, 1);
    const queried = await bridge.queryOutbox(result.notificationId);
    assert.equal(queried.status, 'unknown');
    await assert.rejects(
      () => bridge.dispatchOutbox(result.notificationId),
      (error) => error.code === 'OPERATION_UNKNOWN'
    );
    assert.equal(calls.length, 1);
  } finally {
    await bridge.stop();
    await harness.cleanup();
  }
});

test('IM disabled reports feature disabled before any ingest', async () => {
  const { harness, bridge } = await setup({ im: { enabled: false } });
  try {
    await assert.rejects(() => bridge.ingest(event(), trusted), (error) => error.code === 'FEATURE_DISABLED');
  } finally {
    await harness.cleanup();
  }
});
