# T12.3 真实 Windows ↔ Linux 跨 OS 停机迁移方案（2026-11-11）

> 状态：**owner 已确认 4 项决策（2026-11-12）；执行卡见 [T12_3_EXEC_CARD_2026-11-12.md](T12_3_EXEC_CARD_2026-11-12.md)**。执行前复核修复了 F11（目标首次激活恢复点）与 F12（CLI import 无 runtime 崩溃）；目标 Linux 侧独立目的地已定为 X1（COS 独立前缀，探针通过）。**路线 B 已于 2026-11-15 执行并通过部分验收**（真实生产账本 export/import/validate，两端摘要一致，执行中修复 F13–F15），结果见 [T12_3_ROUTE_B_RESULT_2026-11-15.md](T12_3_ROUTE_B_RESULT_2026-11-15.md)；完整路线 A（目标 activate + 回迁）待排时间窗。本文保留 2026-11-11 方案正文，命令差异以执行卡为准。
> 目标环境：本机 Windows（生产数据）↔ 用户提供的腾讯云 Linux `42.193.20.17`（Ubuntu 24.04，sudo 可用）。

## 0. 结论摘要（给决策者）

- 迁移协议已实现并经过**合成数据**的双向验证（Windows→Linux→Windows，见 `report/priority-linux-acceptance-2026-11-11.json`）；缺的是**真实生产账本**的一次执行。
- 真实迁移必须在 **DSH 应用关闭**、源端不再写入的时间窗内，由 owner 在两侧真实 TTY 中执行；agent 无法在 DSH 关闭期间驱动流程（本方案可作为逐步 runbook）。
- 迁移包**不包含** credentials、backup-policy、config；代码、config、credentials 均需**带外传输**并单独校验。
- 目标 Linux 侧默认只激活 `core:read/core:write`；平台能力需 `account verify` 后另行 `migration reauthorize`。目标侧**没有独立备份域**，因此不建议在目标上执行任何真实平台写。
- 回滚分两种：release 前用 `migration abort`；release 后用 `disable-target` + `rollback`（需要把目标最新账本目录复制回 Windows 供源端读取）。

## 1. 当前基线（2026-11-11 23:20 实测）

| 项 | 值 |
|---|---|
| 代码版本 | `git HEAD = 3bef4cd`（本方案要求两端代码同版本；记录 hash 于验收证据） |
| 数据目录 | `C:\Users\22338\.dsh\dsh-bili-unified` |
| 数据体积 | 总 426,066 B；其中 journal 168,002 B，artifacts/diary/production-work 均为 0 |
| 账本 | eventSeq=186，journalSegments=69，journalPending=0；unknownOperations=0 |
| 任务/操作 | tasks：3 succeeded + 3 failed（全部 settled）；operations：3 confirmed + 2 not_sent |
| 迁移/恢复 | migration.phase=`active`，recovery.phase=`normal`，holds=0 |
| 账号 | bilibili `3546827282450731`（白阑王）；credentials 已绑定 |
| 备份保护 | 远程独立故障域，已有 protected ledger 点（下次执行前须新建新鲜点） |
| 目标主机 | `VM-0-5-ubuntu`，Linux 6.8，Ubuntu 24.04；`/dev/vda2` 59G，已用 92%，可用约 4.8G（均为该次测量）。root 已有 Node v24.14.0（`/root/.nvm/versions/node/v24.14.0/bin/node`）及 ffmpeg/ffprobe，已按用户要求通过 `sudo -i` 完成隔离验收；普通 ubuntu PATH 未暴露它，不代表主机未安装 Node |
| 目标数据/包空间需求 | 包 ≈ 428KB × 1.1 + 16MB ≈ 17MB；目标 `/home/ubuntu` 空间充足 |

## 2. 迁移语义（代码事实，便于审核）

迁移包 `manifest.json` 记录并校验：

