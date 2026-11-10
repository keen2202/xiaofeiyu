// Optional OFFICIAL QQ bot transport (src/adapters/channels/qq-official.js):
// token exchange, read-only capability probe, gateway WS identify/normalize,
// passive reply sending and dsh-im adapter integration. No real network.
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
  DEFAULT_INTENTS,
  QQOfficialHost,
  createQQOfficialHost,
  fetchAppAccessToken,
  parseOfficialCommand
} from '../src/adapters/channels/qq-official.js';
import { DshImChannelAdapter } from '../src/adapters/channels/dsh-im.js';
import { deepClone } from '../src/utils.js';

const API = 'https://api.bot.qq.com';
const WS = 'wss://api.bot.qq.com/websocket/';

function configWith(im = {}, qq = {}) {
  const config = deepClone(DEFAULT_CONFIG);
  config.im = {
    ...config.im,
    enabled: true,
    transport: 'qq-official',
    qqOfficial: { ...config.im.qqOfficial, ...qq },
    ...im
  };
  return config;
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

function scriptedFetch(script, calls = []) {
  const impl = async (url, options = {}) => {
    calls.push({
      url: String(url),
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body ? JSON.parse(options.body) : null
    });
    const handler = script.shift();
    if (!handler) throw new Error(`unexpected request: ${url}`);
    return handler(String(url), options);
  };
  impl.calls = calls;
  return impl;
}

class FakeWebSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.listeners = {};
    this.sent = [];
    this.closed = false;
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  emit(type, data = {}) { for (const handler of this.listeners[type] || []) handler(data); }
  send(text) { this.sent.push(JSON.parse(text)); }
  close() { if (this.closed) return; this.closed = true; this.emit('close', {}); }
}

function resetSockets() { FakeWebSocket.instances = []; }
function lastSocket() { return FakeWebSocket.instances[FakeWebSocket.instances.length - 1]; }

function helloFrame(interval = 45000) { return JSON.stringify({ op: 10, d: { heartbeat_interval: interval } }); }
function readyFrame(user = { id: 'bot-1', username: '测试机器人' }) {
  return JSON.stringify({ op: 0, s: 1, t: 'READY', d: { session_id: 'session-1', user } });
}
function c2cFrame(overrides = {}) {
  return JSON.stringify({
    id: 'event-1',
    op: 0,
    s: 2,
    t: 'C2C_MESSAGE_CREATE',
    d: {
      id: 'ROBOT1.0_msg_1',
      author: { id: 'openid-1', user_openid: 'openid-1', username: '', bot: false },
      content: '{"action":"task.list","input":{},"mode":"dry"}',
      timestamp: '2026-11-10T18:00:00+08:00',
      message_type: 0,
      message_scene: { source: 'default', ext: [] },
      ...overrides
    }
  });
}

function hostFetch(overrides = {}) {
  const script = [
    () => jsonResponse(200, { access_token: 'TOKEN', expires_in: 7200 }),
    () => jsonResponse(200, { id: 'bot-1', username: '测试机器人', bot: true }),
    () => jsonResponse(200, { url: WS })
  ];
  if (overrides.forSend) return scriptedFetch([...script, overrides.forSend]);
  return scriptedFetch(script);
}

async function makeHost(overrides = {}) {
  resetSockets();
  const fetchImpl = overrides.fetchImpl || hostFetch();
  const host = new QQOfficialHost({
    apiBase: API,
    appId: 'APP_ID',
    clientSecret: 'SECRET',
    fetchImpl,
    WebSocketImpl: FakeWebSocket,
    reconnectMs: 60000,
    ...overrides
  });
  return host;
}

test('config accepts the official QQ bot transport and validates its settings', () => {
  const valid = validateConfig(configWith());
  assert.equal(valid.im.transport, 'qq-official');
  assert.equal(valid.im.qqOfficial.apiBase, API);
  assert.equal(DEFAULT_CONFIG.im.qqOfficial.appIdEnv, 'QQBOT_APP_ID');
  assert.throws(
    () => validateConfig(configWith({}, { apiBase: 'http://api.bot.qq.com' })),
    (error) => error.code === 'CONFIG_INVALID'
  );
  assert.throws(
    () => validateConfig(configWith({}, { appIdEnv: 'not-an-env-name' })),
    (error) => error.code === 'CONFIG_INVALID'
  );
  assert.throws(
    () => validateConfig(configWith({}, { intents: -1 })),
    (error) => error.code === 'CONFIG_INVALID'
  );
});

