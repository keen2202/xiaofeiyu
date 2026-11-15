# T12.3 路线 B 执行结果：真实账本 Windows → Linux 导出/导入/验证（2026-11-15）

> 结论：**路线 B 部分验收通过**。真实生产账本已完成 `prepare → export → 传输 → 目标 import → validate → abort`，两端 `snapshotHash` 一致、目标能力仅 `core:read/core:write`、源端回到 `active` 且只剩 `lastAborted` 审计。**目标 `activate`、回迁与平台重授权未执行**（路线 B 本来不做），T12.3 与 T18 的完整验收仍缺该部分。
> 证据目录：`D:\dsh-migration-20261112\evidence\`（12 个文件）；过程补记见同目录 `route-b-retries.md`，账本事件见 `route-b-ledger-events.json`。

## 1. 环境与标识

| 项 | 值 |
|---|---|
| 执行日期 | 2026-11-15 16:19–19:52（+08:00） |
| Windows | `ADMIN\22338`，Windows NT 10.0.26200，PowerShell 5.1.26100.9818，Node v24.18.0，代码 `D:\Workespace\xiaofeiyu`（基线 commit `ea13ec8` + 本次工作区修复） |
| 目标 | `ubuntu@42.193.20.17`（VM-0-5-ubuntu），root 会话，Node v22.23.4，代码 `/home/ubuntu/xiaofeiyu` |
| 源 dataDir | `C:\Users\22338\.dsh\dsh-bili-unified` |
| 目标 dataDir | `/home/ubuntu/dsh-bili/data`（一次性，验收后删除） |
| migrationId | `migration_cbe993e12ea9418da9f0740ed2e27489` |
| 源实例 / 目标实例 | `instance_6c8df66c5ad34a5986687d1c93cfda2e` / `instance_b80efb6231c847bbb1a801ff4ed95f1e` |
| 包快照 | `jcs-sha256-v1:035418d4a400d2de88a53a6720b6b7253e3782ea0e32f4b6a6d308c50890003f`（74 文件 / 390033 字节） |
| manifest SHA256 | `70E50B188103ECAEEFB3C318394BBC010887167FB110B4E553F4FD037C048B86` |

## 2. 执行结果（关键值）

| 阶段 | 结果 |
|---|---|
| `backup create --kind ledger`（窗口内，16:19:45） | 恢复点 `backup_42acfa5deaea4bf89964f08e234b91d1`（由 `migration.prepare` 事件 payload 记录） |
| `migration prepare` | `phase=quiescing`，journal seq 193，`executorStopEvidenceHash=null`（无 live execution 需证据） |
| `migration export --out D:\dsh-migration-20261112\package` | `phase=sealed`，seq 194，`snapshotHash=035418d4…`，`files=74`，`totalBytes=390033`，manifest `sealedAt=2026-11-15T08:43:34.882Z` |
| 传输 | `scp -r` 到 `/home/ubuntu/dsh-migration/transfer/package`；Windows `Get-FileHash manifest.json` = `70E50B18…` |
| 目标 `migration import` | `phase=imported`，`files=74`，`snapshotHash=035418d4…`，`targetInstanceId=instance_b80efb…`（修复后重导；首次 `instance_b579ad12…` 已作废） |
| 目标 `migration validate` | `phase=validated`，`capabilities=["core:read","core:write"]`，`blockedCapabilities=[]`，`validatedAt=2026-11-15T09:01:42.393Z` |
| `migration abort` | seq 195，源端 `phase=active`，`lastAborted={migration_cbe993…, 08:44:59.208Z}`，Windows 侧 package 目录删除，`migrations/` 为空 |
| 窗口后补点（19:51:43） | `backup_bf2a3807937346fba9b68e6fa6003abf`，`cutAt=11:51:43.749Z`，`verifiedAt=11:51:56.548Z`，`points=6`；源端 `eventSeq` 由 195 → 198（`backup.capture.started/completed/copy.completed`） |

## 3. 跨端核对

| 核对项 | 结果 |
|---|---|
| `snapshotHash` 四处一致（journal sealed / 包 manifest / 目标 `state.migration` / `validate.json`） | ✔ `035418d4…` |
| 文件数与字节数 | ✔ 74 / 390033（manifest 自洽，逐条 sizeBytes 求和相同） |
| manifest 文件哈希两端一致 | ✔ `70E50B18…`（Windows `Get-FileHash` = 目标 `data/migration-package.json` sha256） |
| journal 段字节级复核 | ✔ 73/73 段 sha256 与 manifest `files[].sha256` 及源端 journal 文件一致 |
| journal 段哈希链 | ✔ 3/3 迁移事件重算 `segmentHash(historyEpoch, events)` 与段声明一致 |
| 目标任务/审批/outbox | ✔ 3 个 `failed` 任务各带 `migration` hold（`isSettled=false`、`finishedAt=null`）；7 条审批全部失效；`pendingOutbox=[]`；`backups={}` |
| 源端回退完整性 | ✔ `unsettled=0`、`unknownOperations=0`、`journalPending=0`、`credentials.mismatch=false`、能力 7 项与迁移前一致 |
| 目标自产审计事件 | 目标账本 `eventSeq=195`、`journalPending=2`：`config.revision.updated`（v11→v12，previousSha=源 `configRevision`）、`identity.credential.mismatch`（未复制 Cookie 的预期结果，`requires=account.verify`） |
| 目标备份状态 | `unprotected / policy_not_configured`（路线 B 未给目标建 policy，符合预期） |

## 4. 执行中发现并修复的缺陷（F13–F15）

| 编号 | 现象 | 根因 | 修复 | 回归 |
|---|---|---|---|---|
| F13 | `migration prepare` 等子命令报 `DEPENDENCY_UNAVAILABLE: The "paths[0]" argument must be of type string. Received undefined` | `cli.mjs` 在分派前无条件构造所有子命令 payload，`path.resolve(flags['data-dir'])`/`flags.from` 为 undefined；`TypeError` 被顶层兜底成 `DEPENDENCY_UNAVAILABLE`。因此 `prepare/export/release/abort/disable-target/rollback` 全部不可用 | 按子命令按需解析 flag；缺必填 flag 抛 `CONFIG_INVALID` 用法错误。同类加固：独立 `migration import`、`recovery restore`、`artifact import`、`recovery authorize --scope` | `test/fix-entry.test.js` 新增 2 例（无 `--data-dir` 的 prepare、必填 flag 用法错误） |
| F14 | `migration export --out D:\…` 报 `DEPENDENCY_UNAVAILABLE: EXDEV: cross-device link not permitted, rename …` | 暂存目录建在数据目录所在卷（C:），最终 `rename` 到 D: 输出目录跨卷失败；包已写完才失败 | `src/migration.js`：指定 `--out` 时暂存目录建在输出目录旁（同卷）；默认路径不变 | `test/migration.test.js`「export --out stages beside the target so cross-volume out dirs avoid EXDEV」 |
| F15 | 目标 `migration validate` 报 `STORE_CORRUPTED: invalid task field combination for failed` | `_importPackage` 给非终态任务加 migration hold 时只置 `isSettled=false`，已结算 `failed` 任务仍保留 `finishedAt`，违反账本不变量；`state.json` 直写，故 import 成功、下次加载才失败（本次账本有 3 个此类任务） | 同时置 `finishedAt=null`（与 `TaskManager` 重算语义一致）；写入前执行 `validateState`/`validateInstance`，非法账本在 import 当场失败 | `test/migration.test.js`「import normalizes a settled failed task so the target ledger stays loadable」 |

代码改动文件：`cli.mjs`、`src/migration.js`、`test/fix-entry.test.js`、`test/migration.test.js`（工作区，未提交）。验证：`test/fix-entry.test.js` 28/28、`test/migration.test.js` 19/19；全量 424 项 / 417 通过 / 2 跳过，5 项失败均为沙箱禁止子进程管道（`local-execution` ×4、`publisher` ×1，与本次改动无关）；`node scripts/check.mjs` 112 文件通过。

## 5. 证据清单（`D:\dsh-migration-20261112\evidence\`）

| 文件 | 用途 | 校验/备注 |
|---|---|---|
| `route-b-transcript.txt` | Windows 命令痕迹 | 无原生程序输出（PS 5.1 `Start-Transcript` 限制），仅 `Test-Path`/`Get-FileHash` |
| `route-b-retries.md` | 时间线、缺陷、偏差补记 | 与 journal 事件一致 |
| `route-b-ledger-events.json` | 源端 `prepare/sealed/aborted` 事件 + 段哈希链 | 3/3 段哈希重算通过 |
| `target-summary.json` | 目标账本摘要（migration/holds/outbox/approvals） | 与 `validate.json`/`status.json` 一致 |
| `validate.json` | 目标 `migration status` | 注意：CLI 输出把本地账本放在 `source` 键下（`target:null`），内容是目标账本 |
| `status.json` | 目标运行时状态 | `unsettled=3`、`journalPending=2`、`credentials.mismatch=true` 均为预期 |
| `package-manifest-meta.json` | 包 manifest 元数据 + 74 条 file sha256 | `fileCount=74`、`totalBytes=390033` |
| `imported-manifest.sha256` | `data/migration-package.json` 哈希 | `70e50b18…`，与 Windows 一致 |
| `transfer-manifest.note.txt` | 说明 transfer 哈希缺失与替代 | 包在复核前已被删除 |
| `source-status.json` / `source-migration-status.json` | 源端状态/迁移状态 | `active`、`lastAborted`、无残留 |
| `backup-create-after.json` | 窗口后 `backup status` | 最新点 `backup_bf2a3807…`、`verifiedAt=11:51:56Z`、`points=6` |

## 6. 流程偏差与证据边界（必须随验收记录一并保留）

1. **执行窗口内 DSH 未关闭**：单页要求关闭，实际全程开启（agent 会话可用）。源端处于 `quiescing`，业务写入被 store 层阻断，`export` 有 `eventSeq` 前后一致性检查，未发现并发写入；仍属未按单页执行。
2. **transcript 无命令输出**：PowerShell 5.1 的 `Start-Transcript` 不捕获 `node`/`scp`/`ssh` 等原生控制台程序输出；关键 JSON 已用独立文件补证。
3. **一次重复 `prepare`、两次 `export`/`scp`**：重复 `prepare` 在写事务前被拒（无副作用）；第一次 `export` 因 F14 失败，修复后第二次成功，见 `route-b-retries.md`。
4. **首次 import 被作废**：旧代码导入的账本因 F15 不合法，已 `rm -rf` 后重导（同一包、同一 migrationId），旧目标实例 `instance_b579ad12…` 作废。
5. **包在复核前被删除**：`/home/ubuntu/dsh-migration/transfer/package` 已不存在，`transfer-manifest.sha256` 无法产出；改用 `data/migration-package.json` 的字节一致副本证明 manifest 哈希（见 `transfer-manifest.note.txt`）。包内 `state.json` 因 import 会改写，只能做内容级核对。
6. **目标端清理无独立证据**：按单页 §3 删除目标 `data`/`transfer` 由 owner 确认执行；未留存远端 `ls` 输出。

## 7. 未完成（路线 A 前置，T18 完整验收所需）

- 目标侧独立故障域 policy + 首个恢复点（X1：COS 独立前缀 `/cos-backup/dsh-bili-backups`，模板 `report/backup-policy.cos-target.template.json`）；
- 目标 `activate`（需 `--receipt` + `--source-stopped` + 目标保护点）、能力重授权（可选复制 Cookie 做只读 `account verify` 与 `platform:bilibili`）；
- 回迁 Windows 的 `disable-target → rollback → activate` 链路与新 epoch 核对；
- 因此 T12.3 维持**部分验收**，T18 不因本路线完成而 DONE。

## 8. 单页勘误（下次复用需修正）

1. `<migrationId>` 是占位符，必须替换；PowerShell 会把 `<` 当重定向符。
2. `migration export --out` 在修复前跨卷必失败（F14）；修复后暂存于输出目录旁。
3. `migration status --data-dir` 的 JSON 把本地账本放在 `source` 键；`target` 恒为 `null`。
4. §3 清理命令里的 `/home/ubuntu/dsh-migration/config.json` 路径有误，实际在 `/home/ubuntu/dsh-bili/data/config.json`（随 data 删除）。
5. 证据建议逐命令 `Tee-Object`/`Out-File` 落盘，不要依赖 transcript。
