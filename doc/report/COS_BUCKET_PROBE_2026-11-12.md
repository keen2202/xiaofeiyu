# COS 存储桶 `/cos-backup` 连通性与费用估算（2026-11-12）

> 目的：评估 T12.3 路线 A 的 X1 方案（目标 Linux 侧独立备份目的地）是否可用，并给出本项目备份负载的 COS 费用估算。
> 结论：**连通性与读写/改名/原子替换全部实测通过**，现有 systemd + watchdog 使挂载具备自恢复；按当前账本规模和 15 分钟账本点估算，长期费用约 **¥1.0–1.5/月**（存储部分可忽略）；路线 A 一次性验收费用按 2 位小数扣费实际为 **0 元**。费用为按官方刊例价的估算，不是账单承诺。
> 证据：[cos-bucket-probe-2026-11-12.json](cos-bucket-probe-2026-11-12.json)；可复跑脚本：[.dsh-probe/cos-bucket-probe.sh](../../.dsh-probe/cos-bucket-probe.sh)。

## 1. 环境事实（SSH 实测）

| 项 | 值 |
|---|---|
| 主机 | `VM-0-5-ubuntu`（`42.193.20.17`），实例 `ins-24kr23mx`，地域 `ap-chengdu` |
| 存储桶 | `claw-cos-data-1407061106`，挂载前缀 `/claw2` |
| 挂载点 | `/cos-backup`（`cosfs` V1.0.21，`-oallow_other`，读写正常） |
| Endpoint | 主用内网 `http://cos-internal.ap-chengdu.myqcloud.com`（解析 `169.254.0.47`），失败回退公网 HTTPS |
| 挂载方式 | systemd `cos-backup.service`（oneshot，23:02:08 启动）；容器内 `mount` 显示 `cosfs on /cos-backup type fuse.cosfs` |
| 健康检查 | root cron `*/10 * * * * /usr/local/bin/cos-backup-watchdog.sh`：`mountpoint + ls` 失败则 `umount -l` 并 `systemctl restart cos-backup` |
| 凭据 | `/etc/passwd-cosfs` 权限 `600 root:root`（未读取内容） |
| 现有数据 | `/cos-backup/immich/{library,postgres,pre-upgrade,encoded-video,...}`；实测 `postgres` 36MB（DB 备份）；`library/encoded-video` 未做全量递归（避免扫描共享照片库） |
| 现有负载 | 该桶同时服务 immich 备份与视频加速（root cron 每分钟 sync，34 个视频资产，22:59 日志 `uploaded=0 skipped=34`） |

## 2. 连通性测试（隐藏探针目录，已清理，无残留）

脚本只写 `/cos-backup/.dsh-probe-*`，完成后删除；`leftoverProbeDirs=0`，写入前后 sha256 一致。

| 测试 | 结果 |
|---|---|
| 列出根目录 | 23 ms |
| 写 70 个 4KB 文件（≈1 个账本点的对象数） | **11,846 ms**（≈169 ms/对象，含逐对象 PUT） |
| `sync` | 11 ms |
| 读回 70 个文件（drop_caches 后） | **2,853 ms**（≈41 ms/对象） |
| 前后 sha256 | 一致 |
| 单对象写 20MiB | 872 ms；`sync` 13 ms；读回 157 ms |
| 目录跨父目录改名（70 文件，模拟备份发布） | **9,696 ms**，成功，内容完整 |
| 文件原子替换（`os.replace`，`atomicWriteFile` 路径） | 成功 |
| 清理删除探针目录 | 1,417 ms，无残留 |

**对本项目备份发布路径的推算**：F11 修复后的 `backup create` 发布一个当前规模账本点（约 71 个对象、0.37MiB）约为 **写 12s + 目录改名 10s + 回读校验 3s ≈ 25s**（不含策略/索引事务）。15 分钟调度下可接受；若账本 journal 段增长到数百段，发布时间与请求数近似线性增长。

## 3. 与 DSH 备份服务的兼容性

- ✅ 读、写、删除、目录改名、文件原子替换（`atomicWriteFile`/`renameWithRetry`）均可用；`os.replace` 实测成功。
- ✅ 同地域 CVM ↔ COS 自动走内网，**内网上/下行流量免费**；本方案不需要外网下行。
- ⚠️ cosfs 的**目录改名是客户端 copy+delete**（COS 无 rename），因此发布会额外产生“每对象 1 次读 + 1 次写 + 1 次删”的请求，且**不是原子发布**：若在改名中途崩溃，`backups/<id>` 可能残留部分对象，必须依赖既有 `verifyBackupDirectory` / 恢复流程拦截，不能宣称 COS 侧原子。
- ⚠️ 挂载与 immich 共享同一桶；本项目应使用独立前缀，例如 `/cos-backup/dsh-bili-backups`（桶内 `/claw2/dsh-bili-backups`），便于隔离与清理。
- ⚠️ 挂载故障时 `backup status` 会 fail-closed 为 `unprotected`；现有 watchdog 每 10 分钟自愈，仍建议在 T12.3 执行前检查 `mountpoint`/`Test-Path`。
- ⚠️ `/etc/passwd-cosfs` 为 root 600；插件在目标侧以 `ubuntu` 运行时通过 `allow_other` 写挂载点，凭据不进入插件数据目录。

## 4. 官方价格口径（中国大陆，含成都）

