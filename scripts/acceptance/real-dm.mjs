#!/usr/bin/env node
// Guided REAL Bilibili write acceptance: one whitelisted DM at the lowest quota,
// protected by a fresh verified recovery point and by the one-time TTY human
// challenge. Run this in a REAL interactive terminal; every --confirm step asks
// you to type a one-time phrase here. Usage:
//
//   node scripts/acceptance/real-dm.mjs ^
//     --to <peer-mid> --text "acceptance ping" ^
//     --dest D:\dsh-bili-backups ^
//     --failure-domain "same-physical-disk:D (NVMe Disk0; NOT independent)" ^
//     --verified-by "<owner name>" [--data-dir <dir>] [--check]
//
// Order: credentials file -> account verify -> backup policy/point -> config ->
// single DM. Any failure stops before the platform write; unknown results are
// never retried automatically.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  WORK_DIR,
  ensureWorkDir,
  fail,
  info,
  parseArgs,
  promptLine,
  printNextSteps,
  requireString,
  runCapture,
  runInherited,
  writeJson
} from './_common.mjs';

const { flags } = parseArgs(process.argv.slice(2));
if (flags.help) {
  console.log('Usage: node scripts/acceptance/real-dm.mjs --to <mid> --text <text> --dest <abs path> --failure-domain <text> --verified-by <name> [--data-dir <dir>] [--check]');
  process.exit(0);
}

const to = requireString(flags, 'to', { max: 32 });
if (!/^\d{1,20}$/.test(to)) fail('--to must be a numeric Bilibili mid');
const text = requireString(flags, 'text', { max: 300 });
const dest = requireString(flags, 'dest');
if (!path.isAbsolute(dest)) fail('--dest must be an absolute path (e.g. D:\\dsh-bili-backups)');
const failureDomain = requireString(flags, 'failure-domain');
const verifiedBy = requireString(flags, 'verified-by');
const checkOnly = flags.check === true;
const dataDir = typeof flags['data-dir'] === 'string'
  ? path.resolve(flags['data-dir'])
  : (process.env.DSH_HOME
      ? path.join(process.env.DSH_HOME, 'dsh-bili-unified')
      : path.join(os.homedir(), '.dsh', 'dsh-bili-unified'));

ensureWorkDir();
const policyFile = writeJson(path.join(WORK_DIR, 'backup-policy.candidate.json'), {
  schemaVersion: 1,
  scheduleEnabled: false,
  destinationRoot: dest,
  failureDomain,
  verifiedBy,
  verifiedAt: null,
  intervalMinutes: 15,
  maxPointAgeMinutes: 20,
  fullIntervalHours: 24,
  keepRecent: 8,
  keepDaily: 7,
  keepWeekly: 4,
  autoPrune: false,
  checkpointTimeoutMs: 5000
});
const configFile = writeJson(path.join(WORK_DIR, 'dm-acceptance-config.json'), {
  dryRun: false,
  directMessages: {
    enabled: true,
    allowedRecipientMids: [Number(to)],
    requireMutual: true,
    dailyLimit: 1,
    sameVideoDays: 7,
    maxLength: 300
  }
});

console.log('[acceptance] 数据目录:', dataDir);
console.log('[acceptance] 备份策略候选:', policyFile);
console.log('[acceptance] DM 配置补丁:', configFile);

if (checkOnly) {
  printNextSteps([
    '[acceptance] --check 通过（未执行任何命令、未发消息）。真实执行顺序：',
    `  1) node cli.mjs account verify（真实只读 whoami，需要已放置凭据文件）`,
    `  2) node cli.mjs backup policy --file ${policyFile} --confirm（TTY）`,
    `  3) node cli.mjs backup create --kind ledger --confirm（TTY）`,
    `  4) node cli.mjs backup verify <backupId> + backup status（只读）`,
    `  5) node cli.mjs config update --file ${configFile} --confirm（TTY）`,
    `  6) node cli.mjs dm --to ${to} --text "<text>" --go（TTY，单条最低额度）`,
    `  7) node cli.mjs status + task get <taskId>（只读取证）`
  ]);
  process.exit(0);
}

const credentialsFile = path.join(dataDir, 'credentials.json');
if (!fs.existsSync(credentialsFile)) {
  console.log(`\n[acceptance] 未找到凭据文件: ${credentialsFile}`);
  console.log('[acceptance] 请先放置凭据（字段仅 sessdata/bili_jct/buvid3/dedeuserid），或设置 BILI_* 环境变量。');
}

