# T12.3 路线 A 执行单页（2026-11-15，目标 activate + 回迁）

> 前置：路线 B 已通过（真实账本 export/import/validate，见 [T12_3_ROUTE_B_RESULT_2026-11-15.md](T12_3_ROUTE_B_RESULT_2026-11-15.md)）；X1（COS 独立前缀 `/cos-backup/dsh-bili-backups`）探针通过；F13–F15 已修复并提交（`419f699`/`0ceaa8d`/`8274df1`）。
> 规模：约 **5–7 小时**、**约 18 次 TTY 挑战**；全程 owner 本人输入，DSH 桌面关闭。本单页不替代 TTY 人类证明。
> 相对 2026-11-12 执行卡的变化：① 代码需重新同步（F13–F15 修复）；② 上一轮包与目标数据已清理，必须重新 prepare/export；③ `migration export --out` 已支持跨盘；④ **TTY 铁律**：所有 `migration <sub>` 命令和 `--confirm` 命令必须**裸跑**，`| Tee-Object`、`>`、`| tee` 都会把 stdout 变成管道，`HumanTTYProof` 要求 stdin 与 stdout 同时是 TTY，否则直接 `TRUST_UNAVAILABLE: interactive TTY is unavailable`；证据改为“裸跑看控制台 + 只读命令重定向落盘”两步。

## 0. 预检（无 TTY，先做，不通过就停）

```powershell
# Windows
cd D:\Workespace\xiaofeiyu
git rev-parse HEAD                       # 应为含 F13–F15 的提交
node -v                                  # v24.18.0
node scripts/check.mjs                   # 113 文件 OK（含 test/manual 演练脚本）
node cli.mjs status                      # instance=active、migration.phase=active
node cli.mjs backup status               # 目的端可达、points>0、lastError=null（prepare 需要 protected）
# 关闭 DSH 桌面并确认进程退出（任务管理器无 DeepSeek Harness）；NapCat 如需 IM 则脱离 DSH 进程树启动
Test-Path '\\172.30.28.135\dsh-bili-backups'   # True（Windows 侧的独立备份目的地）
#   若为 False：先跑 .\.dsh-probe\setup-remote-backup.ps1 恢复 SMB 映射；WSL 重启后 IP 可能变化，
#   若脚本打印的新 IP 不是 172.30.28.135，需先用 owner TTY 更新 backup policy 的 destinationRoot
#   与 failureDomainVerification（旧恢复点 policyRevision 将不再计数，必须重建一个新点）。
```

```bash
# Linux 目标
ssh -i C:\Users\22338\.ssh\win1.pem -t ubuntu@42.193.20.17
export NODE=/home/ubuntu/xiaofeiyu-acceptance-sx58lukl/node-v22.23.4-linux-x64/bin/node
$NODE -v                                          # v22.23.4
mountpoint /cos-backup && systemctl is-active cos-backup && df -h / | tail -1
ls -ld /home/ubuntu/dsh-bili 2>/dev/null && ls -A /home/ubuntu/dsh-bili/data 2>/dev/null | head  # data 应不存在/为空
```

同步代码（Windows → 目标）：`git archive --format=tar --output D:\dsh-migration-20261115\code.tar HEAD`，`git rev-parse HEAD > commit.txt`，`scp` 后在目标 `tar -xf code.tar -C /home/ubuntu/xiaofeiyu`，并 `sha256sum cli.mjs src/migration.js` 与 Windows `Get-FileHash` 比对。

## 1. 源端：新点 → prepare → export → release（4 次挑战）

> **TTY 铁律（本轮踩过）**：`migration prepare/export/release/validate/activate/abort/...` 和所有 `--confirm` 命令都会走 `humanContext()`，要求 stdin 与 stdout 同时是 TTY。
> `| Tee-Object`、`>`、`| Out-File`、`| tee` 任一出现 → stdout 是管道 → `{"code":"TRUST_UNAVAILABLE","message":"interactive TTY is unavailable"}`，且**不会产生任何副作用**（可安全重跑）。
> 所以：挑战命令裸跑，控制台 JSON 手工复制进证据；结构化证据用后面的**只读**命令重定向（`migration status`/`backup status`/`status` 不需要 TTY）。

