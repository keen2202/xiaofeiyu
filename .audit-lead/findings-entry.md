# 入口层审查

- 审查范围：`src/index.js`、`cli.mjs`、`src/command-service.js`、`src/adapters/channels/dsh-im.js`、`src/adapters/registry.js`、`cordis.patch.yml`、`config.example.json`、`scripts/check.mjs`、`scripts/run-tests.mjs`、`package.json`，以及 `test/cli`、`dsh`、`command-service`、`im-contract`、`outbox`、`entrypoint-reliability`、`lite-loading`、`dependency-preflight`、`safety-matrix`、`integration` 测试；对照 SPEC §3、§16～§18、§22.3、§26，DESIGN §7.4/§8.5、D-11/D-13/D-15，TASKS T10/T16.1/T19。
- 代码基线：工作区当前内容（git HEAD `e12b7d9` + 17 个未提交修复文件，其中本范围涉及 `cli.mjs`、`src/index.js`、`src/command-service.js`、`src/adapters/channels/dsh-im.js`、`src/coordinator.js`、`src/store.js`；新增未跟踪文件 `test/entrypoint-reliability.test.js`）。本次实际读取的代码含未提交改动，F01/F02/F03/F06/F10 均以当前代码为准，不以修复记录为准。
- 方法：`git diff --stat` / `git diff -- <file>` 看第一批修复 → 逐条 read/grep 路由、CLI 命令、错误映射与五条历史缺口调用链 → 运行 8 个可独立执行的 `node test/<file>.test.js`（未运行 `npm test`/`npm run check`，遵守沙箱 spawn EPERM 约束）→ 用隔离临时 dataDir 实际运行 CLI 只读/敏感命令并核对退出码。
- 状态口径：`已完成（离线）`＝本次读到代码实现且有离线测试或实际命令支撑，不代表真实 DSH/B 站/IM 环境验收；`部分完成`/`未实现`/`与设计不一致`/`未验证` 按任务定义使用。

## 结论摘要（各类状态计数 + F01/F02/F03/F06/F10）

共判定 51 行：

| 状态 | 数量 |
|---|---|
| 已完成（离线） | 30 |
| 部分完成 | 11 |
| 与设计不一致 | 5 |
| 未实现 | 2 |
| 未验证 | 3 |

总体判断：入口层主体可达且 fail-closed 基调成立（无信任上下文即 503、敏感 CLI 无 TTY 即拒绝、未开放迁移/备份/恢复路由、36 个错误码均有 HTTP 映射）。第一批修复确实落到了代码：审批回流、outbox 运行时泵、envelope.mode 统一、Task 提交事务内原子绑定 request/inbox/outbox、runtime.close 停 imBridge 均有实现与离线测试支撑。但仍有 **3 个 P1 级入口风险**：评论草稿接受裸 `platformData` 且其 `aid` 不进入审批绑定（批准内容与实际写入目标可分离）；CLI 人类证明只有 TTY 短语/绑定 hash、无绑定内容展示和 OS 会话核验（伪终端可自行完成挑战）；写 API 未实现 `connection.requestRejection` 等价信任栅栏，且 Cordis `enabled` 开关未被入口消费（按当前 `cordis.patch.yml` 真实挂载可能完全不创建 runtime）。另有 CLI 写命令绕过 CommandService 的 P1 一致性缺口。

**F01/F02/F03/F06/F10 当前结论：**

| 编号 | 结论 | 关键证据 |
|---|---|---|
| F01 审批回流 | **已闭合（离线）**：CLI/HTTP/IM 三入口都汇入 `decideAndContinue`，按原 Task kind 分别派发 `comments.send` / `production.run` / `publisher.prepare`；重复/并发批准有持久 `continuation` 认领，拒绝与干跑不执行；进程中断标 `interrupted`/`unknown` 不自动重放。HTTP 有端到端测试；CLI 与 IM 链路代码存在但无自动化测试（真实 TTY/宿主证明未验证）。 | `src/command-service.js:339-349,422-460`；`src/index.js:631-642,667-678`；`cli.mjs:272-303`；`src/adapters/channels/dsh-im.js:364-373,410-418`；`src/approval.js:100-186,165-171`；`test/entrypoint-reliability.test.js:57-115` |
| F02 通知派发 | **已闭合（离线）**：Task 提交事务内由 `commitObservers` 生成 outbox；`ImBridge.start` 建立 1s pump 定时器（unref），`stop` 清定时器并等待在途；pump 只处理 `pending`，`sending/unknown` 不重发；入口测试验证同事务入队、pump 只发一次、群聊 `none` 抑制。`runtime.start → imBridge.start` 的宿主接线未被自动化测试覆盖。 | `src/adapters/channels/dsh-im.js:202-221,223-267,489-494`；`src/index.js:474-480,499-512`；`src/store.js:472-493`；`src/effect-gateway.js:1277-1338,1351-1462`；`test/entrypoint-reliability.test.js:153-183` |
| F03 外层 dry 传入 | **已闭合（离线）**：CommandService 统一以 envelope.mode 为权威，`production.create` 内层 `input.mode` 冲突在创建 Task 前以 `CONFIG_INVALID` 拒绝；模块侧统一走 `effectiveDryRun`。残留：CLI production/publish 直接调模块、`{...job, mode}` 静默覆盖 job.mode，不做冲突拒绝（属 CLI 绕过 CommandService 的一部分）。 | `src/command-service.js:76-78,318-322`；`src/contracts.js:168-187`；`src/modules/production.js:215-231,315-317,339-348`；`test/entrypoint-reliability.test.js:44-55,77-87` |
| F06 同事务 | **部分完成**：Task 提交事务内通过 `store.commandContext` + `commitObservers` 原子绑定 request.taskId、接纳事件、IM inbox 与 notificationTarget/outbox（测试在 `beforeCommit` 直接断言四者同状态）；失联 owner 的 pending 请求恢复为 `OPERATION_UNKNOWN` 不重做。但“请求预留”仍是 Task 前的独立 intent 事务，不满足“预留与 Task/事件/outbox 同一 store.transaction”的字面要求。 | `src/command-service.js:144-179,462-487`；`src/store.js:472-493`；`src/adapters/channels/dsh-im.js:202-221`；`test/entrypoint-reliability.test.js:117-151,153-183` |
| F10 DSH 挂载 | **部分完成**：`runtime.close()` 已新增停 imBridge（`src/index.js:499-512`），定时器随 close/stop 清理。但仍未闭：apply 未消费挂载 `enabled`；`cordis.patch.yml` 的 config 无 `schemaVersion`，apply 仅在 ctx.dataDir 存在或业务配置 schemaVersion=1 时才创建 runtime（当前 patch 下若不额外传 dataDir，路由/工具全部不注册、插件惰性）；可选模块（IM/备份/迁移/执行后端）仍静态 import；`lifecycle.onDispose` 只调 `runtime.close`，注销路由/工具只发生在返回对象的 `dispose`；真实宿主未验证。 | `src/index.js:772-833`（apply `772-794`、注册 `796-818`、dispose `822-831`）；`cordis.patch.yml:1-8`；静态 import `src/index.js:16-27`；`src/adapters/registry.js:15-52` |

## 逐项对照表

### §3 包与运行要求

