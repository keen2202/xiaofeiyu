# DSH 内 IM bridge 真实联调记录（2026-11-11）

后续进展：本文保留入站/回信验收当时的状态；同日稍后的真实 approve 闭环已完成，见 [T12.1 后续验收](T12_1_IM_APPROVE_2026-11-11.md)。下文“approve 未实测”只表示本记录时点，现行状态见 [TASKS §0](../TASKS.md)。

> 结论：**DSH 桌面运行时内的插件 IM bridge 已真正启动并完成一次真实 QQ 入站 + 状态回信闭环**。
> 这补齐了 T16.2 的“DSH 内组合”缺口；T12.1 的**入站/回信**在 DSH 运行时下再次验证，但“真实人类**批准**（approve）并执行真实效果”的路径仍未实测（需要新的真实写授权）。

## 1. 前置恢复过程（QQ 风控 → 在线）

| 时间（本地） | 操作 | 结果 |
|---|---|---|
| 11-10 晚 | 机器人 QQ `275748387` 遭腾讯风控下线 | OneBot `online=false`，NapCat 进程在但账号离线 |
| 11-11 21:5x | 用户用官方 QQ 客户端恢复账号；NapCat 重启到 WebUI | `phase=waiting_qrcode`，快速登录被拒（“用户身份已失效”） |
| 11-11 22:1x | 从 NapCat WebUI 取二维码，用户扫码 | OneBot `online=true`，`get_login_info=275748387`，`im probe available` |
| 11-11 22:20 | 重启 DSH（第一次） | 插件 IM 仍 `started=false`：DSH 启动时 OneBot 已被旧 DSH 退出连带杀掉 |
| 11-11 22:31 | **以脱离 DSH 进程树的方式重启 NapCat**（见 §3） | NapCat 自动恢复登录，3000/3001/6099 监听，`online=true` |
| 11-11 22:41 | 重启 DSH（第二次，最终） | 插件 IM `started=true`、`receive/send=true`、`status=available`、`error=null` |

关键教训：**NapCat 必须作为独立进程启动**。此前用 DSH 工具 shell 启动的 NapCat 是 DSH 进程树的后代，DSH 退出时被一并终止：
- 恢复方式：`Start-Process -FilePath 'explorer.exe' -ArgumentList 'D:\Tools\NapCat\launcher-shell.bat'`（Explorer ShellExecute，父进程退出后不受 DSH 作业对象影响）；
- 验证：`NapCatWinBootMain` 父链上不再有 DSH 进程，DSH 重启后 OneBot 仍在线。

## 2. 新鲜保护点与回信闭环

owner 在真实终端运行 `.dsh-probe/tty-fresh-backup.ps1`（1 次一次性人类挑战）：

| 项 | 值 |
|---|---|
| 恢复点 | `backup_4a68f411ab3b4448b9e22e78cd096f1a`（ledger，verified） |
| cutAt / verifiedAt | `2026-11-11T14:47:24.882Z` / 同轮验证通过 |
| 保护状态 | `protected`（插件 `bili_unified_status` 读取到 `ageMs=81140`） |
| 目的地 | 远程独立故障域（WSL Samba→SSHFS→`42.193.20.17:/srv/dsh-bili-backups`） |

owner（QQ `2233843382`）向机器人（`275748387`）发送结构化只读命令：

```json
{"action":"task.list","input":{}}
```

DSH 插件运行时处理结果（账本 + 平台双证据）：

| 项 | 值 |
|---|---|
| 入站 accept | `inboxKeys` key `im:dsh-im:275748387:private:2233843382:msg:542765618`，status `accepted`，createdAt `2026-11-11T14:48:16.064Z` |
| ledger 事件 | seq 152 `im.command.received`（action `task.list`）、seq 153–155 `outbox.pending → sending → sent` |
| 回信 outbox | `outbox_bb181cf255554a4bb9b507872ba5855f`，summary `Task draft: accepted`，status `sent`，sentAt `2026-11-11T14:48:16.971Z`，attempts 1，error null |
| 回执 | `externalId=873112629`，receivedAt `2026-11-11T14:48:16.950Z` |
| 平台回读 | OneBot `get_msg message_id=873112629`：`post_type=message_sent`，`message_type=private`，`sub_type=friend`，`self_id=275748387`，`raw_message="Task draft: accepted"`，`time=1794408496`（即 14:48:16Z） |

## 3. 运行态注意事项（后续复现必读）

1. **NapCat 启动方式**：必须脱离 DSH 进程树（Explorer ShellExecute 或计划任务/独立终端）；否则 DSH 重启会连带杀死 NapCat，插件 IM 又变回 `started=false`。
2. **WSL/SSHFS 不随 DSH 重启存活**（本机实测 DSH 重启后 WSL distro 停止）：重启后需运行
   `powershell -NoProfile -ExecutionPolicy Bypass -File D:\Workespace\xiaofeiyu\.dsh-probe\setup-remote-backup.ps1`
   该脚本已修复“stale SMB mapping 导致 `SMB share not reachable`”：先 `net use /delete` 再重新映射。
3. **WSL IP 动态**（当前 `172.30.28.135`）：IP 变化后策略里的 destinationRoot 失配，需重新生成 `\.dsh-probe\backup-policy.remote.json` 并由 owner 重新保存。
4. **OneBot 无查询/幂等**：`delivery.query=false`、`idempotent=false`；发送结果未知时不自动重试。
5. QQ 风控可能再次触发；风控期间不要反复重试登录，先恢复官方客户端，再扫码一次。

## 4. 当前状态与剩余

| 项 | 状态 |
|---|---|
| T16.2 DSH 内组合 | ✅ 已补齐：IM `started=true`、`available`、真实入站+回信 |
| T12.1 入站/回信（DSH 运行时） | ✅ 已验证（只读命令 `task.list`） |
| T12.1 真实 approve 路径 | ❌ 未实测：需要对一个 IM 创建的真实任务做本地 TTY 批准并执行真实效果（评论会形成第二条真实评论，需用户另行授权） |
| T12.2 Manual/External 发布 | 未实测 |
| T22 持续 RPO/RTO、介质损坏演练 | 未测 |
| GATE-0 / GATE-MEM | 暂缓 / 未审核 |

## 5. 证据 ID

- 入站事件：`msg:542765618`；会话 `private:2233843382`
- 回信 outbox：`outbox_bb181cf255554a4bb9b507872ba5855f`；平台 `message_id=873112629`
- 保护点：`backup_4a68f411ab3b4448b9e22e78cd096f1a`（cutAt `2026-11-11T14:47:24.882Z`）
- 插件运行态：`components.im.started=true`，`capabilities.receive/send=true`，`status=available`
- 账本事件：`im.command.received`（seq 152）、`outbox.sent`（seq 155）