```powershell
$E = 'D:\dsh-migration-20261115\evidence'
New-Item -ItemType Directory -Force $E | Out-Null

# 1.1 新鲜保护点（挑战1；maxPointAgeMinutes=20，prepare 必须在 20 分钟内）
node cli.mjs backup create --kind ledger --confirm
node cli.mjs backup status | Out-File -Encoding utf8 $E\backup-status-after-create.json

# 1.2 冻结（挑战2）
node cli.mjs migration prepare --target instance_linux_target_20261115 --confirm
#   期望 phase=quiescing；记下 migrationId
#   若报 MIGRATION_BLOCKED + requiresExecutorStopEvidence，追加：
#   --executor-stop-evidence "closed DSH desktop, NapCat and all plugin processes at 2026-11-16T18:00:00+08:00"
#   若报 MIGRATION_BLOCKED 且提示 hold：先 migration release-hold <holdId> --task <taskId> --note "..." --confirm

# 1.3 封包（挑战3；export 虽无 --confirm，但仍需 TTY）
node cli.mjs migration export <migrationId> --out D:\dsh-migration-20261115\package
#   期望 phase=sealed、snapshotHash、files、totalBytes
node cli.mjs migration status | Out-File -Encoding utf8 $E\migration-status-sealed.json

# 1.4 传输 + 两端 manifest 哈希（无 TTY，可重定向）
scp -i C:\Users\22338\.ssh\win1.pem -r D:\dsh-migration-20261115\package ubuntu@42.193.20.17:/home/ubuntu/dsh-migration/transfer/
Get-FileHash D:\dsh-migration-20261115\package\manifest.json -Algorithm SHA256 | Out-File -Encoding utf8 $E\manifest-windows.sha256
ssh -i C:\Users\22338\.ssh\win1.pem ubuntu@42.193.20.17 "sha256sum /home/ubuntu/dsh-migration/transfer/package/manifest.json" | Out-File -Encoding utf8 $E\manifest-target.sha256

# 1.5 release（挑战4；源 instance=retired，包内出现 receipt.json）
node cli.mjs migration release <migrationId> --confirm
node cli.mjs migration status | Out-File -Encoding utf8 $E\migration-status-retired.json
#   核对 package\receipt.json 的 migrationId/targetInstanceId/snapshotHash 与 export 一致
#   注意：release 后不能再 abort；失败只能按 §5 处理

# 1.6 补传 receipt.json（关键）
#   receipt 是 release 时才写进包目录的，而 1.4 已经先传了包；import 只有在包里看到 receipt
#   才会写 data/migration-receipt.json，而 activate 强制要求该文件存在。
scp -i C:\Users\22338\.ssh\win1.pem "$MIG\package\receipt.json" ubuntu@42.193.20.17:/home/ubuntu/dsh-migration/transfer/package/receipt.json
Get-FileHash "$MIG\package\receipt.json" -Algorithm SHA256 | Out-File -Encoding utf8 $E\receipt-windows.sha256
ssh -i C:\Users\22338\.ssh\win1.pem ubuntu@42.193.20.17 "sha256sum /home/ubuntu/dsh-migration/transfer/package/receipt.json" | Out-File -Encoding utf8 $E\receipt-target.sha256
```

## 2. 目标端：import → 首个恢复点 → validate → activate（6 次挑战）

> Linux 上保留真实 TTY 又可落盘的办法是 `script`（分配伪终端，`isTTY` 为真）：
> `script -q -c "<命令>" <日志文件>`。直接 `| tee` 会失败。