| 条款/FR | 状态 | 代码位置 file:line | 判断依据 | 备注 |
|---|---|---|---|---|
| §3.1 目标包结构（package.json/cordis.patch.yml/config.example.json/cli.mjs/src 全部模块/test） | 已完成（离线） | `package.json:1-48`；`cordis.patch.yml:1-8`；`config.example.json:1-131`；`src/index.js:30` | SPEC 列出的 src/adapters/modules/production 文件全部实际存在（含 approval/backup-recovery/command-service 等；`test/helpers/` 存在 7 个辅助器） | 未见 X/抖音替身文件；X/抖音为预留能力、代码明确拒绝，不计缺陷 |
| §3.2 Node≥22、核心无 Python/MCP/ffmpeg/原生 SQLite/桌宠 Helper 硬依赖 | 已完成（离线） | `package.json:26-41`；全 src 仅 import node: 内建与本地模块 | `engines.node>=22`；runtime `dependencies` 为空、仅可选 peer `@deepseek-ai/dsh-tools`；ffmpeg/ffprobe 只在 local-slideshow/profile 预检与显式生产时使用，启动不探测 | 本机 Node 24 实测通过 |
| §3.2 可选适配器动态加载；一个适配器失败不阻止核心状态查询 | 部分完成 | `src/adapters/registry.js:15-77,90-110`；`src/index.js:16-27,204-230` | registry 提供惰性 factory（platform/channel/execution），未注册能力返回 `CAPABILITY_UNSUPPORTED`；但 index 顶层静态 import IM/备份/迁移/执行后端/生产模块，factory 形同虚设；bilibili adapter 与 imAdapter 仍构造期创建 | 与 F10 “可选模块静态 import”同源；无重 SDK 下载（见 `test/lite-loading.test.js:10-42`） |
| §3.2 IM 复用宿主通道、无 QQ/微信 SDK；缺宿主 unavailable/BLOCKED | 已完成（离线） | `src/adapters/channels/dsh-im.js:19-112` | 默认 `host=null` → capability `unavailable/host_not_provided`；host 缺 `describeCapabilities` → `blocked`；`start` 在非 available 时抛 `DEPENDENCY_UNAVAILABLE`；代码无聊天 SDK import | 真实宿主能力/消息/回执见未验证项 |
| §3.3 插件名与 Cordis ID 均为 dsh-bili-unified；HTTP 前缀 `/dsh-bili-unified/api`；包导出 | 已完成（离线） | `src/index.js:30,772-773`；`cordis.patch.yml:2-8`；`package.json:7-15` | `plugin.name='dsh-bili-unified'`；patch id/name/`exports: dsh-bili-unified`；`HTTP_PREFIX='/dsh-bili-unified/api'` 且 registerHandler 用该前缀；`test/dsh.test.js:125-134` 静态断言通过 | — |
| §3.3 挂载层 enabled 开关由入口单独消费 | 未实现 | `src/index.js:774-794`；`cordis.patch.yml:6-8` | apply 只读取 `ctx.config.schemaVersion===1` 的业务配置与 `ctx.dataDir`，全文件 grep 无 `ctx.config.enabled` 消费；`enabled=false` 也会继续挂载，`enabled=true` 也不会仅因此创建 runtime | 见缺口 G-E5 |
| §3.3 插件停止必须注销路由、工具和定时器 | 部分完成 | `src/index.js:819-831,499-512` | 定时器：stop/close 里 maintenance/coordinator/backup/imBridge 均清理；路由/工具：只有 apply 返回对象的 `dispose()` 会逐个调用 webServer/tools 的 disposer；`lifecycle.onDispose(() => runtime.close())` 只停资源、不注销注册 | 真实宿主调用哪个 dispose 未验证 |
| §3.3 宿主核心服务缺失不得导致整个 DSH 加载失败 | 已完成（离线） | `src/index.js:774-833`；`test/dsh.test.js:136-161` | webServer/tools/lifecycle 缺失时 apply 正常返回（runtime 为 null）；测试覆盖 | 若 registerHandler/register 抛错 apply 无 try/catch，属未验证边界 |

### §17.1 HTTP 路由（逐条）与 §18 映射

