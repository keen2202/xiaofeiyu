# 核心状态层审查

- 审查范围：`src/config.js`、`src/credentials.js`、`src/identity.js`、`src/store.js`、`src/event-journal.js`、`src/task-manager.js`、`src/errors.js`、`src/utils.js`、`src/agent.js`，以及对应离线测试。
- 代码基线：工作区当前内容（git HEAD `e12b7d9` + 17 个未提交修复文件；本次实际读到的 store.js/event-journal.js/task-manager.js 含未提交改动）。只读审查，未修改任何源码/测试/文档。
- 方法：先读 SPEC §4.3-4.6/§5/§6/§9/§10.1/§18，再以 grep/read 逐条核对实现与接线，最后运行可独立执行的 Node 测试文件（未运行 `npm test`/`npm run check`，按约束避免 spawn EPERM）。
- 状态口径：`已完成（离线）` = 有代码实现且有离线测试支撑，不代表真实 B 站/宿主环境验收；`部分完成`/`未实现`/`与设计不一致`/`未验证` 按任务定义使用。

## 结论摘要（各类状态计数）

共判定 54 行：

| 状态 | 数量 |
|---|---|
| 已完成（离线） | 38 |
| 部分完成 | 12 |
| 与设计不一致 | 2 |
| 未实现 | 0 |
| 未验证 | 2 |

总体判断：核心状态层主体实现完整，Store 事务/锁/归档/事件结构、Task 白名单与结算字段、配置校验、凭据原子写、AgentClient、错误码均达到可离线验证的完成度。**F08 的历史主缺口（归档无人驱动 + 容量硬门禁缺失）当前已闭合（离线）**，但存在并发归档误报、清理未接线、容量统计开销等残余 P2。**F09（配置更新事务与动态生效）仍未闭合**：文件写入与 configRevision 提交仍分离，scheduler 定时器/Agent/BilibiliClient 不随配置更新生效。另发现一条新的 P1：凭据变化后不自动重新 whoami、派发前不核对 credentialRevision，存在“以旧 accountRef 用新 Cookie 写入”的身份错位风险。

## 逐项对照表

### §4 配置（4.3-4.6）

| 条款/FR | 状态 | 代码位置 file:line | 判断依据 | 备注 |
|---|---|---|---|---|
| §4.3 默认配置与 config.example.json 深比较 | 已完成（离线） | src/config.js:20-23；test/config.test.js:20-24 | DEFAULT_CONFIG=deepClone(JSON.parse(config.example.json))；测试 assert.deepEqual(DEFAULT_CONFIG, example) 通过 | 另用 PowerShell 将 SPEC.md §4.3 JSON 代码块与 config.example.json 做 ConvertFrom-Json 后 compress 比较，结果 IDENTICAL |
| §4.4 布尔字段严格、0 值、范围、枚举 | 已完成（离线） | src/config.js:26-54,199-214,279-281,296-349,354-419 | BOOLEAN_FIELDS 覆盖全部 enabled+dryRun/requireApproval/autoPublish/requireMutual/markWatchHistory/allowTemplate/afterBrowse/daily/publicBook/privateBook/successJson/allowExternalPublisher/allowLocalProducer；Number.isSafeInteger 校验、allowZero 显式处理合法 0；无 `Number(value)||default` | test/config.test.js:26-43 覆盖 0 值与字符串/数字冒充布尔 |
| §4.4 markWatchHistory=true 直接拒绝 | 已完成（离线） | src/config.js:314-318 | 抛 CONFIG_INVALID | test/config.test.js:51 覆盖 |
| §4.4 successJson/外部发布条件 | 已完成（离线） | src/config.js:390-402 | provider=external 且非干跑必须 allowExternalPublisher=true 且 command 非空；successJson=false 非干跑外部发布抛 CAPABILITY_UNSUPPORTED | stdout 回执协议本体在 publisher 模块（非本次文件范围），单独标注 |
| §4.4 platforms.enabled 仅 bilibili | 已完成（离线） | src/config.js:288 | 每项必须 === 'bilibili'，X/抖音值被拒绝 | — |
| §4.4 强制审批/串行/remote 拒绝 | 已完成（离线） | src/config.js:354-372,379-402 | production.backend=remote→CAPABILITY_UNSUPPORTED；maxConcurrent 1..1；production.requireApproval 必须 true；publishing.autoPublish 必须 false、requireApproval 必须 true；rateLimit.minGapMs≥500、writeGapMs≥30000、circuitMax≥circuitBase | test/config.test.js:57-60 覆盖部分 |
| §4.4 rateLimit/agent.baseUrl/目录绝对路径/未知键/im 范围 | 已完成（离线） | src/config.js:216-224,248-272,344-349,404-409,411-435 | baseUrl 必须 https:// 前缀；目录/命令走 requireAbsoluteOrEmpty；未知键收集后 CONFIG_INVALID；im.adapterId 仅 dsh-im、age/ttl 60-3600、groupReplies summary\|none、notifications 下限 | — |
| §4.4 diary 两个 book 都关后仍请求写日记必须拒绝 | 部分完成 | src/config.js:339-341 | 此处只有空注释块（允许两个都关）；“请求写日记时拒绝”在 diary 模块，本次文件范围外未核 | 配置层未强制，需 diary 审查确认 |
| §4.4 allowedRecipientMids 非空正整数数组后才允许实际发送 | 部分完成 | src/config.js:329-334 | 仅校验元素为正整数、允许空数组；非空才可发送的门禁在 direct-messages 模块（范围外） | DM 模块审查确认 |
| §4.5 已知键深合并、角色来自可信上下文、完整校验失败零写 | 已完成（离线） | src/config.js:543-577,692-698,718-742 | assertHttpPatch 白名单；deepPatch 深合并；source 由调用方传入而非请求体；先 validateConfig(merged) 再 atomicWriteJson | 校验阶段失败确实不写文件；提交阶段失败可留文件已改（见 F09 行） |
| §4.5 HTTP PATCH 白名单与审批/干跑保护 | 已完成（离线） | src/config.js:158-197,698-717；src/index.js:594-601 | 白名单排除 dataDir/credentialsFile/timeZone/目录/命令/model/baseUrl/apiKeyEnv/platforms/im/migration/security/profile/backend/主体绑定；HTTP 不能关 requireApproval/autoPublish、不能把全局 dryRun 由 true 改 false；PATCH 要求 isOwner | test/config.test.js:107-126 覆盖 FORBIDDEN |
| §4.5 迁移封存/退役时禁改配置 | 部分完成 | src/config.js:728-739 | 先 getSnapshot 检查 migration.phase/recovery.phase，再写文件；检查与写入不在同一事务（TOCTOU），且未单独检查 instance.status=retired | 见缺口 #G2 |
| §4.5 配置写入与 configRevision 同一 Store 事务（version 单调+JCS sha256） | 与设计不一致 | src/config.js:740-742,745-762 | 先 atomicWriteJson 写 config 文件，随后另开 store.transaction 写 configRevision；两者不是同一事务，崩溃/并发存在文件与 revision 不一致窗口 | F09 核心证据 |
| §4.5 各进程派发时同时核对 version/hash 与当前配置 | 部分完成 | src/config.js:766-773；src/effect-gateway.js:153-163 | assertCurrentState 只比较 state.configRevision.sha256 与当前配置 hash，未核对 version | 见缺口 #G4 |
| §4.5 manifest 保存 configRevision 两值+timeZone；读取/错误递归脱敏 | 已完成（离线） | src/config.js:525-541,656-658,763；src/backup-recovery.js:198-199；src/migration.js:314-315；src/errors.js:122-154,176；src/index.js:720-728 | redactConfig/redactSecrets 递归处理密钥形状键；HTTP 错误响应走 AppError.toJSON() 的脱敏 details；backup/migration manifest 均带 configRevision+timeZone | — |
| §4.5 配置更新“下一轮生效”/统一变更通知 | 部分完成 | src/coordinator.js:45-62；src/index.js:155,247,466,600；src/config.js:743 | tick 每轮读 configService.get()（禁用项下一轮生效）；但 scheduler.enabled 由 false→true 时不会创建定时器（启动后仅 boot 调 coordinator.start），AgentClient/BilibiliClient 持构造时 config 对象不会被 update 替换 | F09；见缺口 #G3，HTTP PATCH 后仅启动归档维护定时器 maintenance.start |
| §4.6 三级 dryRun 公式与结果字段 | 已完成（离线） | src/contracts.js:168-187,160-166 | effectiveDryRun = global OR production.dryRun OR publishing.dryRun OR invocation dry；返回 executionMode/blockedBy（global_dry_run/production_dry_run/publishing_dry_run/invocation_dry）；normalizeMode 强制 dry\|go | test/contracts.test.js 通过；各入口 mode 映射由 entry 审查细化 |
| §4.6 dryRun 不产生外发/业务键、readyForPublish=false、显式 mode | 已完成（离线） | src/modules/comments.js:263-271,327-333；src/modules/direct-messages.js:92,127,163；src/modules/production.js:215-217,339-346；src/modules/publisher.js:228,345-352；test/entrypoint-reliability.test.js:185-202 | 各模块在 dry 时返回 executionMode=dry+blockedBy+plan，不 reserve/dispatch；entrypoint 测试验证 dry 手动浏览不发送自动评论 | 集成测试 integration.test.js 全流程通过 |