```bash
export NODE=/home/ubuntu/xiaofeiyu-acceptance-sx58lukl/node-v22.23.4-linux-x64/bin/node
cd /home/ubuntu/xiaofeiyu
E=/home/ubuntu/dsh-migration/evidence; mkdir -p $E

# 挑战1（裸跑，控制台输出复制进证据；import 结束后补只读状态）
$NODE cli.mjs migration import --from /home/ubuntu/dsh-migration/transfer/package \
  --data-dir /home/ubuntu/dsh-bili/data --confirm

install -m 600 /home/ubuntu/dsh-migration/config.json /home/ubuntu/dsh-bili/data/config.json
install -m 600 /home/ubuntu/dsh-migration/credentials.json /home/ubuntu/dsh-bili/data/credentials.json   # D3 允许复制 Cookie

# 2.1 目的地与 policy（policy 用模板，verifiedAt 换成当前 UTC）
date -u +%Y-%m-%dT%H:%M:%S.000Z
script -q -c "$NODE cli.mjs backup policy --file /home/ubuntu/dsh-migration/backup-policy.target.json --data-dir /home/ubuntu/dsh-bili/data --confirm" $E/policy.log        # 挑战2
script -q -c "$NODE cli.mjs backup create --kind ledger --data-dir /home/ubuntu/dsh-bili/data --confirm" $E/backup-create.log            # 挑战3（F11 路径）

# 2.2 validate（挑战4；注意 validate 也需要 TTY）
script -q -c "$NODE cli.mjs migration validate <migrationId> --data-dir /home/ubuntu/dsh-bili/data" $E/validate.log
$NODE cli.mjs migration status --data-dir /home/ubuntu/dsh-bili/data | tee $E/migration-status-validated.json

# 2.3 activate（挑战5；需 receipt 与 --source-stopped）
script -q -c "$NODE cli.mjs migration activate <migrationId> --receipt /home/ubuntu/dsh-migration/transfer/package/receipt.json --data-dir /home/ubuntu/dsh-bili/data --source-stopped --confirm" $E/activate.log
$NODE cli.mjs status --data-dir /home/ubuntu/dsh-bili/data | tee $E/status-active.json

# 2.4 只读平台重授权（account verify 免 TTY；reauthorize 挑战6）
$NODE cli.mjs account verify --data-dir /home/ubuntu/dsh-bili/data | tee $E/account-verify.json
# 只列“增量”能力：core:read/core:write 是 validate 给的基础能力，reauthorize 只接受
# platform:bilibili / production:local / publish:manual / publish:external / im，传 core:* 会被拒。
script -q -c "$NODE cli.mjs migration reauthorize <migrationId> --capabilities platform:bilibili --data-dir /home/ubuntu/dsh-bili/data --confirm" $E/reauthorize.log
$NODE cli.mjs status --data-dir /home/ubuntu/dsh-bili/data | tee $E/status-reauthorized.json
```

验收要点：`status` 显示 `instance=active`、`migration.phase=active`、`migrationActivation.migrationId` 匹配、能力只含已核验项、`schedulerDisabled=true`、`previousInstanceId=源 instanceId`；旧审批仍不可用、任务 hold 保留、outbox suppressed；重启一次 CLI 后同 instanceId（迁移激活的断电重试用例已覆盖，但真实环境再确认一次）。

## 3. 回迁：Linux prepare/export/release（4 次挑战）

```bash
script -q -c "$NODE cli.mjs backup create --kind ledger --data-dir /home/ubuntu/dsh-bili/data --confirm" $E/return-backup-create.log        # 挑战1（新鲜点）
script -q -c "$NODE cli.mjs migration prepare --target instance_windows_return_20261115 --data-dir /home/ubuntu/dsh-bili/data --confirm" $E/return-prepare.log   # 挑战2
script -q -c "$NODE cli.mjs migration export <returnId> --out /home/ubuntu/dsh-migration/return-package --data-dir /home/ubuntu/dsh-bili/data" $E/return-export.log   # 挑战3
script -q -c "$NODE cli.mjs migration release <returnId> --data-dir /home/ubuntu/dsh-bili/data --confirm" $E/return-release.log            # 挑战4
sha256sum /home/ubuntu/dsh-migration/return-package/manifest.json | tee $E/return-manifest.sha256
```