| 条款/FR | 状态 | 代码位置 file:line | 判断依据 | 备注 |
|---|---|---|---|---|
| GET `/status` | 已完成（离线） | `src/index.js:587-589,516-546`；`src/command-service.js:515-546` | 注册且要求受信上下文；返回能力缓存/计数/capacity/backup 年龄，`loginProbe:false`、无网络；`test/dsh.test.js:45-66`、`test/lite-loading.test.js:10-42` | HTTP 路径只读（不写账本） |
| GET `/config` | 已完成（离线） | `src/index.js:590-593` | owner（human+owner+`*`）限定，返回 `configService.redacted()`；`test/dsh.test.js:68-79` | 非 owner 403 |
| PATCH `/config` | 已完成（离线） | `src/index.js:594-602`；`src/config.js:692-764` | owner 限定；source=http 走 `assertHttpPatch` 白名单、禁止关闭强制审批/提权字段、禁止 true→false 解 dryRun；`test/dsh.test.js:75-92` | 文件写入与 configRevision 非同事务属 F09（核心审查范围） |
| POST `/run/browse` | 部分完成 | `src/index.js:603-610`；`src/command-service.js:258-268`；`src/coordinator.js:153-195,197-273` | 已注册；现在统一接 Coordinator（互斥/后置消费/聚合 partial）并把 mode 传入后置步骤；入口测试证明 dry 手动浏览不发送自动评论（`test/entrypoint-reliability.test.js:185-202`） | 缺省 mode 为 `go`（`body.mode` 缺省回退 `go`）而非显式必填，与 §4.6 显式 mode 原则不一致，见 G-E6 |
| POST `/run/diary` | 已完成（离线） | `src/index.js:611-622`；`src/command-service.js:269-280` | 注册；显式 `{date,scope,book,force}`，强制 envelope mode=dry（日记非平台写）；权限 scope diary.generate.own | 直调 `diary.generate` 而非 `coordinator.runDiary`，手动日记与调度器互斥/游标未统一（G-E13） |
| POST `/comments/draft` | 与设计不一致 | `src/index.js:623-630`；`src/command-service.js:281-298`；`src/modules/comments.js:120-132,144-158,387-392`；`src/bilibili.js:388-398` | 路由/权限存在；但命令层把调用方 `input.platformData` 原样传入并存账；`inputHash` 只覆盖 contentRef/text/root/parent/target，不覆盖 `platformData.aid`；实际写评论用 `oid=aid`（bvid 只进回执 url）。即批准绑定 bvid、实际写 aid，审批内容与写入目标可分离；且 `comments.js:120-121` 的 aid 必填条件写反（仅非 bilibili 才要求），bilibili 缺 aid 时到发送阶段才报错 | SPEC 明确“接受 contentRef 或显式 parent/root 回复引用，由适配器校验目标，不接受裸 platformData 越权”。见 G-E1 |
| POST `/comments/approve` | 部分完成 | `src/index.js:631-642` | 已注册，仅转成统一 `approval.decide`（带 trustedHumanContext），共用 ApprovalService/原 Task 回流，不接受裸 approved 布尔 | 未限定只处理 comment 审批（任意 approvalId 均可走该路由），见 G-E7 |
| POST `/dm/send` | 部分完成 | `src/index.js:643-650`；`src/command-service.js:305-317` | 已注册、权限 scope dm.send、白名单/互关/额度在模块内；但 `mode` 缺失时经 `buildEnvelope` 默认 `dry`，不报“mode 必填” | SPEC §17.1 该行要求 mode 必填；缺省 dry 属 fail-safe 但与“必须显式”不一致（G-E6） |
| POST `/production` | 已完成（离线） | `src/index.js:651-658`；`src/command-service.js:318-323` | 已注册；创建生产任务/干跑并返回持久 taskId；envelope.mode 权威、内层冲突拒绝；`test/entrypoint-reliability.test.js:44-55` | 缺省 mode 同 G-E6（默认 dry） |
| POST `/publish` | 已完成（离线） | `src/index.js:659-666`；`src/command-service.js:329-333` | 已注册；独立创建投稿任务（不继承生产审批），返回 taskId/approval | 缺省 mode 同 G-E6 |
| POST `/approvals/decide` | 已完成（离线） | `src/index.js:667-678`；`src/command-service.js:339-349,422-460` | 已注册；要求 `trustedHumanContext`，缺少即 `TRUST_UNAVAILABLE`；按原 taskId 回流执行；重复/并发/拒绝测试覆盖 | 缺省 mode 为 `go`（需 nonce+人类证明，风险由审批挑战兜底） |
| GET `/tasks` | 已完成（离线） | `src/index.js:679-686`；`src/command-service.js:402-420` | 已注册；owner 看全部、非 owner 按 principalId 过滤；limit 夹在 1..200 有界 | limit 来自 `request.query`，宿主未解析 query 时退化为 50（未验证） |
| GET `/tasks/:id` | 已完成（离线） | `src/index.js:687-698,724-728`；`src/command-service.js:489-496` | 已注册；越权 FORBIDDEN；缺失任务 `CAPABILITY_UNSUPPORTED reason=task_not_found` 经 handler 特判 404；`test/dsh.test.js:94-107` | 返回整 Task 无字段白名单（未发现秘密/绝对路径字段，G-E14） |
| POST `/tasks/:id/cancel` | 已完成（离线） | `src/index.js:699-706`；`src/command-service.js:498-513` | 已注册；所有权+scope 校验；只提交取消请求（modes dry），不保证同步终止 | — |
| POST `/tasks/:id/resume` | 与设计不一致 | `src/index.js:707-714`；`src/command-service.js:363-389`；`src/modules/direct-messages.js:308-342` | 已注册；kind scope/所有权/unknown 检查存在；但 HTTP 路径不要求 trustedHumanContext，mode 缺省 `go`；DM resume 直接 `send()` 触发平台私信写。“人类显式恢复安全阶段”在 HTTP/IM 入口没有人类证明/审批前置（CLI 有 TTY 证明） | §17.1 该行明确“人类显式恢复”；IM 动作集也含 task.resume（见 G-E8） |
| 写 API 信任栅栏：`connection.requestRejection` 或实施前验证过的等价机制，无法建立可信主体则 fail-closed | 未实现 | `src/index.js:550-557,576-731`；全 src grep 无 `requestRejection`/`connection` | handler 仅消费宿主注入的 `request.trustedContext`/`trustedHumanContext`；缺失时 fail-closed（503），但没有任何主动信任建立/拒绝机制，也未在 apply 中使用宿主 connection 能力 | 真实宿主契约未验证；T10 验收阻断项，见 G-E2 |
| 请求体 1MiB 限制 | 已完成（离线） | `src/index.js:31,559-562,582` | `Buffer.byteLength(JSON.stringify(body))>1MiB` → `CONFIG_INVALID` 400；`test/dsh.test.js:59-61` | 依赖宿主预解析 body（原始流语义未验证） |
| 不开放 migration/backup/recovery/凭据管理/任意文件导入/公开 IM webhook 路由 | 已完成（离线） | `src/index.js:576-731`（逐路由核读，无这些路径）；未知路由 `716-719`；`src/index.js:733-765` 工具清单 | handler 仅实现 15 个设计路由，其他路径（含 `/dsh-bili-unified/api/migration/...`）一律 404 `CAPABILITY_UNSUPPORTED`；工具/IM 白名单同样排除 | 这些动作仅 CLI 本地人类入口可执行 |
| §18 36 个稳定错误码 ↔ HTTP 双列映射 | 已完成（离线） | `src/errors.js:6-43,45-82`；`src/index.js:720-729`；`test/safety-matrix.test.js:40-53` | `ERROR_CODES` 36 项与 §18 表一一对应；`ERROR_HTTP` 对 36 项均有整数映射；`CAPABILITY_UNSUPPORTED` 默认 501、按 reason=route_not_found/task_not_found 特判 404；测试断言 36 码全映射 | `SCHEMA_UNSUPPORTED→400` 存在于实现但 SPEC §17.1 表未列（G-E14） |
| 错误序列化脱敏、不含秘密 | 部分完成 | `src/errors.js:121-179`；`src/index.js:720-728` | `AppError.toJSON()` 对 `details` 递归脱敏（cookie/token/secret/...）；HTTP 只返回 code/message/retryable/details；测试覆盖 details 脱敏 | `message` 不参与脱敏、未知错误 message 原样透传；细节低风险（G-E14） |

### §17.2 DSH 工具

| 条款/FR | 状态 | 代码位置 file:line | 判断依据 | 备注 |
|---|---|---|---|---|
| 按需注册 status/browse/comment_draft/dm/diary/production/publish/task_get/task_cancel 的 `bili_unified_` 前缀工具；输出无损 JSON；服务缺失不影响核心/CLI | 已完成（离线） | `src/index.js:733-765,808-818`；`test/dsh.test.js:110-123,136-161` | 9 个工具名与设计逐字对应（`bili_unified_*`）；execute 统一经 CommandService（sourceKind=agent）并 `JSON.parse(JSON.stringify())`；仅 ctx.tools.register 存在时注册；宿主缺 tools 不影响 apply | 工具注册依赖 runtime 创建，受 F10 enabled/配置缺口影响 |
| 不注册 approve/resolve/publish_complete/config/migration 工具 | 已完成（离线） | `src/index.js:754-764`；`test/dsh.test.js:116-118` | 9 个工具中不含上述名称；`test/dsh.test.js` 断言 names 不含 approve/resolve/complete/config/migration/backup | — |

### §17.3 CLI

