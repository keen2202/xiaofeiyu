# 真实写入验收准备工作与交接（2026-11-10）

> 状态：**真实 B 站写入仍未执行**。本文件记录真实数据目录初始化结果、备份/恢复点门禁分析、单盘故障域限制，
> 以及必须由**本地人类在真实 TTY 中执行**的命令清单。按 SPEC §22.1/§27，备份策略、备份点创建与 `dm --go`
> 都由一次性人类挑战证明保护；本 agent 进程不是可靠 TTY，不能代答，因此这些步骤只能由 owner 本人执行。

## 1. 已完成（assistant，本地真实环境）

| 项 | 结果 |
|---|---|
| 真实数据目录 | `C:\Users\22338\.dsh\dsh-bili-unified`（`DSH_HOME=C:\Users\22338\.dsh`）已初始化：`state.json`、`instance.json`、`artifacts/`、`journal/`、`diary/`、`production-work/` |
| 实例状态 | `active`，`activationRevision=1`，capabilities 含 `core:* / platform:bilibili / production:local / publish:manual / publish:external / im` |
| 恢复状态 | `recovery.phase=normal`，holds=0，unknownOperations=0 |
| 凭据 | `bound=false`（尚未放置 B 站 Cookie 文件） |
| 备份保护 | `unprotected / policy_not_configured`（尚无策略与恢复点） |
| 物理介质 | **仅 1 块物理磁盘**：NVMe `SAMSUNG MZALQ512HALU-000L2`（Disk 0），C: 与 D: 是同一磁盘的两个分区；无外置 USB/网络盘 |
| 桌面 DSH profile | 未改动（`~/.dsh/profiles/desktop` 保持应用管理） |

结论：数据目录可正常启动与只读；真实写入仍被"无恢复点 + 无凭据 + 无人类 TTY 证明"三重门禁阻塞。

## 2. 备份/恢复门禁（代码事实）

- `BackupPolicyService.save()` 要求：`destinationRoot` 为绝对路径且**不能位于活动 dataDir 内/不能包含 dataDir**；
  `failureDomain`、`verifiedBy` 必须由 owner 记录（非空）。策略存放于 `<dataDir>/backup-policy.json`。
- `BackupService.getProtection()` 返回 `protected` 的条件：策略存在 + 目标目录存在 + 至少一个 `verified` 恢复点 +
  最新点年龄 ≤ `maxPointAgeMinutes`（默认 **20 分钟**）。`degraded/stale/invalid/unprotected` 均使受保护派发失败
  （`BACKUP_STALE` / `BACKUP_INVALID` / `BACKUP_UNPROTECTED`）。
- DM 真实写入（`dm.send`，`protected: true`）在 `EffectGateway` 预留事务内再次执行同样的保护检查，并检查
  `recovery` holds；普通 `dry` 不消耗真实授权。
- 策略保存、备份创建、`dm --go`、`config update` 等均要求**一次性人类挑战**（受控 TTY 展示绑定摘要后由 owner 输入），
  `--confirm` 本身不是身份。当前 agent 会话无可靠 TTY → 这些动作保持 BLOCKED，不做绕过。

## 3. 故障域：当前硬件无法提供"独立故障域"

| 选项 | 可行性 | 说明 |
|---|---|---|
| A. 外置 USB 移动硬盘 / NAS 网络共享 | 需用户插入或提供地址 | 唯一能真实满足"独立故障域"的选项；`failureDomain` 记录介质序列号/共享名，`verifiedBy` 记录 owner |
| B. `D:\dsh-bili-backups`（同物理磁盘另一分区） | 可执行但**非独立故障域** | 只能防误删/逻辑损坏，不防整盘/控制器故障；`failureDomain` 必须如实写 `same-physical-disk:D (NVMe Disk0; NOT independent)`，验收报告不得宣称灾备已满足 |
| C. 暂不配置 | 保持 BLOCKED | 真实写入继续被 `BACKUP_UNPROTECTED` 拒绝 |

