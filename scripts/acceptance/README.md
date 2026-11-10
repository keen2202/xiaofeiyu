# 真实接入验收脚本（需在真实交互终端中运行）

本目录两个脚本把"人工逐步敲命令 + 逐条回答一次性 TTY 挑战"收敛成引导式流程。
**它们不会绕过任何人工程序**：所有 `--confirm` 步骤都由你本人在同一终端回答挑战短语；
脚本失败即停止，不自动重试真实写入。

## 1. QQ / OneBot 接入引导

前置：你已在本地运行 OneBot v11 实现（NapCat/Lagrange 等），HTTP 与正向 WS 端口可访问；
若启用 token，请先把 token 放到环境变量（不要写进文件/聊天）。

```powershell
node scripts/acceptance/qq-setup.mjs `
  --base-url http://127.0.0.1:3000 `
  --ws-url ws://127.0.0.1:3001 `
  --token-env ONEBOT_ACCESS_TOKEN `
  --owner-qq <你的QQ号> `
  --bot-account <机器人QQ号，可省略由 probe 读取> `
  --check        # 只校验参数并打印计划；去掉 --check 才真正执行
```

执行内容：`im probe`（只读）→ `config update`（TTY）→ `im bind`（TTY）→ `im status`（只读）。
完成后按提示用 owner QQ 私聊机器人发送结构化只读命令验证回信；IM 审批按设计 fail-closed，仍走本地 TTY。

## 2. 真实 B 站单条白名单 DM 验收

前置：凭据文件已放到 `<dataDir>/credentials.json`（字段仅 `sessdata/bili_jct/buvid3/dedeuserid`），
并已选定备份目的地与如实的故障域描述（本机若只有一块物理盘，必须写 "NOT independent"）。

```powershell
node scripts/acceptance/real-dm.mjs `
  --to <白名单收件人mid> `
  --text "dsh-bili-unified acceptance ping" `
  --dest D:\dsh-bili-backups `
  --failure-domain "same-physical-disk:D (NVMe Disk0; NOT independent)" `
  --verified-by "<你的名字>" `
  --check        # 只校验参数并打印计划；去掉 --check 才真正执行
```

执行内容：`account verify`（真实只读）→ `backup policy`（TTY）→ `backup create`（TTY）→
`backup verify/status`（只读）→ `config update`（TTY，打开 dryRun=false 与 DM 白名单）→
`dm --go`（TTY，单条）→ `status`/`task get` 取证。证据写入 `.dsh-probe/acceptance/`（本地、不入库）。

## 3. 只读核对

```powershell
node cli.mjs im probe      # 桥接能力探测（get_status/get_login_info）
node cli.mjs im status     # IM 组件、绑定的 sender/会话、inbox/outbox 计数
node cli.mjs backup status # 保护状态与最新恢复点年龄
```

真实写入失败（not_sent/unknown）时不要重试：先按 `doc/report/REAL_ACCEPTANCE_RUNBOOK_2026-11-10.md`
核查回执/outbox，再决定恢复流程。
