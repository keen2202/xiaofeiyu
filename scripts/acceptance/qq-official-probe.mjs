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
import {
  DEFAULT_API_BASE,
  QQOfficialApiError,
  callOfficialApi,
  fetchAppAccessToken,
  probeOfficialBot
} from '../../src/adapters/channels/qq-official.js';

// Backwards-compatible names for the probe-only consumers/tests.
export {
  DEFAULT_API_BASE,
  fetchAppAccessToken,
  callOfficialApi,
  probeOfficialBot
};
export const QQOfficialProbeError = QQOfficialApiError;

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
  const appId = process.env[appIdEnv];
  const clientSecret = process.env[appSecretEnv];
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