| 条款/FR | 状态 | 代码位置 file:line | 判断依据 | 备注 |
|---|---|---|---|---|
| CLI 命令清单（SPEC 列出的 status/config/account/browse/diary/comment/approval/dm/artifact/production/task/publish/operation/outbox/im/migration/backup/recovery 共 39 条） | 已完成（离线） | `cli.mjs:146-153,155-213,223-590` | 逐条核对：39 条全部有分派分支（含 migration prepare/export/release/import/validate/activate/status/abort/disable-target/rollback、backup policy/create/verify/status/prune、recovery restore/inspect/reconcile/authorize）；另实现 `backup record-restore`（设计表外） | 实测只读命令见文末 |
| 平台写/生产/任务 resume 显式 `--dry` 或 `--go`；本地管理用专用确认 | 已完成（离线） | `cli.mjs:50-56,240,278,305,330,352,363,370` | `modeFrom(required)` 对 browse/approval/dm/production/publish/task resume 强制二选一，`--dry --go` 同用报错；artifact/im/backup 等用 `--confirm` | 安装类管理命令仍存在 --confirm 未强制项（G-E9） |
| 敏感人类证明：受信交互终端/展示绑定内容的确认挑战，无证明则拒绝 | 与设计不一致 | `cli.mjs:83-107,272-303,304-315,362-388`；`src/identity.js:213-291` | 实现了“TTY isTTY 检查 + 一次性短语 + 绑定 hash 校验 + 超时 + constantTimeEqual”，无 TTY 即 `TRUST_UNAVAILABLE`（实测 config update 非 TTY 退出 1）；但只向人展示 `bindingHash` 与短语，不展示被绑定的任务/收件人/文本内容，也没有 OS 会话核验/宿主人类证明；伪终端可自行读取短语并输入完成挑战 | “单有 --confirm 或普通进程身份不足以证明 Agent 代表人类”的防线不足，见 G-E4 |
| 结构化输出与失败非 0 退出码 | 已完成（离线） | `cli.mjs:109-111,597-610` | 成功路径 JSON.stringify(JSON nul,2)；失败路径 stderr 输出 `{code,message,retryable,details}` 且 `process.exitCode=1`；实测 task get 缺失/无 mode/dm 无 mode 均退出 1 | 错误 JSON 走 stderr，未混入 stdout |
| CLI 挂载到同一 CommandService / 请求幂等与审计 | 与设计不一致 | `cli.mjs:251-270,304-315,329-355,362-387,297-300,358-360` | 只有 browse（execute）、approval decide（decideAndContinue）、task get/cancel（直接方法）使用 CommandService；diary/comment draft/dm/production/publish/task resume 直接调用模块/服务方法，无 requestKey 预留/幂等记录，production 模块本身也没有 requestId 去重（`src/modules/production.js:164-167` 只校验存在）；CLI browse 传 `sourceKind:'http'`（`cli.mjs:244`），Task.trigger 会被记成 http | T10 工作项 3 要求“惰性挂载 HTTP/工具/CLI 到同一 CommandService”；见 G-E3、G-E13 |
| `--confirm` 强制覆盖设计声明之处 | 部分完成 | `cli.mjs:272-303,433-490,155-171` | approval decide 设计含 `--confirm` 但代码不检查；migration prepare/release/activate/abort/disable-target/rollback 子命令均不检查 `--confirm`（靠 TTY 证明）；migration import 允许 `--go` 代替 `--confirm`（`cli.mjs:156`） | 见 G-E9 |
| status 只读 | 部分完成 | `cli.mjs:67-69,221-226`；`src/identity.js:65-85`；`src/store.js:460-511` | HTTP GET /status 只读；CLI status 先 `ownerPrincipal()`（`ensureLocalOwner` 包在 store.transaction 中）再取状态。实测同一临时 dataDir 连续两次 `status`，`state.json` SHA256/修改时间均变化（66E4…→CBAE…），即每次 status 都会重写账本文件 | 无网络/无业务副作用，但不满足严格“只读”；见 G-E11 |

### §22.3 通知与宿主适配（FR-IM-005～008）

| 条款/FR | 状态 | 代码位置 file:line | 判断依据 | 备注 |
|---|---|---|---|---|
| FR-IM-005：Task 事件与 outbox 同事务；Notification 字段齐全（notificationId/taskId/taskRevision/bindingId/conversationId/summary/status）；发送前复查 binding/受众/独立预算/RecoveryHold 后事务内写 sending；queryDelivery 只回 sent/not_sent/unknown；unknown 不重发；本地人类 outbox resolve；通知失败不重跑任务；群聊 none 不入队；撤权 suppressed | 已完成（离线） | `src/effect-gateway.js:1277-1338,1351-1462,1464-1501,1503-1540`；`src/adapters/channels/dsh-im.js:202-221,247-267,269-290,489-501`；`src/store.js:472-493`；`test/entrypoint-reliability.test.js:153-183`；`test/im-contract.test.js:173-198`；`test/outbox.test.js:56-138` | appendNotification 写入字段+状态枚举齐全；dispatchNotification 在发送事务内复查 binding/conversation/migration/fence/recovery phase/hold/protection/im enabled/预算，先写 `sending` 再发送，结果落 sent/failed/unknown；unknown 再次 dispatch 抛 `OPERATION_UNKNOWN`；adapter.queryDelivery 仅声明能力时可用；`outbox resolve` 需受信人类；pump 只取 pending；群聊 none 在入队/派发两处抑制；撤权 suppressed | 通知预算使用延迟派发队列：在派发边界扣（`budgetAtDispatch`）；测试使用手动 pump，1s 定时驱动未在自动化中等待验证 |
| FR-IM-006：群聊只发 summary 或不发；不带脚本/私人日记/绝对路径/凭据/未授权附件；产物回信仅 artifactId+摘要 | 已完成（离线） | `src/adapters/channels/dsh-im.js:207,431-442` | 群聊 groupReplies===none 直接跳过；否则 summary 固定为 `Task <id>: <status>`（无脚本/路径/日记正文）；单条回信同样只含 taskId/status | 无附件/下载链接代码 |
| FR-IM-003（附加核对）：IM 可执行动作白名单为生产草稿/干跑、本人任务查询、取消、受信人类审批 | 与设计不一致 | `src/adapters/channels/dsh-im.js:5-13,292-315`；`src/command-service.js:39-47,227-229`；`src/identity.js:12-19` | IM 动作集合额外包含 `task.resume`（两处白名单+IM_SCOPES 均允许）；resume 不属于 §22.2 FR-IM-003 列举的白名单，且 §17.1 要求“人类显式恢复”，IM 路径无 humanContext 要求 | 受 Task 所有权/kind 限制（IM 无法创建 DM 任务），实际立即外发风险有限，但设计上超范围；见 G-E8 |
| FR-IM-007：真实 dsh-im 宿主只读探测后启用，未验证报告 unavailable/BLOCKED | 未验证 | `src/adapters/channels/dsh-im.js:19-112`；`test/im-contract.test.js:94-107` | 代码具备只读 probe（describeCapabilities→status unavailable/blocked）、不安装 SDK、不靠发消息试探；离线 mock 仅证契约 | 真实宿主未取得可核验证据（T16.2 BLOCKED），不判完成 |
| FR-IM-008：真实 IM 授权消息→草稿 Task→人类审批/拒绝→状态回信至少一次 | 未验证 | `test/im-contract.test.js`、`test/entrypoint-reliability.test.js:153-183` 均为 MockHost/MockChannel | 无真实宿主/真实消息/真实回信证据 | 交付报告应列未实测（T12.1），不静默标完成 |

### §26 轻量加载与可交付边界

| 条款/FR | 状态 | 代码位置 file:line | 判断依据 | 备注 |
|---|---|---|---|---|
| FR-LITE-001：默认核心加载不 import 媒体/IM/平台重依赖、不 spawn、不轮询、不 whoami；status 返回 cached/unverified、不发网络请求 | 已完成（离线） | `src/index.js:154-230,247,393-417,464-482`；`src/config.js` 默认配置；`test/lite-loading.test.js:10-42`；`test/dsh.test.js:45-66` | `DEFAULT_CONFIG` 全功能 disabled：`maintenance.start` 因无启用功能直接 return（无定时器）；coordinator.start 因 scheduler.disabled 不建 timer；imHost 缺失不启动 imBridge；startup crypto/credentials/backup 均无网络；status 的 `loginProbe:false`、`capabilities:'declared/cached/unverified'`；测试用 fetch 抛错网关验证 fetchCalls=0、workDir 为空 | 可选媒体/平台依赖仅有 node:child_process 静态 import（不 spawn）；status 只读偏差在 CLI（G-E11）；启用功能后存在 1s 归档定时器与 1s IM pump（属显式启用路径，非默认加载） |
| FR-LITE-002：可选模块未启用/依赖不可用时其他能力可用；启用失败返回明确原因；只有显式生产预检查媒体工具；禁用后不保留新调度/孤儿任务 | 部分完成 | `src/index.js:138-152,387-391,469-480`；`src/coordinator.js:45-70`；`src/adapters/registry.js:58-110` | 隔离：凭据损坏只置 credentialsError、各 recover 失败 warn、backup/im start 失败被捕获；能力未实现 `CAPABILITY_UNSUPPORTED`；media 预检仅在显式生产 preflight。但启用失败原因只出现在 `runtime.start()` 返回值与日志，`status` 不报告 IM/执行后端能力状态；scheduler.enabled 由 false→true 后不会新建 timer（F09 残余，核心审查已记） | 见 G-E12 |
| FR-LITE-003：容量/积压可观测 | 已完成（离线） | `src/store.js:587-621`；`src/index.js:534-546`；`test/entrypoint-reliability.test.js:204-226` | `status.capacity` 含 state/journal/recovery 字节、totalBytes、businessKeyBytes、pendingCount/pendingLimit、warning/hardBytes、healthy/warning/blocked；80/100MiB 门禁在 `tx.assertBusinessAcceptance`；测试验证预警停调度、硬限停新派发、归档/在途结算不受阻 | — |
| FR-LITE-004：基础核心、B 站适配、IM、生产 profile、迁移、备份/灾备分项报告已实现/未实现/不可用/未实测 | 未验证 | `doc/TASKS.md` 状态表、`doc/report/IMPLEMENTATION_FIXES_2026-11-09.md`；代码能力见上 | 代码/报告中有分项状态记录，但真实 DSH、真实 IM、真实 B 站写、真实媒体（T17.3/T16.2/T12.1）仍为 BLOCKED/未实测；入口层无法自证“分项交付”完成 | 需交付报告统一引用最新证据，不以旧 report/文件名推断完成 |

