#!/usr/bin/env node
// Read-only probe for the OFFICIAL QQ bot API (bot.q.qq.com / api.bot.qq.com).
//
// This is NOT the OneBot v11 transport used by src/adapters/channels/onebot-qq.js.
// The official bot platform authenticates with AppID + ClientSecret (from the
// bot management console) and exchanges them for a short-lived access_token;
// there is no static "token environment variable" to hand out.
//
//   $env:QQBOT_APP_ID = '...'          # from bot.q.qq.com -> 开发设置 (AppID)
//   $env:QQBOT_APP_SECRET = '...'      # ClientSecret (AppSecret), never printed
//   node scripts/acceptance/qq-official-probe.mjs
//
// It performs only: token exchange, GET /users/@me, GET /gateway. No message is
// sent and no token/secret is printed.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './_common.mjs';

export const DEFAULT_API_BASE = 'https://api.bot.qq.com';

const TOKEN_ERROR_HINTS = {
  100001: '请求过于频繁，稍后重试',
  100007: 'AppID 无效或机器人状态异常（被封禁/已删除）',
  100016: 'AppID 或 ClientSecret 不正确',
  10004: 'AppID 对应的机器人不存在'
};

export class QQOfficialProbeError extends Error {
  constructor(message, { code = null, hint = null, cause = undefined } = {}) {
    super(message);
    this.name = 'QQOfficialProbeError';
    this.code = code;
    this.hint = hint;
    if (cause !== undefined) this.cause = cause;
  }
}

function ensureFetch(fetchImpl) {
  if (typeof fetchImpl !== 'function') {
    throw new QQOfficialProbeError('HTTP fetch is unavailable in this runtime');
  }
  return fetchImpl;
}

async function readJsonResponse(response, label) {
  let body;
  try {
    body = await response.json();
  } catch (error) {
    throw new QQOfficialProbeError(`${label} returned a non-JSON body`, { cause: error });
  }
  return body ?? {};
}

/** Exchange AppID + ClientSecret for a short-lived access_token (read-only). */
export async function fetchAppAccessToken({
  appId,
  clientSecret,
  tokenUrl = `${DEFAULT_API_BASE}/app/getAppAccessToken`,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10000
} = {}) {
  const fetcher = ensureFetch(fetchImpl);
  if (typeof appId !== 'string' || appId.trim() === '') {
    throw new QQOfficialProbeError('AppID is missing');
  }
  if (typeof clientSecret !== 'string' || clientSecret.trim() === '') {
    throw new QQOfficialProbeError('ClientSecret is missing');
  }
  let response;
  try {
    response = await fetcher(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId: appId.trim(), clientSecret: clientSecret.trim() }),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    throw new QQOfficialProbeError('cannot reach the token endpoint', {
      code: error?.cause?.code || error?.name || null,
      cause: error
    });
  }
  const body = await readJsonResponse(response, 'token endpoint');
  // The official API reports business errors with HTTP 200 and a code field.
  if (body.code !== undefined && body.code !== 0) {
    const numeric = Number(body.code);
    throw new QQOfficialProbeError(`token exchange failed with code ${body.code}`, {
      code: numeric,
      hint: TOKEN_ERROR_HINTS[numeric] || null
    });
  }
  if (typeof body.access_token !== 'string' || body.access_token === '') {
    throw new QQOfficialProbeError('token endpoint returned no access_token', { code: body.code ?? null });
  }
  return {
    accessToken: body.access_token,
    expiresIn: Number(body.expires_in) || null
  };
}