### §5 凭据（含 identity.js 辅助）

| 条款/FR | 状态 | 代码位置 file:line | 判断依据 | 备注 |
|---|---|---|---|---|
| §5.1 凭据字段与环境变量 | 已完成（离线） | src/credentials.js:11-17,36-56 | 四个字段白名单；BILI_SESSDATA / BILI_JCT / BILI_BUVID3 / BILI_DEDEUSERID 覆盖文件值；未知字段拒绝 | test/credentials.test.js:20-22 |
| §5.2 写操作必须具备 sessdata 和 bili_jct | 部分完成 | src/bilibili.js:383-386,112-120；src/credentials.js:120-126 | bili_jct 由 _csrf() 强制（CREDENTIAL_MISSING）；sessdata 缺失时 _cookieHeader 返回 null，不提前报错而是带无 Cookie 请求；requireWrite() 有实现但 grep 无调用者 | 见缺口 #G9；写入最终因平台回执缺失判 failed/unknown，不会误判成功 |
| §5.2 Cookie 只发往允许的 B 站域名、字幕不带 Cookie | 已完成（离线） | src/bilibili.js:5,112-120,293-338 | BILI_ALLOWED_COOKIE_HOSTS=['api.bilibili.com','api.vc.bilibili.com']，_cookieHeader 不匹配即不加 Cookie；字幕下载单独 fetch 且不带 Cookie，只允许 https bilibili/hdslb/bilivideo 域名 | redirect:'follow' 跨域是否剥离 Cookie 未验证（见无法确认项） |
| §5.2 凭据原子保存+最小权限 | 已完成（离线，Windows ACL 未验证） | src/credentials.js:58-64；src/utils.js:348-374 | atomicWriteJson 同目录临时文件（pid+随机后缀）→ fsync → rename → syncDir；mode 0o600 并 chmod | test/credentials.test.js:9-27 在 Windows 仅断言文件存在并输出诊断，未认证 NTFS ACL |
| §5.2 whoami 核验 MID；owner.mid/dedeuserid 不替代 whoami、不一致拒绝 | 已完成（离线） | src/credentials.js:136-160；src/adapters/platforms/bilibili.js:91-101 | verifier（client.whoami）isLogin=true 且 mid 存在才继续；ownerMid 与 dedeuserid 与 whoami mid 不一致均抛 IDENTITY_UNVERIFIED | test/credentials.test.js:44-57,63-97；但仅在显式 verifyAndBind 时执行，见下一行 |
| §5.2 credentialRevision 仅为 SESSDATA 摘要、不进入账号命名空间 | 已完成（离线） | src/credentials.js:66-77,154-193 | credentialRevision=sha256('credential-v1\n'+sessdata)；账号命名空间 key=`bilibili:${accountId}` 与摘要无关 | — |
| §5.2 同 MID 换 Cookie 保留额度/业务键/devId/unknown；不同 MID 独立命名空间且旧记录保留 | 已完成（离线） | src/credentials.js:162-181；src/index.js:171-175；src/modules/comments.js:66-70；src/modules/direct-messages.js:103-104 | verifyAndBind 覆盖 account 时保留 devId/boundAt，不清空 rate/businessKeys/operations；额度 key=`bilibili:${accountId}`，业务键含 accountId；切 MID 需 switchAccount，旧 accounts 键保留 | test/credentials.test.js:29-97 覆盖同 MID 换 Cookie 保留 devId、不同 MID 需显式切换 |
| §5.2 凭据变化后重新 whoami、无法核验时平台写入 fail-closed；在途操作固定原 accountRef 与凭据版本 | 与设计不一致 | src/credentials.js:136-195（仅显式绑定）；src/index.js:138-152,193,456-463；src/bilibili.js:51-60；src/effect-gateway.js:395-428（op 记录 accountRef 无 credentialRevision） | boot 只 load 凭据不比对 account.credentialRevision；写路径 _activeAccount 只查 activeAccountRef/账号记录存在，不重新 whoami、不比对当前 SESSDATA 摘要；Operation 只固定 accountRef，未固定/校验凭据版本；credentialRevision 仅在 credentials.js 与状态命令出现 | P1，见缺口 #G1 |
| §5.2 Cookie 不外发（模型/生产/发布/迁移包） | 已完成（离线，迁移包范围外） | src/index.js:138-192,247,280-304；src/agent.js:4-19 | BilibiliClient 是唯一持凭据对象；AgentClient/ProductionModule/PublisherModule 构造参数均无 credentials；生产子进程不接收 Cookie 从构造参数侧看成立 | 迁移包不携秘密、生产端 env 全集的实证属 migration/backup/production 审查 |
| §5/§17 identity.js 主体/绑定/人类证明基础 | 已完成（离线，真实宿主证明未验证） | src/identity.js:34-128,130-206,213-291 | 仅 human+可信 sourceKind 创建人类主体；scope 默认拒绝、owner '*' 仅限本地 owner；IM binding 限定 IM_SCOPES、撤销 fail-closed；TTY 挑战一次性+绑定 hash+超时+constantTimeEqual；无 verifier 时拒绝 | test/identity.test.js 3 项全过；真实 DSH human proof 属真实宿主验收 |

