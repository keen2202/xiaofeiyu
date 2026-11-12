# T12.3 路线 B 执行单页（2026-11-12，已预置）

> owner 已选定**路线 B：真实生产账本跨 OS 导出/导入/验证，不改生产状态**。目标侧环境与代码已预置完成，剩余步骤预计 **30–45 分钟 / 6 次 TTY 挑战**。
> 执行期间必须关闭 DSH 桌面（本会话不可用）。完成后重新打开 DSH，把 `D:\dsh-migration-20261112\evidence\` 下文件发我核验；本单页不替代 TTY 人类证明。

## 0. 已完成的预置（2026-11-12 22:58）

| 项 | 状态 |
|---|---|
| Windows 暂存目录 | `D:\dsh-migration-20261112\`（code.tar、commit.txt、evidence\） |
| 代码归档 | `code.tar`（HEAD=`ea13ec8`）；sha256 `40BFE2701586DF1A6C12FBE105EEC4613219B41F12421500E29765AC154AF1C0` |
| Windows ↔ 目标代码一致性 | `src/backup-recovery.js`、`src/migration.js`、`cli.mjs` 三文件 sha256 两端完全一致 |
| 目标环境 | `/home/ubuntu/xiaofeiyu`（已解压代码）、`/home/ubuntu/dsh-migration/`（code.tar、commit.txt、config.json 600）、`/home/ubuntu/dsh-bili/`（空，`data` 尚未创建） |
| 目标 Node | `/home/ubuntu/xiaofeiyu-acceptance-sx58lukl/node-v22.23.4-linux-x64/bin/node`（v22.23.4，与历史证据 tarball sha256 一致） |
| 目标 CLI 自检 | `$NODE cli.mjs` 正常打印帮助（F11/F12 修复已随代码预置） |
| 目标磁盘 | `/` 59G，已用 40G，可用 17G |
| 生产数据 | 未触碰；WSH 备份挂载需在执行窗口重新确认（见步骤 1） |

## 1. Windows 侧（关 DSH 后，真实 PowerShell 窗口）

```powershell
cd D:\Workespace\xiaofeiyu
New-Item -ItemType Directory -Force D:\dsh-migration-20261112\evidence | Out-Null
Start-Transcript D:\dsh-migration-20261112\evidence\route-b-transcript.txt

# 1.1 恢复独立备份目的地（同一窗口；WSL/Samba/SSHFS）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .dsh-probe\setup-remote-backup.ps1
Test-Path '\\172.30.28.135\dsh-bili-backups'          # 必须 True
node cli.mjs status
node cli.mjs migration status
node cli.mjs backup status

# 1.2 新鲜保护点（第 1 次 TTY 挑战）
node cli.mjs backup create --kind ledger --confirm
node cli.mjs backup status                            # 期望 protected，age 很小

# 1.3 冻结源端（第 2 次挑战；记录 migrationId）
node cli.mjs migration prepare --target instance_linux_target_20261112 --confirm
# 期望：phase=quiescing；记下 migration.id

# 1.4 导出（第 3 次挑战；export 无需 --confirm）
node cli.mjs migration export <migrationId> --out D:\dsh-migration-20261112\package
# 期望：phase=sealed；记录 snapshotHash、cutEventSeq、files、totalBytes

# 1.5 先传输（abort 会删 Windows 侧包目录），再 abort（第 4 次挑战）
scp -r D:\dsh-migration-20261112\package ubuntu@42.193.20.17:/home/ubuntu/dsh-migration/transfer/
Get-FileHash D:\dsh-migration-20261112\package\manifest.json -Algorithm SHA256
ssh -i C:\Users\22338\.ssh\win1.pem ubuntu@42.193.20.17 "sha256sum /home/ubuntu/dsh-migration/transfer/package/manifest.json /home/ubuntu/dsh-migration/transfer/package/receipt.json"
node cli.mjs migration abort <migrationId> --confirm
node cli.mjs status                                   # 期望 active；migration.phase=active
Stop-Transcript
```

预期 JSON（记入 evidence）：
- `backup create`：`backupId`、`status=verified`、`snapshotHash`；
- `prepare`：`migration.phase=quiescing`、`protectionPoint.backupId`；
- `export`：`phase=sealed`、`packageDir`、`snapshotHash`、`cutEventSeq=186`、`files`、`totalBytes`；
- `abort`：`phase=active`。

> 若 `backup status` 不是 protected：重跑 setup 脚本；若 `Test-Path` 失败，把执行卡 §5 第 7 条的 contingency 输出发我（可能需要 owner 更新 policy + 重建点）。

## 2. Linux 侧（`ssh -t`，2 次 TTY 挑战）

```bash
ssh -t ubuntu@42.193.20.17
export NODE=/home/ubuntu/xiaofeiyu-acceptance-sx58lukl/node-v22.23.4-linux-x64/bin/node
cd /home/ubuntu/xiaofeiyu
mkdir -p /home/ubuntu/dsh-migration/evidence

