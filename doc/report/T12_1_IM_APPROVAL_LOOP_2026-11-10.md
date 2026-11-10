# T12.1 真实 IM 入站 → 草稿 Task → 人类拒绝 → 状态回信（2026-11-10）

结论：**T12.1 的真实 IM 闭环已通过（拒绝路径）**。使用 NapCat OneBot v11 + 真实 QQ 消息，走通了
“IM 入站结构化命令 → 持久草稿 Task + Approval → 本地 TTY 人类拒绝 → outbox 真实状态回信”，
并补充了 IM 审批 fail-closed 的负例证据。全程**未产生任何 B 站平台写入**（评论草稿被拒绝，未发送）。

## 1. 前置与授权

- 机器人 QQ `275748387`（🐟）经 NapCat OneBot v11 接入；owner QQ `2233843382`；
- `im.enabled=true`、`im.notifications.enabled=true`、`comments.enabled=true`（mode=approval）；
- 保护点：新鲜 `protected` 恢复点（每次状态回信派发前校验 <20 分钟）；
- owner 在真实 TTY 完成 `config update`（开评论/通知）与 `im bind`；为本次测试 owner 明确同意把
  `comment.draft` 加入其 IM 绑定 scopes（旧的 3-scope 绑定 `binding_4ad9d6b3…` 已 revoke，
  新绑定 `binding_3c1e2cda…`）；IM 通道只允许草稿/只读动作，`go` 被 bridge 硬性拒绝；
- 本次只用 **reject** 路径：批准一条 comment 会触发真实评论写入，而真实评论写入不在本次授权范围。

## 2. 正例证据链

| 环节 | 证据 |
|---|---|
| IM 入站命令 | owner 从 QQ 发送 `{"action":"comment.draft","input":{"contentRef":{"platform":"bilibili","contentId":"BV1ZAWM61Evb"},"text":"T12.1 approval-loop test"},"mode":"dry"}`；事件 `msg:1750364829`（另见重复发送的 `msg:1558381181` 等，均按同一 target 复用一个 pending 草稿） |
| 草稿 Task | `task_15f7069d709d408bb9b758d15b068647`（kind=comment，status=`waiting_approval`，trigger=im） |
| Approval | `approval_9e929107db9143e2b2c01bd39a91ee2b`（action=comment.send，TTL 10 分钟） |
| 状态回信 1 | `outbox_9ca13f579e4d425aa84a5de1046714b4` → `status=sent`，receipt `{platform:"onebot-v11", externalId:"790450181"}`；平台 `get_msg` 确认文本 `Task task_15f…647: waiting_approval` |
| 本地 TTY 人类拒绝 | `node cli.mjs approval decide approval_9e929107db9143e2b2c01bd39a91ee2b reject --nonce <local> --go --confirm`（真实 TTY 一次性短语）；`decision=reject`、`decidedAt=2026-11-10T15:06:24.862Z`、`decidedBy=principal_bcacedd1…`；Task → `failed` 已结算（`FORBIDDEN: approval rejected`） |
| 状态回信 2 | `outbox_5238f7e7098648229a79a9eab5936ac8` → `status=sent`，receipt `externalId=191643848`；平台 `get_msg` 确认文本 `Task task_15f…647: failed`；owner 在 QQ 上确认收到两条回信 |

补充：approval 创建时返回的一次性 nonce 由本地验证 daemon 写入 `.dsh-probe/last-approval.json`
（仅本机、未打印到聊天）；TTY 决策命令从该文件读取 nonce。该文件不入库。

## 3. 负例证据：IM 侧审批决策 fail-closed

owner 从 QQ 发送：

```json
{"action":"approval.decide","input":{"approvalId":"approval_9e929107db9143e2b2c01bd39a91ee2b","decision":"approve"}}
```

结果：bridge 直接以 **`TRUST_UNAVAILABLE: IM approval requires verified host human identity`** 拒绝
（OneBot 通道 `humanAssurance=unverified`，按设计 IM 不得做审批决策）。账本复核：approval 仍为
`reject`、Task 仍为 `failed`、无新 `im.command.received`/approval 事件、无执行副作用。

另有一条更早的授权边界负例（2026-11-10T14:14Z）：绑定缺少 `comment.draft` scope 时，同一条
`comment.draft` 命令被 `FORBIDDEN: principal lacks scope comment.draft` 拒绝，未创建任务/回信。

## 4. 测试中发现并修复的缺陷（均为真实环境暴露）

1. `videoDetails()` 冷 WBI 缓存时把 WBI 密钥获取计为一次平台读取，紧接的视频读取被 1500ms 读间隔
   门禁拒绝（`RATE_LIMITED`）→ 改为 WBI 元数据不占读配额（commit `a347e0d`）。
2. `outbox` 失败时丢弃通道的结构化错误详情（只显示 "delivery failed"）→ 保留平台错误（同 commit）。
3. `approval decide` 未传 `--nonce` 时把 `undefined` 放入请求输入导致 JCS 编码异常 → CLI dispatch
   过滤 undefined（commit `8042058`）。
4. 机器人 QQ 会话失效（QQ 提示“你的用户身份已失效”）导致回信发送失败；重新扫码登录后恢复。
   另修复了 `launcher-shell.bat` 的编码问题（重写为 ASCII+CRLF）。

## 5. 限制与后续

- 仅验证 **reject** 路径；approve 路径会触发真实评论写入，未在本次授权范围内（T12.2 发布/评论
  真实写入仍 BLOCKED，评论真实写入未实测）；
- T12.1 的“真实人类来源”是本地 TTY（可信），IM 通道自身仍保持 `humanAssurance=unverified` 且审批
  fail-closed，符合 FR-IM-007；
- 本次为测试临时扩大了 owner 绑定 scopes（加 `comment.draft`），建议测试后 revoke
  `binding_3c1e2cda…` 并用原 `napcat-binding.json` 恢复最小权限绑定；
- 回信派发依赖新鲜恢复点；调度器未启用，点超龄时回信按设计 fail-closed 保持 pending。