### 历史缺口复核（F01/F02/F03/F06/F10）

| 条款/FR | 状态 | 代码位置 file:line | 判断依据 | 备注 |
|---|---|---|---|---|
| F01 审批通过后原任务执行回流（CLI/HTTP/IM） | 已完成（离线） | `src/command-service.js:339-349,422-460`；`src/index.js:631-642,667-678`；`cli.mjs:272-303`；`src/adapters/channels/dsh-im.js:364-373,410-418`；`src/approval.js:100-186,165-171`；`test/entrypoint-reliability.test.js:57-115` | 三个入口都构造 humanContext 后进入 `decideAndContinue`；按 `task.kind` 派发 comment/production/publish；`continuation` 持久认领防重复/并发；dry 不消费、reject 不执行；错误时 continuation=interrupted、task 视 unknown/dispatch 状态转 interrupted/unknown，不自动重放。HTTP 端到端测试覆盖生产执行一次/重放/reject/并发；CLI/IM 链路仅代码审阅 | 真实 TTY/宿主人类证明与 IM 审批链无自动化测试；hostProof 需宿主注入的 verifier 支持（默认 TtyHumanVerifier 只认 TTY 挑战） |
| F02 通知常规派发与状态回信 | 已完成（离线） | `src/adapters/channels/dsh-im.js:202-221,223-235,237-267,489-494`；`src/index.js:474-480,499-512`；`src/effect-gateway.js:1351-1462`；`test/entrypoint-reliability.test.js:153-183`；`test/im-contract.test.js:173-198` | 业务事务内 commitObservers 生成 outbox；start 建立 1s unref pump（只处理 pending、单飞、错误分类 break/log）；stop 清 timer 并等待在途；runtime.close 也停 imBridge；测试中 pump 只发送一次、group none 抑制、unknown 不重发 | runtime.start→imBridge.start 的宿主接线未测试；pump 定时器本身未用 fake-timer 验证 |
| F03 生产外层 dry 未传入 | 已完成（离线） | `src/command-service.js:76-78,318-322`；`src/contracts.js:168-187`；`src/modules/production.js:215-231,339-348`；`test/entrypoint-reliability.test.js:44-55,77-87` | envelope.mode 统一为权威；production.create 内层 mode 冲突创建前 `CONFIG_INVALID`；模块用 effectiveDryRun 输出 dry plan/blockedBy 且不 ready；测试验证 HTTP dry→executionMode dry、backend 零请求、冲突拒绝 | CLI production/publish 直调模块且 `{...job, mode}` 静默覆盖内层 mode（无冲突拒绝），作为 CLI 绕过一部分 G-E3 |
| F06 请求/Task/事件/outbox 同事务 | 部分完成 | `src/command-service.js:144-179`（预留事务 vs dispatch）、`176-179`（commandContext.run）；`src/store.js:472-493`；`src/adapters/channels/dsh-im.js:202-221`；`test/entrypoint-reliability.test.js:117-151,153-183` | Task 提交事务内原子绑定 request.taskId、`request.accepted` 事件、IM inbox.taskId/result、task.notificationTarget、outbox 通知（beforeCommit 测试直接断言）；任务落账后崩溃重放返回同 taskId 不重做；失联 owner 的 pending 请求恢复为 `OPERATION_UNKNOWN`。但首个“请求预留”事务仍独立于 dispatch，严格“预留与 Task/outbox 同事务”不成立 | 该残余属修复设计明示的“持久 intent+补偿”；若按审计原文/任务措辞“同一 store.transaction”判定则不闭合 |
| F10 DSH 挂载 enabled/资源释放/静态导入 | 部分完成 | `src/index.js:499-512`（close 停 imBridge）、`772-833`（apply/dispose）；`cordis.patch.yml:1-8`；`src/index.js:16-27`（静态 import）；`test/dsh.test.js:136-161` | 已修：runtime.close 新增 `await imBridge.stop()`；stop/close 清维护/调度/备份/IM 定时器。未修：apply 无 enabled 消费；patch config 无 schemaVersion 时只有 dataDir 才建 runtime（否则一切不注册）；可选模块静态 import、registry lazy factory 未作为加载边界；lifecycle.onDispose 不注销路由/工具；真实宿主未验证 | 与 G-E5/G-E10 对应 |

## 缺口详情

### G-E1 [P1] 评论草稿接受裸 platformData，审批绑定与实际写入目标可分离

- 设计要求：SPEC §17.1 `/comments/draft`“接受 contentRef 或显式 parent/root 回复引用，由适配器校验目标，不接受裸 platformData 越权”；§8.2/§22 要求审批绑定输入 hash 后按该输入派发。
- 证据：HTTP 路由把 `body.input || body` 整体作为 command input（`src/index.js:623-630`）；`_dispatch` 将 `input.platformData` 组成 candidate（`src/command-service.js:281-298`）；`createDraft` 只检查 aid 是否存在且条件写反（`src/modules/comments.js:120-121`，bilibili contentRef 缺 aid 反而放行），随后把 `platformData` 深拷贝进 Task input（`src/modules/comments.js:130-132`）；`inputHash` 只算 contentRef/text/root/parent/target（`src/modules/comments.js:144-158`），不含 `platformData.aid`；发送时用持久化的 `platformData`（`src/modules/comments.js:387-392`），B 站适配器把 `contentRef.contentId` 当 bvid、`platformData.aid` 当 oid 写入（`src/adapters/platforms/bilibili.js:229-238`），客户端写评论 `oid=aid`（`src/bilibili.js:396-399`），bvid 只用于回执 url。
- 影响：有 `comment.draft` 权限的主体可提供 `contentRef=BV_A` + `platformData.aid=视频B`；审批挑战/绑定 hash 展示/比对的是 BV_A 相关输入，实际评论写到视频 B。审批绑定不能证明“被批准的写入目标”，违反“不接受裸 platformData 越权”。
- 建议：路由/命令层拒绝调用方 platformData（只接受 contentRef 与显式回复引用），由服务端/适配器解析并回填 aid；若必须接受，则把 aid/cid 纳入 inputHash 与 Approval 绑定并在 createDraft 时校验 aid 与 contentRef 一致；修正 aid 必填条件。