# 2.1 import（第 5 次挑战；data 目录必须为空/不存在）
$NODE cli.mjs migration import --from /home/ubuntu/dsh-migration/transfer/package \
  --data-dir /home/ubuntu/dsh-bili/data --confirm 2>&1 | tee /home/ubuntu/dsh-migration/evidence/import.json
# 期望：{"phase":"imported","files":...,"snapshotHash":"...","dataDir":"/home/ubuntu/dsh-bili/data"}

# 2.2 放业务配置（validate 需要 config；本路线不复制 Cookie）
install -m 600 /home/ubuntu/dsh-migration/config.json /home/ubuntu/dsh-bili/data/config.json

# 2.3 validate（第 6 次挑战）
$NODE cli.mjs migration validate <migrationId> \
  --data-dir /home/ubuntu/dsh-bili/data 2>&1 | tee /home/ubuntu/dsh-migration/evidence/validate.json
# 期望：phase=validated、capabilities=["core:read","core:write"]；平台能力不入清单（blocked 通常为空，平台只读需路线 A 的 reauthorize）

# 2.4 只读证据（不含 TTY）
$NODE cli.mjs status --data-dir /home/ubuntu/dsh-bili/data | tee /home/ubuntu/dsh-migration/evidence/status.json
$NODE -e "const fs=require('fs');const s=JSON.parse(fs.readFileSync('/home/ubuntu/dsh-bili/data/state.json'));const i=JSON.parse(fs.readFileSync('/home/ubuntu/dsh-bili/data/instance.json'));console.log(JSON.stringify({historyEpoch:s.historyEpoch,eventSeq:s.eventSeq,migration:s.migration,instanceStatus:i.status,previousInstanceId:i.previousInstanceId,capabilities:i.allowedCapabilities,approvalsAllInvalid:Object.values(s.approvals||{}).every(a=>a.usableForAuthorization===false&&a.invalidatedByMigration===true),unsettledHolds:Object.values(s.tasks||{}).filter(t=>!['succeeded','cancelled'].includes(t.status)).map(t=>({id:t.id,holds:(t.holds||[]).map(h=>h.kind)})),pendingOutbox:Object.values(s.outbox||{}).filter(o=>['pending','sending'].includes(o.status)),backups:s.backups,journalPending:s.journalPending},null,2))" \
  | tee /home/ubuntu/dsh-migration/evidence/target-summary.json
```

## 3. 证据回传与清理

```powershell
# Windows 侧（DSH 可先不打开）
scp -r ubuntu@42.193.20.17:/home/ubuntu/dsh-migration/evidence D:\dsh-migration-20261112\
# 核对后清理目标临时账本/配置（保留 evidence 与 sha256 记录）
ssh -i C:\Users\22338\.ssh\win1.pem ubuntu@42.193.20.17 "rm -rf /home/ubuntu/dsh-bili/data /home/ubuntu/dsh-migration/transfer/package /home/ubuntu/dsh-migration/config.json; ls /home/ubuntu/dsh-migration"
```

然后重新打开 DSH → `status` 应显示生产仍 active（仅新增 `migration.lastAborted` 审计）。把 `D:\dsh-migration-20261112\evidence\` 发我，我核验后更新 TASKS/报告并提交；**T12.3 仍为部分验收（目标 activate 未执行）**。

## 4. 失败处理速查

| 现象 | 处理 |
|---|---|
| `backup create` → `BACKUP_UNPROTECTED/degraded` | 重跑 `setup-remote-backup.ps1`；`Test-Path` 失败说明 WSL IP 变化，记录新 IP 后告知我 |
| `prepare` → `MIGRATION_BLOCKED` | 看 `node cli.mjs status`：unsettled/unknown/journalPending 非 0 或存在 RecoveryHold 时不要重试，把输出发我 |
| `export` → `JOURNAL_CORRUPTED`/`MIGRATION_BLOCKED` | 保留输出，可同 migrationId 幂等重试一次；仍失败则 `abort` 后把输出发我 |
| 已 export 但未传完就想 abort | 先传完再 abort（abort 删除 Windows 包目录，Linux 副本不受影响） |
| target `import` → `target data directory is not empty` | `rm -rf /home/ubuntu/dsh-bili/data` 后重试 |
| target `validate` → `MIGRATION_BLOCKED` | 保留 `import.json`/`validate.json` 与 `state.json` 关键字段，不要自行改账本 |
| 中途中断 | Windows 侧：`migration status` 看阶段；quiescing/sealed 可 `abort`，released 不走本路线 |

## 5. 本路线不做什么

- 不 release、不 activate、不复制 Cookie、不做平台/IM 真实调用；
- 不改写生产 dataDir、不启动第二实例、不删除任何生产文件；
- 不把注入测试或合成数据算作真实跨 OS 验收；目标 activate/回迁仍属路线 A（需先定目标侧独立故障域）。