test('createQQOfficialHost reads AppID/Secret from env names and only for the transport', () => {
  assert.equal(createQQOfficialHost({ config: deepClone(DEFAULT_CONFIG) }), null);
  const host = createQQOfficialHost({
    config: configWith(),
    env: { QQBOT_APP_ID: 'A', QQBOT_APP_SECRET: 'S' },
    fetchImpl: hostFetch(),
    WebSocketImpl: FakeWebSocket
  });
  assert.equal(host.appId, 'A');
  assert.equal(host.clientSecret, 'S');
  assert.deepEqual(host.envNames, { appIdEnv: 'QQBOT_APP_ID', appSecretEnv: 'QQBOT_APP_SECRET' });
  const missing = createQQOfficialHost({ config: configWith(), env: {}, fetchImpl: hostFetch(), WebSocketImpl: FakeWebSocket });
  assert.equal(missing.appId, null);
});

test('probe reports app_credentials_missing, token_failed and available', async () => {
  const noCreds = new QQOfficialHost({ apiBase: API, fetchImpl: async () => { throw new Error('must not call'); }, WebSocketImpl: FakeWebSocket });
  const missing = await noCreds.describeCapabilities();
  assert.equal(missing.status, 'blocked');
  assert.equal(missing.reason, 'app_credentials_missing');

  const tokenFail = await new QQOfficialHost({
    apiBase: API,
    appId: 'A',
    clientSecret: 'S',
    fetchImpl: scriptedFetch([() => jsonResponse(200, { code: 100016, message: 'invalid' })]),
    WebSocketImpl: FakeWebSocket
  }).describeCapabilities();
  assert.equal(tokenFail.status, 'blocked');
  assert.equal(tokenFail.reason, 'token_failed');
  assert.equal(tokenFail.error.code, 100016);

  const host = await makeHost();
  const capabilities = await host.describeCapabilities();
  assert.equal(capabilities.status, 'available');
  assert.equal(capabilities.receive, true);
  assert.equal(capabilities.send, true);
  assert.equal(capabilities.humanIdentity, 'unverified');
  assert.deepEqual(capabilities.delivery, { query: false, idempotent: false });
  assert.deepEqual(host.botIdentity, { botAccountId: 'bot-1', username: '测试机器人' });
  assert.equal(host.gatewayUrl, WS);
});

test('gateway identify uses QQBot token and the C2C event is normalized', async () => {
  const host = await makeHost();
  const events = [];
  await host.start((event, trustedContext) => { events.push({ event, trustedContext }); });
  const socket = lastSocket();
  assert.equal(socket.url, WS);
  socket.emit('message', { data: helloFrame(1000) });
  await new Promise((resolve) => setImmediate(resolve));
  const identify = socket.sent.find((frame) => frame.op === 2);
  assert.ok(identify);
  assert.equal(identify.d.token, 'QQBot TOKEN');
  assert.equal(identify.d.intents, DEFAULT_INTENTS);
  assert.deepEqual(identify.d.shard, [0, 1]);
  const heartbeat = socket.sent.find((frame) => frame.op === 1);
  assert.ok(heartbeat);
  assert.equal(heartbeat.d, null);

  socket.emit('message', { data: readyFrame() });
  socket.emit('message', { data: c2cFrame() });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.length, 1);
  const { event, trustedContext } = events[0];
  assert.equal(event.adapterId, 'dsh-im');
  assert.equal(event.conversationId, 'private:openid-1');
  assert.equal(event.senderRef, 'openid-1');
  assert.equal(event.eventId, 'ROBOT1.0_msg_1');
  assert.equal(event.occurredAt, '2026-11-10T10:00:00.000Z');
  assert.deepEqual(event.command, { action: 'task.list', input: {}, mode: 'dry' });
  assert.equal(trustedContext.trusted, true);
  assert.equal(trustedContext.source, 'qq-official');
  assert.equal(trustedContext.humanAssurance, 'unverified');
  await host.stop();
});

test('passive replies use the inbound msg_id and proactive fallback handles expired ids', async () => {
  const fetchImpl = scriptedFetch([
    () => jsonResponse(200, { access_token: 'TOKEN', expires_in: 7200 }),
    () => jsonResponse(200, { id: 'bot-1', username: 'bot', bot: true }),
    () => jsonResponse(200, { url: WS }),
    () => jsonResponse(200, { id: 'sent-1', timestamp: '2026-11-10T18:00:01+08:00' }),
    () => jsonResponse(200, { code: 40034005, message: 'msg_id expired' }),
    () => jsonResponse(200, { id: 'sent-2', timestamp: '2026-11-10T18:00:02+08:00' })
  ]);
  const host = await makeHost({ fetchImpl });
  await host.start(() => {});
  const socket = lastSocket();
  socket.emit('message', { data: helloFrame(1000) });
  socket.emit('message', { data: readyFrame() });
  socket.emit('message', { data: c2cFrame() });
  await new Promise((resolve) => setImmediate(resolve));

  const passive = await host.send({ conversationId: 'private:openid-1', text: 'hi' });
  assert.equal(passive.status, 'sent');
  assert.equal(passive.receipt.externalId, 'sent-1');
  const firstSend = fetchImpl.calls.find((call) => call.url.includes('/v2/users/openid-1/messages'));
  assert.equal(firstSend.body.msg_id, 'ROBOT1.0_msg_1');
  assert.equal(firstSend.body.msg_seq, 1);
  assert.equal(firstSend.headers.authorization, 'QQBot TOKEN');

  const expired = await host.send({ conversationId: 'private:openid-1', text: 'again' });
  assert.equal(expired.receipt.externalId, 'sent-2');
  await host.stop();
});

