# 网关与平台层审查

- 审查对象：`src/contracts.js`、`src/approval.js`、`src/effect-gateway.js`、`src/rate-limiter.js`、`src/bilibili.js`、`src/adapters/platforms/bilibili.js`；关联读取 `src/identity.js`、`src/task-manager.js`、`src/command-service.js`、`src/index.js`、`src/credentials.js`、`src/adapters/{registry,channels/dsh-im,execution/local}.js`、`src/modules/{comments,direct-messages,publisher,production}.js`、`src/migration.js`、`src/backup-recovery.js`、`src/utils.js`、`src/store.js`。
- 对照文档：SPEC §5.2、§7.1–7.4、§8.1–8.5、§21.1–21.2、§22.1–22.2；DESIGN §7.3、§8.2、§9.4、§9.6；TASKS T14/T03。
- 版本：git HEAD `e12b7d9` + 未提交的第一批修复（工作区当前代码，`git status` 显示 effect-gateway/command-service/index 等处于修改状态）。
- 方法：只读取当前代码；所有结论给当前文件真实行号；JCS 金标准用 `node` 进程内实算并与 SPEC 逐字符比对；定向测试用 `node test/<file>.test.js` 进程内执行（未运行 `npm test`/`npm run check`，遵守沙箱限制）。
- 未把 `doc/report/IMPLEMENTATION_AUDIT_2026-11-09.md` 等历史报告当证据。

## 结论摘要（各类状态计数）

逐项对照表共 **58** 项：**已完成 39 / 部分完成 10 / 与设计不一致 3 / 未实现 4 / 未验证 2**。
缺口 18 条：P0 **0** 条、P1 **6** 条、P2 **12** 条。

总体判断：契约散列（§21.1）、写预留六步与派发二次栅栏（§7.2）、Operation 状态机与 resolve（§7.3）、B 站协议主体（§8.2–8.4）、审批挑战与同事务消费（§22.2）真实存在且与设计基本一致；**最严重的问题集中在三处**：(1) 平台风控/登录失效的自动化处置不完整（412 非 JSON 不熔断、登录失效无人工暂停）；(2) 凭据变化后写操作没有 fail-closed 重新 whoami；(3) 跨机/恢复后旧审批的失效只写标记、无消费者，且 `ExecutionDispatchContext` 契约定义了却无人调用。JCS 三条金标准向量**全部通过**。

## 逐项对照表