### G-E2 [P1] HTTP 写 API 未实现宿主信任栅栏（requestRejection/等价机制），真实宿主未验证

- 设计要求：SPEC §17.1“所有非公开读取和写入需经宿主信任栅栏及主体权限检查；本机来源不等于管理员。写 API 必须通过 `connection.requestRejection` 或实施前验证过的等价机制；无法建立可信主体则 fail-closed”；§3.3 挂载参数/宿主集成须验证。
- 证据：`createHttpHandler` 仅检查 `request.trustedContext.trusted===true` 与 principal（`src/index.js:550-557,576-731`）；全 src grep 无 `requestRejection`、无 `connection` 使用；`plugin.apply` 接收 ctx 但从不调用宿主信任 API，也不校验 trustedContext 的来源签名（`src/index.js:774-833`）。缺失时确实返回 503 `TRUST_UNAVAILABLE`（`test/dsh.test.js:53-55`）。
- 影响：信任完全建立在“宿主会正确注入 trustedContext”这一未验证假设上；若无等价机制，真实 DSH 下写 API 可能无法建立可信主体（全部 fail-closed）或被伪造上下文绕过（取决于宿主实现）。T10 验收项“HTTP 信任机制先验证，缺失拒绝写”未完成。
- 建议：在 apply 中用宿主 connection 的 requestRejection/等价 API 建立可信上下文并做主体核验；补 DSH Mock host 的“信任服务缺失时写 API 拒绝/伪造上下文拒绝”测试（§19.2 第 10 条）。

### G-E3 [P1] CLI 写命令绕过 CommandService，缺请求预留/幂等/统一审计

- 设计要求：TASKS T10 工作项 3“惰性挂载 HTTP/工具/CLI 到同一 CommandService”；§17 统一命令校验；FR-EXT-002 请求键幂等。
- 证据：CLI 只有 browse（`cli.mjs:239-248`）与 approval decide（`297-300`，decideAndContinue）经 CommandService；`diary`（`249-260`）、`comment --draft`（`261-270`）、`dm`（`304-316`）、`production`（`329-335`）、`publish`（`351-357`）、`task resume`（`368-388`）直接调用模块/service；`task get/cancel` 直接调 commandService 方法而非 execute。production 模块只要求 requestId 字符串、无请求去重（`src/modules/production.js:164-167`）。CLI browse 还把 `sourceKind:'http'` 写死（`cli.mjs:244`）。
- 影响：CLI 的写命令不写入 `state.requests`、无 requestKey 幂等，重复执行 `production --go` 会创建多个生产 Task（均需各自审批）；审计/入口来源（trigger/http）记录不准确；与“同一 CommandService”设计不一致，T10 无法按项验收。
- 建议：CLI 与 HTTP 共用同一个 `execute(envelope, principal, {sourceKind:'cli', ...})` 入口（管理/恢复类保留专用本地入口），并让 CLI 生成稳定 requestId；browse 改传 sourceKind='cli'。

### G-E4 [P1] CLI 人类证明只有 TTY 短语/绑定 hash，无内容展示与 OS 会话核验，伪 TTY 可自证

- 设计要求：SPEC §17.3“人类敏感命令须验证受信交互终端及展示绑定内容的确认挑战，或宿主提供的经验证人类证明；单有 `--confirm` 或普通进程身份不足以证明 Agent 代表人类”；TASKS T10 工作项 5“受控TTY＋OS会话核验＋一次性挑战”。
- 证据：`promptProofWithVerifier` 只要求 `process.stdin.isTTY`，调用 `verifier.issue(binding)` 并读取输入（`cli.mjs:83-107`）；`TtyHumanVerifier.issue` 只向终端打印 `Action binding: <jcsHash>` 与一次性短语，不打印绑定内容（`src/identity.js:245-274`）；`verify` 只校验 challengeId/短语/binding hash/时效（`276-290`），没有 OS 会话/进程祖先/宿主人类证明核验。敏感命令只要求短语匹配即可通过。
- 影响：任何能分配伪终端并捕获输出的自动化 Agent 都能自行读取短语并输入完成“人类确认”，没有可证明“代表人类”的机制；`--confirm` 之外的安全目标（防模型自批）未达成。真实 TTY 下人能看到 hash 但看不到批准内容，误批风险仍在。
- 建议：绑定内容以可读形式展示（action/动作对象/摘要/收件人/文本 hash+短摘），并引入宿主人类证明或本机 OS 会话核验（终端/会话/窗口绑定），在无法建立时敏感 go 保持 BLOCKED。

### G-E5 [P1] F10 未闭：apply 不消费 enabled、patch 配置下插件可能完全不挂载、可选模块静态 import

- 设计要求：SPEC §3.3“Cordis 挂载层的 enabled 开关由入口单独消费”；§26/FR-LITE-001/D-13 可选模块显式加载；F10 修复要求 apply 检查 enabled、统一 close/dispose。
- 证据：`plugin.apply`（`src/index.js:772-794`）只判断 `ctx.config.schemaVersion===1` 与 `ctx.dataDir`，无任何 `enabled` 读取；`cordis.patch.yml` 的 config 只有 `enabled`/`httpPrefix`、无 `schemaVersion`（`cordis.patch.yml:6-8`），因此当前 patch 下 `businessConfig=null`；若宿主不额外传 `ctx.dataDir`，runtime=null，HTTP 路由与工具全部不注册（插件静默惰性），而 enabled=false 时也不会阻止挂载。可选模块（IM/备份/迁移/执行/生产）在 `src/index.js:16-27` 静态 import；registry lazy factory（`src/adapters/registry.js:15-52`）未成为这些模块的加载边界。`runtime.close` 已停 imBridge（本批修复），但 lifecycle 注销问题仍在 G-E10。
- 影响：真实 Cordis 挂载语义与设计声明不一致，T10/§3.3 不能判完成；“轻核心按需加载”停留在边界声明。
- 建议：apply 读取 `ctx.config.enabled`/`httpPrefix` 并处理 false；明确 dataDir/业务配置来源（patch 配置 schema 与宿主注入路径）；用动态 import/工厂按启用加载可选模块；在宿主集成任务中实测后更新 cordis.patch.yml 与测试。

### G-E6 [P2] HTTP 缺省 mode 不一致：browse/resume/approvals 缺省 go，dm/production/publish 不强制显式

- 设计要求：SPEC §4.6“平台写、生产执行和发布的 HTTP/CLI/IM 请求必须显式 mode:dry|go”；§17.1 `/dm/send` 行、§17.1 `/run/browse`“参数 mode 不提升后置权限”。
- 证据：`src/index.js:605`（browse `body.mode || 'go'`）、`636`（comments/approve go）、`672`（approvals/decide go）、`709`（tasks resume go）；`645/653/661`（dm/production/publish 传 `body.mode`，缺省经 `buildEnvelope` 默认 `dry`，不报必填）；`buildEnvelope` 默认 dry（`src/index.js:33-41`）。
- 影响：同一 API 面缺省值偏宽松/偏保守不一致；browse 缺省 go 会把 go 传给后置自动评论/DM（配置 auto 时），与“显式 mode”原则不符；dm/send 缺省 dry 未按设计返回 400。
- 建议：所有平台写/生产/发布/恢复入口对缺省 mode 返回 CONFIG_INVALID；browse 是否允许缺省 go 需在设计层明确（建议缺省 dry）。

### G-E7 [P2] `/comments/approve` 未限定 comment 审批