/** Call one official QQ bot API path with the exchanged token. */
export async function callOfficialApi({
  pathname,
  accessToken,
  apiBase = DEFAULT_API_BASE,
  method = 'GET',
  body = undefined,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10000
} = {}) {
  const fetcher = ensureFetch(fetchImpl);
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new QQOfficialProbeError('access_token is missing');
  }
  const url = new URL(pathname.replace(/^\/+/, ''), `${apiBase.replace(/\/+$/, '')}/`);
  let response;
  try {
    response = await fetcher(url, {
      method,
      headers: {
        authorization: `QQBot ${accessToken}`,
        'content-type': 'application/json'
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    throw new QQOfficialProbeError(`cannot reach ${pathname}`, {
      code: error?.cause?.code || error?.name || null,
      cause: error
    });
  }
  const payload = await readJsonResponse(response, pathname);
  if (!response.ok) {
    throw new QQOfficialProbeError(`${pathname} returned HTTP ${response.status}`, {
      code: payload.code ?? response.status,
      hint: payload.message ? String(payload.message).slice(0, 200) : null
    });
  }
  if (payload.code !== undefined && payload.code !== 0) {
    throw new QQOfficialProbeError(`${pathname} returned business code ${payload.code}`, {
      code: Number(payload.code),
      hint: payload.message ? String(payload.message).slice(0, 200) : null
    });
  }
  return payload;
}

/**
 * Read-only identity/gateway probe. Returns only non-secret data; the access
 * token and client secret are never included in the result.
 */
export async function probeOfficialBot({
  appId,
  clientSecret,
  apiBase = DEFAULT_API_BASE,
  tokenUrl = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10000
} = {}) {
  const token = await fetchAppAccessToken({
    appId,
    clientSecret,
    tokenUrl: tokenUrl || `${apiBase.replace(/\/+$/, '')}/app/getAppAccessToken`,
    fetchImpl,
    timeoutMs
  });
  const me = await callOfficialApi({
    pathname: '/users/@me',
    accessToken: token.accessToken,
    apiBase,
    fetchImpl,
    timeoutMs
  });
  const gateway = await callOfficialApi({
    pathname: '/gateway',
    accessToken: token.accessToken,
    apiBase,
    fetchImpl,
    timeoutMs
  });
  return {
    ok: true,
    tokenAcquired: true,
    tokenExpiresIn: token.expiresIn,
    bot: {
      id: me.id ? String(me.id) : null,
      username: me.username ? String(me.username).slice(0, 64) : null,
      bot: me.bot === true
    },
    gatewayUrl: typeof gateway.url === 'string' ? gateway.url : null,
    // Never include accessToken/clientSecret here.
    note: 'read-only probe: token exchange + /users/@me + /gateway; no message sent'
  };
}

async function cli() {
  const { flags } = parseArgs(process.argv.slice(2));
  const appIdEnv = typeof flags['app-id-env'] === 'string' ? flags['app-id-env'] : 'QQBOT_APP_ID';
  const appSecretEnv = typeof flags['app-secret-env'] === 'string' ? flags['app-secret-env'] : 'QQBOT_APP_SECRET';
  const apiBase = typeof flags['api-base'] === 'string' ? flags['api-base'] : DEFAULT_API_BASE;
  const timeoutMs = Number(flags['timeout-ms'] || 10000);
  if (flags.help) {
    console.log(`Usage: node scripts/acceptance/qq-official-probe.mjs [--app-id-env QQBOT_APP_ID] [--app-secret-env QQBOT_APP_SECRET] [--api-base https://api.bot.qq.com] [--timeout-ms 10000]

官方 QQ 机器人只读探测：用 AppID + ClientSecret 换取短期 access_token，
再调用 GET /users/@me 与 GET /gateway；不发送消息、不打印 token/secret。

AppID 和 ClientSecret 获取方式：QQ 开放平台 https://bot.q.qq.com/open -> 你的机器人 ->
开发设置/机器人密钥 页面；把它们放进本机环境变量（不要写进仓库文件/聊天）：
  $env:${appIdEnv} = '<AppID>'
  $env:${appSecretEnv} = '<ClientSecret>'`);
    return 0;
  }
  const appId = appIdEnv ? process.env[appIdEnv] : undefined;
  const clientSecret = appSecretEnv ? process.env[appSecretEnv] : undefined;
  if (!appId || !clientSecret) {
    console.error(JSON.stringify({
      ok: false,
      reason: 'app_credentials_missing',
      message: `环境变量 ${appIdEnv} / ${appSecretEnv} 未设置。官方 QQ 机器人使用 AppID + ClientSecret（不是固定 token）；`
        + '请在 bot.q.qq.com 管理端获取后设置到本机环境变量。',
      env: { appIdEnv, appSecretEnv, appIdPresent: Boolean(appId), clientSecretPresent: Boolean(clientSecret) }
    }, null, 2));
    return 1;
  }
  try {
    const result = await probeOfficialBot({ appId, clientSecret, apiBase, timeoutMs });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      reason: 'probe_failed',
      message: error.message,
      code: error.code ?? null,
      hint: error.hint ?? null
    }, null, 2));
    return 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
const selfPath = fileURLToPath(import.meta.url);
if (invokedPath === selfPath) {
  cli().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(JSON.stringify({ ok: false, reason: 'unexpected_error', message: error.message }, null, 2));
    process.exitCode = 1;
  });
}