| 条款/FR | 状态 | 代码位置 file:line | 判断依据 | 备注 |
|---|---|---|---|---|
| §21.1 FR-EXT-001 schemaVersion=1、未知字段/动作/版本拒绝 | 已完成 | src/contracts.js:16-61,63-106 | `ENVELOPE_KEYS` 白名单、`schemaVersion!==1`→SCHEMA_UNSUPPORTED、未知 action→CAPABILITY_UNSUPPORTED；test/contracts.test.js:69-85 断言 | 顶层未知安全字段一律拒绝，`extensions` 是唯一扩展位 |
| §21.1 extensions 边界 | 已完成 | src/contracts.js:95-104 | `extensions` 必须为 plain object 并 deepClone 透传；未知顶层字段拒绝 | 全库无 `extensions` 消费方，也不参与 requestKey/inputHash；当前无已定义扩展，风险低 |
| §21.1 requestKey 精确定义 | 已完成 | src/contracts.js:108-113; src/utils.js:66-68 | 实为 `jcs-sha256-v1:`+`sha256Hex(canonicalize({workspaceId,principalId,action,requestId}))`，四字段齐全、小写 hex | test/contracts.test.js:29-41 只断言格式与 principal 敏感性，未断言四字段金标准值（测试偏弱） |
| §21.1 inputHash 覆盖范围 | 已完成 | src/contracts.js:115-147 | 覆盖 action、input、全部输入 artifact 的 sha256（按 artifactId 排序）、outputSpec、profileVersion、providerVersion、target、feeCapMinor、metadata；不含 requestId/时间/显示名 | 调用方 command-service.js:91 额外把 envelope `mode` 注入 metadata（见 G-15） |
| §21.1 metadataHash 覆盖范围 | 已完成 | src/contracts.js:149-158; src/modules/publisher.js:162-169 | action=publish、video/cover sha256、target、metadata、providerVersion；业务键 `publish:<platform>:<accountId>:<videoSha>:<metadataHash>` 与 DESIGN §9.4 一致 | — |
| §21.1 normalized-text-hash | 已完成 | src/utils.js:70-79 | NFC→CRLF/CR→LF→trim→`SHA256(JCS(text))`；不折叠大小写与内部空白 | test/contracts.test.js:23-26 用 `'  你好\r\n'` 同时覆盖三种规范化 |
| §21.1 三条 JCS 金标准向量（实现一致 + 测试断言） | 已完成 | src/utils.js:11-52,66-68; test/contracts.test.js:17-27 | `node test/contracts.test.js` 5/5 通过；另用 node 直接计算三条向量，输出与 SPEC §21.1 逐字符一致（`f904ec…`、`c770c2…`、`092251…`） | canonicalize 为 RFC8785 风格：键排序、数组保序、-0→"0"、拒绝非有限数/循环/非 plain object |
| §21.1 「改输入递增 revision 并失效审批」 | 与设计不一致 | src/task-manager.js:80,156-188（无 revision 递增）；src/approval.js:72,197,200 | Task `revision` 创建时=1，全库无写入点（grep 仅读）；`approval.taskRevision` 恒为 1，revision 失效分支不可达；改参失效实际由 inputHash 检查兜底；测试靠手工 `draft.tasks[].revision += 1` 模拟（test/approval.test.js:89-91） | G-08 |
| §21.1 FR-EXT-002 请求去重/异参冲突与响应契约 | 已完成 | src/command-service.js:85-142,183-210; src/errors.js:84-119,156-178 | 同 requestKey 同 hash 返回原 taskId/result；异 hash→IDEMPOTENCY_CONFLICT；accepted 仅在事务提交后返回；unknown 的 retryable=false | 该文件不在本范围清单，仅作调用链证据 |
| §21.2 PlatformAdapter 方法集合 | 已完成 | src/adapters/platforms/bilibili.js:28-297 | capabilities 属性 + verifyAccount/discover/readContent/readComments/writeComment/sendDirectMessage/preparePublish/normalizeReceipt 全部存在 | preparePublish 显式 CAPABILITY_UNSUPPORTED（原生 UPOS 不在本期） |
| §21.2 ChannelAdapter 方法集合 | 已完成 | src/adapters/channels/dsh-im.js:26-29,94-111,129-160,162-171,173 | capabilities（含 delivery.query/idempotent）、start(onEvent)、send(notification)、queryDelivery、stop 齐全 | queryDelivery 在宿主不支持时 CAPABILITY_UNSUPPORTED |
| §21.2 ExecutionBackend 方法集合 | 已完成 | src/adapters/execution/local.js:44-54,86,401,418,444 | capabilities/submit/getStatus/cancel/close 齐全；声明 supportedStages/supportsCancel | 另有 wait/run 辅助方法 |
| §21.2 FR-EXT-003 能力逐项声明、B站 dm.receive=false | 已完成 | src/adapters/platforms/bilibili.js:9-17,37; src/contracts.js:349-380; test/bilibili-adapter.test.js:8-27 | 7 个能力逐项 supported/reason/limits；dm.receive=false（inbox_not_in_scope）、publish.external=false；测试断言 | write.comment limits.maxLength=2000 与 config 允许上限一致 |
| §21.2 X/抖音/remote 不支持、不被注册 | 部分完成 | src/config.js:288,368-371; src/adapters/registry.js:58-77; src/index.js:203-211 | 平台白名单只允许 bilibili；remote 后端直接 CAPABILITY_UNSUPPORTED；未注册平台查询返回 CAPABILITY_UNSUPPORTED；src 无 X/抖音适配器，运行期只注册 bilibili | TASKS T14 目标文件 test/helpers/mock-platforms.js 不存在，缺「测试替身不得注册」专项测试（G-18） |
| §21.2 AccountRef/ContentRef/Receipt 契约 | 已完成 | src/contracts.js:215-305; src/adapters/platforms/bilibili.js:276-287 | 结构校验、未知字段拒绝、receipt verification 白名单、makeReceipt 归一 | 适配器 relation 缺字段时降级为 attribute=0（bilibili.js:352-364），属弱校验 |
| §21.2/§22.2 三类派发上下文与统一栅栏 | 部分完成 | src/contracts.js:307-347; src/effect-gateway.js:111-151,625,1403-1410; src/modules/production.js:859-924; src/adapters/execution/local.js:60-87 | OperationContext（核心签发 token+permit，适配器/client 校验）与 OutboxDispatchContext（构造+assert）真实使用；`assertExecutionDispatchContext` 定义了但全库无调用，免费本地执行以裸 `stageRequest` 直接 `submit` | G-04 |
| §7.1 读额度与时间槽预留 | 部分完成 | src/rate-limiter.js:71-84; src/adapters/platforms/bilibili.js:62-71; src/index.js:169-177; src/bilibili.js:214 | 每次读前在 store 事务内 `reserveRead`（按稳定账号 key）；但读重试的第二次 HTTP 不再预留（实测 beforeRead=1 / fetch=2），无读 nextAllowedAt/最小间隔，`config.rateLimit.minGapMs` 全库无消费者 | G-09 |
| §7.1 只读可重试错误最多重试 1 次 | 已完成 | src/bilibili.js:209-222 | 读 maxAttempts=2（1 次重试），仅 `retryable===true` 才重试；写 maxAttempts=1 | 风险响应 retryable=false，不重试 |
| §7.1 相同 GET 进程内并发合并（不跨账号） | 未实现 | 全库无 in-flight/coalesce 实现 | SPEC 用「可以」，是许可性条款而非强制 | 未实现不构成违规；若后续要求性能可补 |
| §7.2 写预留六步同一 Store 事务 | 已完成 | src/effect-gateway.js:437-570 | 439-448 配置/迁移/recovery phase/checkpointFence/实例能力；455-472 业务键（含 extra/reusable）；481-487 审批；499-516 额度桶+预算；488-527 创建 reserved Operation；rate-limiter.js:127 写 nextAllowedAt；store.transaction 单次提交（store.js:452-511，抛错整体回滚） | `_assertProtected` 在事务内 await 注入的 protection 服务（测试为桩）；顺序为额度→保护→落 records，同一事务保证原子 |
| §7.2 派发前二次复核并持久化 dispatching/dispatchAt | 已完成 | src/effect-gateway.js:573-642 | 独立事务重查 config/migration/recovery/fence/instance/protection/hold（593-604）→ 审批 assertApproved+consume（605-613）→ 写 `status=dispatching`/`dispatchAt`/attempts（614-618）→ 之后才 execute 一次（735-790） | 无独立「等待槽位」循环：冷却未到时 reserveWrite 抛 RATE_LIMITED 由调用方重试，不持全局锁 |
| §7.2 明确未派发取消/unknown 处置 | 部分完成 | src/effect-gateway.js:644-733,803-836,1124-1199 | unknown 冻结额度与业务键且 prepare 拒绝重派（585-592）；重启恢复 reserved→cancelled、dispatching→unknown；但 `cancelReserved` 全库无调用方，二次复核失败的 reserved 无人工/系统取消入口 | G-06 |
| §7.2 额度/费用/通知分桶且互不消耗 | 已完成 | src/rate-limiter.js:90-133; src/effect-gateway.js:314-393,1247-1270 | B 站写按稳定账号 key+actionQuota；付费预算按 `workspace:provider:budgetId`；IM 通知按 adapter:bot 独立 minute bucket/minGap | 三者共享 store 状态但 key 与结算分离 |
| §7.2 第 2 步「检查熔断及人工暂停」 | 未实现 | 全库无平台人工暂停状态或入口；仅 rate-limiter 熔断 | 实现了熔断检查（rate-limiter.js:52-69），未实现「人工暂停」 | G-01 |
| §7.3 Operation 状态机与恢复 | 已完成 | src/effect-gateway.js:573-733,1124-1199; src/task-manager.js:190-246 | reserved→dispatching→confirmed/failed/unknown/cancelled；settleOperation/recompute 维护 task 聚合与 isSettled | 与 SPEC §7.3 表格一致 |
| §7.3 resolve 规则 | 已完成 | src/effect-gateway.js:838-963 | 仅 unknown 可 resolve（878-883）；confirmed 需结构化回执（857-863）；not_sent 需 note/回执（872）；同一事务更新 Operation/businessKeys/budget/Task/事件（903-961）；同结论幂等、冲突拒绝 | 幂等仅比较 decision，不比较 receipt 内容（G-13） |
| §7.3 confirmed 发布核查（平台/BV/来源，更新原 Publish+Operation） | 部分完成 | src/effect-gateway.js:857-871; src/modules/publisher.js:656-673,797-842 | external resolve 校验 platform/accountId/action/externalId 非空/url/verification∈{publisher_receipt,platform_readback}；manual complete 校验 BV_PATTERN；external resolve 路径未校验 externalId 为 BV | G-13 |
| §7.3 普通重启恢复规则 | 已完成 | src/effect-gateway.js:1124-1199; test/effect-gateway.test.js:394-441 | 仅处理 owner 可证失效的 reserved/dispatching；alive 且 start 未知保守跳过；无 dispatchAt→cancelled、有→unknown；不重放 | 与 SPEC「属主存活/PID 不明保守处理」一致 |
| §7.3 恢复不自动重试、备份优先 §27 | 已完成 | src/effect-gateway.js:580-584,1130-1132 | `recoveryAmbiguous` 拒绝派发；recovery phase 非正常时跳过普通重启推断 | 备份/恢复完整语义属备份审查范围，本处只确认网关侧接线 |
| §7.4 风控码/指数熔断/Retry-After | 部分完成 | src/rate-limiter.js:4,52-69,156-175; src/bilibili.js:6,168-176 | -412/-352/-799/-509/-10403 两处列表一致；失败 1 次 5 分钟、上限 30 分钟；Retry-After(秒) 与指数延迟取大；412/429 或风险码触发 onRisk | 非 JSON 的 412/429 不触发熔断且被当可重试（实测，G-02）；HTTP-date 形式 Retry-After 被忽略 |
| §7.4 登录失效/验证码转人工暂停 | 未实现 | src/bilibili.js:7,186-195 | -101/-111 转 CREDENTIAL_MISSING 抛出，无持久暂停状态、无回调（实测 onRisk 未调用），后续请求不会被阻止 | G-01 |
| §8.1 构造参数 | 与设计不一致 | src/bilibili.js:84-110; src/index.js:155-192 | SPEC 要求 `{config,credentials,store,rateLimiter,fetchImpl,now,logger}`；实现不接收 store/rateLimiter，改为注入 beforeRead/onRisk/operationContextVerifier/deviceIdProvider | 功能等价由 index.js 接线，契约签名偏离（G-10） |
| §8.1 每个响应检查 HTTP/JSON 结构/code | 已完成 | src/bilibili.js:136-207 | 响应文本→JSON 解析、412/429/风险码、HTTP 非 2xx、形状、`code!==0`、auth code 分列处理 | — |
| §8.1 成功依赖业务回执 | 已完成 | src/bilibili.js:244-251,289,411-417,454-460 | whoami 需 isLogin、view 需 data.bvid、comment 需 rpid、DM 需 msg_key，否则 OPERATION_UNKNOWN | — |
| §8.1 写方法只接受核心 OperationContext 并校验 | 已完成 | src/bilibili.js:366-381; src/effect-gateway.js:111-151; src/contracts.js:307-321; src/adapters/platforms/bilibili.js:229-239,254-268 | verifier 由核心注入并以 token 表校验 operationId/inputHash；`permit='dispatch-once'`；适配器再校验 context.accountRef 与当前 active account 一致 | 「当前派发许可」= 内存 token（settle 时 consume），不查持久 state |
| §8.1 日志不含 Cookie/完整表单/私信 | 已完成 | src/bilibili.js:126-134,190-194; src/index.js:178-191 | 仅记录 message/bvid/code，不记录请求头、表单或消息正文 | — |
| §8.2 WBI（nav 获取、固定 mixin、wts、MD5、10 分钟缓存、空 key 拒绝、纯函数导出） | 已完成 | src/bilibili.js:10-56,224-242; test/bilibili.test.js:39-51,158-161 | `WBI_MIXIN_KEY_ENC_TAB` 固定表、`signWbi` 导出纯函数、`wts` 秒、MD5、10 分钟缓存、空 wbi_img 抛错 | 与 SPEC §8.2 逐条对应 |
| §8.3 whoami/popular/search/view/subtitles/comments/relation | 已完成 | src/bilibili.js:244-364 | 六个读方法与对应接口全部实现（search/view 走 WBI） | client 返回 B 站原始字段，Candidate 归一在适配器（adapter:103-227），符合 T03 分层 |
| §8.3 字幕 HTTPS/允许域名/不携带 Cookie | 已完成 | src/bilibili.js:66-81,293-338; test/bilibili.test.js:77-96 | 仅 HTTPS 且 *.bilibili.com/*.hdslb.com/*.bilivideo.com；协议相对 URL 拒绝；字幕 fetch 不设置 Cookie | — |
| §8.4 评论（接口/长度/CSRF/回执/code 非 0） | 已完成 | src/bilibili.js:388-427; test/bilibili.test.js:122-144 | `/x/v2/reply/add`；发送前校验长度与 bili_jct；rpid 回执；code≠0 在 _rawRequest 已抛错；写不重试 | — |
| §8.5 DM（接口/dev_id/content JSON/自发拒绝） | 已完成 | src/bilibili.js:429-470; src/credentials.js:176; src/index.js:164-168 | `web_im/send_msg`；dev_id 来自持久化 `accounts[].devId`（绑定账号时生成并复用）；content 为 `{"content":...}` JSON 字符串；自发拒绝 | 换账号命名空间独立生成 devId，符合稳定设备要求 |
| §8.5 DM 默认为互关 | 部分完成 | src/bilibili.js:429（接收 requireMutual 但 429-470 未使用）；src/adapters/platforms/bilibili.js:241-252,254-268 | 适配器在派发时调 relation 并抛 MUTUAL_FOLLOW_REQUIRED；协议客户端忽略该参数，绕过适配器直接调用 client 不校验互关 | G-11 |
| §8.5 DM 成功 code/回执/unknown | 已完成 | src/bilibili.js:448-469 | code 必须为 0；缺 msg_key → OPERATION_UNKNOWN 且 notSent=false；回执 externalId=msg_key | — |
| §22.1 Principal 从可信上下文绑定 | 已完成 | src/index.js:550-557,583-584; src/identity.js:34-57 | 只从 `request.trustedContext.principal` 取；trusted!==true→TRUST_UNAVAILABLE；正文 role/approved/actorKind 不参与 | test/dsh.test.js:45-66 覆盖未受信拒绝 |
| §22.1 绑定结构与默认空 scopes | 已完成 | src/identity.js:32-57,130-172,189-206 | binding 含 bindingId/adapterId/botAccountId/senderRef/conversationIds/principalId/scopes/revokedAt；makePrincipal 默认 scopes=[]；IM scopes 限定子集；只经本地 CLI 人工证明入口绑定/撤销 | IM_SCOPES 比 SPEC 列表多 task.resume.own、comment.draft（扩展授权，未发现滥用） |
| §22.1 本地人类证明机制 | 部分完成 | src/identity.js:213-291; src/index.js:100-102; cli.mjs:74-105,218 | HumanProofService 无 verifier/验证失败一律 fail-closed；TTY 挑战展示绑定摘要、一次性短语、120s 过期、常量时间比较、非 TTY 拒绝；宿主签名挑战仅有 humanVerifier 注入点，无实现 | 未做「当前 OS 会话独立身份核验」，真实宿主证明待外部验收（见无法确认项） |
| §22.1 模型/system/agent 主体无人工审批资格 | 已完成 | src/approval.js:125-137; src/identity.js:222-225,116-128 | decide 要求 humanContext.principal.id 匹配且 HumanProofService 要求 kind=human；agent/service 无此路径 | — |
| §22.2 Approval 字段绑定（task/action/inputHash/revision/principal/nonceHash/expires） | 已完成 | src/approval.js:43-92 | 字段齐全；create 要求 task.waiting_approval 且 task.inputHash 一致；同一 task+action 旧未决挑战被 superseded | — |
| §22.2 同决定幂等/冲突拒绝/过期/改参失效 | 已完成 | src/approval.js:144-212; test/approval.test.js:24-120 | 同决定返回 deduplicated，异决定 APPROVAL_STALE；过期、task revision/inputHash 变化、nonce 重放均拒绝 | revision 恒为 1 使其分支不可达（G-08），但 inputHash 兜底 |
| §22.2 主体撤权/迁机后旧挑战拒绝 | 与设计不一致 | src/migration.js:487-491; src/backup-recovery.js:152-161,1631-1640; src/approval.js:140-143,215-233 | 迁移/备份写 `usableForAuthorization=false`、`invalidatedByMigration=true`、`requiresReverification=true`，但全库无读取方（grep 仅写入与测试断言）；decide 只查 principal.revokedAt（且无主体撤销 API）；assertApproved 派发时不复核主体/标记 | G-05、G-07 |
| §22.2 干跑不消费真实执行授权 | 已完成 | src/approval.js:111-119; src/command-service.js:428-430; test/approval.test.js:54-83 | mode=dry 直接返回 `consumed:false`，不写 decision/usedByOperationId；CLI/HTTP 经 effectiveDryRun 降级 | 之后 go 仍需有效挑战与 nonce |
| §22.2 事务内消费并回流原 Task + 实际派发二次栅栏 | 已完成 | src/effect-gateway.js:605-616; src/approval.js:235-244; test/effect-gateway.test.js:322-358 | 派发边界事务内 assertApproved+consume（写 usedByOperationId），同事务写 dispatching；decide 事务内把原 Task 转 running；随后仍执行 §7 栅栏 | — |
| §22.2 三类上下文与统一栅栏同事务 | 部分完成 | src/effect-gateway.js:573-604,1106-1117,1351-1418; test/effect-gateway.test.js:360-392 | Operation、免费本地执行、通知都在各自业务事务中检查迁移/recovery/fence/instance(仅 op 与本地)/hold；免费本地不查备份保护（符合 §27）；通知派发缺 configRevision 与 instance 状态复核 | G-04、G-14 |
| §5.2 Cookie 只发往允许域名 | 部分完成 | src/bilibili.js:112-120,136-155 | 仅 api.bilibili.com / api.vc.bilibili.com 附 Cookie；字幕 URL 不附 Cookie | `redirect:'follow'` 未在跳转目标复核域名（G-12） |
| §5.2 凭据原子保存/最小权限/credentialRevision 语义 | 已完成 | src/credentials.js:58-69,161-182 | atomicWriteJson + mode 0600 + chmod；credentialRevision=SHA256(SESSDATA) 仅作修订摘要；账号命名空间用 whoami MID | — |
| §5.2 凭据变化后重新 whoami，无法核验时写 fail-closed | 未实现 | src/credentials.js:120-126,136-215; 全库无读取 credentialRevision/lastVerifiedAt | credentialRevision 与 lastVerifiedAt 只写不读；requireWrite/getPublicSummary/hasWriteCredentials 全库无调用方（grep）；重启或换 Cookie 后写派发不要求重新核验，可能以新账号发送而 Operation/回执记旧 accountRef | G-03 |
| §21.1 JCS/RFC8785 边界（lone surrogate、数字极值、Unicode 排序） | 未验证 | src/utils.js:11-52; test/contracts.test.js:17-27 | SPEC 仅给 3 条向量，无这些边界向量或测试 | 无法据此断言完整 RFC8785 合规 |
| §8.3/§8.5 真实 B 站响应与回执结构 | 未验证 | test/bilibili.test.js:8,53-161; test/bilibili-adapter.test.js | 全部使用 createMockFetch，无真实网络/账号证据；回执字段（rpid/msg_key/attribute）为 Mock 假设 | SPEC 允许离线 Mock 验收，真实接入须按 T03/T22 另行验收 |

## 缺口详情

### G-01 [P1] 登录失效/验证码无「人工暂停」，风控暂停语义不完整
- 设计要求：SPEC §7.4「登录失效/验证码要求转为人工暂停，不得持续请求」；§7.2 第 2 步要求检查平台/服务「熔断及人工暂停」。
- 证据：`src/bilibili.js:7` 定义 `BILI_AUTH_CODES=[-101,-111]`，`src/bilibili.js:186-195` 仅抛出 `CREDENTIAL_MISSING`；`onRisk` 不会被调用（`_notifyRisk` 只在 168-176 风险分支调用）。实测：模拟 nav 返回 `code:-101`，得到 `CREDENTIAL_MISSING`、onRisk=null、只请求 1 次。全库 grep 无平台暂停状态/命令；`instance.status='paused'` 仅用于迁移目标，且 `_assertInstance` 只覆盖 Operation 预留（`src/effect-gateway.js:165-180`）。
- 影响：登录失效后没有被持久暂停，调用方反复重试会持续请求平台；无法表达「已暂停、待人工恢复」的合规状态。
- 建议：核心增加按稳定账号的 `authPaused` 持久位，`_notifyAuthFailure` 回调写入并在写预留/读预留事务内 fail-closed；提供本机人工 `account resume` 入口；该位需随迁移/恢复带走。

### G-02 [P1] HTTP 412/429 非 JSON 响应不触发熔断，且被当作可重试错误
- 设计要求：SPEC §7.4「HTTP 412/429 或业务码 -412,-352,-799,-509,-10403 触发指数熔断」。
- 证据：`src/bilibili.js:156-176` 先 `JSON.parse(text)`，解析失败在 164 行直接抛错，168-176 的状态/风险码判断永远执行不到。实测：返回 412 + HTML 正文时，onRisk 未被调用，错误 `BILI_API_ERROR.retryable=true`，读请求实际发了 2 次。
- 影响：真实风控页常是 HTML，熔断器可能根本不打开，读侧还会重复请求风控页，违反「不得持续请求」。
- 建议：先按 `response.status` 判定 412/429 并触发 onRisk（body 解析失败不回退分支），风险错误显式 `retryable:false`。

### G-03 [P1] 凭据变化后写操作未重新 whoami，未 fail-closed
- 设计要求：SPEC §5.2「凭据变化后重新 whoami，无法核验时平台写入 fail-closed；不得通过清空账本恢复」。
- 证据：`src/credentials.js:161-180` 只写入 `credentialRevision`/`lastVerifiedAt`；全库无读取/比较（grep）。`requireWrite`/`getPublicSummary` 无调用方（`src/credentials.js:116-126`）。写路径只检查 `state.activeAccountRef` 存在（`src/adapters/platforms/bilibili.js:51-60`、`src/modules/comments.js:36-39`），而客户端使用启动时加载的 `credentials.get()`（`src/index.js:155-157`）。重启/换 Cookie 后不强制 `account.verify`。
- 影响：可换用另一 MID 的 Cookie 直接发起写，平台按新账号执行，而 Operation/quota/businessKey/回执仍记旧 accountRef，破坏「同 MID 沿用命名空间、换 MID 独立命名空间」与审计一致性（可能造成错账号公开发送）。
- 建议：启动与每次写预留事务内比对 `credentialRevision`；不一致或无法核验时拒绝写并提示 `account.verify`；将 `requireWrite()` 接入派发前检查。

### G-04 [P1] ExecutionDispatchContext 契约存在但零调用，免费本地执行无核心签发上下文
- 设计要求：SPEC §21.2「免费本地执行接受绑定 executionId 的 ExecutionDispatchContext；三类上下文均由核心校验并在派发前检查统一栅栏」；TASKS T14 第 6 条。
- 证据：`src/contracts.js:323-334` 定义 `assertExecutionDispatchContext`，但全库无调用（grep 仅定义处）；`src/modules/production.js:859-924` 直接构造裸 `stageRequest` 并调用 `backend.submit`；`src/adapters/execution/local.js:60-87` 仅校验裸对象字段，无 permit/token/核心签发来源。
- 影响：免费本地执行无法证明「适配器收到的派发上下文来自核心」，契约承诺的防伪造边界缺失；安全上依赖进程内信任，未来远程/外部后端接入时该缺口会变成真实风险。
- 建议：生产模块在 `assertLocalDispatchInTransaction` 同一事务中由网关签发含 `executionId/taskId/stageId/attempt/inputHash/permit` 的上下文，local backend 用 `assertExecutionDispatchContext` 校验；或经评审后修改 SPEC 明确降级。

### G-05 [P1] 迁机/备份恢复对旧审批的失效标记无消费者
- 设计要求：SPEC §22.2 / FR-IM-004「批准过期、输入变更、主体撤权、迁机后的旧挑战一律拒绝」。
- 证据：`src/migration.js:487-491` 写 `usableForAuthorization=false`、`invalidatedByMigration=true`；`src/backup-recovery.js:152-161,1631-1640` 同样写 `usableForAuthorization=false`。全库 grep 只有这些写入点与 `test/recovery.test.js:68` 的断言，没有任何读取/强制。`ApprovalService.assertApproved`（`src/approval.js:215-233`）与 `_assertChallengeCurrent` 均不检查这些标记；已决定审批的 `nonceHash` 本就为 null，清空对已决定审批无作用。
- 影响：当前阻断主要靠任务上的 migration hold（`src/migration.js:495-508`）；一旦 `recovery.authorize` 释放 hold（`src/backup-recovery.js:2244`），旧批准仍可被 `assertApproved` 复用，「迁机后旧挑战一律拒绝」没有独立实现保证。`test/recovery.test.js:68` 只验证标记被写入，未验证其被拒绝。
- 建议：`assertApproved`/`decide` 拒绝 `usableForAuthorization===false` 或 `invalidatedByMigration` 的审批；迁移/恢复后对未消费审批统一置为 rejected 并留事件；补「恢复授权后旧审批仍被拒」测试。

### G-06 [P1] reserved Operation 没有可用的取消入口
- 设计要求：SPEC §7.3「reserved；二次复核失败 → reserved，或人工/系统明确取消为 cancelled」「明确尚未派发的取消可释放预留」。
- 证据：`src/effect-gateway.js:803-836` 实现 `cancelReserved`，但全库无调用方（grep 仅定义）；`src/command-service.js:498-513` 的 task.cancel 只 `requestCancel`，而 `src/task-manager.js:151-152` 要求 pendingOperationIds 为空才可 cancelled。二次复核在 `_prepareDispatch` 失败（如并发迁移/保护变化）时 Operation 停在 reserved。
- 影响：失败的 reserved 会长期占用额度预留与业务键（同一进程不重启就一直冻结），只能等重启恢复转 cancelled，与 SPEC 要求的人工/系统明确取消不符。
- 建议：增加受信的 `operation.cancel`（要求 `provenUndispatched` 证据，如从未进入 `_prepareDispatch`）并接线 `cancelReserved`；运营文档写明处置方式；补对应测试。

### G-07 [P2] 撤权/主体复核不完整
- 设计要求：SPEC §22.2「主体撤权、迁机后的旧挑战一律拒绝」；§22.1 绑定撤权后拒绝。
- 证据：`src/identity.js:174-187` 只实现 binding 撤销，无 principal 撤销 API；`src/approval.js:140-143` 只在「决定」时查 `principal.revokedAt`，派发时 `assertApproved` 不查主体/scopes；`requiresReverification` 也只在 `src/backup-recovery.js:163-167,1631-1648` 写入，无读取方。
- 影响：已批准未消费的审批在主体撤权后仍可被消费；恢复后权限重建期间缺少显式复核点（当前主要靠 task hold/phase 兜底）。
- 建议：明确本期「主体撤权」的实现方式（至少让派发事务复核 principal 有效性与恢复标记），或在文档中如实标注本期仅支持 binding 撤销。

### G-08 [P2] Task revision 创建后永不递增，审批 revision 绑定成为静态值
- 设计要求：SPEC §22.2 审批绑定 `taskRevision`，输入/配置/权限变化失效；TASKS T14。
- 证据：`src/task-manager.js:80` revision=1；`transition`（156-188）与全库均无 revision 递增（grep）；`src/approval.js:72,197` 绑定/比较它。测试 `test/approval.test.js:89-91` 直接改 `draft.tasks[].revision += 1` 制造变化，非产品路径。
- 影响：任务输入若被改写而 inputHash 忘记同步，revision 检查不能兜底；该绑定目前是「看起来有、实际恒真」的防线。
- 建议：在会改变 approval 绑定对象的操作中递增 revision（如任务输入修订、resume 重建审批），并让测试走真实修订路径。

### G-09 [P2] 读重试不再预留额度；无读时间槽；minGapMs 无消费者
- 设计要求：SPEC §7.1「每次读取前预留读额度与时间槽」「只读请求…默认最多 1 次」。
- 证据：`src/bilibili.js:214` 仅 attempt 0 调用 `beforeRead`；实测读重试时 beforeRead=1、fetch=2。`src/rate-limiter.js:71-84` 只有 hour/day 计数，没有 nextAllowedAt；`src/config.js:127,411` 定义并校验 `rateLimit.minGapMs`，但全库无消费者（grep），writeGapMs 才有使用。
- 影响：读额度可被重试放大；「时间槽」语义缺失；minGapMs 是误导性死配置。
- 建议：重试前再预留读额度（或明确读重试计入一次）；实现读最小间隔并接 minGapMs，或从 config/文档移除该字段。

### G-10 [P2] BilibiliClient 构造签名与 SPEC §8.1 不一致
- 设计要求：SPEC §8.1 示例构造参数为 `{config, credentials, store, rateLimiter, fetchImpl, now, logger}`。
- 证据：`src/bilibili.js:84-110` 实际参数为 config/credentials/fetchImpl/now/logger/onRisk/beforeRead/operationContextVerifier/deviceId/deviceIdProvider/timeoutMs，不接收 store/rateLimiter；等价接线在 `src/index.js:155-192`（读额度/风控经 beforeRead/onRisk 回调，写入上下文经 verifier）。
- 影响：按 SPEC 直接构造的调用方会“以为注入了 store/rateLimiter”但被静默忽略（不报错），契约与实现漂移；测试用注入回调方式掩盖。
- 建议：要么恢复 store/rateLimiter 入参并接线，要么修订 SPEC §8.1 示例使其与注入式设计一致（并拒绝未知构造参数）。

### G-11 [P2] DM 互关只在适配器层执行，协议客户端 requireMutual 是死参数
- 设计要求：SPEC §8.5「默认要求互关」。
- 证据：`src/bilibili.js:429` 接收 `requireMutual`，但 429-470 正文从未引用；互关校验在 `src/adapters/platforms/bilibili.js:241-252,254-268`。直接调用 `BilibiliClient.sendDirectMessage`（本文件即公开导出类）可绕过互关。
- 影响：分层边界上「默认互关」不是协议层保证；外部代码或未来新调用方容易漏检。
- 建议：在客户端内做 relation 校验（或在契约层显式标注该参数已被忽略并改为必传前置校验 token）。

### G-12 [P2] Cookie 域名白名单不覆盖 follow 重定向
- 设计要求：SPEC §5.2「Cookie 只发往明确允许的 B 站域名」。
- 证据：`src/bilibili.js:137-145` 依据初始 URL 决定 Cookie；149-155 请求使用 `redirect:'follow'`。Node fetch 对手动设置的 Cookie 头在跨源重定向时不会像浏览器那样剥离（未在本环境实测真实网络行为）。
- 影响：若 api.bilibili.com/api.vc 返回跳转，Cookie 可能被带到非白名单域名。
- 建议：带 Cookie 的请求用 `redirect:'manual'` 或逐跳校验目标 host；补重定向泄漏测试。

### G-13 [P2] resolve 幂等不比较回执内容；external publish 未校验 BV 格式
- 设计要求：SPEC §7.3「同一 Operation 重复 resolve 为相同结果应幂等返回」「confirmed 的发布核查必须带平台、postId（B 站为 BV）、来源及确认信息」。
- 证据：`src/effect-gateway.js:878-880` 同 decision 直接 deduplicated，不比较 `receipt.externalId/verification`，第二次带不同回执也会被静默忽略；`src/effect-gateway.js:857-871` 对 external 只要求 externalId 非空与 url，无 BV 正则；manual complete 才校验（`src/modules/publisher.js:657`）。
- 影响：审计上可能记录“第一次”之外的人工核查差异而不报冲突；external 路径可登记任意字符串为 BV。
- 建议：同 decision 时比较外化回执关键字段，冲突抛 IDEMPOTENCY_CONFLICT；external resolve 复用 `BV_PATTERN` 校验（B 站账号/命名空间时）。

### G-14 [P2] 通知派发缺配置修订与实例状态复核
- 设计要求：SPEC §22.3/§27、T14「通知使用 OutboxDispatchContext；共享适用栅栏」。
- 证据：`src/effect-gateway.js:1351-1418` 的 `dispatchNotification` 检查 binding/conversation/migration/fence/recovery/hold/保护/im 开关与预算，但没有 `_assertConfig` 与 `_assertInstance`（对比 Operation 的 593-604、本地执行的 1106-1117）。
- 影响：配置修订变化或实例处于 paused/disabled 时，通知仍可能派发（迁移目标实例上 IM 桥接若被误启动会漏栅栏）。
- 建议：补 `_assertConfig(tx)` 与实例 capability/状态检查，或在文档中明确通知不适用实例门禁及理由。

### G-15 [P2] 请求去重 inputHash 额外包含 envelope mode（跨范围提示）
- 设计边界：SPEC §21.1 规定 inputHash 覆盖范围，明确不覆盖 requestId/时间/显示名，未列 `mode`。
- 证据：`src/command-service.js:91` `computeInputHash({ action, input, metadata: { mode: request.mode } })`。
- 影响：同一 requestId 先 dry 后 go 会被判 `IDEMPOTENCY_CONFLICT`；若产品希望「干跑后同 requestId 可继续 go」（SPEC §22.2 语义上干跑不消费授权），这是行为偏差。属其它审查范围，仅作提示。
- 建议：确认规范意图；若 mode 不应参与 request 去重 hash，以独立字段记录执行模式。

### G-16 [P2] 适配器内 `_beforeRead`/`_onRisk` 为死代码，与 index 内联逻辑重复
- 证据：`src/adapters/platforms/bilibili.js:62-71,73-89` 定义两个回调，但全库无调用/接线（grep）；实际接线是 `src/index.js:169-191` 的内联实现（读额度 key 的处理方式还不完全一致：内联版在无 activeAccountRef 时用 `bilibili:unverified`）。
- 影响：双份逻辑易漂移；未来维护者可能改错一份。
- 建议：删除适配器内死方法，或统一由适配器提供并被 index 使用。

### G-17 [P2] 权限/dryRun 复核不在网关预留事务内
- 设计要求：SPEC §7.2 第 1 步「检查…权限和审批」在同一 Store 事务中完成。
- 证据：`src/effect-gateway.js:431-437` `reserveOperation` 无 principal/mode 入参；实例能力在事务内校验（443-448），审批仅对传入 approvalId 校验（481-487）；principal 权限与 effectiveDryRun 由 CommandService/模块在事务外先行检查（如 `src/command-service.js:84,327`）。
- 影响：主体权限/干跑判定与预留之间存在 TOCTOU 窗口（当前无 principal 撤销 API，风险有限）。
- 建议：预留入参显式携带 principalId/mode 并在事务内复核，或文档明确该步骤由调用方保证。

### G-18 [P2] X/抖音/remote 契约测试缺失（T14 目标文件不存在）
- 设计要求：TASKS T14 目标文件包含 `test/helpers/mock-platforms.js`；SPEC §21.2/R-13「X/抖音只做平台契约与 Mock 一致性测试」「测试替身不得注册为正式启用适配器」。
- 证据：`test/helpers/` 实际只有 backup.js/fake-execution-backend.js/fake-publisher.mjs/fake-runner.mjs/harness.js/mock-channel.js/mock-fetch.js，无 mock-platforms.js（glob 确认）；test 中无 douyin/X/remote 平台注册断言。实现侧仅靠 config.js:288 白名单与 registry 未注册报错“结构性拒绝”。
- 影响：「未支持平台返回 CAPABILITY_UNSUPPORTED、不被注册」缺少直接测试证据，属验收缺口而非运行缺陷。
- 建议：补测试替身与「registerPlatform 后未启用/未注册返回 CAPABILITY_UNSUPPORTED、不能正式调用」用例。

## 无法确认项

1. **真实 B 站接口与回执**：本仓库全部协议测试使用 `createMockFetch`（test/bilibili.test.js:8），无真实网络/账号证据；DM 成功响应字段（msg_key）、relation（attribute/be_relation）、字幕 URL 形态均为 Mock 假设。真实接入验收应按 T03/T22 另做，本次无法确认。
2. **真实 DSH 宿主人类证明**：SPEC §22.1 允许两种机制之一；仓库只实现 TTY 路径（`src/identity.js:245-291`），宿主签名 challenge 仅有 `humanVerifier` 注入点（`src/index.js:51,100`），无宿主侧证据。且 TTY 路径不校验「当前 OS 会话独立身份」；宿主证明不可用时真实 go 应为 BLOCKED（SPEC 允许离线实现但不可冒充）。
3. **Node 24 fetch 的重定向 Cookie 行为**：G-12 依据代码路径与 undici 语义推断，未在本环境构造真实跨域重定向实测，故未升级为 P1。
4. **RFC 8785 边界**：仅 3 条 SPEC 向量可验证，lone surrogate、数字边界、Unicode 排序等无金标准向量或测试，无法确认完整合规。
5. **多进程/多实例**：沙箱下不能运行 `npm test` 的 spawn，多进程竞争、跨进程恢复、迁移期间双写者等场景未实测（本任务只做离线单进程定向测试）。
6. **生产 protection 服务在事务内行为**：测试注入的是桩（test/helpers/harness.js）；真实 `BackupService.getProtection`（src/backup-recovery.js:963）在 Store 事务锁内读取磁盘的耗时/阻塞影响未测。
7. **迁移/灾备端到端后旧审批的实际利用路径**：未做端到端演练，G-05 的“可利用性”基于代码路径推理（hold 释放后 assertApproved 仍不检查标记）。

## 实际运行的定向测试与结果

按任务约束未运行 `npm test` / `npm run check` / `npm run test:coverage`；用 `node test/<file>.test.js`（node:test 进程内）逐个执行，全部退出码 0：

| 测试文件 | 结果 | 用时 | 关键覆盖 |
|---|---|---|---|
| test/contracts.test.js | 5/5 通过 | 31ms | §21.1 三条 JCS 金标准向量、requestKey 定义、inputHash/metadataHash、未知信封字段拒绝 |
| test/approval.test.js | 4/4 通过 | 1.13s | 挑战绑定/决定幂等/非 nonce 重放/干跑不消费/改 revision 与过期失效/错误人类证明 fail-closed |
| test/effect-gateway.test.js | 12/12 通过 | 4.55s | 预留六步门禁（迁移/fence/保护/hold/配置 revision）、unknown 冻结、resolve 同事务、审批派发边界消费、重启恢复、付费预算、免费本地不受备份保护但仍受迁移门禁 |
| test/rate-limiter.test.js | 3/3 通过 | 516ms | 读额度/写冷却、风险码指数熔断 5 分钟、成功重置与日窗口轮转 |
| test/bilibili.test.js | 7/7 通过 | 21ms | WBI 纯函数/空 key 拒绝、读重试一次写不重试、非 0 code 不成功、字幕域名/无 Cookie、评论/DM 回执与 dev_id、风险回调 |
| test/bilibili-adapter.test.js | 3/3 通过 | 236ms | dm.receive=false/无原生发布、discover 归一、跨账号写上下文拒绝 |
| **合计** | **34/34 通过** | — | — |

补充的进程内探针（`node --input-type=module -e`，不写文件、不联网）：
- JCS 三条金标准独立复算：`{"a":1,"b":"你好"}`→`f904ec…ca088`；`{"action":"comment",...}`→`c770c2…fe9f3`；`normalizedTextHash('你好')`→`092251…a8b9`，与 SPEC §21.1 完全一致。
- 构造 `fetchImpl` 返回 HTTP 412 + HTML：`onRisk` 未调用、错误 `BILI_API_ERROR.retryable=true`、读请求实际 2 次（G-02 证据）。
- 模拟 nav 返回 `code:-101`：抛 `CREDENTIAL_MISSING`、`onRisk=null`、无暂停机制（G-01 证据）。
- 模拟读首次 503 后成功：`beforeRead` 调用 1 次、`fetch` 2 次（G-09 证据）。

另：`.audit-lead/findings-gateway.md` 为本任务唯一写入文件；未修改 src/test/doc 或其它文件。