- `migrationId`、`workspaceId`、`sourceInstanceId`、`targetInstanceId`、`historyEpoch`、`cutEventSeq`、`configRevision`、`timeZone`、`stableAccountRefs`、`profileDependencies`、`recoveryRefs`、`fileCount/totalBytes`、逐文件 `sha256`、`snapshotHash`。
- 包内文件角色：`state`（脱敏 state.json）、`journal`（全部归档段）、`diary`、`artifacts`、`bundle/posts`；**不含** config/credentials/backup-policy/instance。
- 导入时：目标目录必须为空；自动生成新 `instanceId`（status=`paused`，`scheduledDisabled=true`）；所有 approval `usableForAuthorization=false`、`nonceHash=null`；未结算 Task 追加 migration hold；pending/sending outbox 置 `suppressed`；production `readyForPublish=false`；bindings `requiresReverification=true`。
- 激活前置：`validate` 通过 + source release receipt 与 package/target 绑定 + 显式 `--source-stopped` + **目标侧健康独立恢复点**（2026-11-12 F11 修复后，全新目标可在 imported/validated 阶段由本地 owner 创建首个恢复点；见执行卡 §1.1/§4.4）。
- 释放前不可 export 的状态：存在 live local executions、未结算 executions、in-flight operations、pending artifact imports、pending diary commits、journal 未归档、无健康独立恢复点（`BACKUP_UNPROTECTED/BACKUP_STALE`）。

## 3. 执行前提与决策门

| 门 | 内容 | 通过条件 |
|---|---|---|
| G0 | 用户批准本方案与时间窗；确认是否要求“返回 Windows” | 明确回答 §9 的 4 个问题 |
| G1 | 目标环境就绪 | Node 22+ 安装并校验、代码同 commit、包/目标目录权限就绪、SSH 可用 |
| G2 | 源端 preflight | `status`：active、unknown=0、unsettled=0、journalPending=0；`migration status`=active；无 live execution；**DSH 已关闭且不再连源库** |
| G3 | 健康独立恢复点 | 真实 TTY 执行 `backup create --kind ledger --confirm`，`status` 显示 `protected` 且 age < 20min |
| G4 | 人机可用性 | owner 能在两侧真实 TTY 连续完成约 18 次一次性挑战（含回迁）；迁移窗口内不接受外部写入 |
| G5 | 目标侧独立恢复点（2026-11-12 新增；已解决） | **owner 已确认 X1**：COS 独立前缀 `/cos-backup/dsh-bili-backups`（实测连通/读写/改名/集成探针通过）；目标 policy 模板已备（[backup-policy.cos-target.template.json](backup-policy.cos-target.template.json)）；目标 activation 前写 policy 并创建首个恢复点（F11 修复后支持） |

## 4. 阶段步骤（可执行 runbook）

> 约定：Windows 命令在 `D:\Workespace\xiaofeiyu` 下、真实 PowerShell 窗口执行；Linux 命令通过 `ssh -t ubuntu@42.193.20.17` 在真实 TTY 执行。所有 `--confirm` 会显示一次性挑战短语，必须 owner 本人输入。

### Phase 0：环境与保险准备（不触碰生产账本）

1. Windows 侧：
   - 关闭 DSH 桌面应用（避免插件运行时与 CLI 并发写源库）；确认任务管理器无 `DeepSeek Harness`。
   - 关闭 NapCat/QQ 桥接（迁移窗口内不需要 IM，减少外部写入）。
   - 记录基线：`git rev-parse HEAD`、`node --version`、`node cli.mjs status`、`node cli.mjs migration status` 输出存档。
   - **文件系统级保险副本**（不是迁移包，不必走 TTY）：把整个数据目录复制到 `D:\dsh-migration-<ts>\source-data-backup`，并记录 `robocopy`/`sha256` 清单；此副本只作灾难兜底，不能替代受保护恢复点。
2. Linux 侧：
   - 先在拟使用的运行账号下核验 Node 22+。root 已有 v24.14.0；本次隔离验收目录另有校验过的 Node v22.23.4。仅当生产运行账号确实缺少可用运行时时，才另准备官方 tarball 并校验 `SHASUMS256.txt`，记录真实绝对路径与 `node -v`；下文 `/opt/node-v22.x-linux-x64` 是待替换示例，不是现有安装事实。
   - 传输代码：Windows 执行 `git archive --format=tar --output D:\dsh-migration-<ts>\code.tar HEAD`，scp 到 Linux 后解压到 `/home/ubuntu/xiaofeiyu`；两端核对 `git` 不可用时直接比对 `src/index.js` 的 sha256 与 commit 记录。
   - 建目录：`/home/ubuntu/dsh-migration/transfer`、`/home/ubuntu/dsh-bili/data`（`data` 必须为空）。
3. 记录计划使用的 target 标签（prepare 时使用，例：`instance_linux_target_20261111`）。

### Phase 1：源端 preflight 与冻结前检查（TTY 窗口开始）

