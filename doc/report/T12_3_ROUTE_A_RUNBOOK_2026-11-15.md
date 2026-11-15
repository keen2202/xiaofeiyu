# T12.3 路线 A 执行单页（2026-11-15，目标 activate + 回迁）

> 前置：路线 B 已通过（真实账本 export/import/validate，见 [T12_3_ROUTE_B_RESULT_2026-11-15.md](T12_3_ROUTE_B_RESULT_2026-11-15.md)）；X1（COS 独立前缀 `/cos-backup/dsh-bili-backups`）探针通过；F13–F15 已修复并提交（`419f699`/`0ceaa8d`/`8274df1`）。
> 规模：约 **5–7 小时**、**约 18 次 TTY 挑战**；全程 owner 本人输入，DSH 桌面关闭。本单页不替代 TTY 人类证明。
> 相对 2026-11-12 执行卡的变化：① 代码需重新同步（F13–F15 修复）；② 上一轮包与目标数据已清理，必须重新 prepare/export；③ `migration export --out` 已支持跨盘；④ 证据逐命令落盘（`Start-Transcript` 不捕获 `node`/`scp` 输出）。

## 0. 预检（无 TTY，先做，不通过就停）

```powershell
# Windows
cd D:\Workespace\xiaofeiyu
git rev-parse HEAD                       # 应为含 F13–F15 的提交
node -v                                  # v24.18.0
node scripts/check.mjs                   # 112 文件 OK
node cli.mjs status                      # instance=active、migration.phase=active、backup=protected
# 关闭 DSH 桌面并确认进程退出（任务管理器无 DeepSeek Harness）；NapCat 如需 IM 则脱离 DSH 进程树启动
Test-Path '\\172.30.28.135\dsh-bili-backups'   # True（Windows 侧的独立备份目的地）
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

```powershell
New-Item -ItemType Directory -Force D:\dsh-migration-20261115\evidence | Out-Null
# 1.1 新鲜保护点（挑战1；maxPointAgeMinutes=20，prepare 必须在 20 分钟内）
node cli.mjs backup create --kind ledger --confirm | Tee-Object D:\dsh-migration-20261115\evidence\backup-create.json
# 1.2 冻结（挑战2）
node cli.mjs migration prepare --target instance_linux_target_20261115 --confirm | Tee-Object ...\prepare.json
#   期望 phase=quiescing；记下 migrationId
# 1.3 封包（无 --confirm，仍要 TTY 挑战3）
node cli.mjs migration export <migrationId> --out D:\dsh-migration-20261115\package | Tee-Object ...\export.json
#   期望 phase=sealed、snapshotHash、files、totalBytes
# 1.4 传输 + 两端 manifest 哈希（无 TTY）
scp -i C:\Users\22338\.ssh\win1.pem -r D:\dsh-migration-20261115\package ubuntu@42.193.20.17:/home/ubuntu/dsh-migration/transfer/
Get-FileHash D:\dsh-migration-20261115\package\manifest.json -Algorithm SHA256 | Tee-Object ...\manifest-windows.sha256
ssh -i C:\Users\22338\.ssh\win1.pem ubuntu@42.193.20.17 "sha256sum /home/ubuntu/dsh-migration/transfer/package/manifest.json" | Tee-Object ...\manifest-target.sha256
# 1.5 release（挑战4；源 instance=retired，包内出现 receipt.json）
node cli.mjs migration release <migrationId> --confirm | Tee-Object ...\release.json
#   核对 package\receipt.json 的 migrationId/targetInstanceId/snapshotHash 与 export 一致
#   注意：release 后不能再 abort；失败只能按 §5 处理
```

## 2. 目标端：import → 首个恢复点 → validate → activate（6 次挑战）

```bash
export NODE=/home/ubuntu/xiaofeiyu-acceptance-sx58lukl/node-v22.23.4-linux-x64/bin/node
cd /home/ubuntu/xiaofeiyu
E=/home/ubuntu/dsh-migration/evidence; mkdir -p $E
$NODE cli.mjs migration import --from /home/ubuntu/dsh-migration/transfer/package \
  --data-dir /home/ubuntu/dsh-bili/data --confirm              # 挑战1
install -m 600 /home/ubuntu/dsh-migration/config.json /home/ubuntu/dsh-bili/data/config.json
install -m 600 /home/ubuntu/dsh-migration/credentials.json /home/ubuntu/dsh-bili/data/credentials.json   # D3 允许复制 Cookie

# 2.1 目的地与 policy（policy 用模板，verifiedAt 换成当前 UTC）
date -u +%Y-%m-%dT%H:%M:%S.000Z
$NODE cli.mjs backup policy --file /home/ubuntu/dsh-migration/backup-policy.target.json \
  --data-dir /home/ubuntu/dsh-bili/data --confirm               # 挑战2
