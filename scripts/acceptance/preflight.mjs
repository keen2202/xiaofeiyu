#!/usr/bin/env node
// Read-only preflight for the real acceptance: validates the inputs the owner
// must provide, probes the QQ bridge if configured, inspects the credential
// file and backup protection, and prints the exact TTY commands to run next.
// It NEVER calls a --confirm step, never sends a message and never prints
// secrets (token values are never read into output; cookie values are not read).
//
//   node scripts/acceptance/preflight.mjs --inputs .dsh-probe/acceptance/inputs.json
//   node scripts/acceptance/preflight.mjs --write-template
//   node scripts/acceptance/preflight.mjs --base-url ... --ws-url ... --owner-qq ...
//       --to <mid> --text "..." --dest D:\dsh-bili-backups
//       --failure-domain "..." --verified-by "..." [--bot-account <qq>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFailureDomainVerification } from './_failure-domain.mjs';
import {
  WORK_DIR,
  ensureWorkDir,
  fail,
  info,
  optionalString,
  parseArgs,
  printNextSteps,
  requireEnvName,
  requireString,
  requireUrl,
  writeJson
} from './_common.mjs';

const { flags } = parseArgs(process.argv.slice(2));
if (flags.help) {
  console.log(`Usage: node scripts/acceptance/preflight.mjs [--inputs <json>] [--write-template]
  QQ:   --base-url <http url> --ws-url <ws url> [--token-env NAME] [--owner-qq <qq>] [--bot-account <qq>]
  DM:   --to <mid> --text <text> --dest <abs path> --failure-domain <text> --verified-by <name> --verification <json>
  Other: --data-dir <dir>`);
  process.exit(0);
}

ensureWorkDir();
if (flags['write-template']) {
  const template = writeJson(path.join(WORK_DIR, 'inputs.template.json'), {
    dataDir: null,
    qq: {
      baseUrl: 'http://127.0.0.1:3000',
      wsUrl: 'ws://127.0.0.1:3001',
      tokenEnv: 'ONEBOT_ACCESS_TOKEN',
      ownerQQ: 'REPLACE_OWNER_QQ',
      botAccount: 'REPLACE_BOT_QQ'
    },
    bilibili: {
      to: 'REPLACE_PEER_MID',
      text: 'dsh-bili-unified acceptance ping',
      dest: 'REPLACE_INDEPENDENT_MEDIA_ABSOLUTE_PATH',
      failureDomain: 'REPLACE_OWNER_VERIFIED_FAILURE_DOMAIN',
      verification: 'REPLACE_OWNER_VERIFICATION_JSON_PATH',
      verifiedBy: 'REPLACE_OWNER_NAME'
    }
  });
  console.log('[preflight] template written:', template);
  console.log('[preflight] fill the values (never put the access token itself in this file), then re-run with --inputs <file>.');
  process.exit(0);
}

let inputs = {};
const inputsFile = optionalString(flags, 'inputs', null);
if (inputsFile) {
  if (!fs.existsSync(inputsFile)) fail(`--inputs file not found: ${inputsFile}`);
  try {
    inputs = JSON.parse(fs.readFileSync(inputsFile, 'utf8'));
  } catch (error) {
    fail(`--inputs is not valid JSON: ${error.message}`);
  }
}
const pick = (value, ...fallbacks) => {
  for (const candidate of [value, ...fallbacks]) {
    if (candidate !== undefined && candidate !== null && String(candidate).trim() !== '') return String(candidate).trim();
  }
  return null;
};
const qq = {
  baseUrl: pick(flags['base-url'], inputs.qq?.baseUrl),
  wsUrl: pick(flags['ws-url'], inputs.qq?.wsUrl),
  tokenEnv: pick(flags['token-env'], inputs.qq?.tokenEnv),
  ownerQQ: pick(flags['owner-qq'], inputs.qq?.ownerQQ),
  botAccount: pick(flags['bot-account'], inputs.qq?.botAccount)
};
const dm = {
  to: pick(flags.to, inputs.bilibili?.to),
  text: pick(flags.text, inputs.bilibili?.text),
  dest: pick(flags.dest, inputs.bilibili?.dest),
  failureDomain: pick(flags['failure-domain'], inputs.bilibili?.failureDomain),
  verification: pick(flags.verification, inputs.bilibili?.verification),
  verifiedBy: pick(flags['verified-by'], inputs.bilibili?.verifiedBy)
};
const dataDir = optionalString(flags, 'data-dir', null)
  || pick(inputs.dataDir)
  || (process.env.DSH_HOME ? path.join(process.env.DSH_HOME, 'dsh-bili-unified') : path.join(os.homedir(), '.dsh', 'dsh-bili-unified'));

