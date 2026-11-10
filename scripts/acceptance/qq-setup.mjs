#!/usr/bin/env node
// Guided setup for the optional QQ bridge over OneBot v11.
//
// Run this in a REAL interactive terminal (Windows Terminal / PowerShell). Steps
// marked "human proof" ask you to type a one-time phrase in this same terminal;
// nothing here bypasses that check. Usage:
//
//   node scripts/acceptance/qq-setup.mjs ^
//     --base-url http://127.0.0.1:3000 --ws-url ws://127.0.0.1:3001 ^
//     --token-env ONEBOT_ACCESS_TOKEN --owner-qq 123456 [--bot-account 654321] [--check]
//
// Prerequisites: a OneBot v11 implementation (NapCat / Lagrange / ...) is
// running, `im.transport=onebot-v11` is accepted by this build, and (for the
// token) the access token env var is set in THIS terminal.
import path from 'node:path';
import {
  WORK_DIR,
  ensureWorkDir,
  fail,
  info,
  printNextSteps,
  promptLine,
  readJson,
  requireEnvName,
  requireString,
  requireUrl,
  runCapture,
  runInherited,
  parseArgs,
  writeJson
} from './_common.mjs';

const { flags } = parseArgs(process.argv.slice(2));
if (flags.help) {
  console.log(`Usage: node scripts/acceptance/qq-setup.mjs --base-url <http url> --ws-url <ws url> [--token-env NAME] [--owner-qq <qq>] [--bot-account <qq>] [--data-dir <dir>] [--check]`);
  process.exit(0);
}

const baseUrl = requireUrl(flags, 'base-url', ['http:', 'https:']);
const wsUrl = requireUrl(flags, 'ws-url', ['ws:', 'wss:']);
const tokenEnv = requireEnvName(flags, 'token-env', 'ONEBOT_ACCESS_TOKEN');
const ownerQQ = requireString(flags, 'owner-qq');
if (!/^\d{5,12}$/.test(ownerQQ)) fail('--owner-qq must be a QQ number (5-12 digits)');
const botAccount = typeof flags['bot-account'] === 'string' ? flags['bot-account'].trim() : null;
if (botAccount !== null && !/^\d{5,12}$/.test(botAccount)) fail('--bot-account must be a QQ number (5-12 digits)');
const checkOnly = flags.check === true;

ensureWorkDir();
const configPatch = {
  im: {
    enabled: true,
    adapterId: 'dsh-im',
    transport: 'onebot-v11',
    maxMessageAgeSec: 600,
    approvalTtlSec: 600,
    groupReplies: 'none',
    notifications: { enabled: true, minGapMs: 1500, perMinute: 20 },
    onebot: {
      baseUrl,
      websocketUrl: wsUrl,
      accessTokenEnv: tokenEnv,
      timeoutMs: 10000,
      reconnectMs: 5000
    }
  }
};
const configPatchPath = writeJson(path.join(WORK_DIR, 'im-config-patch.json'), configPatch);

console.log('[acceptance] QQ/OneBot 配置补丁已生成:', configPatchPath);
if (!process.env[tokenEnv]) {
  console.log(`[acceptance] 注意: 当前终端未设置 ${tokenEnv}；若桥接需要 token，请先 $env:${tokenEnv}="..."（值不要写进任何文件/聊天）。`);
}

if (checkOnly) {
  printNextSteps([
    '[acceptance] --check 完成（未执行任何命令、未发消息）。真实执行时脚本会依次调用：',
    `  1) node cli.mjs im probe（只读）`,
    `  2) node cli.mjs config update --file ${configPatchPath} --confirm（TTY 人类挑战）`,
    `  3) node cli.mjs im bind --file .dsh-probe/acceptance/im-binding.json --confirm（TTY 人类挑战）`,
    `  4) node cli.mjs im status（只读核对）`,
    '然后你在 QQ 私聊中给机器人发送一条只读命令（如 task.list）验证真实回信。'
  ]);
  process.exit(0);
}

info('步骤 1/4：只读能力探测（get_status / get_login_info，不发送消息）');
const probe = runCapture(['im', 'probe', '--config', configPatchPath]);
console.log('[acceptance] probe:', JSON.stringify({ ok: probe.ok, status: probe.capabilities?.status, reason: probe.capabilities?.reason, bot: probe.bot }, null, 2));
if (!probe.ok) {
  fail(`QQ 桥接不可用（${probe.capabilities?.reason || 'unknown'}）。请确认 OneBot v11 已在 ${baseUrl} 运行、WS 监听 ${wsUrl}。`);
}
const resolvedBot = botAccount || probe.bot?.botAccountId || null;
if (!resolvedBot) fail('无法从桥接读取机器人 QQ 号，请用 --bot-account 显式提供');
console.log(`[acceptance] 机器人 QQ: ${resolvedBot}${probe.bot?.nickname ? ` (${probe.bot.nickname})` : ''}`);

const confirmedOwner = await promptLine(`[acceptance] 确认 owner QQ 为 ${ownerQQ}，绑定后仅该 QQ 可驱动命令 [y/N]: `);
if (confirmedOwner.toLowerCase() !== 'y') fail('已取消（未做任何变更）');

const bindingFile = writeJson(path.join(WORK_DIR, 'im-binding.json'), {
  adapterId: 'dsh-im',
  botAccountId: resolvedBot,
  senderRef: ownerQQ,
  conversationIds: [`private:${ownerQQ}`],
  scopes: ['task.read.own', 'task.cancel.own', 'production.create']
});
console.log('[acceptance] 绑定文件已生成:', bindingFile);

info('步骤 2/4：写入 IM 配置（TTY 人类挑战）');
runInherited(['config', 'update', '--file', configPatchPath, '--confirm'], flags);

info('步骤 3/4：绑定 owner QQ（TTY 人类挑战）');
runInherited(['im', 'bind', '--file', bindingFile, '--confirm'], flags);

info('步骤 4/4：只读核对');
const status = runCapture(['im', 'status']);
console.log(JSON.stringify(status, null, 2));
const available = status.component?.capabilities?.status;
if (available !== 'available') {
  console.log(`\n[acceptance] 注意：当前 IM 能力状态为 ${available}（${status.component?.capabilities?.reason || status.component?.reason}）。`);
  console.log('[acceptance] 若 was just enabled，插件在下次 CLI/DSH 启动时会重新探测；可用 `node cli.mjs im status` 复核。');
}

printNextSteps([
  '[acceptance] QQ 接入准备完成。真实回信验证：',
  `  1) 用 owner QQ 私聊机器人发送结构化只读命令，例如：`,
  '     {"action":"task.list","input":{},"mode":"dry"}',
  '  2) 机器人应通过 outbox 回一条任务状态摘要（若通知通道可用）；',
  '  3) 本机执行 `node cli.mjs im status` 查看 inbox/outbox 计数；',
  '  4) 尝试在 QQ 中做审批会被设计拒绝（TRUST_UNAVAILABLE）——审批仍必须走本地 TTY。',
  `  5) 撤销绑定：node cli.mjs im revoke <bindingId> --confirm（TTY）`
]);