```powershell
cd D:\Workespace\xiaofeiyu
node cli.mjs status
node cli.mjs migration status
node cli.mjs backup status
# 若距离上次 protected 点已超过 20 分钟，先创建新鲜点：
node cli.mjs backup create --kind ledger --confirm
```

通过标准：`instance.status=active`、`migration.phase=active`、`unknownOperations=0`、`unsettled=0`、`journalPending=0`、`backup.status=protected`。

### Phase 2：源端 prepare → export → release

每条均为 TTY 一次性挑战，顺序不可颠倒：

```powershell
# 2.1 冻结源端（新写入被阻断，进入 quiescing）
node cli.mjs migration prepare --target instance_linux_target_20261111 --confirm

# 2.2 导出迁移包（--out 必须是不在 dataDir 内的空目录；推荐绝对路径）
node cli.mjs migration export <migrationId> --out D:\dsh-migration-20261111\package

# 2.3 发布释放（源实例 retired；receipt.json 写入 package 目录）
node cli.mjs migration release <migrationId> --confirm
```

记录并核对：

- `migrationId`、`snapshotHash`、`cutEventSeq`、`fileCount/totalBytes`；
- `package\manifest.json` 的 `snapshotHash`；
- `package\receipt.json` 的 `snapshotHash`、`targetInstanceId`、`migrationId`；
- `instance.json` → `status=retired`（release 后）。

> 到 release 为止仍可用 `migration abort <migrationId> --confirm` 回到 active；release 后只能走 §6.2 回滚。

### Phase 3：传输与完整性校验

```powershell
# Windows → Linux
scp -r D:\dsh-migration-20261111\package ubuntu@42.193.20.17:/home/ubuntu/dsh-migration/transfer/
scp D:\dsh-migration-20261111\code.tar ubuntu@42.193.20.17:/home/ubuntu/dsh-migration/
# Linux 侧
sha256sum /home/ubuntu/dsh-migration/transfer/package/manifest.json
sha256sum /home/ubuntu/dsh-migration/transfer/package/receipt.json
```

两端比对 `manifest.json`/`receipt.json` 的 sha256 与 Windows 输出；导入时还会按 manifest 逐文件 sha256 复验。

### Phase 4：目标端 import → validate → activate（TTY，SSH 伪终端）

```bash
ssh -t ubuntu@42.193.20.17
export NODE=/opt/node-v22.x-linux-x64/bin/node
cd /home/ubuntu/xiaofeiyu

# 4.1 导入（目标 data 目录必须为空）
$NODE cli.mjs migration import --from /home/ubuntu/dsh-migration/transfer/package --data-dir /home/ubuntu/dsh-bili/data --confirm

# 4.2 放入业务配置与凭据（迁移包不含它们；凭据 600 权限）
cp /home/ubuntu/dsh-migration/config.json /home/ubuntu/dsh-bili/data/config.json
install -m 600 /home/ubuntu/dsh-migration/credentials.json /home/ubuntu/dsh-bili/data/credentials.json

# 4.3 校验（目标 instance 应为 validated，allowedCapabilities=core:read/core:write）
$NODE cli.mjs migration validate <migrationId> --data-dir /home/ubuntu/dsh-bili/data

# 4.4 激活（必须带 --source-stopped，receipt 使用包内 receipt.json）
$NODE cli.mjs migration activate <migrationId> --receipt /home/ubuntu/dsh-migration/transfer/package/receipt.json --data-dir /home/ubuntu/dsh-bili/data --source-stopped --confirm

# 4.5 只读状态
$NODE cli.mjs status --data-dir /home/ubuntu/dsh-bili/data
```

期望：`instance.status=active`、`allowedCapabilities` 初始仅 `core:read/core:write`、`previousInstanceId=源 instanceId`、`schedulerDisabled=true`。

### Phase 5：目标端验收矩阵（只读）

| 检查 | 期望 |
|---|---|
| workspaceId / historyEpoch | 与 manifest 一致 |
| instanceId / previousInstanceId | 新 id / 源 id |
| accountRef | 与源一致（`3546827282450731`） |
| 永久键 businessKeys | 与源导出前一致 |
| tasks / operations | 已结算任务不变；未结算任务带 migration hold；unknown=0 |
| approvals | 全部 `usableForAuthorization=false`；旧审批 decide 应被拒绝 |
| outbox | pending/sending 全部 suppressed |
| production | `readyForPublish=false`、`migrationHold=true` |
| journal | eventSeq=cutEventSeq；segment 哈希复验通过；journalPending=0 |
| artifact | 包内文件 sha256 与账本一致（当前为 0 个） |
| 重启 | 再次启动 runtime，仍是同一个 instanceId 且只有一个 active 实例 |
| 源端 | 源 `instance.status=retired`，且不得再对源库写/打开 DSH |

