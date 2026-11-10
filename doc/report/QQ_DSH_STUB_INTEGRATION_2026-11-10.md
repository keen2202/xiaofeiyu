# 真实 DSH + OneBot v11 宿主联调报告（stub，非真实 QQ）

> 结论先行：在**本机真实 DSH 0.2.2-rc.1** 中，插件的可选 QQ 宿主（OneBot v11 薄客户端）已完整跑通
> "DSH 插件启动 → 连接 OneBot WS → 接收私聊事件 → 绑定身份 → 命令/入站去重 → outbox 保护门禁 → OneBot HTTP 发送"链路。
> 本次对端是**本地 stub**（不是 QQ、不是真实桥接），因此只证明协议与宿主接线正确，**不构成真实 QQ 接入验收**；
> T16.2 仍为 BLOCKED，等待用户提供真实 OneBot 桥接端点/token/QQ 号。

## 1. 环境与对象

| 项 | 取值 |
|---|---|
| DSH | 0.2.2-rc.1，临时 `DSH_HOME=D:\Workespace\xiaofeiyu\.dsh-probe-home`，profile `probe`（junction 挂载本仓库） |
| 探测端口 | 127.0.0.1:39780（不复用桌面 GUI 端口） |
| OneBot 对端 | 本地 stub：HTTP `http://127.0.0.1:13000`，正向 WS `ws://127.0.0.1:13001`（`.dsh-probe/onebot-stub.mjs`，未接真实 QQ） |
| 探测数据目录 | `.dsh-probe-home/dsh-bili-unified`（隔离的探针数据） |
| IM 配置 | `im.enabled=true`、`transport=onebot-v11`、`adapterId=dsh-im`、通知开启、groupReplies=none |
| 绑定 | 测试用本地绑定：adapterId=`dsh-im`、botAccountId=`123456789`、senderRef=`20002`、conversation=`private:20002`、scopes=`task.read.own/task.cancel.own/production.create` |
| 保护点 | 探针数据目录内的测试用 ledger 恢复点（仅用于满足 outbox 的 `_assertProtected` 门禁；用测试 verifier 创建，非真实 owner 挑战） |

## 2. 启动与 IM 组件（真实 DSH `/status`）

入口激活无警告，插件 HTTP 路由可用（200/401/404 同此前探测）。`result.components.im` 实测：

```json
{
  "enabled": true,
  "configured": true,
  "moduleAvailable": true,
  "transport": "onebot-v11",
  "hostSource": "onebot-v11",
  "started": true,
  "capabilities": {
    "receive": true,
    "send": true,
    "delivery": { "query": false, "idempotent": false },
    "humanIdentity": false,
    "verified": true,
    "status": "available",
    "reason": null,
    "description": "onebot-v11 qq 123456789"
  },
  "error": null
}
```

含义：真实 DSH 内插件运行时按配置构建了 OneBot 宿主，`imBridge` 已启动；能力探测为 available；
`humanIdentity=false`（OneBot 无人证明）与 `delivery.query/idempotent=false` 都按设计如实报告。

## 3. 入站链路（WS 事件 → 去重入库）

stub 向已连接的 WS 客户端推送一条私聊消息（`message_id=5002`，发送者 20002，内容为结构化只读命令
`{"action":"task.list","input":{},"mode":"dry"}`），并**重复推送同一 eventId**：

```text
{"kind":"ws-open","clients":1}
{"kind":"emit",...,"message_id":5002}
{"kind":"action","action":"send_private_msg","body":{"user_id":20002,"message":"Task draft: accepted"}}
{"kind":"emit",...,"message_id":5002}          # 重复投递，未产生第二次执行/发送
{"kind":"ws-close","clients":0}
```

关闭 DSH 后 `node cli.mjs im status --data-dir <probe> --config <probe>\config.json --probe`：

```json
{
  "bindings": [ { "bindingId": "binding_...", "adapterId": "dsh-im", "botAccountId": "123456789", "senderRef": "20002", "conversationIds": ["private:20002"] } ],
  "inbox": { "total": 1, "byStatus": { "accepted": 1 } },
  "outbox": { "total": 1, "byStatus": { "sent": 1 } },
  "liveProbe": { "status": "available", "description": "onebot-v11 qq 123456789" }
}
```

即：两条重复事件只产生 1 条 inboxKey（commandHash 相同、重投复用原结果），只产生 1 条通知并已发送。

## 4. 出站链路（outbox → 保护门禁 → OneBot HTTP）

`ImBridge` 的 outbox pump 在真实 DSH 进程内把通知派发到 OneBot 宿主：stub 收到并有记录：

```json
{"kind":"action","action":"send_private_msg","body":{"user_id":20002,"message":"Task draft: accepted"}}
```

该条发送同样经过 `EffectGateway.dispatchNotification` 的完整门禁：binding/会话校验、配置/迁移/实例能力、
RecoveryHold、`_assertProtected`（本轮用探针内 ledger 恢复点满足，20 分钟窗口）、通知配额与 `sending` 事务。
未配置恢复点时该通知会保持 `pending` 且不发送（fail-closed），与设计一致。

## 5. 证据与复现

- 复现脚本（本机、临时目录、stub；均为开发用，不写真实数据）：
  - `.dsh-probe/onebot-stub.mjs`（HTTP + 最小 WS 服务端，支持 `/__emit` 注入事件与 JSONL 日志）
  - `.dsh-probe/bind-probe.mjs`（探针数据目录写入 IM 配置与测试绑定）
  - `.dsh-probe/probe-backup.mjs`（探针数据目录创建测试用恢复点，满足 outbox 保护门禁）
  - `.dsh-probe/qq-dsh-probe.ps1`（启动真实 DSH → 校验 IM 组件 → 注入事件 → 去重 → 关闭 → 读 im/outbox 状态）
- 本地证据（不入库）：`.dsh-probe/qq-dsh-status.json`、`.dsh-probe/qq-dsh-probe-out.log`、`.dsh-probe/onebot-stub.log`。
- 回归：`node --test test/onebot-channel.test.js` 10 项通过；全量套件见提交记录。

## 6. 边界与后续

**已验证**：QQ 宿主在真实 DSH 组合中的构建、WS 连接与鉴权、事件归一化、本地绑定解析、入站去重、
通知 outbox 保护门禁与 OneBot 发送请求形状。

**未验证 / 仍阻塞**：

- 真实 QQ：本次对端是 stub，未发生任何真实 QQ 消息；真实桥接（NapCat/Lagrange 等）仍需用户提供
  HTTP/WS 地址、token 环境变量与机器人 QQ 号；真实 QQ 的消息时间/事件 id/频率限制语义也要实测。
- IM 审批：OneBot 无法提供人类证明（`humanAssurance=unverified`、`hostProof=null`），审批保持 fail-closed；
  本地 TTY 审批路径不变。
- 群聊：本版只消费私聊；群事件被忽略。
- 真实 owner 挑战：探针中的恢复点用测试 verifier 创建，仅用于链路验证；真实写入仍须 owner 在 TTY 完成。

拿到真实端点后，同一套流程替换 stub 配置即可（`node cli.mjs im probe` → `scripts/acceptance/qq-setup.mjs`），
再按 T16.2/T12.1 单独记录真实证据。