建议：能接外置介质就选 A；否则接受 B 并在验收记录中明确"仅逻辑备份、非灾备"。

## 4. 必须由 owner 在真实 TTY 中执行的步骤

> 便捷入口（同样在真实终端运行、逐步回答人类挑战）：
> `node scripts/acceptance/real-dm.mjs --to <mid> --text "<text>" --dest <path> --failure-domain "<text>" --verified-by "<name>"`，
> 先加 `--check` 可只校验参数并打印计划。脚本等价于下面 4.2～4.6 的命令序列，失败即停止、不自动重试。
> QQ 接入同理使用 `node scripts/acceptance/qq-setup.mjs ...`（见 `scripts/acceptance/README.md`）。
> 运行位置：本机原始终端（Windows Terminal / PowerShell 窗口），仓库目录 `D:\Workespace\xiaofeiyu`。
> 每个 `--confirm` 命令会展示绑定摘要并要求输入一次性挑战短语；请不要把挑战短语交给任何自动化进程代答。

### 4.1 放置 B 站凭据（owner 本人操作，勿粘贴到聊天）

保存到 `C:\Users\22338\.dsh\dsh-bili-unified\credentials.json`，字段**只能**是以下四个：
`sessdata`、`bili_jct`、`buvid3`、`dedeuserid`（未知字段会 `CONFIG_INVALID`；文件权限建议仅当前用户可读）。
可用 `BILI_SESSDATA/BILI_JCT/BILI_BUVID3/BILI_DEDEUSERID` 环境变量替代文件，但文件方式优先。

### 4.2 绑定 B 站账号（真实只读核验）

```powershell
node cli.mjs account verify
```

期望：`accounts` 中出现绑定的稳定账号；不触发任何写操作。

### 4.3 配置备份策略与恢复点（TTY 人类挑战）

1) 在仓库外（或 `.dsh-probe/`，已被 git 忽略）保存一个候选策略 JSON，按 §3 选择 `destinationRoot` 与如实的
`failureDomain`/`verifiedBy`：

```json
{
  "schemaVersion": 1,
  "scheduleEnabled": false,
  "destinationRoot": "D:\\dsh-bili-backups",
  "failureDomain": "same-physical-disk:D (NVMe Disk0; NOT independent)",
  "verifiedBy": "<owner 名字>",
  "verifiedAt": null,
  "intervalMinutes": 15,
  "maxPointAgeMinutes": 20,
  "fullIntervalHours": 24,
  "keepRecent": 8,
  "keepDaily": 7,
  "keepWeekly": 4,
  "autoPrune": false,
  "checkpointTimeoutMs": 5000
}
```

2) 保存策略（human proof）：

```powershell
node cli.mjs backup policy --file .dsh-probe\backup-policy.candidate.json --confirm
```

3) 立即创建一个 ledger 恢复点（human proof）：

```powershell
node cli.mjs backup create --kind ledger --confirm
```

4) 核验并确认保护窗口：

```powershell
node cli.mjs backup verify <backupId>
node cli.mjs backup status
```

期望：`service.status=protected`，`ageMs < maxPointAgeMinutes*60000`。ledger 点不覆盖媒体，`mediaUnprotected=true`
属预期（DM/评论门禁不需要媒体；真实发布另需 full 点）。恢复点超过 20 分钟会 `BACKUP_STALE`，
真实写入前需重新 `backup create`。

> 命令语法已用临时目录 + 测试用 TTY verifier 做过 smoke 验证（policy→create→verify→status 均成功、
> 状态为 protected、`config update` 成功）；真实路径仍必须由 owner 在交互终端完成人类挑战。

### 4.4 打开 DM 真实写入所需配置（TTY 人类挑战）

创建 `acceptance-config.json`（示例，`<OWNER_MID>` 为 B 站用户 mid，`<PEER_MID>` 为白名单收件人 mid）：