### Phase 6（可选）：目标端能力重授权

```bash
# 只读平台能力需要：目标 credentials + config.platforms.enabled 含 bilibili + account verify 一致
$NODE cli.mjs account verify --data-dir /home/ubuntu/dsh-bili/data
$NODE cli.mjs migration reauthorize <migrationId> --capabilities core:read,core:write,platform:bilibili --data-dir /home/ubuntu/dsh-bili/data --confirm
```

- 通过后只做只读校验（whoami/status）；**不在目标执行真实平台写**（目标没有独立备份域，受保护派发会 fail-closed）。
- `im` 能力不建议在目标重授权（目标没有 QQ 桥接；bindings 需重新核验）。

### Phase 7（可选，取决于 G0 决策）：返回 Windows

两种模式：

- **A. 验收后回迁原 Windows 生产**：在 Linux 上按 Phase 2 反向执行（prepare/export/release），把包传回 Windows，在**新的空目录**（如 `D:\dsh-bili-unified-return`）import/validate/activate；验收后：停止 DSH → 把旧源库改名 `dsh-bili-unified.retired-<ts>` → 把 return 目录移动为原位（或修改插件 dataDir 配置）→ 重启 DSH。旧源实例保持 retired。
- **B. 直接以 Linux 为新生产**：跳过返回；在 Linux 配置新的独立备份介质与真实 IM 桥接不在本方案范围。

### Phase 8：收尾

- 保留源 retire 目录、迁移包、receipt、两端 `status` 输出作为证据；
- 若 credentials 复制到过 Linux：回迁/结束后**轮换 B 站 Cookie** 并重新 `account verify`；
- 清理 Linux 上的临时 credentials/包（保留 evidence JSON）；
- 更新 `doc/TASKS.md` T12.3 状态与 `doc/report/` 证据，提交 git。

## 5. 验收证据清单（执行时收集）

- 源端：prepare/export/release 的 JSON 输出、`manifest.json`/`receipt.json`、`instance.json` retired 状态、`git HEAD`。
- 传输：两端 `sha256sum`、文件数/总字节。
- 目标端：import/validate/activate 的 JSON、`status` 输出、第二次启动的 instance 一致性、旧审批拒绝与 hold 证据。
- 时间线：每个 TTY 挑战的时间点、cutEventSeq、snapshotHash。

## 6. 回滚方案

### 6.1 release 前（quiescing/sealed）

```powershell
node cli.mjs migration abort <migrationId> --confirm
```

源回 `migration.phase=active`；如已生成 package，删除可选；该路径不影响账本业务事实。

### 6.2 release 后（源已 retired）

前提：目标已停止写入；把目标**最新**数据目录复制回 Windows 可读位置。

```powershell
# 1) 从 Linux 复制目标最新账本目录回 Windows（state/instance/journal/artifacts/diary/posts/migration-*.json）
scp -r ubuntu@42.193.20.17:/home/ubuntu/dsh-bili/data D:\dsh-migration-rollback\target-data

# 2) 源端：显式停止目标写入并禁用目标（不能把目标目录直接当活动源）
node cli.mjs migration disable-target <migrationId> `
  --target-data-dir D:\dsh-migration-rollback\target-data `
  --target-stopped --target-stop-evidence "target runtime stopped; last copy at <time>" `
  --confirm

# 3) 源端：构建反向包并导入/校验/激活到新的恢复目录
node cli.mjs migration rollback <migrationId> `
  --target-data-dir D:\dsh-migration-rollback\target-data `
  --to D:\dsh-migration-rollback\recovered `
  --confirm
```

说明：
- `rollback` 以目标最新账本为准生成反向迁移包，并在 `--to` 目录完成 import/validate/activate；旧源实例保持 retired。
- 若目标在激活后产生了新业务（需独立保护才能发生），回滚只保留**目标账本里已提交的事实**；无法证明的区间按 recovery/unknown 规则处理，不伪造。
- 灾难级兜底：用 Phase 0 的文件系统副本或独立故障域的 protected 恢复点，走 `recovery restore/authorize`（只读新 epoch，不自动恢复旧写权限）。

