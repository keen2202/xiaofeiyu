// Optional local QQ bridge over OneBot v11 (no QQ SDK bundled): read-only
// capability probe, private-message event normalization, fail-closed trust
// semantics and outbound delivery result mapping.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_CONFIG,
  validateConfig
} from '../src/config.js';
import { createRuntime } from '../src/index.js';
import { makePrincipal } from '../src/identity.js';
import {
  OneBotHttpClient,
  OneBotQqHost,
  createOneBotQqHost,
  parseOneBotCommand,
  privateConversationId
} from '../src/adapters/channels/onebot-qq.js';
import { DshImChannelAdapter } from '../src/adapters/channels/dsh-im.js';
import { deepClone } from '../src/utils.js';

const BASE = 'http://127.0.0.1:3000';
const WS = 'ws://127.0.0.1:3001';

function configWith(im = {}) {
  const config = deepClone(DEFAULT_CONFIG);
  config.im = {
    ...config.im,
    enabled: true,
    transport: 'onebot-v11',
    onebot: { ...config.im.onebot, baseUrl: BASE, websocketUrl: WS },
    ...im
  };
  return config;
}

function fakeFetch(handlers = {}) {
  const calls = [];
  const impl = async (url, init) => {
    const action = new URL(url).pathname.split('/').filter(Boolean).pop();
    calls.push({ action, url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    const handler = handlers[action];
    if (handler instanceof Error) throw handler;
    if (typeof handler === 'function') return handler(url, init);
    if (handler === undefined) return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: {} }) };
    return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: handler }) };
  };
  impl.calls = calls;
  return impl;
}

class FakeWebSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.listeners = {};
    this.closed = false;
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type, handler) {
    (this.listeners[type] ||= []).push(handler);
  }
  emit(type, data = {}) {
    for (const handler of this.listeners[type] || []) handler(data);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', {});
  }
}

function resetFakeWebSockets() {
  FakeWebSocket.instances = [];
}

function lastSocket() {
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
}

function messageEvent(overrides = {}) {
  return {
    post_type: 'message',
    message_type: 'private',
    self_id: 10001,
    user_id: 20002,
    message_id: 1001,
    time: Math.floor(Date.now() / 1000),
    message: [{ type: 'text', data: { text: '{"action":"task.get","input":{},"mode":"dry"}' } }],
    ...overrides
  };
}

test('config accepts the optional onebot transport and validates its endpoint', () => {
  const valid = validateConfig(configWith());
  assert.equal(valid.im.transport, 'onebot-v11');
  assert.equal(valid.im.onebot.baseUrl, BASE);
  assert.throws(() => validateConfig(configWith({ onebot: { ...configWith().im.onebot, baseUrl: '' } })),
    (error) => error.code === 'CONFIG_INVALID' && /baseUrl/.test(error.message));
  assert.throws(() => validateConfig(configWith({ onebot: { ...configWith().im.onebot, websocketUrl: '' } })),
    (error) => error.code === 'CONFIG_INVALID' && /websocketUrl/.test(error.message));
  assert.throws(() => validateConfig(configWith({ onebot: { ...configWith().im.onebot, baseUrl: 'ftp://x' } })),
    (error) => error.code === 'CONFIG_INVALID');
  assert.throws(() => validateConfig(configWith({ onebot: { ...configWith().im.onebot, accessTokenEnv: 'not-a-name' } })),
    (error) => error.code === 'CONFIG_INVALID');
  // The default composition stays on dsh-im and performs no network activity.
  assert.equal(DEFAULT_CONFIG.im.transport, 'dsh-im');
  assert.equal(DEFAULT_CONFIG.im.onebot.baseUrl, '');
});

