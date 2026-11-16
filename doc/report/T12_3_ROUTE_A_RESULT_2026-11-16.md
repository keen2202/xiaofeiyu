# T12.3 路线 A 执行结果（2026-11-16，目标 activate + 回迁）

> 结论：**路线 A 完成**。真实生产账本从 Windows 源端迁到 Linux 目标并 `activate`，再以反向迁移回迁 Windows 并 `activate`；两跳的 `snapshotHash`、manifest/receipt 哈希、目标实例链均可核对。
> 判定：T12.3 由「部分验收」改为 **PASS**（收尾项见 §6，不影响迁移结论）。
> 本报告依据：两端 CLI 输出、`D:\dsh-migration-20261115\evidence\`、`/home/ubuntu/dsh-migration/evidence/`、Windows 最终账本只读审计（`validateState`/`validateInstance` 通过）。

## 1. 实例与迁移链

| 角色 | instanceId | 迁移 | 快照 |
|---|---|---|---|
| Windows 源（起点） | `instance_6c8df66c5ad34a5986687d1c93cfda2e` | `migration_0cd0a1a1cc964d648643b0ece71656ec` | `jcs-sha256-v1:0fca551b…` |
| Linux 目标（第一跳） | `instance_85f9aab97d4a4ebda23400a6ff78f7aa` | `migration_cd45ed32634d4aee96f80c29702c6136`（反向） | `jcs-sha256-v1:6f211ff1…` |
| Windows 回迁（终点） | `instance_f7d054a9c38e418783366d5203ca4677` | `migration_cd45ed32634d4aee96f80c29702c6136` | `jcs-sha256-v1:6f211ff141feeccce3526aa68b46bbd4fb4411f188f4bacd7ef1afbfaa1bdeff` |

- 终点实例 `previousInstanceId=instance_85f9aab9…`，`intendedTargetInstanceId=instance_windows_return_20261115`，`migrationActivation.migrationId/snapshotHash` 与回迁包一致。
- 目标名与 policy 中的 `failuredomain` 前缀分别对应 COS 独立前缀（Linux 侧）与 SMB 独立主机（Windows 侧）。

## 2. 时间线（UTC）

| 时间 | 步骤 | 结果 |
|---|---|---|
| 10:02:40 | 源端保护点 `backup_7d72b076…` | `protected`，cut 记录于 prepare |
| 10:03:26 | `migration prepare` | `quiescing`，`executors.stopped=true`，无 unsettled |
| 10:07:55 | `migration export` | `sealed`，81 文件 / 405744 字节，`cutEventSeq=202` |
| 10:12:11 | `migration release` | `released`，源实例 `retired`，receipt 绑定快照 |
| 11:57:07 | Linux `migration import` | `imported`，81 文件，快照一致 |
| 12:13:37 | Linux 首个恢复点 `backup_c30cdeb5…` | `verified`，COS 独立故障域 |
| 12:16:54 | Linux `migration validate` | `validated`，`capabilities=["core:read","core:write"]`，`blocked=[]` |
| ~12:24 | Linux `migration activate` + `reauthorize` | `active`，能力 3 项（`platform:bilibili` 已核验） |
| 12:30:00 | 反向 `export` | `sealed`，86 文件 / 425461 字节，`cutEventSeq=213` |
| 12:30:27 | 反向 `release` | `released`，Linux 实例 `retired` |
| 12:38:24 | Windows `migration import`（反向包） | `imported`，86 文件，快照一致 |
| 12:39:27 | Windows 恢复点 | `protected`（SMB 独立主机） |
| 12:40:12 | Windows `migration validate` | `validated`，`blocked=[]` |
| 12:41:02 | Windows `migration activate` | `active`，`previousInstanceId=instance_85f9aab9…` |
| 12:44:39 | Windows `reauthorize` | 能力 `["core:read","core:write","platform:bilibili"]` |

## 3. 哈希链

| 跳 | snapshotHash | manifest SHA256 | receipt SHA256 | 文件/字节 |
|---|---|---|---|---|
| 正向（Windows→Linux） | `jcs-sha256-v1:0fca551bb7162bfc4184ad399782a75d30ef31791bd5d87775293dda267a05da` | `9afec524…0515c8` | `58e8e27f…0d64` | 81 / 405744 |
| 反向（Linux→Windows） | `jcs-sha256-v1:6f211ff141feeccce3526aa68b46bbd4fb4411f188f4bacd7ef1afbfaa1bdeff` | `d59ebb49…dbd0c0` | `40f2d5d0…e9af` | 86 / 425461 |

两端 `manifest.json`/`receipt.json` 哈希逐一对照一致；正向包在 Windows 侧另以 `verifyMigrationPackage` 重算过全部文件哈希与 `snapshotHash`（81/81 通过、无多余文件）。

## 4. Windows 终点只读审计

- `validateState` / `validateInstance` 通过（账本可加载、字段不变式成立）。
- `instance.status=active`、`schedulerDisabled=true`、`activationRevision=3`。
- 能力：`core:read`、`core:write`、`platform:bilibili`；`capabilityDecision.state=committed`，`baseCapabilities` 为 core 两项。
- 6 个任务中 3 个 `failed` 保留 `migration` hold（`unsettled=3`），与迁移前一致；无 pending operation。
- 7 个旧审批全部 `invalidatedByMigration=true`、`usableForAuthorization=false`；2 个 IM 绑定均 `requiresReverification=true`；agent 主体同样待重验。
- outbox 11 条全部终态（10 `sent` / 1 `failed`），无 pending/unknown。
- 账号 `白阑王`（mid `3546827282450731`），`lastVerifiedAt=12:44:14Z`，`verifiedFrom=whoami`。
- 备份 `protected`（cut 12:39:27Z，20 分钟窗口内）；`mediaUnprotected=true` 属预期（仅 ledger 级点，无 full 点）。

## 5. 过程中发现并修复的问题

1. **TTY 铁律**：`--confirm` 与所有 `migration <sub>` 命令接 `| Tee-Object`/`>` 会让 stdout 非 TTY，直接 `TRUST_UNAVAILABLE`；改为裸跑 + 只读命令重定向，Linux 用 `script -q -c` 落盘（`fcfb47a`）。
2. **release receipt 时序**：receipt 在 release 时才写入包目录，而 import 只有在包内看到它才会写 `data/migration-receipt.json`；activate 强制要求该文件。执行单补 §1.6 补传步骤（`ad1ac56`）。
3. **reauthorize 能力列表**：`core:read/core:write` 是基础能力，`reauthorize` 白名单只接受增量能力；原执行单写法会 `INPUT_REQUIRED`，已改为 `--capabilities platform:bilibili`（`ad1ac56`）。
4. **跨用户读包**：export/release 以 root 运行，包内 0600 导致 `ubuntu` 用户 scp 报 `Permission denied`；传输前 `chown -R ubuntu:ubuntu` 修复。

## 6. 遗留收尾（不影响 PASS 判定）

- Linux 侧清理：`/home/ubuntu/dsh-bili/data`、`credentials.json`、两轮包副本（保留 evidence 日志）。
- Windows 侧保留 `dsh-bili-unified.retired-20261116` 作为唯一回退证据，签署后再删。
- B 站 Cookie 曾落到 Linux，按执行单 §6 轮换并重新 `account verify`。
- T22 真实项（墙钟 RPO/RTO、媒体 full 点、物理/异地介质）仍为 PARTIAL；T11/T13 正式人工签署未完成。

## 7. 证据位置

- Windows：`D:\dsh-migration-20261115\evidence\`（prepare/sealed/released 状态、manifest 与 receipt 哈希、package 与 return-package 实体）。
- Linux：`/home/ubuntu/dsh-migration/evidence/`（policy、backup-create、validate、activate、reauthorize 日志与 `return-hashes.txt`）。
- 保护点：源 `backup_7d72b076…`、Linux `backup_c30cdeb5…`、Windows 回迁后点（cut 12:39:27Z）。
