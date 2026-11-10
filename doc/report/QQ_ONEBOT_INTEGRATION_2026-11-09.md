# QQ 接入（可选 OneBot v11 桥接）实现与本地探测报告（2026-11-09）

> 结论先行：按"IM 接入使用 QQ、不自研 QQ SDK、复用用户提供的 OneBot 桥接端点"的方向，已实现可选的
> OneBot v11 宿主适配、配置/CLI/状态接线与回归测试；**本机没有可用的 OneBot/ NapCat/LLOneBot/ Lagrange
> 桥接在运行**，因此真实 QQ 收发仍为 **BLOCKED**，需用户提供桥接端点与 token 后才能做真实闭环验证。
> 本地 stub 只证明 HTTP/URL/鉴权/能力映射与失败语义，不冒充真实 QQ 接入（FR-IM-008）。

## 1. 授权与设计边界

- 用户选择"提供 OneBot 桥接端点（推荐）"，因此插件只做**薄客户端**：说话对象是标准 OneBot v11 协议，
  不捆绑 QQ/微信 SDK（DESIGN D-15、SPEC §22 FR-IM-007）。
- 通道语义不变：入站仍经本地 `im.bind` 绑定 `adapterId/botAccountId/senderRef/conversationId` 推导 principal；
  OneBot 无法提供宿主签名的人类证明，所以本条通道的 `humanAssurance` 固定为 `unverified`，**IM 审批保持 fail-closed**，
  只能通过受信本地人类入口（TTY/宿主挑战）审批。
- 首版只消费**私聊**消息（窄通道，不接群、不发群）；出站只面向已绑定的私聊会话，正文使用 outbox 中的摘要文本。
- OneBot v11 没有发送幂等键与送达查询 API，因此 `delivery.query=false`、`delivery.idempotent=false`；
  超时/无法判定一律保持 unknown，不自动重投（避免重复发消息）。

## 2. 实现内容

| 文件 | 变更 |
|---|---|
| `src/adapters/channels/onebot-qq.js` | 新增：`OneBotHttpClient` + `OneBotQqHost` + `createOneBotQqHost`（dsh-im 宿主契约实现） |
| `src/adapters/channels/dsh-im.js` | 未改：继续作为 ChannelAdapter/ImBridge 契约层 |
| `src/config.js`、`config.example.json` | 新增 `im.transport`（`dsh-im`｜`onebot-v11`）与 `im.onebot.{baseUrl,websocketUrl,accessTokenEnv,timeoutMs,reconnectMs}` 校验/默认值 |
| `src/index.js` | 仅当 `im.enabled` 且 `im.transport=onebot-v11` 且配置端点时构建本地宿主（注入的 `imHost` 优先）；`/status` 增加 `transport`/`hostSource`/capabilities |
| `cli.mjs` | 新增只读 `im probe`：`get_status`+`get_login_info`，输出能力、bot 账号与绑定提示，不发送任何消息 |
| `test/onebot-channel.test.js` | 新增 10 项：配置校验、HTTP 映射（token/retcode/ECONNREFUSED/超时）、能力探测、事件归一化、发送 sent/not_sent/unknown、适配器与 runtime 接线、重连/停止 |

关键行为：

- **只读探测**：`im probe` 只发 `get_status`、`get_login_info` 两个 POST，不发送消息，不需要 `--confirm`。
- **事件**：只接受 `post_type=message`、`message_type=private`、非自身消息；`eventId=msg:<message_id>`，
  `conversationId=private:<QQ号>`，`occurredAt` 取事件 `time`，过旧/未来时间由 ImBridge 拒绝。
- **命令**：私聊文本若是含 `action` 字段的 JSON 对象 → 结构化命令（受 IM 动作白名单限制）；否则只作为自然语言候选草稿。
- **出站**：`send_private_msg`；`ECONNREFUSED/ENOTFOUND/HTTP 4xx/retcode≠0` 视为确定未发送（可有限重试），
  超时/响应不可解析视为 unknown（不重投）。
- **鉴权**：token 只从 `im.onebot.accessTokenEnv` 指定的环境变量读取，不写入配置/状态/报告；URL 自动附加 `access_token` 查询参数。

## 3. 本机探测结果

### 3.1 环境扫描（只读）

- QQ NT 9.9.36 正在运行（`QQ.exe`/`QQEX.exe` 多个进程），仅监听自身内部端口（4001/4301/4310/5283/8082/8083/9210/9410 等）。
- 未发现 NapCat / LiteLoader / LLOneBot / Lagrange 的安装目录或进程；标准 OneBot 端口（3000/3001/5700/6099/6700）均未监听。
- 结论：当前没有可发消息的真实 OneBot 桥接；按 FR-IM-007 报告 unavailable/BLOCKED，不以 Mock 冒充。

### 3.2 本地 stub 验证（不是 QQ，只验证协议通路）

`.dsh-probe/onebot-stub.mjs` 提供最小 OneBot v11 HTTP stub（`get_status`/`get_login_info`/`send_private_msg`）：

