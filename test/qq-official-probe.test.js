// Read-only official QQ bot probe (scripts/acceptance/qq-official-probe.mjs):
// token exchange, identity/gateway calls and secret handling. No real network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchAppAccessToken,
  callOfficialApi,
  probeOfficialBot
} from '../scripts/acceptance/qq-official-probe.mjs';

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; }
  };
}

function scriptedFetch(script, calls = []) {
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', headers: options.headers || {}, body: options.body ? JSON.parse(options.body) : null });
    const handler = script.shift();
    if (!handler) throw new Error('unexpected request');
    return handler(String(url), options);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test('official probe exchanges the token and reads identity/gateway without leaking secrets', async () => {
  const calls = [];
  const fetchImpl = scriptedFetch([
    () => jsonResponse(200, { access_token: 'SECRET_TOKEN_VALUE', expires_in: 7200 }),
    () => jsonResponse(200, { id: 'bot-openid', username: 'QQ机器人', bot: true }),
    () => jsonResponse(200, { url: 'wss://api.bot.qq.com/websocket/' })
  ], calls);
  const result = await probeOfficialBot({
    appId: 'APP_ID_VALUE',
    clientSecret: 'CLIENT_SECRET_VALUE',
    fetchImpl
  });
  assert.equal(result.ok, true);
  assert.equal(result.tokenAcquired, true);
  assert.equal(result.tokenExpiresIn, 7200);
  assert.deepEqual(result.bot, { id: 'bot-openid', username: 'QQ机器人', bot: true });
  assert.equal(result.gatewayUrl, 'wss://api.bot.qq.com/websocket/');
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, 'https://api.bot.qq.com/app/getAppAccessToken');
  assert.deepEqual(calls[0].body, { appId: 'APP_ID_VALUE', clientSecret: 'CLIENT_SECRET_VALUE' });
  assert.equal(calls[1].url, 'https://api.bot.qq.com/users/@me');
  assert.equal(calls[1].headers.authorization, 'QQBot SECRET_TOKEN_VALUE');
  assert.equal(calls[2].url, 'https://api.bot.qq.com/gateway');
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('SECRET_TOKEN_VALUE'), false);
  assert.equal(serialized.includes('CLIENT_SECRET_VALUE'), false);
  assert.equal(serialized.includes('APP_ID_VALUE'), false);
});

test('token business errors surface the code and hint without echoing secrets', async () => {
  const fetchImpl = scriptedFetch([
    () => jsonResponse(200, { code: 100016, message: 'invalid appid or secret' })
  ]);
  await assert.rejects(
    () => fetchAppAccessToken({ appId: 'A', clientSecret: 'S', fetchImpl }),
    (error) => error.name === 'QQOfficialApiError'
      && error.code === 100016
      && /ClientSecret/.test(error.hint || '')
      && !error.message.includes('S')
  );
});

test('API errors and transport errors fail closed', async () => {
  await assert.rejects(
    () => callOfficialApi({
      pathname: '/users/@me',
      accessToken: 'T',
      fetchImpl: scriptedFetch([() => jsonResponse(401, { code: 11241, message: 'unauthorized' })])
    }),
    (error) => error.code === 11241
  );
  const unreachable = new Error('fetch failed');
  unreachable.cause = { code: 'ECONNREFUSED' };
  await assert.rejects(
    () => fetchAppAccessToken({ appId: 'A', clientSecret: 'S', fetchImpl: scriptedFetch([() => { throw unreachable; }]) }),
    (error) => error.code === 'ECONNREFUSED'
  );
});

test('missing credentials are rejected before any request', async () => {
  const calls = [];
  const fetchImpl = scriptedFetch([], calls);
  await assert.rejects(() => fetchAppAccessToken({ appId: '', clientSecret: 'S', fetchImpl }), /AppID is missing/);
  await assert.rejects(() => fetchAppAccessToken({ appId: 'A', clientSecret: ' ', fetchImpl }), /ClientSecret is missing/);
  assert.equal(calls.length, 0);
});