来源：[计费示例](https://cloud.tencent.com/document/product/436/6241)（2024-08 更新，标准存储/请求单价示例）、[计费概述](https://cloud.tencent.com/document/product/436/16871)、[存储容量费用](https://cloud.tencent.com/document/product/436/53482)、[请求费用](https://cloud.tencent.com/document/product/436/53861)、[流量费用](https://cloud.tencent.com/document/product/436/53863)、[免费额度](https://cloud.tencent.com/document/product/436/6240)、[请求账单为 0 元的原因](https://cloud.tencent.cn/developer/techpedia/1039/7266)。

| 计费项 | 单价（刊例价） |
|---|---|
| 标准存储容量 | **0.118 元/GB/月**（≈0.00393 元/GB/天，按日结算） |
| 标准存储读请求 | **0.01 元/万次** |
| 标准存储写请求 | **0.01 元/万次** |
| 内网上/下行流量 | **免费**（同地域 CVM↔COS） |
| 外网上行 | 免费 |
| 外网下行 | **0.5 元/GB**（本方案不走公网，不产生） |
| 免费额度 | 个人新用户 **50GB 标准存储 × 6 个月（180 天）**，仅抵扣存储容量，不抵扣请求/流量 |
| 结算细节 | 按日结算；费用最多 2 位小数，单日费用 <0.005 元时账单为 0 元 |

> 说明：0.118 元/GB/月与 0.01 元/万次是官方计费示例中的中国大陆标准存储价格；成都属公有云地域，实际账单以 [COS 定价中心](https://buy.cloud.tencent.com/price/cos) 与账单为准。若账号仍在免费额度有效期内，50GB 以内的存储容量费用可被抵扣。

## 5. 费用估算（本项目负载）

### 5.1 单点成本模型

当前账本备份点：**0.37MiB / 约 71 个对象**；cosfs 发布约产生 **350–500 次请求**（写 + 回读校验 + 改名 copy/delete + 索引），发布耗时约 25s。

### 5.2 场景估算

| 场景 | 用量假设 | 存储费/月 | 请求费/月 | 合计 |
|---|---|---|---|---|
| S1 路线 A 一次性验收 | 1–3 个恢复点（源端新点 + 目标首个点等），<3MB | <¥0.001 | ¥0.001–0.003 | **≈0 元**（2 位小数舍入） |
| S2 生产长期备份，15 分钟账本点 + 每日 full（当前规模） | 96 点/天 × ~370–500 请求；保留约 19 点 ≈ 7MiB | ≈¥0.001 | **¥1.0–1.5** | **≈¥1.0–1.5/月** |
| S3 同上但 30 分钟账本点 | 48 点/天 | ≈¥0.001 | ¥0.5–0.75 | **≈¥0.5–0.8/月** |
| S4 同上但每小时账本点 | 24 点/天 | ≈¥0.001 | ¥0.25–0.4 | **≈¥0.3–0.4/月** |
| S5 账本增长到 ~300 对象/点（≈1–2 年 journal 累积） | 15 分钟调度，约 1,500 请求/点 | ≈¥0.005 | ¥4–6 | **≈¥4–6/月** |
| S6 含媒体 full 备份（假设保留约 11 个 full） | 每 GB 媒体 ×11 份 | **+0.118×11 ≈ +¥1.3/GB 媒体** | 请求增量小 | 例：1GB 媒体 **+¥1.3/月**；10GB **+¥13/月** |

> S6 中 full 点包含 artifacts 媒体；当前 `artifacts=0`，暂无媒体成本。full 体积随投稿素材/产物增长，按实际 GB 线性增加。

### 5.3 现有 immich 数据（共享桶，另计）

- 已确认 `postgres` 备份 **36MB**；`library`/`encoded-video` 体积未扫描。
- 若需估算其现有费用：`0.118 元/GB/月 × 容量(GB)`；例如 10GB≈¥1.18/月，50GB≈¥5.9/月，100GB≈¥11.8/月，500GB≈¥59/月，1TB≈¥120.8/月，2TB≈¥241.7/月。请求费按其同步/缩略图访问频率另计。
- 免费额度是否仍在有效期内（COS 开通后 180 天）需在控制台确认；该桶最早使用记录为 2026-08-11，若 COS 于当时开通，免费额度约在 2027-02 到期。

## 6. 结论与建议

1. **技术上可用**：`/cos-backup` 满足 T12.3 X1 需要的“目标 Linux 侧、与目标主机不同故障域的独立目的地”条件（COS 托管存储 + 内网 endpoint；owner 可据此核验独立故障域），建议使用独立前缀 `/cos-backup/dsh-bili-backups`。
2. **费用极低**：路线 A 验收可忽略（0 元级）；若作为长期独立备份域，当前规模约 **¥1–1.5/月**；主要成本来自 cosfs 目录改名的逐对象请求，而非存储容量。
3. **运维前提**：执行前确认 `mountpoint /cos-backup` 与 `systemctl is-active cos-backup`；不要在同一前缀同时放 immich 与 DSH 备份；如需降低长期成本，可把调度降为 30–60 分钟或减少 full 媒体保留。
4. **边界**：COS 侧目录改名非原子，备份完整性仍由本项目的 verify/recovery 保证；本报告只判断连通性与费用，不改变 T12.3 的 TTY/人类证明/保护点要求。
5. **待 owner 确认**：是否把 X1（该桶 + 独立前缀）作为 T12.3 路线 A 的目标侧独立目的地；若是，后续按执行卡 §4.4 写目标 policy（`destinationRoot=/cos-backup/dsh-bili-backups`、`sourceRoot=/home/ubuntu/dsh-bili/data`）并创建目标首个恢复点（F11 路径）。
