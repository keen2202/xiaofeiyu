# P3 真实验收记录：远程独立备份域 + 单条真实评论（2026-11-11）

> 结论：**已完成两项真实环境验收**：
> 1. owner 核验的**独立故障域**备份目的地已建立（Windows → WSL Samba → SSHFS → 腾讯云主机），并创建、验证了一个 `protected` 账本恢复点；
> 2. 在该保护点有效期内，经 owner 真实 TTY 一次性审批，向 B 站 `BV1mv4Y6rESW` 成功写入 **1 条真实评论**，并在平台侧独立回读确认。
>
> 本记录不改变 GATE-0/GATE-MEM 状态；不宣称 Manual/External 发布、持续 RPO/RTO 或 DSH 内 IM 组合已完成。

## 1. 独立备份域

### 1.1 硬件与介质事实

| 项 | 值 |
|---|---|
| 本机磁盘 | 仅 1 块物理 NVMe：SAMSUNG MZALQ512HALU-000L2（Disk 0），C: 与 D: 是同一磁盘的分区 |
| 远程序列 | 用户提供 SSH：`ubuntu@42.193.20.17`，密钥 `C:\Users\22338\.ssh\win1.pem`，可免密 `sudo -i` |
| 远端系统 | `VM-0-5-ubuntu`，Linux 6.8.0-71-generic x86_64 |
| 远端备份目录 | `/srv/dsh-bili-backups`（远端 `/dev/vda2`，59G，已用 92%，可用约 4.8G） |
| 故障域声明 | `remote-host:42.193.20.17 (Tencent Cloud VM-0-5-ubuntu; independent physical host via WSL2 SSHFS + Samba mount; local host has a single NVMe Disk0)` |
| 核验人/时间 | `白阑王` / `2026-11-11T13:50:15.982Z`（owner 声明的物理独立性；软件不依据盘符推断） |

### 1.2 挂载链路（已验证）

```text
Windows 备份服务/CLI (Node)
  -> UNC \\172.30.28.135\dsh-bili-backups            (WSL2 vEthernet, 动态 IP)
  -> Samba smbd (WSL Ubuntu-24.04, share dsh-bili-backups, user bili, force user keen2206)
  -> FUSE sshfs /home/keen2206/dsh-bili-backups
  -> SSHFS -> ubuntu@42.193.20.17:/srv/dsh-bili-backups
```

验证项（2026-11-11 21:47–21:52）：
- Windows 写入的文件在远端 `ls -la /srv/dsh-bili-backups` 可见（数据确实落在远端，而非本机缓存）；
- Node 在 UNC 路径上执行 `mkdir / wx 锁文件 / 写入 / fsync / 文件与目录 rename / 递归删除 / statfs` 全部通过；
- 远端 `index.json` 由备份服务实际写入，含 `backup_8e99f036090b41008ac33566d00f4a57` 的 manifest 摘要。

重建脚本（普通权限，可重复执行）：`.dsh-probe/setup-remote-backup.ps1`
（内部：WSL sshfs 挂载 → WSL Samba 配置/启动 → 解析 WSL IP → `net use` 映射 → 写读自检）

### 1.3 策略与恢复点（owner 真实 TTY 执行）

owner 在真实终端运行 `.dsh-probe/tty-backup-remote.ps1`，完成两次一次性人类挑战：

1. `backup policy --file .dsh-probe/backup-policy.remote.json --confirm`
2. `backup create --kind ledger --confirm`

结果（`node cli.mjs status` 与远端 `index.json` 双证据）：

| 项 | 值 |
|---|---|
| policy destinationRoot | `\\172.30.28.135\dsh-bili-backups` |
| `failureDomainVerification.independent` | `true`（owner 声明，sourceRoot/destinationRoot/verifiedBy/verifiedAt 绑定） |
| backupId | `backup_8e99f036090b41008ac33566d00f4a57` |
| kind / status | `ledger` / `verified` |
| cutAt | `2026-11-11T13:59:05.299Z` |
| verifiedAt | `2026-11-11T13:59:16.146Z` |
| files / cutEventSeq | 47 / 134 |
| sourceStateHash / snapshotHash | `jcs-sha256-v1:6e71…80a7` / `jcs-sha256-v1:e32f…5a91` |
| policyRevision | `jcs-sha256-v1:10e30…afb4` |
| 保护状态 | `protected`（dispatched 前复核 age < 20 分钟） |

限制与注意：
- 旧同盘策略的 12 个历史点不匹配新 policyRevision，不再计入保护；
- 该点仅为 ledger，媒体覆盖 `complete=false`（真实发布需另建 full 点）；
- 远端磁盘已用 92%，当前仅够小体量 ledger/full；长期保留需扩容或另选介质；
- WSL IP 为动态（当前 `172.30.28.135`），WSL 重启后需重跑 setup 脚本；若 IP 变化需重新保存策略；
- 持续 15 分钟调度、20 分钟上限、24 小时媒体目标与 RPO/RTO 仍属 T22 待验项。

> 说明：TTY 脚本最后一行的汇总曾误读 `backup status` 的 `service.status`（该子命令不含保护字段），导致脚本报“not protected”；实际保护状态取自主 `status` 命令，为 `protected`。修复：`.dsh-probe/tty-backup-remote.ps1` 已改读主 `status`。

## 2. 真实评论写入（B 站）

### 2.1 授权与目标

