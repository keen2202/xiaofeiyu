# DM unknown operation 取证与 not_sent 结论（2026-11-10）

本文件是 `operation resolve <id> not_sent` 的受控人工证据（evidenceRef 指向本文件）。结论：
操作 `op_c1649d3c14c745368ce5dc24368b446b` / 任务 `task_db1e2bf194e841cea46d614cb85a5293`
**没有产生 B 站私聊写入**，属于本地读限流门禁在平台请求之前失败，应按 `not_sent` 结算。

## 1. 事实

- 触发：`node cli.mjs dm --to 508187015 --text hello --go`（真实 TTY 人类挑战通过，attempt 1）
- 操作创建：`2026-11-10T13:16:45.172Z`；进入 dispatch：`13:16:45.250Z`；结束：`13:16:45.319Z`（共 69ms）
- 错误：`RATE_LIMITED: read time slot is not available yet`（`retryable:false`）
- 回执：`receipt = null`，`resultSummary = null`，`error.code = RATE_LIMITED`
- 账本限流桶：`bilibili:3546827282450731.read.nextAllowedAt = 13:16:46.265Z`（说明 dispatch 前
  已被 preflight 关系读取占用了读时间槽），`write.nextAllowedAt = 13:18:45.172Z`
- 平台侧：没有 `send_msg` 的响应数据，没有 `msg_key/msgid`，因此没有可登记的平台回执

## 2. 代码路径证明（为什么是 not_sent 而不是 unknown）

失败发生在 `src/modules/direct-messages.js` 的 dispatch 回调里，具体是
`src/adapters/platforms/bilibili.js#sendDirectMessage` → `this.client.relation(recipientMid)`
（互关复核读取）。该读取在 `src/bilibili.js` 的 `sendDirectMessage` 中位于构造 `send_msg`
请求体之前：

1. `assertMutualFollow()`（`src/bilibili.js:661`）
2. `const body = new URLSearchParams()`（`:664`）
3. `this._request('https://api.vc.bilibili.com/web_im/v1/web_im/send_msg', ...)`（`:673`）

第 1 步的 `relation()` 读取抛出 `RATE_LIMITED`，第 2/3 步从未执行，因此平台写请求**没有发出**。
`dispatchAt` 与 `finishedAt` 仅相隔 69ms，也符合“在读门禁处立即失败”。

## 3. 根因（已修复）

`dm.send` 在创建任务前先做一次只读 preflight `adapter.checkRecipient()`（消耗读时间槽，
`nextAllowedAt = now + minGapMs 1500ms`）；随后 dispatch 里的适配器又做一次互关读取，
两次读取间隔毫秒级，第二次被读时间槽保护拒绝 → 操作落 unknown（保守语义）。

修复（本 commit）：

- `src/adapters/platforms/bilibili.js`：`checkRecipient` 返回 `mutualVerified` 证据；
  `sendDirectMessage` 接受 `mutualVerified` 并据此跳过 dispatch 内的第二次关系读取。
- `src/modules/direct-messages.js`：把 preflight 的 `mutualVerified` 传入 dispatch。
- `src/effect-gateway.js`：`not_sent` resolve 时释放该操作预留的写配额（与 cancel 路径一致），
  否则一次经证明未发送的失败会烧掉当日 DM 配额（本次 `dailyLimit=1`），使合法重试不可能。
- 测试：`test/bilibili-adapter.test.js`（preflight 证据跳过二次读取）、
  `test/direct-messages.test.js`（dispatch 收到 mutualVerified=true）、
  `test/fix-gateway.test.js`（not_sent resolve 释放配额且可重试）。

## 4. 结论与操作

- 该操作按 **not_sent** 结算，业务 key 置为 `not_sent` 后可重试（需重新生成恢复点，保护状态要求）。
- 该结论由本机 owner 在真实 TTY 中确认，并记录进账本 `operation.not_sent` 事件（含 evidenceRef）。
- 之后按 `real-dm.mjs` 重跑：`backup create`（TTY）→ 保护状态 protected → `dm --go`（TTY）。