info('步骤 1/6：真实只读账号核验（account verify，无网络写入）');
const account = runCapture(['account', 'verify'], flags);
console.log('[acceptance] account verify:', JSON.stringify(account, null, 2).slice(0, 1500));

const before = runCapture(['backup', 'status'], flags);
console.log('[acceptance] 当前 backup status:', JSON.stringify(before.service || before, null, 2));

console.log('\n[acceptance] 即将创建的真实写入前置条件：');
console.log(`  - 备份目标: ${dest}`);
console.log(`  - 故障域(owner 记录): ${failureDomain}`);
console.log(`  - 记录人: ${verifiedBy}`);
console.log(`  - 收件人 mid: ${to}（白名单，单条）`);
console.log(`  - 文本: ${text}`);
const confirmed = await promptLine('[acceptance] 输入 y 继续执行备份/配置/单条 DM（其余任意键取消）: ');
if (confirmed.toLowerCase() !== 'y') fail('已取消（未做任何变更）');

info('步骤 2/6：保存备份策略（TTY 人类挑战）');
runInherited(['backup', 'policy', '--file', policyFile, '--confirm'], flags);

info('步骤 3/6：创建并核验恢复点（TTY 人类挑战）');
runInherited(['backup', 'create', '--kind', 'ledger', '--confirm'], flags);
const afterCreate = runCapture(['backup', 'status'], flags);
const latest = afterCreate.service?.latest || null;
if (!latest?.backupId) fail('未发现新的恢复点；请检查 backup status');
console.log(`[acceptance] 恢复点: ${latest.backupId} kind=${latest.kind} ageMs=${latest.ageMs}`);
runCapture(['backup', 'verify', latest.backupId], flags);

info('步骤 4/6：打开 DM 真实写入配置（TTY 人类挑战）');
runInherited(['config', 'update', '--file', configFile, '--confirm'], flags);

info('步骤 5/6：记录保护点时间并执行单条 DM（TTY 人类挑战）');
const protectedState = runCapture(['backup', 'status'], flags);
const protection = protectedState.service?.status;
if (protection !== 'protected') fail(`当前保护状态为 ${protection}，真实写入会被 BACKUP_UNPROTECTED/BACKUP_STALE 拒绝`);
console.log(`[acceptance] 保护状态: ${protection}, 最新点年龄: ${protectedState.service.latest?.ageMs}ms`);
runInherited(['dm', '--to', to, '--text', text, '--go'], flags);

info('步骤 6/6：取证');
const stateFile = path.join(dataDir, 'state.json');
let task = null;
try {
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const dmTasks = Object.values(state.tasks || {}).filter((item) => item.kind === 'dm');
  task = dmTasks.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] || null;
} catch (error) {
  console.log(`[acceptance] 读取 state.json 失败: ${error.message}`);
}
const evidence = {
  capturedAt: new Date().toISOString(),
  dataDir,
  recipientMid: to,
  textHashInputLength: text.length,
  backup: {
    backupId: latest?.backupId || null,
    kind: latest?.kind || null,
    cutAt: latest?.cutAt || null,
    protection: protectedState.service?.status || null,
    failureDomain: protectedState.service?.failureDomain || failureDomain,
    verifiedBy: protectedState.service?.failureDomainVerifiedBy || verifiedBy
  },
  task: task
    ? {
        taskId: task.id,
        kind: task.kind,
        status: task.status,
        revision: task.revision,
        attempts: task.attempts,
        createdAt: task.createdAt,
        result: task.result || null
      }
    : null,
  account: account.accounts || account.account || null
};
const evidenceFile = writeJson(path.join(WORK_DIR, `real-dm-evidence-${Date.now()}.json`), evidence);
if (task?.id) {
  console.log('\n[acceptance] task get:');
  attempt(() => runInherited(['task', 'get', task.id], flags));
}
printNextSteps([
  `[acceptance] 证据已保存: ${evidenceFile}`,
  '[acceptance] 请把该文件（以及 dm/status 输出，脱敏后）发给维护者归档到验收报告；',
  '[acceptance] 若 DM 结果为失败/unknown：不得盲重试，先按 runbook 核查回执/outbox，再决定恢复流程。'
]);

function attempt(fn) {
  try {
    fn();
  } catch (error) {
    console.log(`[acceptance] 附加取证失败: ${error.message}`);
  }
}