### §6 Store（6.1-6.4）

| 条款/FR | 状态 | 代码位置 file:line | 判断依据 | 备注 |
|---|---|---|---|---|
| §6.1 state version=3 字段逐个存在/旧版本拒绝 | 已完成（离线） | src/store.js:77-124,126-171 | createInitialState 含 SPEC 所列全部字段（workspaceId/historyEpoch/configRevision/recovery/activeAccountRef/accounts/operations/businessKeys/requests/tasks/videos/events/eventSeq/journalPending/journalSegments/cursors/diaries/rate/publishes/principals/bindings/approvals/inboxKeys/outbox/artifacts/productions/executions/budgets/migration）并额外 artifactPendingImports/checkpointFence/artifactPins/backups/timeZone；validateState 拒绝 v1/v2（SCHEMA_UNSUPPORTED），不重建 | test/store.test.js:10-23,149-173 |
| §6.2 wx 原子锁、属主/PID/lease、存活与超时、PID 复用/无法判断 fail-closed | 已完成（离线） | src/store.js:354-450；src/utils.js:441-473 | fsp.open(lock,'wx',0o600) 原子创建，payload 含 token/ownerPid/processStartedAt/instanceId/createdAt；对 EEXIST 走盗锁：malformed→不盗；未超 staleLockMs→不盗；活属主且 /proc 启动时间可判定且不一致→盗，不可判定→fail-closed；release 校验 token | test/store.test.js:66-127；PID 复用检测仅 Linux /proc，Windows 下活属主无法判定即 fail-closed |
| §6.2 每次事务重读、损坏 fail-closed 不改名重建、临时文件与持久化 | 已完成（离线） | src/store.js:311-325,318-331,460-511；src/utils.js:336-374 | transaction 获锁后重新 getSnapshot+deepClone 再写；state.json 缺失/损坏抛 STORE_CORRUPTED/RECOVERY_REQUIRED；bootstrap state/instance 双写且崩溃可检测；临时文件带 pid+随机后缀，fsync 文件+rename+目录 fsync | test/store.test.js:25-64,175-201 |
| §6.2 最近 2000 events 热缓存 | 已完成（离线） | src/store.js:539-547 | appendEvent push 后 while(>2000) shift；同时写 journalPending | test/event-journal.test.js:7-30（2500 事件） |
| §6.2 500 Task/5000 Operation 普通清理仅已结算、未决引用不得淘汰 | 部分完成 | src/store.js:629-684 | prune 只删 isSettled 且未被引用 Task、仅 confirmed/failed/not_sent/cancelled 且未被未决 Task 引用的 Operation；但 grep 显示 prune 在 src 内无任何调用者、无测试 | 保护逻辑正确但未接线，见缺口 #G5 |
| §6.2 businessKeys 独立永久、不参与数量清理 | 已完成（离线） | src/store.js:52-75,629-684；src/effect-gateway.js:528-545,674-693 | businessKeys 为独立对象；prune 不触碰；确认时写 confirmedAt/receipt，reserved/unknown 写状态与 lastOperationId | 业务键结构由 gateway 维护，属核心-网关交界 |
| §6.2 锁不在网络/渲染期间持有；核心唯一账本实施者 | 已完成（离线，抽样式） | src/effect-gateway.js:735-742,573-641；src/agent.js:4-19；src/bilibili.js:83-110；src/index.js:212-218 | reserve/_prepareDispatch 在事务内写 dispatching，execute 网络调用在事务外，随后 _settleDispatch 新事务；BilibiliClient/AgentClient/LocalExecutionBackend 不接收 store | 无法全量静态证明所有调用点，见无法确认项 |
| §6.3 事件字段/epoch/seq/eventId/去重 | 已完成（离线） | src/store.js:523-547；src/event-journal.js:236-252 | eventId 随机唯一、epoch/seq/workspaceId/accountRef/type/taskId/occurredAt/payload 齐全；读取时对同 seq 不同内容、同 eventId 不同内容抛 JOURNAL_CORRUPTED | — |
| §6.3 payload 单条 64KiB 上限 | 已完成（离线） | src/store.js:539-541 | jsonByteLength(event)>64KiB 抛 INPUT_REQUIRED（改用受管引用） | test/store.test.js:129-147 |
| §6.3 分段命名/摘要/临时 rename/登记后移除 pending/崩溃保留/epoch 隔离 | 已完成（离线） | src/event-journal.js:39-130,132-146,254-266 | 段文件 journal/<epoch>/<start>-<end>-<hash32>.json，临时文件 fsync 后 rename；事务登记 journalSegments 并删 pending；崩溃/rename 失败 pending 不动；同 epoch+seq 不同 hash 报 JOURNAL_CORRUPTED；不同 epoch 目录隔离 | test/event-journal.test.js:53-104 |
| §6.3 10000 pending 门禁、80/100MiB 容量门禁、归档运行时驱动（F08） | 已完成（离线） | src/store.js:548-562,587-621；src/coordinator.js:96-99；src/index.js:393-417,536；src/command-service.js:145,438；src/effect-gateway.js:438 | assertBusinessAcceptance 对 pending>=10000 与 totalBytes>=hardBytes 拒绝新业务；capacityStatus 汇总 state+segments+recovery 字节并给 healthy/warning/blocked；warning 时 coordinator.tick 跳过调度生成；status 暴露 capacity；maintenance 每 1s 分批 flush（仅任一功能启用时启动），start/stop/close 生命周期接线；在途结算路径不加门禁 | F08 主缺口已闭合；残余见 #G6/#G10/#G12；test/entrypoint-reliability.test.js:204-226,228-241 |
| §6.3 归档缺失/损坏/seq 冲突 fail-closed | 已完成（离线） | src/event-journal.js:152-214,216-233 | readEvents 校验路径安全/文件存在/schema/epoch/start/end/hash/内容 hash，缺段或冲突抛 JOURNAL_CORRUPTED；读范围按 seq 连续，gap 即错 | test/event-journal.test.js:32-51 |
| §6.3 日记读取“归档+pending 一致性截止序号快照” | 未验证 | src/event-journal.js:224-233（只提供按 epoch+seq 读游标能力） | 截止序号快照的消费方在 diary 模块，本次未核 | 需 diary 审查确认 |
| §6.4 公共接口与 appendEvent 仅 transaction 内、同 draft 一次提交 | 已完成（离线） | src/store.js:247-309,318-325,452-511,523-547,571-573,575-580 | init/getSnapshot/transaction/appendEvent/close 齐备；实例级 appendEvent 恒抛 STORE_CORRUPTED；上下文 tx.appendEvent 写 events+journalPending；事务内可同时写请求/任务/outbox；嵌套事务拒绝 | test/store.test.js:129-147 |
| §6.4 transaction 回调不得网络/长时间等待 | 部分完成 | src/store.js:452-511 | 无运行时强制（无法静态证明），仅靠调用约定；抽查 dispatch 模式符合（网络在事务外） | 见无法确认项 |