- 设计要求：SPEC §17.1“仅把 comment 的 approvalId/decision/nonce/mode 转换为统一 `/approvals/decide` 调用”。
- 证据：`src/index.js:631-642` 直接把任意 `body.approvalId` 组 `approval.decide` envelope，未校验目标 approval 的 action/所属 Task kind 是 comment。
- 影响：兼容入口可批准生产/发布审批（实际仍走统一 ApprovalService/humanContext，无额外权限提升），但与“评论动作兼容入口”语义不符，审计归属模糊。
- 建议：在 command/service 侧校验 approval.action/任务 kind 属于 comment 才允许该路由。

### G-E8 [P2] IM 动作集合含 task.resume，超出 FR-IM-003 白名单；resume 缺人类显式前置

- 设计要求：SPEC §22.2 FR-IM-003 可执行动作白名单为生产草稿/干跑、本人任务查询、取消请求、受信人类审批；§17.1 tasks resume“人类显式恢复安全阶段”。
- 证据：`src/adapters/channels/dsh-im.js:5-13` 与 `src/command-service.js:39-47` 的 IM 动作集合均含 `task.resume`；`src/identity.js:12-19` IM_SCOPES 也允许 `task.resume.own`；HTTP `/tasks/:id/resume` 不要求 trustedHumanContext（`src/index.js:707-714`），而 DM resume 会直接触发平台私信写（`src/modules/direct-messages.js:308-342`）。IM 因无法创建 DM 任务，实际不可达 DM 外发；生产/评论 resume 仍需新审批。
- 影响：设计白名单不一致；若未来 IM 主体可拥有 DM 任务则会变成 IM 直接外发通道。
- 建议：从 IM 动作集与 IM_SCOPES 移除 task.resume，或规定 IM resume 必须绑定宿主人类证明；task.resume HTTP 路由要求 trustedHumanContext 或至少对 DM kind 强制人类证明。

### G-E9 [P2] CLI `--confirm` 未按设计强制，migration import 可用 `--go` 替代

- 设计要求：SPEC §17.3 列出 approval decide/.../migration prepare/... 的 `--confirm`；“本地管理动作使用专用确认而非滥用 dry/go”。
- 证据：`cli.mjs:272-303` approval decide 无 `flags.confirm` 检查；`cli.mjs:433-490` migration prepare/release/activate/abort/disable-target/rollback 均无 `--confirm` 检查（依赖 TTY 证明）；`cli.mjs:155-171` migration import 允许 `flags.go===true` 代替 `--confirm`。
- 影响：`--confirm` 作为“专用确认”的语义不一致；虽然 TTY 人类证明仍是实际门禁，但命令契约与设计文档不符，且 `--go` 被用作管理确认违反“勿滥用 dry/go”。
- 建议：统一在敏感管理命令上强制 `--confirm`，移除 migration import 的 `--go` 替代路径。

### G-E10 [P2] 资源释放与 F06 事务残余：lifecycle onDispose 不注销路由/工具；请求预留仍为独立事务

- 设计要求：SPEC §3.3“插件停止必须注销路由、工具和定时器”；F06 要求请求/Task/事件/outbox 同事务。
- 证据：`src/index.js:819-821` 将 `ctx.lifecycle.onDispose(() => runtime.close())` 注册为只停资源；注销 webServer/tools 的 disposer 只在 apply 返回对象的 `dispose()` 中执行（`822-831`）。F06：请求预留事务 `src/command-service.js:144-172` 先于 `store.commandContext.run`（`176-179`）的 Task 提交事务；原子绑定只发生在后者（`src/store.js:472-493`）。
- 影响：若真实宿主只调用 lifecycle dispose，路由/工具注册可能残留（重复挂载/路由冲突）；F06 的 crash 窗口依赖 OPERATION_UNKNOWN 恢复而非真正单事务。
- 建议：把路由/工具 disposer 也纳入 lifecycle 回调；F06 若要字面闭环，把预留与 Task 初始创建合并为一个事务（或更新设计文档明确“持久 intent+补偿”口径）。

### G-E11 [P2] CLI `status` 非严格只读（实测重写账本）

- 设计要求：FR-LITE-001/§26 与 T19“status 只读、零副作用”；T10 工作项要求 status 仅显示脱敏缓存。
- 证据：`cli.mjs:221` 每次先 `ownerPrincipal(runtime)`（`cli.mjs:67-69`→`src/identity.js:65-85`），外层 `store.transaction` 无论如何都 `atomicWriteJson`（`src/store.js:460-511,497-503`），`updatedAt` 变化。实测同一临时 dataDir 连续两次 `node cli.mjs status`，state.json SHA256 由 `66E4…` 变为 `CBAE…`、mtime 变化；HTTP GET /status 无此写。
- 影响：无网络/无业务副作用，但“status 只读”不成立；高频监控会持续改写账本与触发锁竞争。
- 建议：status 只在需要时解析/创建 owner（例如不存在时才写），或提供只读路径（先 getSnapshot 查 owner，缺失再事务创建）。

### G-E12 [P2] 启用失败原因不可从 status 查询；禁用后既有定时器不撤销

- 设计要求：FR-LITE-002“启用失败返回明确能力原因”；§16 配置下一轮生效。
- 证据：`runtime.start` 把 im/backup 失败放在返回值 `{started:false,error}`（`src/index.js:469-480`），但 `runtime.status`（`516-546`）只报告 backup 保护状态与 scheduler，无 im bridge/执行后端能力与失败原因；`maintenance.start`（`393-417`）只在启动/PATCH 时启动，功能由 enabled→disabled 后不停止；`coordinator.start` 后 scheduler.enabled 变更不重建 timer（核心审查 F09 已记）。
- 影响：运行中无法通过状态接口得知可选组件为何不可用；禁用后仍有后台定时器（journal 归档 1s）继续运行。
- 建议：status 增加各可选组件 capability/status/reason；config 更新后按差异启停 timer。

### G-E13 [P2] 入口一致性：/run/diary 未走 Coordinator、CLI browse sourceKind 标错、CLI production 内层 mode 静默覆盖

- 设计要求：§16 唯一调度入口；T10 统一入口；F03 内层冲突拒绝。
- 证据：`src/command-service.js:269-280` diary.generate 直接调 diary 模块，而 browse 已改为 coordinator.runBrowse（`258-262`）；`cli.mjs:244` browse 传 `sourceKind:'http'`（Task trigger 记成 http）；`cli.mjs:329-335/351-357` `{...job, mode}` 使 job.mode 被静默覆盖、不做冲突拒绝（CommandService 的冲突拒绝在 `src/command-service.js:76-78`，CLI 不经过）。
- 影响：手动日记与调度器互斥/游标不一致；CLI 运行在审计中被标为 http；CLI 传入的内层 mode 与顶层 mode 冲突不被拒绝。
- 建议：diary 也接 coordinator.runDiary；CLI sourceKind 用 'cli'；CLI production/publish 走 CommandService 以获得统一冲突拒绝。

### G-E14 [P2] 细节一致性：/tasks/:id 整 Task 返回、错误 message 不脱敏、SCHEMA_UNSUPPORTED 映射未声明