test('createOneBotQqHost only builds a host for a configured onebot-v11 transport', () => {
  assert.equal(createOneBotQqHost({ config: deepClone(DEFAULT_CONFIG), env: {} }), null);
  const disabled = configWith({ baseUrl: BASE, onebot: { ...configWith().im.onebot, baseUrl: '' } });
  assert.equal(createOneBotQqHost({ config: disabled, env: {} }), null);
  const host = createOneBotQqHost({ config: configWith(), env: {}, fetchImpl: fakeFetch(), WebSocketImpl: FakeWebSocket });
  assert.ok(host instanceof OneBotQqHost);
  // The token is read from the configured environment variable, never stored in config.
  const tokenHost = createOneBotQqHost({
    config: configWith(),
    env: { ONEBOT_ACCESS_TOKEN: 'sekret' },
    fetchImpl: fakeFetch(),
    WebSocketImpl: FakeWebSocket
  });
  assert.equal(tokenHost.http.accessToken, 'sekret');
});

test('onebot http client posts JSON actions with an access token and maps failures', async () => {
  const fetchImpl = fakeFetch({ get_status: { online: true, good: true } });
  const client = new OneBotHttpClient({ baseUrl: BASE, accessToken: 'sekret', fetchImpl });
  const data = await client.call('get_status', {});
  assert.equal(data.online, true);
  assert.equal(fetchImpl.calls[0].url.includes('access_token=sekret'), true);
  assert.deepEqual(fetchImpl.calls[0].body, {});

  const retcodeFetch = fakeFetch({
    send_private_msg: async () => ({ ok: true, status: 200, json: async () => ({ status: 'failed', retcode: 1200 }) })
  });
  await assert.rejects(
    () => new OneBotHttpClient({ baseUrl: BASE, fetchImpl: retcodeFetch }).call('send_private_msg', {}),
    (error) => error.notSent === true
  );

  const unreachable = new Error('fetch failed');
  unreachable.cause = { code: 'ECONNREFUSED' };
  await assert.rejects(
    () => new OneBotHttpClient({ baseUrl: BASE, fetchImpl: fakeFetch({ get_status: unreachable }) }).call('get_status'),
    (error) => error.notSent === true
  );

  const timedOut = new Error('The operation was aborted');
  timedOut.name = 'AbortError';
  await assert.rejects(
    () => new OneBotHttpClient({ baseUrl: BASE, fetchImpl: fakeFetch({ send_private_msg: timedOut }) }).call('send_private_msg'),
    (error) => error.notSent === false
  );
});

test('read-only probe reports bridge availability and never sends a message', async () => {
  const fetchImpl = fakeFetch({
    get_status: { online: true, good: true },
    get_login_info: { user_id: 10001, nickname: 'owner-bot' }
  });
  const host = new OneBotQqHost({ baseUrl: BASE, websocketUrl: WS, fetchImpl, WebSocketImpl: FakeWebSocket });
  const capabilities = await host.describeCapabilities();
  assert.equal(capabilities.status, 'available');
  assert.equal(capabilities.receive, true);
  assert.equal(capabilities.send, true);
  assert.equal(capabilities.humanIdentity, 'unverified');
  assert.deepEqual(capabilities.delivery, { query: false, idempotent: false });
  assert.deepEqual(host.loginInfo, { botAccountId: '10001', nickname: 'owner-bot' });
  assert.deepEqual(fetchImpl.calls.map((call) => call.action).sort(), ['get_login_info', 'get_status']);

  const noSocket = new OneBotQqHost({ baseUrl: BASE, fetchImpl, WebSocketImpl: FakeWebSocket });
  const partial = await noSocket.describeCapabilities();
  assert.equal(partial.status, 'unavailable');
  assert.equal(partial.reason, 'websocket_url_missing');

  const unreachable = new Error('fetch failed');
  unreachable.cause = { code: 'ECONNREFUSED' };
  const blocked = await new OneBotQqHost({ baseUrl: BASE, websocketUrl: WS, fetchImpl: fakeFetch({ get_status: unreachable }), WebSocketImpl: FakeWebSocket }).describeCapabilities();
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.reason, 'bridge_unreachable');

  const unauthorizedFetch = async () => ({ ok: false, status: 401, json: async () => ({ status: 'failed', retcode: 401 }) });
  const unauthorized = await new OneBotQqHost({ baseUrl: BASE, websocketUrl: WS, fetchImpl: unauthorizedFetch, WebSocketImpl: FakeWebSocket }).describeCapabilities();
  assert.equal(unauthorized.status, 'blocked');
  assert.equal(unauthorized.reason, 'auth_rejected');
});