test('send maps provable failures to not_sent and ambiguous ones to unknown', async () => {
  const fetchImpl = scriptedFetch([
    () => jsonResponse(200, { access_token: 'TOKEN', expires_in: 7200 }),
    () => jsonResponse(200, { id: 'bot-1', username: 'bot', bot: true }),
    () => jsonResponse(200, { url: WS }),
    () => jsonResponse(200, { code: 40054004, message: 'no friend relationship' }),
    () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } }); }
  ]);
  const host = await makeHost({ fetchImpl });
  await host.start(() => {});
  const socket = lastSocket();
  socket.emit('message', { data: helloFrame(1000) });
  socket.emit('message', { data: readyFrame() });
  await new Promise((resolve) => setImmediate(resolve));

  await assert.rejects(
    () => host.send({ conversationId: 'private:openid-x', text: 'hi' }),
    (error) => error.notSent === true && error.code === 40054004
  );
  await assert.rejects(
    () => host.send({ conversationId: 'private:openid-x', text: 'hi' }),
    (error) => error.code === 'OPERATION_UNKNOWN'
  );
  await assert.rejects(
    () => host.send({ conversationId: 'other:1', text: 'hi' }),
    (error) => error.code === 'FORBIDDEN'
  );
  await host.stop();
});

test('dsh-im adapter can use the official host and refuses delivery queries', async () => {
  const hostFetchImpl = scriptedFetch([
    () => jsonResponse(200, { access_token: 'TOKEN', expires_in: 7200 }),
    () => jsonResponse(200, { id: 'bot-1', username: 'bot', bot: true }),
    () => jsonResponse(200, { url: WS }),
    () => jsonResponse(200, { id: 'sent-9' })
  ]);
  const host = await makeHost({ fetchImpl: hostFetchImpl });
  const adapter = new DshImChannelAdapter({ host, config: configWith(), now: () => new Date() });
  const capabilities = await adapter.probe();
  assert.equal(capabilities.status, 'available');
  assert.equal(capabilities.humanIdentity, false);
  assert.equal(capabilities.delivery.query, false);
  await adapter.start(() => ({ accepted: true }));
  const sent = await adapter.send(
    { notificationId: 'n1', bindingId: 'b1', conversationId: 'private:openid-1' },
    { summary: 'Task t1: succeeded' }
  );
  assert.equal(sent.status, 'sent');
  assert.equal(sent.receipt.externalId, 'sent-9');
  await assert.rejects(() => adapter.queryDelivery('n1', {}), (error) => error.code === 'CAPABILITY_UNSUPPORTED');
  await adapter.stop();
});

test('parseOfficialCommand keeps natural language as a candidate', () => {
  assert.equal(parseOfficialCommand(' 你好 '), '你好');
  assert.deepEqual(parseOfficialCommand('{"action":"task.list","input":{}}'), { action: 'task.list', input: {} });
  assert.equal(parseOfficialCommand('not json {'), 'not json {');
});

test('runtime wires the official QQ host only from an enabled qq-official config', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-qqofficial-'));
  const config = configWith({ enabled: true });
  config.dataDir = dir;
  const fetchImpl = scriptedFetch([
    () => jsonResponse(200, { access_token: 'TOKEN', expires_in: 7200 }),
    () => jsonResponse(200, { id: 'bot-1', username: '测试机器人', bot: true }),
    () => jsonResponse(200, { url: WS })
  ]);
  const runtime = await createRuntime({
    dataDir: dir,
    config,
    env: { QQBOT_APP_ID: 'APP_ID', QQBOT_APP_SECRET: 'SECRET' },
    fetchImpl,
    webSocketImpl: FakeWebSocket,
    humanVerifier: { async verify() { return false; } }
  });
  try {
    await runtime.start();
    assert.equal(runtime.componentStatus.im.started, true);
    const owner = makePrincipal({
      id: 'owner_qq_official',
      kind: 'human',
      role: 'owner',
      sourceKind: 'local_cli',
      scopes: ['*'],
      workspaceId: 'workspace_test'
    });
    const status = await runtime.status(owner);
    assert.equal(status.components.im.transport, 'qq-official');
    assert.equal(status.components.im.hostSource, 'qq-official');
    assert.equal(status.components.im.configured, true);
    assert.equal(status.components.im.started, true);
    assert.equal(status.components.im.capabilities.status, 'available');
    const socket = lastSocket();
    assert.ok(socket);
  } finally {
    await runtime.close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