const report = { dataDir, qq: { configured: false }, bilibili: { configured: false }, credentials: null, backup: null, problems: [] };
const problems = report.problems;

// --- QQ bridge (read-only probe; never sends) ---
if (qq.baseUrl || qq.wsUrl || qq.ownerQQ) {
  try {
    if (!qq.baseUrl || !qq.wsUrl || !qq.ownerQQ) throw new Error('需要同时提供 --base-url/--ws-url/--owner-qq');
    requireUrl({ 'base-url': qq.baseUrl }, 'base-url', ['http:', 'https:']);
    requireUrl({ 'ws-url': qq.wsUrl }, 'ws-url', ['ws:', 'wss:']);
    qq.tokenEnv = requireEnvName({ 'token-env': qq.tokenEnv || 'ONEBOT_ACCESS_TOKEN' }, 'token-env', 'ONEBOT_ACCESS_TOKEN');
    if (!/^\d{5,12}$/.test(qq.ownerQQ)) throw new Error('--owner-qq 必须是 QQ 号（5-12 位数字）');
    if (qq.botAccount && !/^\d{5,12}$/.test(qq.botAccount)) throw new Error('--bot-account 必须是 QQ 号');
    const { createOneBotQqHost } = await import('../../src/adapters/channels/onebot-qq.js');
    const host = createOneBotQqHost({
      config: {
        im: {
          transport: 'onebot-v11',
          onebot: {
            baseUrl: qq.baseUrl,
            websocketUrl: qq.wsUrl,
            accessTokenEnv: qq.tokenEnv,
            timeoutMs: 10000,
            reconnectMs: 5000
          }
        }
      },
      env: process.env,
      logger: { warn() {}, info() {}, debug() {} }
    });
    const capabilities = host ? await host.describeCapabilities() : { status: 'unavailable', reason: 'host_not_configured' };
    report.qq = {
      configured: true,
      baseUrl: qq.baseUrl,
      wsUrl: qq.wsUrl,
      tokenEnv: qq.tokenEnv,
      tokenPresent: Boolean(process.env[qq.tokenEnv]),
      ownerQQ: qq.ownerQQ,
      capabilities,
      bot: host?.loginInfo || null
    };
    if (capabilities.status !== 'available') problems.push(`QQ 桥接不可用: ${capabilities.reason}`);
    if (!process.env[qq.tokenEnv]) console.log(`[preflight] 提示: 当前进程未设置 ${qq.tokenEnv}；如果桥接需要 token，请在运行终端先设置。`);
  } catch (error) {
    problems.push(`QQ 输入无效/探测失败: ${error.message}`);
  }
} else {
  console.log('[preflight] QQ 未配置：提供 --base-url/--ws-url/--owner-qq 后会做只读探测。');
}

// --- Bilibili credentials (only key presence; values are never read) ---
const credentialsFile = path.join(dataDir, 'credentials.json');
try {
  if (fs.existsSync(credentialsFile)) {
    const raw = JSON.parse(fs.readFileSync(credentialsFile, 'utf8'));
    const keys = Object.keys(raw).sort();
    const known = ['bili_jct', 'buvid3', 'dedeuserid', 'sessdata'];
    const unknown = keys.filter((key) => !known.includes(key));
    report.credentials = {
      file: credentialsFile,
      fields: keys,
      hasWriteCredentials: Boolean(raw.sessdata && raw.bili_jct),
      unknownFields: unknown
    };
    if (unknown.length > 0) problems.push(`凭据文件包含未知字段: ${unknown.join(',')}`);
    if (!raw.sessdata) problems.push('凭据文件缺少 sessdata');
  } else {
    report.credentials = { file: credentialsFile, present: false };
    problems.push(`凭据文件不存在（或使用 BILI_* 环境变量）: ${credentialsFile}`);
  }
} catch (error) {
  problems.push(`凭据文件不可解析: ${error.message}`);
}