## 7. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| 源端未真正停写（DSH/IM/计划任务） | 高 | 关闭 DSH 与 NapCat；prepare/export 前复查 migration.phase 与 eventSeq 稳定 |
| 传输损坏/包不完整 | 中 | manifest 逐文件 sha256 + snapshotHash + receipt 绑定；scp 后两端校验 |
| 凭据外泄 | 中 | 包内不含凭据；scp 单独传输 + chmod 600；结束后轮换 Cookie |
| 目标没有独立备份域却做真实写 | 高 | 目标只激活 core（+平台只读）；真实写保持 fail-closed；不做 IM |
| 目标磁盘 92% 已用 | 中 | 迁移前后检查可用空间；包小（<1MB），但避免在目标生成媒体 |
| release 后回滚不可得 | 中 | 保留目标最新账本副本 + Phase 0 文件系统副本 + protected 点；禁用目标前不得删除 |
| Windows 旧目录被误启动 | 高 | release 后不给旧目录启动 DSH；如需回迁按 Phase 7 新目录 + 改名流程 |
| WSL/远程挂载影响 | 低 | 迁移窗口内备份目的地仍可用；但 prepare 前必须已有新鲜 protected 点，不依赖实时挂载 |
| TTY 挑战中断 | 低 | 每步可幂等重试（同 migrationId）；失败保留输出，不重复真实写 |

## 8. 时间估算与人工步骤

- 环境准备（Node/代码/目录）：30–60 分钟；
- 源端 preflight + 新鲜保护点：10 分钟；
- prepare/export/release（3 次 TTY + 等待）：20–40 分钟；
- 传输与校验：10 分钟；
- 目标 import + policy + 首个恢复点 + validate/activate（约 5 次 TTY）：30–50 分钟（F11 修复后）；
- 验收矩阵 + 重启验证：30 分钟；
- 可选 reauthorize（1 次 TTY）：10 分钟；回迁 Windows（prepare/export/release + import/validate/activate，约 8 次 TTY）：1.5–2.5 小时。
- **合计（含回迁）：约 5–7 小时；TTY 挑战约 18 次。仅正向、不回迁约 3–4 小时 / 10–12 次。** 实际以执行卡 §3/§4 为准。

## 9. owner 决策记录（2026-11-12）

1. **目标标签**：可按日期变更 → 本次使用 `instance_linux_target_20261112`。
2. **是否要求返回 Windows**：**必须回迁 Windows**（执行卡 §4 A6–A8）。
3. **平台只读能力重授权**：**允许**复制 B 站 Cookie 到 Linux 做 `account verify` + `platform:bilibili` 只读重授权；目标不做真实平台写；完成后轮换 Cookie。
4. **时间窗与操作人**：确认可行；本人两侧真实 TTY 执行，DSH 关闭、无外部写。
5. **目标侧独立目的地（G5）**：确认选 **X1**——腾讯云 COS 桶 `claw-cos-data-1407061106` 的独立前缀 `/cos-backup/dsh-bili-backups`（桶内 `/claw2/dsh-bili-backups`）。2026-11-12 已实测连通/读写/改名/原子替换与真实 BackupService 集成探针（见 [COS_BUCKET_PROBE_2026-11-12.md](COS_BUCKET_PROBE_2026-11-12.md)），费用估算长期约 ¥1–1.5/月；目标 policy 模板见 [backup-policy.cos-target.template.json](backup-policy.cos-target.template.json)。

**已解决/剩余**：F11/F12 修复已提交回归（`ea13ec8` 基线）；X1 已确认；**路线 B 已于 2026-11-15 执行并通过部分验收**（见 [T12_3_ROUTE_B_RESULT_2026-11-15.md](T12_3_ROUTE_B_RESULT_2026-11-15.md)）；剩余仅路线 A 时间窗（目标 policy + 首点、activate、回迁、平台重授权）。

## 10. 明确不在本方案范围

- 目标 Linux 上的真实平台写、IM/QQ 桥接、Manual/External 投稿；
- 自动备份调度/持续 RPO-RTO（T22 另项）；
- GATE-0 签署与记忆能力（GATE-MEM）；
- 任何自动化绕过 TTY 人类证明、保护点或恢复 hold 的行为。