```json
{
  "dryRun": false,
  "directMessages": {
    "enabled": true,
    "allowedRecipientMids": [<PEER_MID>],
    "requireMutual": true,
    "dailyLimit": 1,
    "sameVideoDays": 7,
    "maxLength": 300
  }
}
```

```powershell
node cli.mjs config update --file acceptance-config.json --confirm
```

说明：`dryRun=false` 与 `directMessages.enabled=true` 是真实派发前置；`dailyLimit`/`sameVideoDays`/`rateLimit.writePerHour`
仍会限流，白名单外收件人直接 `RECIPIENT_NOT_ALLOWED`，不能给自己发（`FORBIDDEN`）。

### 4.5 执行 1 次最低额度真实 DM（TTY 人类挑战）

在 §4.3 的恢复点仍在 20 分钟窗口内执行：

```powershell
node cli.mjs dm --to <PEER_MID> --text "dsh-bili-unified acceptance ping (single message)" --go
```

成功标准：输出 task/operation 回执，`task get <taskId>` 为 `succeeded` 且含平台回执；`status` 中
`counts`、额度与业务键（`dm:...`）落账；失败按 `not_sent`/`unknown` 语义处理，unknown 不允许盲目重试。

### 4.6 证据保全

```powershell
node cli.mjs status
node cli.mjs task get <taskId>
node cli.mjs outbox resolve ...   # 仅在产生 IM 通知且结果未知时，按受控证据登记
```

把上述输出（脱敏后）追加到验收报告；不要在报告中写入 Cookie、挑战短语或完整私信正文。

## 5. QQ / OneBot 接入被阻塞的输入

按用户"IM 接入使用 QQ"方向，代码与只读探测已就绪（`src/adapters/channels/onebot-qq.js`、`im probe`，
见 `QQ_ONEBOT_INTEGRATION_2026-11-09.md`），当前仍缺少以下**真实值**，提供后即可继续：

1. OneBot v11 桥接的 HTTP API 地址（如 `http://127.0.0.1:3000`）与正向 WebSocket 地址（如 `ws://127.0.0.1:3001`）；
2. access token 的环境变量名与值（只放本机环境变量，不写配置/报告）；
3. 机器人 QQ 号（可用 `node cli.mjs im probe` 读出 `botAccountId`）与 owner QQ 号；
4. 桥接实现与版本（NapCat / Lagrange / 其他），以便记录能力与已知限制。

拿到后按顺序：`im probe`（只读）→ owner TTY 中 `im bind --file <binding.json> --confirm` →
真实 QQ 私聊发一条最低额度通知 → 回执入库；IM 审批路径按设计会返回 `TRUST_UNAVAILABLE`（fail-closed），
审批仍走本地 TTY。

## 6. 本文件不构成执行授权

以上命令是交接清单：备份策略、备份点与真实 DM 都需要 owner 本人在 TTY 中逐项确认；本 agent 未执行、
也不会代为输入人类挑战。真实写入是否执行、执行目标与文本由用户决定。

## 7. agent 侧安全门禁实测（2026-11-10）

为确认"agent 不能代替 owner 完成敏感步骤"，在隔离临时目录对本 agent 的非 TTY 环境做了实测：

| 命令（临时数据目录） | 结果 |
|---|---|
| `node cli.mjs backup policy --file <policy> --confirm` | `TRUST_UNAVAILABLE: interactive TTY is unavailable`；未生成 `backup-policy.json` |
| `node cli.mjs config update --file <patch> --confirm` | `TRUST_UNAVAILABLE`；未生成/修改 `config.json` |
| `node cli.mjs dm --to <mid> --text <text> --go` | 打印绑定摘要后 `TRUST_UNAVAILABLE`；未创建 Task/未外发 |
| 真实数据目录 `node cli.mjs account verify`（无凭据） | `CREDENTIAL_MISSING: SESSDATA is missing`；`credentials.bound` 仍为 false |

结论：当前会话（无可靠 TTY、无凭据）无法绕过人类挑战、备份保护或凭据检查；上述步骤必须由 owner 本人完成。
