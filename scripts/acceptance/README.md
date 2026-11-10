# 真实接入验收脚本（需在真实交互终端中运行）

本目录两个脚本把"人工逐步敲命令 + 逐条回答一次性 TTY 挑战"收敛成引导式流程。
**它们不会绕过任何人工程序**：所有 `--confirm` 步骤都由你本人在同一终端回答挑战短语；
脚本失败即停止，不自动重试真实写入。

## 0. 只读预检（推荐先跑，任何终端）

```powershell
node scripts/acceptance/preflight.mjs --write-template   # 生成 .dsh-probe/acceptance/inputs.template.json
# 填写模板里的端点/QQ/mid/备份参数（token 只放环境变量，不写进文件）后：
node scripts/acceptance/preflight.mjs --inputs .dsh-probe/acceptance/inputs.template.json
```

预检只读：探测 OneBot 桥接（get_status/get_login_info）、检查凭据文件字段（不读取值）、读取备份保护状态，
并输出下一步要执行的 TTY 命令；有问题时非 0 退出并列出原因。也可直接用命令行参数指定（见 `--help`）。

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
node cli.mjs im probe        # 桥接能力探测（get_status/get_login_info）
node cli.mjs im status       # IM 组件、绑定 sender/会话、inbox/outbox 计数
node cli.mjs im status --probe  # 额外做一次只读桥接探测，显示 liveProbe
node cli.mjs backup status   # 保护状态与最新恢复点年龄
```

真实写入失败（not_sent/unknown）时不要重试：先按 `doc/report/REAL_ACCEPTANCE_RUNBOOK_2026-11-10.md`
核查回执/outbox，再决定恢复流程。

## 4. 凭据安全落盘（不打印值）

```powershell
# 不要把 Cookie 值写进仓库文件；从剪贴板/浏览器复制的整段 Cookie 通过管道传入即可
$cookie = Read-Host '粘贴 B 站 Cookie 串（不会回显到日志）'
$cookie | node scripts/acceptance/save-credentials.mjs
```

脚本只保留 `sessdata/bili_jct/buvid3/dedeuserid` 四个字段写入 `<dataDir>/credentials.json`，输出只含字段名与路径；
随后在真实终端执行 `node cli.mjs account verify` 做只读 whoami 绑定。建议验收结束后轮换 Cookie。

## 5. 官方 QQ 机器人（bot.q.qq.com）只读探测

如果你用的是**官方 QQ 机器人**（`api.bot.qq.com`），它不是 OneBot v11，不能用 `qq-setup.mjs` 的 OneBot 流程。
官方平台用 **AppID + ClientSecret** 换短期 `access_token`（无固定 token 环境变量）。

1) 获取 AppID / ClientSecret：登录 [QQ 开放平台](https://bot.q.qq.com/open) → 你的机器人 → 开发设置/机器人密钥；
2) 只在本机环境变量中保存（不要写进仓库/聊天）：
```powershell
$env:QQBOT_APP_ID = '<AppID>'
$env:QQBOT_APP_SECRET = '<ClientSecret>'
```
3) 只读探测（token 交换 + `GET /users/@me` + `GET /gateway`，不发消息、不打印 token）：
```powershell
node scripts/acceptance/qq-official-probe.mjs
```
4) 输出包含机器人 id/昵称与 gateway URL；把结果发我（不含 token）。
5) 当前已实现官方机器人 transport（`im.transport=qq-official`），拿到 AppID/ClientSecret 后按下面顺序继续：
```powershell
# 配置 transport=qq-official（config update 需要 TTY 人类挑战）
node cli.mjs config update --file <qq-official-config-patch.json> --confirm
# 只读监听入站消息，捕获 owner openid（不会执行命令/发消息）
node cli.mjs im listen --seconds 120
# 用捕获到的 openid 绑定 owner（TTY 人类挑战）
node cli.mjs im bind --file <binding.json> --confirm
node cli.mjs im status --probe
```
细节与 binding.json/config 示例见 doc/report/QQ_OFFICIAL_TRANSPORT_2026-11-10.md。