### §10.1 Task 状态

| 条款/FR | 状态 | 代码位置 file:line | 判断依据 | 备注 |
|---|---|---|---|---|
| §10.1 白名单迁移逐对一致、未列出拒绝、初始 queued | 已完成（离线） | src/task-manager.js:4-48,94-99,119-154 | TASK_TRANSITIONS 与 SPEC 表格逐对一致；create 强制 status=queued；同状态 no-op 允许（非迁移） | test/task-manager.test.js:20-37 |
| §10.1 迁移条件（running→cancelled 需证明未派发、审批/人工/unknown 校验） | 部分完成 | src/task-manager.js:130-153 | waiting_approval→running 需 approved、awaiting_manual→succeeded 需 manualReceipt、unknown/partial/failed 需 verified/manual、succeeded/cancelled 需无 pendingOperationIds；但“已证明未派发”仅凭调用方 options.provenUndispatched 布尔，核心不核对 operation.dispatchAt | 见缺口 #G8 |
| §10.1 isSettled/executionActive/finishedAt 合法组合 | 部分完成 | src/task-manager.js:166-246,391-409；src/store.js:126-171 | recompute 按状态维护组合（unknown/succeeded/cancelled/partial/failed 规则基本正确）；assertSettledCombination 有实现但 grep 显示仅测试调用、生产无调用者；validateState 不校验 task 组合；running 迁移时未清 finishedAt；succeeded 的 isSettled 未计入 pendingApprovals（partial/failed 计入） | 见缺口 #G7；test/task-manager.test.js:125-142 仅直接单测该函数 |
| §10.1 partial/failed 含 unknown 未结算、finishedAt=null | 已完成（离线） | src/task-manager.js:227-236 | pendingOperationIds 非空/有 unknown op/active holds/未决审批任一存在即 isSettled=false、finishedAt=null | test/task-manager.test.js:39-64 |
| §10.1 cancelRequestedAt 语义 | 已完成（离线） | src/task-manager.js:308-317,345 | requestCancel 仅记录时间与历史、不伪改状态；resume 清空 cancelRequestedAt；已派发取消由 effect-gateway cancelReserved 的“仅 reserved 且未派发可取消”承接 | — |
| §10.1 父子任务聚合（待审批子任务不算成功、unknown 不结算） | 部分完成 | src/task-manager.js:248-287 | recomputeParent 汇总 unsettled/unknown/failed/succeeded，待审批/未知子任务使父不结算，全成功才 succeeded；但 unknown 判定引用 child.hasUnknownOperation，而该属性在全 src 中从未赋值（只在 252 行读取），属死条件；未对父任务执行额外未知检测 | 见缺口 #G7；test/task-manager.test.js:105-123 仅覆盖子任务 status=unknown 场景 |