- 设计要求：§17.1 `/tasks/:id`“不回显秘密/敏感路径”；§18 双列映射与脱敏。
- 证据：`src/command-service.js:489-496` 对 `deepClone(task)` 整体返回（含 notificationTarget/inboxKey 等内部字段，本次未发现秘密/绝对路径字段）；`src/errors.js:171-179` 只脱敏 details，message 原样；`ERROR_HTTP` 把 `SCHEMA_UNSUPPORTED` 映射为 400，但 SPEC §17.1 表未列该码（`src/errors.js:51`）。
- 影响：字段级最小暴露与错误信息最小暴露未系统化；映射实现比设计表多一条（方向安全但需文档同步）。
- 建议：任务详情做字段白名单/脱敏投影；message 也做秘密形状过滤；在 §17.1 表补 SCHEMA_UNSUPPORTED 或调整映射。

### G-E15 [P2] 入口层测试覆盖缺口（不判为代码缺陷，但影响“已完成”外推）

- 证据：本次运行 8 个测试文件共 43 项全部通过；但 HTTP 路由端到端仅覆盖 `/status`、`/config` GET/PATCH、`/run/browse`（失败路径）、`/tasks`、`/tasks/:id`、`/production`、`/approvals/decide`、`/comments/approve`；`/run/diary`、`/comments/draft`、`/dm/send`、`/publish`、`/tasks/:id/cancel`、`/tasks/:id/resume` 无端到端测试；36 个错误码只有 4～5 个走 handler 的断言（`test/dsh.test.js:45-107`），其余仅有 `ERROR_HTTP` 全映射静态断言；CLI 审批 go 链、IM 审批链、`createRuntime.start→imBridge.start` pump 接线、真实宿主信任/人类证明均无测试。
- 影响：T10 验收“§17 全路由逐项测试、36 错误码逐条测试、所有入口三级 dry 真值表”未达成；现有“通过”不能外推到未测路由。
- 建议：补 HTTP 全路由矩阵（含 400/403/404/409/429/501/503 代表码与 1MB）、CLI/IM 审批回流、runtime IM 启动与 pump 定时器的离线测试。

## 无法确认项

1. **真实 DSH 宿主契约（T16.2/T10）**：`connection.requestRejection`/等价信任机制是否存在、`webServer.registerHandler` 的请求形态（URL 是否已含前缀、body 是否预解析、`trustedContext`/`trustedHumanContext` 由谁填充、是否注入 `ctx.dataDir`/`humanVerifier`）、宿主是否调用返回对象的 `dispose` 还是仅 lifecycle `onDispose`——均未取得真实证据，本报告按 fail-closed 的离线行为判断。
2. **真实 dsh-im 宿主（FR-IM-007/008）**：真实消息来源/eventId/发送/回执/人类证明未探测；当前仅 MockHost/MockChannel 契约，真实交付 BLOCKED，不判完成。
3. **CLI 真实交互 TTY**：本环境 stdin 非 TTY，只能验证无 TTY 时 fail-closed；无法验证真实终端下“展示绑定内容/短语输入”的可用性与伪 TTY 对抗效果（结论基于 `src/identity.js:245-291` 代码）。
4. **真实 B 站评论写入**：G-E1 的 `oid=aid` 目标绑定结论来自 `src/bilibili.js:388-427` 代码阅读，未在真实平台复验。
5. **真实生产/发布/媒体工具执行链路**：入口审批回流后的实际 ffmpeg/ffprobe/External 执行未实测（依赖 T17.3/真实工具授权）。
6. **宿主原始 body 的 1MiB 语义**：`assertBodySize` 依赖 `request.body` 已是对象；若宿主传字符串/流，限制语义未验证。
7. **全量测试**：按约束未运行 `npm test`/`npm run check`；`npm` 级 229 项结果不在本次证据内（工作区存在他人的 `.audit-lead/tests.log`，仅作线索，不引用为本次证据）。

## 实际运行的定向测试与结果

| 命令 | 结果 |
|---|---|
| `node test/entrypoint-reliability.test.js` | 11 pass / 0 fail（约 14.6s）：HTTP production dry/冲突拒绝、审批执行一次/重放/reject、干跑不消费+并发只执行一次、独立事务串行+嵌套拒绝、评论审批发送+发布 manual prepare、任务提交后崩溃请求关联不重放、失联 owner 转 unknown、IM 同事务+泵一次+群聊抑制、轮次互斥+干跑不发评论、容量门禁、维护定时器生命周期 |
| `node test/cli.test.js` | 4 pass / 0 fail：help/config validate JSON、隔离 dataDir status、无 TTY 敏感命令拒绝、未知命令 |
| `node test/dsh.test.js` | 6 pass / 0 fail：status 不探测、信任栅栏 503、未知路由 404、1MiB 400、config owner/脱敏/特权字段 403、FEATURE_DISABLED 409/task 404、工具清单、cordis 静态断言、缺宿主服务 tolerance |
| `node test/im-contract.test.js` | 6 pass / 0 fail：只读 probe、防重/冲突/body 身份伪造/信任、过期未来撤权动作白名单、自然语言候选、outbox unknown 不重跑、IM disabled |
| `node test/outbox.test.js` | 4 pass / 0 fail：独立结算、delivery query 复活 unknown+人工 resolve、撤权 suppressed/未保护阻止、独立预算 |
| `node test/command-service.test.js` | 7 pass / 0 fail：同请求键单 Task 重放、同键异内容冲突、只读不增长请求索引、agent 无 scope 拒绝/IM 不能 DM、失败请求重放失败不重执行、无信任拒绝、resume 所有权+kind scope |
| `node test/lite-loading.test.js` | 3 pass / 0 fail：默认启动零 fetch/零媒体探测、禁用生产 dry plan 零进程、损坏凭据不影响核心 status |
| `node test/dependency-preflight.test.js` | 2 pass / 0 fail：未绑定 profile 不 spawn、显式预检只检查声明工具 |
| **合计** | **43 pass / 0 fail / 0 skip**（仅本会话实际执行的 8 个文件） |

隔离 dataDir 下实际运行的 CLI（临时目录位于系统 TEMP，命令后已删除）：

| 命令 | 结果 |
|---|---|
| `node cli.mjs --help` | 退出 0，输出命令总览 |
| `node cli.mjs config validate --config config.example.json` | 退出 0，`{"valid":true,...}`，dryRun=true |
| `node cli.mjs status --data-dir <tmp>` | 退出 0，JSON 含 instance(active)/migration(active)/recovery(normal)/counts/capacity(healthy)/backup(unprotected, policy_not_configured)/loginProbe=false；零网络 |
| 第二次 `status`（同一 dataDir） | 退出 0；state.json SHA256/mtime 变化（证明 G-E11） |
| `node cli.mjs migration status --data-dir <tmp>` | 退出 0，`{source:{phase:"active"},target:null}` |
| `node cli.mjs backup status --data-dir <tmp>` | 退出 0，未配置策略、scheduler 未启动 |
| `node cli.mjs task get task_missing --data-dir <tmp>` | 退出 1，stderr `CAPABILITY_UNSUPPORTED` details.reason=task_not_found |
| `node cli.mjs browse --data-dir <tmp>` | 退出 1，`CONFIG_INVALID`“explicit --dry or --go is required” |
| `node cli.mjs dm --to 123 --text hi --data-dir <tmp>` | 退出 1，`CONFIG_INVALID` 同 mode 必填 |
| `node cli.mjs config update --file <patch.json> --confirm --data-dir <tmp>` | 退出 1，`TRUST_UNAVAILABLE`“interactive TTY human proof is unavailable”，未写配置（敏感命令 fail-closed） |
| `node cli.mjs account verify --platform bilibili --data-dir <tmp>` | 退出 1，`CREDENTIAL_MISSING`（无 whoami 网络调用） |

（未运行 `npm test`/`npm run check`；未修改任何源码/测试/文档；工作区仅新增本文件。）