| 场景 | `im probe` 结果 |
|---|---|
| stub 在线、配置 HTTP+WS 端点 | `ok:true`，capabilities `available`，`botAccountId=123456789`，附 bindingHint |
| stub 带 `access_token`，环境变量未设置 | `ok:false`，`status=blocked`，`reason=auth_rejected`（HTTP 401） |
| 同上，设置 `ONEBOT_PROBE_TOKEN` | `ok:true`，`available` |
| 无桥接（127.0.0.1:3000 无监听） | `ok:false`，`status=blocked`，`reason=bridge_unreachable`（ECONNREFUSED） |

说明：stub 的 WS 端点未实现，`receive=true` 仅基于"配置了 WS 端点"的契约判断；真实链路需真实 OneBot 桥接验证事件流。

## 4. 回归与证据

- `node --test test/onebot-channel.test.js` → 10/10 通过。
- 全量 `node scripts/run-tests.mjs` → **387 tests / 385 pass / 0 fail / 2 skipped**；`node scripts/check.mjs` → 101 files OK。
- 探测命令与结果（本地，不入库）：
  - `node cli.mjs im probe --data-dir .dsh-probe/im-onebot-stub`（stub 在线）
  - `node cli.mjs im probe --data-dir .dsh-probe/im-onebot-token`（无/有 token 对比）
  - `node cli.mjs im probe --data-dir .dsh-probe/im-onebot-absent`（无桥接 fail-closed）

## 5. 仍 BLOCKED 的条件与真实闭环步骤

需要用户提供（缺一即保持 BLOCKED）：

1. 本机（或可访问的受控地址）OneBot v11 实现的 **HTTP API 地址**与 **正向 WebSocket 地址**，以及 access token（只给环境变量名与值，落到本机环境变量）。
2. 机器人 QQ 号（`im probe` 会读出 `botAccountId`）与 owner QQ 号；随后由本地人类在 TTY 中执行 `im bind --confirm` 建立绑定。
3. 配置（本地 owner CLI 修改，不接受 HTTP/模型/IM 写入）：

```json
{
  "im": {
    "enabled": true,
    "transport": "onebot-v11",
    "adapterId": "dsh-im",
    "notifications": { "enabled": true, "minGapMs": 1500, "perMinute": 20 },
    "onebot": {
      "baseUrl": "http://127.0.0.1:3000",
      "websocketUrl": "ws://127.0.0.1:3001",
      "accessTokenEnv": "ONEBOT_ACCESS_TOKEN",
      "timeoutMs": 10000,
      "reconnectMs": 5000
    }
  }
}
```

4. 真实闭环验收（每步单独记录）：`im probe` 只读通过 → `im bind`（TTY）→ 发一条最低额度 outbox 通知并记录回执 →
   owner 私聊发 `{"action":"task.list","input":{},"mode":"dry"}` 验证只读命令 → 尝试 IM 审批时必须返回 `TRUST_UNAVAILABLE`（设计上不可用）→
   本地 TTY 审批路径仍可用。

## 6. 与设计文档的同步
- DESIGN D-15 / §适配器与 SPEC §22.3 已补充"可选本地 OneBot v11 宿主实现（用户提供端点，不自研 QQ SDK）"的说明；
- TASKS T16.2 实现状态更新为"代码已就绪，真实桥接未验证 → 保持 BLOCKED"；
- 真实 QQ 消息发送、审批回信与回执语义必须等真实桥接后按 FR-IM-008 单独验收，不能用本报告的 stub 结果替代。

## 7. 操作入口（2026-11-10 补充，仍待真实端点）

- 新增只读 CLI `node cli.mjs im status`：输出 IM 组件状态（enabled/configured/started/transport/hostSource/capabilities）、
  当前有效绑定（sender/会话/scopes）与 inbox/outbox 计数；不发送消息、不要求人类挑战，有单测覆盖。
- 新增引导脚本（需在真实交互终端运行，详见 `scripts/acceptance/README.md`）：
  - `node scripts/acceptance/preflight.mjs --inputs <json>`：只读预检（OneBot 探测、凭据字段、备份保护、下一步 TTY 命令），
    支持 `--write-template` 生成输入模板；不创建备份点、不改配置、不发消息；
  - `node scripts/acceptance/qq-setup.mjs --base-url ... --ws-url ... --owner-qq ... [--check]`：
    `im probe`（只读）→ `config update`（TTY）→ `im bind`（TTY）→ `im status`；
  - `node scripts/acceptance/real-dm.mjs --to ... --text ... --dest ... --failure-domain ... --verified-by ... [--check]`：
    `account verify` → `backup policy/create`（TTY）→ `config update`（TTY）→ 单条 `dm --go`（TTY）→ 取证；
  - 上述脚本的 `--check`/预检模式已在本机验证（只校验参数/打印计划，不执行敏感步骤、不发消息）。
- 真实 QQ 验收仍未进行：本机没有 OneBot 桥接在监听，也没有可用的 token/机器人 QQ；保持 BLOCKED 等用户提供端点。
- 2026-11-10 补充：已在**真实本地 DSH** 组合内用本地 OneBot stub 跑通完整链路（WS 事件 → 绑定解析 → 入站去重 →
  outbox 保护门禁 → `send_private_msg`），见 `QQ_DSH_STUB_INTEGRATION_2026-11-10.md`；stub 不等于真实 QQ，
  T16.2 仍 BLOCKED，等待真实端点后替换配置即可复用同一流程。