用户明确选择“由 agent 起草 1 条热门视频评论，交 owner TTY 审批”。目标为只读热门列表中的 `BV1mv4Y6rESW`《近十几年的梗都在这里了》（author 怠惰的一休，mid 27501480，非本人内容）。

| 项 | 值 |
|---|---|
| 评论文本 | `这个合集太全了，看完很有共鸣，感谢整理！` |
| textHash | `jcs-sha256-v1:ed7d96c39084104b02552c4e2a28ad68ee7d9f927ab2a10238b7af08c465765a` |
| platformData | aid `117565317715732`，cid `43362486677`（由适配器解析，非调用方提供） |
| 模式 | `comments.mode=approval`，单条，dailyLimit=3 |

### 2.2 审批与派发

1. 草稿：`node cli.mjs comment --draft .dsh-probe/comment-draft.json`
   - task `task_ac3a25534fb34d5e9bbaaf8fc8315d84` → `waiting_approval`
   - approval `approval_e9291ecebbdc4b6cac274ed065f4f80e`，有效期至 `2026-11-11T14:11:00.494Z`
2. 第一次 `approval decide ... --go` 缺失审批自身的一次性 `nonce` → `APPROVAL_STALE: approval nonce is required`；**零副作用**（未派发、未消耗审批）。
3. 使用带 `--nonce` 的 `.dsh-probe/tty-approve-comment.ps1` 重试：owner 输入一次性人类挑战短语后派发。
   - startedAt `2026-11-11T14:06:19.750Z`，finishedAt `2026-11-11T14:06:21.145Z`
   - task → `succeeded` / settled / attempts=0
   - operation `op_5f916581484f4550a3d6bd9c1baf645a` → `confirmed`
   - receipt：`externalId=323659699648`，url `https://www.bilibili.com/video/BV1mv4Y6rESW#reply323659699648`，`verification=platform_readback`，receivedAt `2026-11-11T14:06:21.101Z`

### 2.3 平台独立回读

只读 `GET https://api.bilibili.com/x/v2/reply?type=1&oid=117565317715732&sort=0&ps=20&pn=1`（cookie 从本机凭据读取，未输出值）：

```json
{
  "rpid": "323659699648",
  "mid": "3546827282450731",
  "uname": "白阑王",
  "ctime": 1794405980,
  "ctimeUtc": "2026-11-11T14:06:20.000Z",
  "content": "这个合集太全了，看完很有共鸣，感谢整理！",
  "textMatches": true,
  "like": 0,
  "state": 0
}
```

### 2.4 副作用与保护边界

- 派发时保护点 age ≈ 7 分 14 秒（cut 13:59:05.299Z → dispatch 14:06:19.750Z），在 20 分钟上限内；
- 主 `status`：`counts.unknownOperations=0`、`unsettled=0`、backup=`protected`；
- 写额度：单条评论，受 rate limiter 写桶与 comments 每日额度约束；
- 评论为公开内容，owner 可自行在 B 站删除；本系统未做自动清理或重试；
- 未做第二次评论，未触碰 Manual/External 发布。

## 3. 当前仍剩余（P3/P4）

| 项 | 状态 | 说明 |
|---|---|---|
| T12.1 IM approve 路径 + DSH 内 IM 组合 | BLOCKED | 机器人 QQ 275748387 遭腾讯风控下线（OneBot online=false，NapCat 显示“已登录但 offline”）；需重启 NapCat 后重新扫码 |
| T12.2 Manual/External 投稿 | 未实测 | 需 owner 明确内容/额度/发布器范围；Manual 需 Artifact + 审批，External 需绑定执行器 |
| T12.3 真实双系统迁移 | 未实测 | 需实际 Windows/Linux 双环境与生产授权前置 |
| T20/T22 持续 RPO/RTO、介质损坏演练 | 部分 | 独立故障域已具备并有一个 protected 点；15 分钟调度、媒体 full、持续 RPO/RTO、物理介质损坏/异地恢复未测 |
| T17.3 生产 TTY 人类证明 | 未实测 | 媒体验收使用测试 human verifier |
| T11 正式人工审查/签署 | 未完成 | 自动化与定向回归通过 |
| GATE-0 | 暂缓 | 用户选择暂缓签署，继续按已授权范围实施 |
| GATE-MEM | 未审核 | 后置，不实施记忆能力 |

## 4. 证据清单

| 证据 | 位置/ID |
|---|---|
| 远端策略/恢复点 | `\\172.30.28.135\dsh-bili-backups\index.json`（`backup_8e99f036090b41008ac33566d00f4a57`） |
| 本机策略 | `C:\Users\22338\.dsh\dsh-bili-unified\backup-policy.json` |
| 策略/核验输入 | `.dsh-probe/backup-policy.remote.json`、`.dsh-probe/verification.remote.json` |
| TTY 脚本 | `.dsh-probe/tty-backup-remote.ps1`、`.dsh-probe/tty-approve-comment.ps1` |
| 评论任务/操作 | `task_ac3a25534fb34d5e9bbaaf8fc8315d84`、`op_5f916581484f4550a3d6bd9c1baf645a` |
| 评论回执 | `externalId=323659699648`（`verification=platform_readback`） |
| 平台回读脚本 | `.dsh-probe/comment-readback.mjs` |
| 结构化证据 | `report/real-comment-readback-2026-11-11.json` |