// --- backup protection (read-only CLI) ---
try {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(process.execPath, [
    path.join(WORK_DIR, '..', '..', 'cli.mjs'),
    'backup', 'status', '--data-dir', dataDir
  ], { encoding: 'utf8', cwd: path.join(WORK_DIR, '..', '..'), maxBuffer: 4 * 1024 * 1024 });
  report.backup = JSON.parse(out);
  const status = JSON.parse(execFileSync(process.execPath, [path.join(WORK_DIR, '..', '..', 'cli.mjs'),
    'status', '--data-dir', dataDir], { encoding: 'utf8', cwd: path.join(WORK_DIR, '..', '..'), maxBuffer: 4 * 1024 * 1024 }));
  report.backup.protection = status.backup;
  if (status.backup?.status !== 'protected') problems.push(`备份保护未就绪: ${status.backup?.reason || 'unprotected'}`);
  const service = report.backup.service || {};
  if (!service.latest?.backupId) problems.push('尚无有效恢复点：真实写入前需 owner 在 TTY 中创建');
  else if (Number(service.latest.ageMs) > Number(service.maxPointAgeMinutes || 20) * 60000) problems.push('最新恢复点已超龄，需重新 backup create');
} catch (error) {
  problems.push(`backup status 读取失败: ${error.message}`);
}

// --- DM inputs ---
if (dm.to || dm.text || dm.dest) {
  try {
    if (!dm.to || !dm.text || !dm.dest || !dm.failureDomain || !dm.verifiedBy) {
      throw new Error('真实 DM 需要同时提供 --to/--text/--dest/--failure-domain/--verified-by');
    }
    if (!/^\d{1,20}$/.test(dm.to)) throw new Error('--to 必须是数字 mid');
    if (!path.isAbsolute(dm.dest)) throw new Error('--dest 必须是绝对路径');
    if (dm.text.length > 300) throw new Error('--text 超过 DM maxLength(300)');
    readFailureDomainVerification(dm.verification, { dataDir, destinationRoot: dm.dest, failureDomain: dm.failureDomain, verifiedBy: dm.verifiedBy });
    report.bilibili = { configured: true, to: dm.to, textLength: dm.text.length, dest: dm.dest, failureDomain: dm.failureDomain, verifiedBy: dm.verifiedBy };
  } catch (error) {
    problems.push(`DM 输入无效: ${error.message}`);
  }
} else {
  console.log('[preflight] 真实 DM 未配置：提供 --to/--text/--dest/--failure-domain/--verified-by 后会校验。');
}

const reportFile = writeJson(path.join(WORK_DIR, 'preflight-report.json'), report);
console.log(JSON.stringify(report, null, 2));
console.log(`\n[preflight] 报告: ${reportFile}`);
console.log(`[preflight] 问题数: ${problems.length}${problems.length ? ' ->\n  - ' + problems.join('\n  - ') : ''}`);

if (report.qq.configured && report.qq.capabilities.status === 'available') {
  info('下一步（owner 真实 TTY 中执行）：');
  console.log(`  node scripts/acceptance/qq-setup.mjs --base-url ${report.qq.baseUrl} --ws-url ${report.qq.wsUrl} --token-env ${report.qq.tokenEnv} --owner-qq ${report.qq.ownerQQ}${report.qq.bot?.botAccountId ? ` --bot-account ${report.qq.bot.botAccountId}` : ''}`);
}
if (report.bilibili.configured) {
  console.log(`  node scripts/acceptance/real-dm.mjs --to ${dm.to} --text "${dm.text}" --dest "${dm.dest}" --failure-domain "${dm.failureDomain}" --verified-by "${dm.verifiedBy}" --verification "${dm.verification}" --data-dir "${dataDir}"`);
}
printNextSteps([
  '[preflight] 本步骤只读：未创建备份点、未修改配置、未发送消息。',
  '[preflight] 有问题的项先补齐；真实执行必须由 owner 在 TTY 中运行上面的脚本并逐条回答人类挑战。'
]);
process.exit(problems.length === 0 ? 0 : 1);