$NODE cli.mjs backup create --kind ledger --data-dir /home/ubuntu/dsh-bili/data --confirm   # 挑战3（F11 路径）
# 2.2 validate（挑战4）
$NODE cli.mjs migration validate <migrationId> --data-dir /home/ubuntu/dsh-bili/data | tee $E/validate.json
# 2.3 activate（挑战5；需 receipt 与 --source-stopped）
$NODE cli.mjs migration activate <migrationId> \
  --receipt /home/ubuntu/dsh-migration/transfer/package/receipt.json \
  --data-dir /home/ubuntu/dsh-bili/data --source-stopped --confirm | tee $E/activate.json
$NODE cli.mjs status --data-dir /home/ubuntu/dsh-bili/data | tee $E/status-active.json
# 2.4 只读平台重授权（account verify 免 TTY；reauthorize 挑战6）
$NODE cli.mjs account verify --data-dir /home/ubuntu/dsh-bili/data | tee $E/account-verify.json
$NODE cli.mjs migration reauthorize <migrationId> \
  --capabilities core:read,core:write,platform:bilibili \
  --data-dir /home/ubuntu/dsh-bili/data --confirm | tee $E/reauthorize.json
```

验收要点：`status` 显示 `instance=active`、`migration.phase=active`、`migrationActivation.migrationId` 匹配、能力只含已核验项、`schedulerDisabled=true`、`previousInstanceId=源 instanceId`；旧审批仍不可用、任务 hold 保留、outbox suppressed；重启一次 CLI 后同 instanceId（迁移激活的断电重试用例已覆盖，但真实环境再确认一次）。

## 3. 回迁：Linux prepare/export/release（4 次挑战）

```bash
$NODE cli.mjs backup create --kind ledger --data-dir /home/ubuntu/dsh-bili/data --confirm   # 挑战1（新鲜点）
$NODE cli.mjs migration prepare --target instance_windows_return_20261115 \
  --data-dir /home/ubuntu/dsh-bili/data --confirm                                            # 挑战2
$NODE cli.mjs migration export <returnId> --out /home/ubuntu/dsh-migration/return-package \
  --data-dir /home/ubuntu/dsh-bili/data                                                      # 挑战3
$NODE cli.mjs migration release <returnId> --data-dir /home/ubuntu/dsh-bili/data --confirm   # 挑战4
sha256sum /home/ubuntu/dsh-migration/return-package/manifest.json | tee $E/return-manifest.sha256
```

Windows 拉回：`scp -i ... -r ubuntu@42.193.20.17:/home/ubuntu/dsh-migration/return-package D:\dsh-migration-20261115\return-package`，比对 manifest/receipt 哈希。

## 4. Windows 回迁 import/validate/activate（4 次挑战）

```powershell
# 关闭 DSH 与 NapCat，确认无插件进程
Rename-Item 'C:\Users\22338\.dsh\dsh-bili-unified' 'dsh-bili-unified.retired-20261115'
New-Item -ItemType Directory 'C:\Users\22338\.dsh\dsh-bili-unified' | Out-Null
node cli.mjs migration import --from D:\dsh-migration-20261115\return-package `
  --data-dir 'C:\Users\22338\.dsh\dsh-bili-unified' --confirm                     # 挑战1
Copy-Item '...retired-20261115\config.json' 'C:\Users\22338\.dsh\dsh-bili-unified\config.json'
Copy-Item '...retired-20261115\credentials.json' 'C:\Users\22338\.dsh\dsh-bili-unified\credentials.json'
Copy-Item '...retired-20261115\backup-policy.json' 'C:\Users\22338\.dsh\dsh-bili-unified\backup-policy.json'
node cli.mjs backup create --kind ledger --data-dir 'C:\Users\22338\.dsh\dsh-bili-unified' --confirm   # 挑战2
node cli.mjs migration validate <returnId> --data-dir 'C:\Users\22338\.dsh\dsh-bili-unified'          # 挑战3
node cli.mjs migration activate <returnId> --receipt D:\dsh-migration-20261115\return-package\receipt.json `
  --data-dir 'C:\Users\22338\.dsh\dsh-bili-unified' --source-stopped --confirm                        # 挑战4
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

- 每次 `--confirm` 命令单独 `Tee-Object`/`tee` 落盘（幂等重试保留两份并注明）；关键 JSON：backup、prepare、export、release、import、validate、activate、status、account-verify、reauthorize、回迁四步与 Windows 激活。
- 两端 `git rev-parse HEAD`、`node -v`、代码 sha256、`manifest.json`/`receipt.json` 两端哈希。
- 完成后：重启 DSH → `status` 应 active + `backup=protected`；轮换已在 Linux 落盘的 B 站 Cookie 并重新 `account verify`；删除 Linux 侧 `data`/`credentials`/包副本，保留 retired 目录与证据。
- 更新 `doc/TASKS.md` T12.3/T18 状态与本报告，提交 git；**只有目标 activate 与回迁都成功，T12.3 才能从部分验收改为 PASS**。
