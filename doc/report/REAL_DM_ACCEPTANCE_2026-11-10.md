# 真实 B 站私信写入验收（T12.2 单动作）— 2026-11-10

结论：**在真实 TTY 人类挑战与新鲜恢复点保护下，向白名单收件人发送 1 条真实 B 站私信成功**，
任务 `succeeded`、操作 `confirmed`，并已用**只读平台回读**独立确认消息存在。范围严格限定为
“一次、一条、最低额度、白名单 mid”，不代表 T12.2 的评论/External 发布验收已完成。

## 1. 执行参数（owner 在真实终端确认）

| 项 | 值 |
|---|---|
| 执行方式 | `node scripts/acceptance/real-dm.mjs`（受保护 TTY 引导脚本） |
| 数据目录 | `C:\Users\22338\.dsh\dsh-bili-unified` |
| 账号 | 3546827282450731（白阑王，whoami 真实核验） |
| 收件人 | 508187015（白名单，requireMutual=true，互关） |
| 文本 | `hello` |
| 备份目标 | `D:\dsh-bili-backups` |
| 故障域 | `same-physical-disk:D (NVMe Disk0; NOT independent)`——单盘，**非独立故障域**，已如实记录 |
| 额度 | directMessages.dailyLimit=1，perRound=1；真实写入 1 条 |

## 2. 保护前置（写前重新核对）

- 恢复点：`backup_2aff9a1b172148d29240c81743da421c`（kind=ledger，cutAt `2026-11-10T13:39:29.875Z`）；
- 保护状态：`protected`，点年龄 11,763ms（上限 20 分钟）；
- 人类挑战：`dm.send` 一次性短语（真实 TTY）；审批对象绑定 recipient/text hash；
- owner 记录的故障域与 verifiedBy=白阑王 已写入 policy 并在发送前重验。

## 3. 结果与回执

```
taskId:      task_f6ad8b41f0744c5f881eb746521ba576   status=succeeded  isSettled=true
operationId: op_d2f63521d5e1470da2c8e125403003bf   status=confirmed
receipt:     externalId=7706537081688760000  verification=platform_readback
createdAt:   2026-11-10T13:39:49.168Z   finishedAt: 2026-11-10T13:39:49.614Z
```

**独立平台回读**（只读，使用本机凭据，`GET https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs?talker_id=508187015&session_type=1&size=20`）：

| 时间 (UTC) | 发送方 | 内容 |
|---|---|---|
| 2026-11-10T13:39:49Z | 3546827282450731（本账号） | `{"content":"hello"}` ← **本次验收写入** |
| 2026-11-10T11:57:52Z | 508187015（对方） | `hello` |
| 2026-11-10T11:53:00Z | 3546827282450731（人工历史） | `你好` |
| 2025-11-09T15:08:23Z | 508187015 | 互相关注系统提示 |

证据 JSON：`real-dm-evidence-1794317989745.json`（本目录，含 backup/task/account 摘要，无 Cookie/token）。

## 4. 前两次失败与修复（真实写入前的 not_sent 历史）

本目录的验收在真正成功前经历 3 次尝试，前两次均未产生平台效果，已按 `not_sent` 结案并留证
（`DM_UNKNOWN_OP_EVIDENCE_2026-11-10.md`）：

1. `op_c1649d3c14c745368ce5dc24368b446b`（13:16:45Z）：preflight 关系读取与 dispatch 重复读取
   触发读时间槽门禁，平台请求未发出 → 修复为 preflight 证据传给 dispatch（跳过二次读）。
2. `op_d95cad460f144cc687c2297011bf141c`（13:26:30Z）：请求真实到达 B 站但被拒绝“请求错误”
   → 根因 `msg[dev_id]` 非 UUID 形状、缺 `msg[sender_uid]`；修复后设备号升级为持久 UUID v4，
   补齐字段，并把平台拒绝码（-400/-403/-404）归类 `notSent`、失败时归还写配额、账本记录脱敏
   `error.details.biliCode`。
3. `op_d2f63521d5e1470da2c8e125403003bf`（13:39:49Z）：成功，`platform_readback` 回执。

## 5. 限制与后续

- 仅验证 **单条白名单 DM**；评论、External 投稿、Manual Bundle 发布仍未实测（T12.2 其余部分保持 BLOCKED）。
- 备份目的地与 C: 同物理盘，**非独立故障域**；恢复演练（T22）未做。
- 本次验收使用的账号身份与保护条件不可被解释为通用授权；后续真实写入仍需逐动作授权。
- 建议：验收后轮换该账号的 SESSDATA/bili_jct（凭据曾在本机文件与人工交接中使用），并保持
  `<dataDir>/credentials.json` ACL 限制。