### §9 AgentClient

| 条款/FR | 状态 | 代码位置 file:line | 判断依据 | 备注 |
|---|---|---|---|---|
| §9 AgentClient 全部行为 | 已完成（离线） | src/agent.js:21-115 | 仅 POST <baseUrl>/chat/completions；Key 从 env[config.agent.apiKeyEnv] 读且缺失抛 AGENT_DISABLED；外部素材包在 <untrusted-material> 并声明为数据；JSON 可去 ```json 围栏、解析失败抛 AGENT_OUTPUT_INVALID；超时/HTTP 错误→DEPENDENCY_UNAVAILABLE；构造不接受凭据 | test/agent.test.js 4 项全过（含“密钥不进 body”） |
| §9 Agent 失败不得绕过审批或直接外发 | 未验证 | src/agent.js 本身无外发能力；调用方在 browse/diary 等模块 | 属模块编排范围，本次未核 | 需 browse/diary 审查确认 |

### §18 错误码

| 条款/FR | 状态 | 代码位置 file:line | 判断依据 | 备注 |
|---|---|---|---|---|
| §18 错误码定义齐全、序列化与不可重试语义 | 已完成（离线） | src/errors.js:6-43,45-119,156-199；src/index.js:720-728 | ERROR_CODES 36 个与 SPEC §18 表格逐项一致；ERROR_HTTP 覆盖全部 36 码；OPERATION_UNKNOWN/RECOVERY_*/MIGRATION_BLOCKED/BACKUP_* 等副作用未知/恢复类 retryable=false；AppError.toJSON 对 details 递归脱敏；HTTP 错误响应使用 toJSON | 错误码 HTTP 用法的入口映射由 entry 审查复核 |

### F08 / F09 闭合判定

| 条款/FR | 状态 | 代码位置 file:line | 判断依据 | 备注 |
|---|---|---|---|---|
| F08（归档无人常规驱动、容量门禁缺失）当前是否闭合 | 已完成（离线） | src/index.js:393-417,465,500-511,536,600；src/store.js:548-562,587-621；src/coordinator.js:96-99；test/entrypoint-reliability.test.js:204-226,228-241 | 运行时 maintenance 每 1s 分批归档（启用功能时）并在关停/HTTP PATCH 后接线；容量统计与 80/100MiB、10000 pending 门禁接入新业务接纳/派发；warning 停调度生成；status 暴露容量；离线测试覆盖门禁、归档与定时器关闭 | 主缺口已闭合；残余 #G6（并发归档误报）、#G5（prune 未接线）、#G10（门禁覆盖不全）、#G12（统计开销） |
| F09（配置更新事务与动态生效）当前是否闭合 | 部分完成 | src/config.js:728-762；src/coordinator.js:45-62；src/index.js:155,247,466,600；src/config.js:743；src/agent.js:13；src/bilibili.js:97 | 文件写先于 revision 事务、检查在事务外；expectedRevision 可选且命令通道不传；scheduler 定时器不因配置开启而创建；Agent/BilibiliClient 持旧 config 对象 | 未闭合；与历史审查 F09 结论一致，修复记录边界也承认“完整配置更新协议”未关闭 |

## 缺口详情

### #G1 [P1] 凭据变化后未重新 whoami，派发前未核对 credentialRevision，可能以旧 accountRef 用新 Cookie 写入

- 设计要求：SPEC §5.2“同一 MID 更新 Cookie、重启或迁机必须沿用原额度、businessKeys 与未决 Operation。凭据变化后重新 whoami，无法核验时平台写入 fail-closed”；“进行中的操作固定其原 accountRef 与凭据版本，不能转用新账号完成”。
- 现状与证据：
  - `CredentialService.verifyAndBind` 只在显式绑定时执行核验（src/credentials.js:136-195）；唯一调用点在 src/index.js:456-463 的 `runtime.bindAccount`（CLI account verify 走这里）。
  - 启动路径只加载凭据、不比对状态（src/index.js:138-152）；写路径 `BilibiliPlatformAdapter._activeAccount` 只检查 activeAccountRef 与 accounts 记录存在（src/adapters/platforms/bilibili.js:51-60）；comments/direct-messages/browse 同类只查记录存在（src/modules/comments.js:38-40；src/modules/direct-messages.js:20-22；src/modules/browse.js:228-231）。
  - 全 src 中 `credentialRevision` 只出现在 src/credentials.js 与状态命令（src/command-service.js:541），派发链路无任何比对；Operation 只记录 accountRef（src/effect-gateway.js:411-428），未记录/校验凭据版本。
  - 客户端在构造时持有凭据快照（src/bilibili.js:97-110），启动加载后不再刷新。
- 影响：把 credentials.json 换成另一个 MID 的 Cookie 并重启（未显式 account verify）后，activeAccountRef 仍是旧 MID，写请求实际以新 MID 发送，而额度/businessKeys/Operation 记在旧 MID 命名空间；违背“无法核验时平台写入 fail-closed”，身份/账本错位。旧测试只覆盖显式 verifyAndBind 路径（test/credentials.test.js:29-97）。
- 建议：派发事务内比对 `account.credentialRevision` 与当前 `credentialRevision(credentials)`，不一致即抛 IDENTITY_UNVERIFIED 并要求先 verifyAndBind；启动时若不一致自动 re-whoami 失败则冻结平台写；Operation 记录 credentialRevision 并在 dispatch 前复核。

### #G2 [P1] 配置更新仍非同一 Store 事务：先写文件、后独立事务写 configRevision，检查在事务外

- 设计要求：SPEC §4.5“配置写入必须采用同目录临时文件 + rename；每次校验成功的写入在同一 Store 事务中把 configRevision.version 单调加一，并以 SHA256(JCS(...)) 更新 configRevision.sha256”；“本机处于迁移封存/退役时不得通过改配置绕过禁写”。
- 现状与证据：src/config.js:728-739 在事务外用 `store.getSnapshot()` 做 expectedRevision/migration.phase/recovery.phase 检查；src/config.js:740-742 先 `atomicWriteJson(paths.configFile, merged)`；src/config.js:745-762 才另开 `store.transaction` 写 revision 与事件。`expectedRevision` 可选（src/config.js:692,730），命令通道 `config.update` 不传（src/command-service.js:390-394）。
- 影响：崩溃在文件写后/revision 提交前会留下“新文件+旧 revision”；两进程并发更新存在丢失更新窗口；迁移/恢复阶段检查与写入之间的 TOCTOU 可被并发迁移利用；与设计“同一事务”明确不符。启动 `syncRevision`（src/config.js:660-690）可部分自愈，但会产生额外版本自增且不改变协议性质。
- 建议：实现可恢复提交协议（事务内登记 intent+CAS，rename 文件，再事务确认）或至少把 CAS/阶段检查放进同一事务并以文件内容 hash 复核；HTTP 强制 expectedRevision，命令通道补齐；失败时回滚/标记 intent。

### #G3 [P1] 配置动态生效不完整：scheduler 定时器、Agent、BilibiliClient 不随配置更新刷新

- 设计要求：SPEC §4.5“各进程在派发时同时核对 version/hash 与当前配置，不能使用旧缓存绕过新禁用项”；F09 要求更新后下一轮生效。
- 现状与证据：Coordinator 仅在 `start()` 时按 config.scheduler.enabled 创建 setInterval（src/coordinator.js:45-62），而 `coordinator.start()` 只在启动时调用一次（src/index.js:466）；HTTP PATCH 后仅调用 `runtime.maintenance?.start()`（src/index.js:600），不会重启 coordinator，因此 scheduler.enabled 由 false→true 后永远没有定时轮次。`AgentClient` 与 `BilibiliClient` 在构造时接收 boot 期 config 对象（src/index.js:155,247；src/agent.js:13；src/bilibili.js:97），`ConfigService.update` 只替换 `this.config`（src/config.js:743），不通知已构造组件；模块层虽走 configService.get()（如 src/modules/comments.js:117,244，direct-messages.js:72），Agent 的 enabled/apiKeyEnv/baseUrl/timeout 与 Client 的 maxLength/rateLimit/requestTimeout 仍读旧值。
- 影响：通过 HTTP PATCH 打开 scheduler 后调度功能不生效（违反“下一轮生效”）；本地配置关闭 agent 后运行中进程仍可能调用模型（旧缓存绕过新禁用项）。
- 建议：config 更新后触发已注册监听器：按 scheduler.enabled 启动/清停 coordinator timer，重建/热更新 AgentClient 与 BilibiliClient（或统一注入 getConfig()）；补测试覆盖“运行中 PATCH 开启 scheduler”和“禁用 agent 后不再调用”。

### #G4 [P2] 派发时未核对 configRevision.version

- 设计要求：SPEC §4.5“各进程在派发时同时核对 version/hash 与当前配置”。
- 现状与证据：src/config.js:766-773 只比较 sha256；src/effect-gateway.js:153-163 调用它。version 未参与判断。
- 影响：hash 相同但 version 不一致（如恢复/迁移写回旧 revision 或外部改写状态）不会被发现；审计层面的版本一致性缺口。
- 建议：assertCurrentState 同时校验 configRevision.version（或明确记录只看 hash 的理由并更新 SPEC 表述）。

### #G5 [P2] store.prune 无任何调用者/测试，500 Task/5000 Operation 清理未接入运行时

- 设计要求：SPEC §6.2“500 个 Task、5000 个 Operation 的普通清理仅适用于已结算记录。任何 isSettled=false Task、其 Operation/审批/执行/请求引用及 unknown 均不得按数量淘汰”。
- 现状与证据：prune 实现正确保护未结算记录（src/store.js:629-684），但 grep 全 src 无调用者（仅 backup 自己的 prune）；无任何测试直接覆盖 store.prune。
- 影响：长期运行已结算热数据永不清理，配合 100MiB 硬门禁最终会停止新业务，缺少设计中的“普通清理”回收路径（首版可不自动删历史事实，但已结算 Task/Operation 属可清理范围）。
- 建议：在 maintenance 周期或 status/backup 收尾时触发 prune（仅 settled），并补“unknown/未决不被清理”的离线测试。

### #G6 [P2] 多进程并发归档会误报 JOURNAL_CORRUPTED

- 设计要求：SPEC §6.3 崩溃凭 eventId 及 (epoch,seq) 去重、不丢未确认 pending；§6.2 同机宿主与 CLI 可调用其排他事务。
- 现状与证据：flush 先 getSnapshot 取 pending（src/event-journal.js:68-74）并写段文件；登记事务里 `segmentEventsFromPending` 在同一区间必须仍存在于 draft.journalPending（src/event-journal.js:82-116,254-266），否则抛 JOURNAL_CORRUPTED。若另一进程/CLI 已归档并删除同区间 pending（CLI 关停也调用 archiveAll，src/index.js:505-511），后到者会因 pending 已清空而误报损坏，尽管已登记段 hash 相同。
- 影响：同机 host+CLI 并发归档时出现假损坏错误、归档失败（fail-closed 不丢数据但会阻断维护并误导审计）。
- 建议：登记事务内若同区间 pending 已被清空且 journalSegments 已存在且 hash 一致，则视为幂等成功；仅在 hash/内容冲突时报 JOURNAL_CORRUPTED。补并发/顺序化复现测试。

### #G7 [P2] Task 字段组合校验未接入生产路径；hasUnknownOperation 从未赋值；succeeded 未计未决审批

- 设计要求：SPEC §10.1 合法字段组合（unknown 固定未结算且不活跃、partial/failed 由未决 Operation/审批/人工事项计算）；§10.2 无未决项才 succeeded。
- 现状与证据：`assertSettledCombination` 有实现（src/task-manager.js:391-409）但全 src 无调用者，只有 test/task-manager.test.js:135-137 直接调用；`validateState`（src/store.js:126-171）不校验 task 组合；`recomputeParent` 读取的 `child.hasUnknownOperation`（src/task-manager.js:252）在全文件从未赋值（recompute 只写 hasDispatchedOperation，src/task-manager.js:240）；recompute 的 succeeded 分支（src/task-manager.js:219-222）不考虑 pendingApprovals，而 partial/failed 分支考虑（229-233）；transition 到 running 时未清空旧 finishedAt（166-169）。
- 影响：模块 bug/外部写入可产生非法组合而不被拒绝；父任务 unknown 聚合少一条判定；succeeded 可能在存在未决审批记录时被标结算；resume 后 Task 带过期 finishedAt。
- 建议：事务提交前（或 validateState）对每个 task 调用 assertSettledCombination；recompute 中给 task 设置 hasUnknownOperation；succeeded 的 isSettled 计入 pendingApprovals；running 时清 finishedAt；补父子未知场景测试。

### #G8 [P2] Task 迁移条件依赖调用方布尔自证

- 设计要求：SPEC §10.1 running→cancelled“仅限已证明全部剩余工作未派发且无副作用；否则转 unknown/partial”；unknown/partial/failed 的恢复需“核查/人工恢复”。
- 现状与证据：src/task-manager.js:130-153 的 provenUndispatched/verified/manual/approved/manualReceipt 均为调用方传入的 options；TaskManager 不核对 state.operations 的 dispatchAt/status，也不核对 approval 的实际状态。
- 影响：上游调用点若传递错误布尔即可绕过迁移条件（如把已派发任务标 cancelled），与“必须证明”的意图存在信任边界缺口。
- 建议：由 TaskManager 依据 tx.state.operations/approvals 自动判定（存在 dispatchAt 即不可 cancelled），仅保留人工事实类标志由人工入口传入并记录 actor/evidence。

### #G9 [P2] 写操作 sessdata 缺失未预校验；requireWrite 无调用者

- 设计要求：SPEC §5.2“写操作必须具备 sessdata 和 bili_jct”。
- 现状与证据：`CredentialService.requireWrite` 已实现（src/credentials.js:120-126）但 grep 全 src 无调用者；bili_jct 由 `_csrf()` 强制（src/bilibili.js:383-386），sessdata 缺失时 `_cookieHeader` 返回 null（src/bilibili.js:112-120），请求会以无 Cookie 形式发出，最终走平台错误/unknown。
- 影响：缺少 SESSDATA 时浪费一次受保护派发机会并产生 failed/unknown 记录，而非在派发前 CREDENTIAL_MISSING fail-closed。
- 建议：写方法入口统一 `credentials.requireWrite()`（或客户端检查 sessdata），并把 requireWrite 接入派发预检。

### #G10 [P2] 100MiB 硬门禁覆盖不完整（本地生成类新业务未统一拦截）

- 设计要求：SPEC §6.3“达到 100MiB 时停止接纳新业务和受保护派发，只允许归档、核查、备份与恢复收尾”。
- 现状与证据：assertBusinessAcceptance 只接在请求接纳的 5 个动作（src/command-service.js:145）、审批续办（src/command-service.js:438）、操作预留/派发（src/effect-gateway.js:438）、browse/production/publisher 的 Task 创建（src/modules/browse.js:22；src/modules/production.js:248；src/modules/publisher.js:248）。HTTP `/run/diary` → command-service 的 diary.generate 不在门禁列表，diary 模块无 assertBusinessAcceptance（grep 无），故硬容量下仍可生成日记并写账本；browse 轮次内的 comment 子任务创建（comments.createDraft）也不直接门禁。
- 影响：容量硬门禁可被本地生成路径部分绕过，账本继续增长，与“只允许维护/收尾”不符（不涉外发，风险低于平台写，故 P2）。
- 建议：把“新业务接纳”统一收敛到 CommandService/模块入口调用同一 capacity gate（允许显式 maintenance 白名单），并为 diary.generate 等本地生成补门禁。

### #G11 [P2] 配置同步的 fail-closed 意图为空实现，存在死代码/误导注释

- 设计要求：SPEC §4.5 各进程不能使用旧缓存绕过新禁用项（对应启动/外部改文件的处理）。
- 现状与证据：src/config.js:669-672 `if (!bootstrap && current.sha256 !== '' && !this.allowForeignRevision) { // 注释说 dispatch must fail-closed ... }` 是空块，不抛错也不告警；`allowForeignRevision` 从未赋值；`ABSOLUTE_OR_EMPTY`（src/config.js:146-156）定义后未被引用；`getRevision()` 的 version fallback 为 1（src/config.js:651-654）。
- 影响：外部改 config 文件后，运行中进程首次 sync 时静默接受并自增 revision（版本语义混乱）；注释使人误以为有校验。
- 建议：删除死代码或在非 bootstrap/非 owner 来源变更时显式告警/拒绝并审计；统一 version 来源。

### #G12 [P2] 容量统计在每个事务内递归扫描 recovery 目录与全部段，开销风险

- 设计要求：SPEC §6.2 事务内不得长时间等待、§6.3 容量可观测。
- 现状与证据：`_transaction` 每次执行 `capacityStatus(state)`（src/store.js:469），capacityStatus 对每个 journalSegment 统计、并递归遍历 recovery 目录（src/store.js:587-621）；已结算业务长跑后段数/证据文件增长，事务延迟随之增长，锁持有时间变长。
- 影响：高频事务（每次读额度预留、每次事件）产生额外 I/O，可能拖慢派发并提高锁超时概率。
- 建议：容量统计加时间/次数节流或缓存（如每分钟/每 N 事务刷新），维护线程做全量扫描。

## 无法确认项

1. **Windows NTFS ACL 实际权限**：credentials.js:62 的 chmod 0o600 在 Windows 无语义，离线测试只断言文件存在并输出诊断（test/credentials.test.js:15-19）；未验证凭据/state 文件的真实 ACL 是否仅属主可读。
2. **Cookie 跨域重定向是否被剥离**：src/bilibili.js:149-155 使用 `redirect:'follow'`，Cookie 为手动设置头；按 fetch 规范跨源重定向应移除敏感头，但本机未做运行时网络验证。若未剥离可能违反 §5.2“Cookie 只发往明确允许的 B 站域名”。
3. **多进程归档并发误报**（#G6）：为静态代码推断，未做多进程故障复现（Windows 沙箱下未做并发进程实验）。
4. **真实 DSH 宿主生命周期/插件 apply/dispose、真实 B 站/IM/External 环境**：均无真实验证，属 T16.2/T12.x 交付缺口，不能由离线测试替代。
5. **PID 复用检测平台差异**：utils.js:452-468 仅在 Linux /proc 判定启动时间；Windows 上活属主锁无法判断复用只能 fail-closed；未做 Windows 多进程真实锁竞争压测（离线测试用同进程两个 JsonStore 实例）。
6. **“锁不得在网络请求/渲染期间持有”全量证明**：仅抽查 effect-gateway dispatch 模式与客户端构造，无法静态证明所有模块（production/publisher/diary 等）的所有事务回调都无网络/长等待。
7. **§6.3 日记读取归档+pending 截止序号快照、§9 Agent 失败不绕过审批、§10.2 单飞/孤儿进程**：消费方在 diary/browse/production/coordinator 模块，属其他审查范围。
8. **§4.4 publishing.external.successJson stdout 回执协议、迁移包不携带秘密值、生产 profile 工具绑定、production.limits 调用限制只收紧**：实现不在本次文件范围（publisher/migration/production/backup 审查）。
9. **§4.4 diary 两个 book 都关时拒绝写日记、§4.4 DM 非空白名单门禁**：执行在 diary/direct-messages 模块，本次未核（仅确认 config 层校验/未强制）。
10. **生产端不接收宿主环境全集/账本写权限**：仅从构造参数侧确认无 credentials，外部进程 env 传递未追。

## 实际运行的定向测试与结果

未运行 `npm test` / `npm run check` / `npm run test:coverage`（约束：Windows 沙箱下测试 runner spawn EPERM，98 处失败不代表代码缺陷）。逐个直接执行 Node 测试文件（进程内运行，均退出码 0）：

| 测试文件 | 通过 | 失败 | 覆盖点 |
|---|---|---|---|
| node test/config.test.js | 9 | 0 | 默认值深比较、0 值、布尔严格、markWatchHistory/timeZone/未知键/强制审批、脱敏、环境覆盖、路径、配置更新 revision+HTTP 禁止项 |
| node test/credentials.test.js | 4 | 0 | 原子保存、同 MID 换 Cookie 保留 devId、不同 MID 需显式切换、dedeuserid 不匹配、缺写凭据 |
| node test/store.test.js | 8 | 0 | v3 bootstrap、损坏/缺失 fail-closed、回滚、锁竞争、死属主 stale 锁、appendEvent 事务限制、64KiB、旧版本拒绝、afterCommit 失败不污染 |
| node test/event-journal.test.js | 4 | 0 | 2500 事件归档+可读、段篡改/缺失 fail-closed、崩溃保留 pending、epoch 隔离 |
| node test/task-manager.test.js | 6 | 0 | 白名单拒绝、unknown 未结算、waiting/awaiting 组合、resume、父聚合 unknown、组合矩阵 |
| node test/agent.test.js | 4 | 0 | 禁用零网络、缺 Key、不可信素材、JSON 围栏/解析失败、HTTP 错误、Key 不进 body |
| node test/identity.test.js | 3 | 0 | IM 绑定/撤销、scope 默认拒绝、binding 不授予 owner 权限 |
| node test/history-epoch.test.js | 1 | 0 | 新 epoch 复用 seq 不覆盖旧归档 |
| node test/contracts.test.js | 5 | 0 | JCS 金标准、requestKey/inputHash、未知动作/字段拒绝、recovery scope |
| node test/integration.test.js | 2 | 0 | 浏览→评论审批→发送→日记全链路、幂等/账本一致性 |
| node test/entrypoint-reliability.test.js | 11 | 0 | 含容量门禁/归档维护定时器（F08）、审批续办、IM 同事务落账、轮次互斥等 |
| 合计 | 57 | 0 | 0 cancelled、0 skipped（credentials 中 Windows 0600 仅为 t.diagnostic，不计 skip） |

另：追加运行了 `node test/entrypoint-reliability.test.js`（26.2s）与 `node test/integration.test.js`（3.1s）作为 F08/§4.6 的离线佐证；其测试使用临时目录与 Mock 平台/宿主，不代表真实外部服务验收。