Windows 拉回：`scp -i ... -r ubuntu@42.193.20.17:/home/ubuntu/dsh-migration/return-package D:\dsh-migration-20261115\return-package`，比对 manifest/receipt 哈希。

## 4. Windows 回迁 import/validate/activate（4 次挑战）

```powershell
# 关闭 DSH 与 NapCat，确认无插件进程
Rename-Item 'C:\Users\22338\.dsh\dsh-bili-unified' 'dsh-bili-unified.retired-20261115'
New-Item -ItemType Directory 'C:\Users\22338\.dsh\dsh-bili-unified' | Out-Null
node cli.mjs migration import --from D:\dsh-migration-20261115\return-package `
  --data-dir 'C:\Users\22338\.dsh\dsh-bili-unified' --confirm                     # 挑战1（裸跑）
Copy-Item '...retired-20261115\config.json' 'C:\Users\22338\.dsh\dsh-bili-unified\config.json'
Copy-Item '...retired-20261115\credentials.json' 'C:\Users\22338\.dsh\dsh-bili-unified\credentials.json'
Copy-Item '...retired-20261115\backup-policy.json' 'C:\Users\22338\.dsh\dsh-bili-unified\backup-policy.json'
node cli.mjs backup create --kind ledger --data-dir 'C:\Users\22338\.dsh\dsh-bili-unified' --confirm   # 挑战2（裸跑）
node cli.mjs migration validate <returnId> --data-dir 'C:\Users\22338\.dsh\dsh-bili-unified'          # 挑战3（裸跑）
node cli.mjs migration activate <returnId> --receipt D:\dsh-migration-20261115\return-package\receipt.json `
  --data-dir 'C:\Users\22338\.dsh\dsh-bili-unified' --source-stopped --confirm                        # 挑战4（裸跑）
node cli.mjs status
```

## 5. 失败处理与回滚

| 阶段 | 失败处理 |
|---|---|
| release 前任意失败 | `migration abort <id> --confirm` → 源回 active；包作废 |
| release 后目标 import/validate/activate 失败 | **源保持 retired**；修目标侧条件（policy/点/摘要）后同 migrationId 幂等重试 activate；不得删目标账本绕门禁 |
| 目标不可恢复 | `migration disable-target <id> --target-data-dir <目标账本副本> --target-stopped --target-stop-evidence "<说明>" --confirm` → `migration rollback <id> --target-data-dir <副本> --to <新空目录> --confirm`（源端保护点超 20 分钟会 `BACKUP_STALE`，回迁前先建新点，或走 A6–A7 正向回迁） |
| 回迁激活失败 | 保留 retired 目录与反向包；同 returnId 重试；旧目录是唯一回退证据，不得删除 |

## 6. 证据与收尾

- 人类挑战命令**裸跑**，控制台输出手工复制进证据文件；随后用只读命令（`backup status`/`migration status`/`status`）重定向补齐结构化证据。Linux 用 `script -q -c "<命令>" <log>` 保存逐字输出（含挑战提示），Windows 无等价 pty，只能复制控制台。关键 JSON：backup、prepare、export、release、import、validate、activate、status、account-verify、reauthorize、回迁四步与 Windows 激活。
- 两端 `git rev-parse HEAD`、`node -v`、代码 sha256、`manifest.json`/`receipt.json` 两端哈希。
- 完成后：重启 DSH → `status` 应 active + `backup=protected`；轮换已在 Linux 落盘的 B 站 Cookie 并重新 `account verify`；删除 Linux 侧 `data`/`credentials`/包副本，保留 retired 目录与证据。
- 更新 `doc/TASKS.md` T12.3/T18 状态与本报告，提交 git；**只有目标 activate 与回迁都成功，T12.3 才能从部分验收改为 PASS**。
