# 官方 QQ 机器人 transport（qq-official）实现与验收准备（2026-11-10）

> 状态：**代码已实现并有离线测试，真实探测仍待用户提供 AppID/ClientSecret**。
> 该 transport 面对的是 QQ 官方机器人开放平台（`bot.q.qq.com` / `api.bot.qq.com`），
> 与 OneBot v11 是两套协议；插件只调用官方 HTTP/WS API，不捆绑 QQ SDK。

## 1. 为什么需要它

用户提供的 QQ 入口是官方机器人平台：

- `POST /`、`POST /get_status` 等 OneBot 动作返回 `{"message":"不支持的调用","code":11001}`；
- 官方平台用 **AppID + ClientSecret**（管理端获取）换 **2 小时有效**的 `access_token`；
- 事件走 `GET /gateway` 返回的 `wss://api.bot.qq.com/websocket/`，op10 Hello → op2 Identify（intents `1<<25`）；
- 单聊事件 `C2C_MESSAGE_CREATE` 按 `author.user_openid` 寻址，回复
  `POST /v2/users/{user_openid}/messages` 并带 `msg_id`/`msg_seq`（被动回复窗口约 5 分钟，60 分钟内可多次回复）。

## 2. 实现内容

| 文件 | 说明 |
|---|---|
| `src/adapters/channels/qq-official.js` | 新增：token 获取/缓存、`/users/@me`、`/gateway`、WS Hello/Identify/Heartbeat/Resume、C2C/群事件归一化、被动/主动发送、错误 not_sent/unknown 映射 |
| `src/config.js`、`config.example.json` | 新增 `im.transport=qq-official` 与 `im.qqOfficial.{apiBase,appIdEnv,appSecretEnv,websocketUrl,intents,timeoutMs,reconnectMs}`（AppID/Secret 只从环境变量读取，不落配置） |
| `src/index.js` | 运行时按 transport 构建对应宿主（注入 `imHost` 优先）；`/status` 的 `transport/hostSource/capabilities` 如实反映 |
| `cli.mjs` | `im probe` 支持 OneBot/官方机器人；`im status --probe` 同上；新增 `im listen --seconds N`（只读入站观察，用于发现 owner openid，不执行命令/不发消息） |
| `scripts/acceptance/qq-official-probe.mjs` | 只读探测薄 CLI（复用 src 实现）：token + 机器人身份 + gateway，不打印 token/secret |
| `test/qq-official-channel.test.js`、`test/qq-official-probe.test.js` | 13 项测试：配置校验、host 工厂、能力探测、WS identify/心跳、事件归一化、被动回复与过期回退、not_sent/unknown、dsh-im 适配器接线、runtime 接线、只读探测与脱敏 |

安全语义与 OneBot 版本一致：

- 官方平台无法提供宿主人类证明 → `humanAssurance='unverified'`、**IM 审批 fail-closed**；
- 只消费**私聊**事件（群事件可归一但默认 `groupReplies=none` 不产生群回信）；
- sender 必须命中本地 `im.bind`（官方为 openid，不是 QQ 号）；
- 无送达查询 API → `delivery.query=false/idempotent=false`；网络超时/5xx 保持 unknown，不自动重发；
  官方业务错误码（如 `40054004` 无好友关系、`40034005` msg_id 过期）视为确定未发送；
- AppID/ClientSecret 仅在环境变量中，不写配置/状态/日志。

## 3. 用法（拿到 AppID/ClientSecret 后）

```powershell
# 1) 只读探测（不发送消息）
$env:QQBOT_APP_ID = '<AppID>'
$env:QQBOT_APP_SECRET = '<ClientSecret>'
node scripts/acceptance/qq-official-probe.mjs

# 2) 发现 owner openid：配置 transport=qq-official 后监听（只读）
node cli.mjs im listen --seconds 120
#    用 owner QQ 私聊机器人发一条消息；输出里的 senderRef/conversationId 即 openid

# 3) 写入 IM 配置（owner TTY 人类挑战）与绑定（owner TTY 人类挑战）
node cli.mjs config update --file <qq-official-config-patch.json> --confirm
node cli.mjs im bind --file <binding.json> --confirm
```

`binding.json` 形态（openid 来自第 2 步）：

```json
{
  "adapterId": "dsh-im",
  "botAccountId": "<机器人 openid，由 im probe 给出>",
  "senderRef": "<owner openid>",
  "conversationIds": ["private:<owner openid>"],
  "scopes": ["task.read.own", "task.cancel.own", "production.create"]
}
```

配置补丁示例：

```json
{
  "im": {
    "enabled": true,
    "adapterId": "dsh-im",
    "transport": "qq-official",
    "groupReplies": "none",
    "notifications": { "enabled": true, "minGapMs": 1500, "perMinute": 20 },
    "qqOfficial": {
      "apiBase": "https://api.bot.qq.com",
      "appIdEnv": "QQBOT_APP_ID",
      "appSecretEnv": "QQBOT_APP_SECRET",
      "intents": 33554432,
      "timeoutMs": 10000,
      "reconnectMs": 5000
    }
  }
}
```

## 4. 回归与证据

- `node --test test/qq-official-channel.test.js test/qq-official-probe.test.js` → 13/13 通过；
- 全量 `node scripts/run-tests.mjs` → **402 tests / 400 pass / 0 fail / 2 skipped**；
  `node scripts/check.mjs` → **110 files OK**；
- 真实探测待办：本机未提供 `QQBOT_APP_ID` / `QQBOT_APP_SECRET`，未向官方平台发起鉴权/事件连接；
  拿到后先跑只读 probe/`im listen`，再按 TTY 流程做真实闭环（发一条消息、收一条回信）。

## 5. 边界

- 官方机器人只能回复与其交互过的用户（openid 约束、被动回复时限/次数、主动消息频控）；
  本实现不绕过这些平台规则，失败按 not_sent/unknown 语义处理。
- 群聊仅最小归一化，默认不产生群回信；IM 审批仍不可用。
- 真实 QQ 验收仍需用户提供 AppID/ClientSecret 环境变量并完成 TTY 绑定/配置。