test('host normalizes only private messages and marks human assurance unverified', async () => {
  resetFakeWebSockets();
  const host = new OneBotQqHost({ baseUrl: BASE, websocketUrl: WS, fetchImpl: fakeFetch(), WebSocketImpl: FakeWebSocket, reconnectMs: 60000 });
  const events = [];
  await host.start((event, trustedContext) => { events.push({ event, trustedContext }); });
  const socket = lastSocket();
  assert.equal(socket.url.includes('ws://127.0.0.1:3001'), true);

  socket.emit('message', { data: JSON.stringify(messageEvent()) });
  socket.emit('message', { data: JSON.stringify(messageEvent({ post_type: 'meta_event', meta_event_type: 'heartbeat' })) });
  socket.emit('message', { data: JSON.stringify(messageEvent({ message_type: 'group', group_id: 30003 })) });
  socket.emit('message', { data: JSON.stringify(messageEvent({ user_id: 10001 })) });
  socket.emit('message', { data: 'not json' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(events.length, 1);
  const { event, trustedContext } = events[0];
  assert.equal(event.adapterId, 'dsh-im');
  assert.equal(event.botAccountId, '10001');
  assert.equal(event.conversationId, privateConversationId(20002));
  assert.equal(event.senderRef, '20002');
  assert.equal(event.eventId, 'msg:1001');
  assert.deepEqual(event.command, { action: 'task.get', input: {}, mode: 'dry' });
  assert.equal(event.group, false);
  assert.equal(trustedContext.trusted, true);
  assert.equal(trustedContext.humanAssurance, 'unverified');
  assert.equal(trustedContext.hostProof, null);
  await host.stop();
});

test('plain text becomes a natural-language candidate, not a structured command', () => {
  assert.equal(parseOneBotCommand('  hello  '), 'hello');
  assert.equal(parseOneBotCommand('{bad json'), '{bad json');
  assert.deepEqual(parseOneBotCommand('{"action":"task.list","input":{}}'), { action: 'task.list', input: {} });
  assert.equal(parseOneBotCommand('[CQ:face,id=1] hi'.replace('[CQ:face,id=1] ', '')), 'hi');
});

test('outbound sends map to sent/not_sent/unknown and reject non-private targets', async () => {
  resetFakeWebSockets();
  const fetchImpl = fakeFetch({ send_private_msg: { message_id: 777 } });
  const host = new OneBotQqHost({ baseUrl: BASE, websocketUrl: WS, fetchImpl, WebSocketImpl: FakeWebSocket });
  await host.start(() => {});
  const sent = await host.send({ conversationId: 'private:20002', text: 'hello' });
  assert.deepEqual(sent, {
    status: 'sent',
    receipt: { platform: 'onebot-v11', externalId: '777', receivedAt: sent.receipt.receivedAt }
  });
  assert.equal(fetchImpl.calls.find((call) => call.action === 'send_private_msg').body.user_id, 20002);

  await assert.rejects(
    () => host.send({ conversationId: 'group:30003', text: 'hi' }),
    (error) => error.code === 'FORBIDDEN'
  );

  const rejected = new Error('fetch failed');
  rejected.cause = { code: 'ECONNREFUSED' };
  const downHost = new OneBotQqHost({ baseUrl: BASE, websocketUrl: WS, fetchImpl: fakeFetch({ get_status: {}, get_login_info: {}, send_private_msg: rejected }), WebSocketImpl: FakeWebSocket });
  await downHost.start(() => {});
  await assert.rejects(() => downHost.send({ conversationId: 'private:20002', text: 'hi' }), (error) => error.notSent === true);

  const stalled = new Error('The operation was aborted');
  stalled.name = 'AbortError';
  const stalledHost = new OneBotQqHost({ baseUrl: BASE, websocketUrl: WS, fetchImpl: fakeFetch({ get_status: {}, get_login_info: {}, send_private_msg: stalled }), WebSocketImpl: FakeWebSocket });
  await stalledHost.start(() => {});
  await assert.rejects(() => stalledHost.send({ conversationId: 'private:20002', text: 'hi' }), (error) => error.code === 'OPERATION_UNKNOWN');
  await host.stop();
  await downHost.stop();
  await stalledHost.stop();
});

test('dsh-im adapter exposes the onebot host capabilities and delivery results', async () => {
  resetFakeWebSockets();
  const fetchImpl = fakeFetch({
    get_status: { online: true },
    get_login_info: { user_id: 10001, nickname: 'bot' },
    send_private_msg: { message_id: 888 }
  });
  const host = new OneBotQqHost({ baseUrl: BASE, websocketUrl: WS, fetchImpl, WebSocketImpl: FakeWebSocket });
  const adapter = new DshImChannelAdapter({
    host,
    config: configWith(),
    now: () => new Date()
  });
  const capabilities = await adapter.probe();
  assert.equal(capabilities.status, 'available');
  assert.equal(capabilities.humanIdentity, false);
  assert.equal(capabilities.delivery.query, false);
  await adapter.start(() => ({ accepted: true }));
  const sent = await adapter.send(
    { notificationId: 'n1', bindingId: 'b1', conversationId: 'private:20002' },
    { summary: 'Task t1: succeeded' }
  );
  assert.equal(sent.status, 'sent');
  assert.equal(sent.receipt.externalId, '888');
  await assert.rejects(
    () => adapter.queryDelivery('n1', {}),
    (error) => error.code === 'CAPABILITY_UNSUPPORTED'
  );
  await adapter.stop();
});

test('onebot host reconnects after an unexpected close and stops cleanly', async () => {
  resetFakeWebSockets();
  const host = new OneBotQqHost({ baseUrl: BASE, websocketUrl: WS, fetchImpl: fakeFetch(), WebSocketImpl: FakeWebSocket, reconnectMs: 1000 });
  await host.start(() => {});
  const first = lastSocket();
  first.emit('close', {});
  assert.notEqual(host.reconnectTimer, null, 'an unexpected close must schedule a reconnect');
  assert.equal(host.socket, null);
  await host.stop();
  assert.equal(host.started, false);
  assert.equal(host.reconnectTimer, null);
  assert.equal(host.stopped, true);
});

test('runtime creates the optional onebot host only from an enabled onebot-v11 config', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-onebot-'));
  const offlineFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ status: 'ok', retcode: 0, data: { online: false } })
  });
  const config = configWith({ enabled: true });
  config.dataDir = dir;
  const runtime = await createRuntime({
    dataDir: dir,
    config,
    env: {},
    fetchImpl: offlineFetch,
    humanVerifier: { async verify() { return false; } }
  });
  try {
    await runtime.start();
    assert.equal(runtime.componentStatus.im.started, false);
    assert.equal(runtime.componentStatus.im.error.code, 'DEPENDENCY_UNAVAILABLE');
    const owner = makePrincipal({
      id: 'owner_onebot_probe',
      kind: 'human',
      role: 'owner',
      sourceKind: 'local_cli',
      scopes: ['*'],
      workspaceId: 'workspace_test'
    });
    const status = await runtime.status(owner);
    assert.equal(status.components.im.transport, 'onebot-v11');
    assert.equal(status.components.im.hostSource, 'onebot-v11');
    assert.equal(status.components.im.configured, true);
    assert.equal(status.components.im.started, false);
    assert.equal(status.components.im.capabilities.status, 'unavailable');
    assert.equal(status.components.im.capabilities.reason, 'host_lacks_required_capability');
    assert.equal(status.components.im.capabilities.receive, false);
    assert.equal(status.components.im.capabilities.send, false);
  } finally {
    await runtime.close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
