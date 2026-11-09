# 当前实现与设计符合性审查

> 本文是修复前审查快照。用户随后指定的第 1～4 项修复及 Windows 测试结果见 [第一批修复记录](IMPLEMENTATION_FIXES_2026-11-09.md)，请勿将本文原计数作为修复后的完成状态。

审查日期：2026-11-09（Asia/Shanghai）。基线：工作区当前代码、DESIGN/SPEC 0.2.1-draft、TASKS §10；历史 report 文档用于追溯，不作为当前完成证明。本次未修改业务代码，未执行真实平台、IM 或 External 外发。

## 结论与口径

项目已经有较完整的核心、业务模块及离线测试，**尚未完成用户入口到业务执行的端到端交付**。主要短板不仅是真实环境未验收，还包括审批回流、通知派发、调度互斥、按账号浏览去重、日记自动触发、归档和容量门禁。

“已完成（离线）”表示对应模块已有实现且本轮相关离线测试支持，未发现直接反例；不表示所有边界均已证明或真实服务验收通过。“部分完成”包括实现存在但接线、平台场景或必要验收不完整。“与设计不一致”有明确代码反例。“未实现”包括尚未开展的明确验收交付项，不能误解为整个模块没有代码。

附录按 SPEC 中 **78 条唯一 FR** 逐项列出原始要求、状态、代码、测试与依据：已完成（离线） 55 条；与设计不一致 4 条；部分完成 18 条；未实现 1 条。这些是等权需求条目统计，且不包含所有无 FR 编号条款；不能据此声称项目完成率或生产可用率。整体判断为：**主体代码已落地，离线能力较完整，集成与运行闭环仍有实质缺口，未达到 SPEC §19.4 的完整交付门槛。**

## 本轮验证

- Windows，Node.js v24.18.0；满足 Node >=22，但未验证最低版本 Node 22。
- npm run check：91 个文件语法检查通过。
- npm test：改用工作区隔离 TEMP/TMP 后，215 项、211 通过、4 失败、0 skip。通过比例 98.1% 是测试通过率，**不是功能完成度**。
- 失败 1/2：artifact-store 与 migration-paths 的符号链接创建 EPERM；测试在构造 fixture 时失败，未证明实现拒绝链接失效，也不能算场景通过。
- 失败 3：config.test 的预期写死 /tmp/example-data/state.json，Windows 实际为 D:\\tmp\\example-data\\state.json。
- 失败 4：credentials.test 预期 POSIX 0600，Windows 实际 mode 为 0666。代码确有 atomic write 与 chmod 尝试，符合 §5.2 “尝试最小权限”的字面要求；本测试不可移植，NTFS ACL 是否满足隔离未验证，不能据此直接断言凭据已泄漏。
- 首次默认沙箱 TEMP 执行大量 rename EPERM；已通过换工作区临时目录排除该主要环境阻碍。复测 4 项仍如上。
- 三个最小定向探针：同类浏览同时启动 2 次；外层 dry 生产请求把内层 go 原样传给模块；审批通过后 production.run 调用次数为 0。探针只使用替身，不执行副作用。
- 未重新跑 coverage；TASKS §10.2 的 79.41%/62.77%/72.12% 是历史记录。本机 PATH 未找到 ffmpeg/ffprobe，本次未执行真实媒体验收。TASKS 记录的历史媒体结果保留为历史证据。

测试日志：[.audit-tmp/tests.log](D:/Workespace/xiaofeiyu/.audit-tmp/tests.log)；定向探针：[.audit-tmp/probe.mjs](D:/Workespace/xiaofeiyu/.audit-tmp/probe.mjs)。

## 功能模块核对（含无 FR 编号条款）

| 功能 / 设计要求 | 状态 | 代码与判断依据 |
|---|---|---|
| Node ESM 包、CLI、Cordis 声明（§3） | 部分完成 | [package.json](D:/Workespace/xiaofeiyu/package.json)、[cordis.patch.yml](D:/Workespace/xiaofeiyu/cordis.patch.yml)、[src/index.js:736](D:/Workespace/xiaofeiyu/src/index.js:736)；包结构存在；真实宿主未验证，挂载 enabled/lifecycle 见 F10。 |
| 配置默认值、校验、脱敏与干跑（§4） | 部分完成 | [src/config.js:614](D:/Workespace/xiaofeiyu/src/config.js:614)、[src/contracts.js:160](D:/Workespace/xiaofeiyu/src/contracts.js:160)；严格字段和安全默认值有测试；更新跨文件事务、动态生效及 mode 传递见 F03/F09。 |
| 凭据、稳定账号、Cookie 隔离（§5） | 已完成（离线） | [src/credentials.js](D:/Workespace/xiaofeiyu/src/credentials.js)、[src/bilibili.js](D:/Workespace/xiaofeiyu/src/bilibili.js)；credentials/identity/bilibili 测试支持，Windows 权限断言另列。 |
| v3 Store、锁、永久键、损坏拒绝（§6） | 部分完成 | [src/store.js:447](D:/Workespace/xiaofeiyu/src/store.js:447)、[src/event-journal.js](D:/Workespace/xiaofeiyu/src/event-journal.js)；事务/损坏/归档恢复有测试；跨模块原子性及容量/归档调度见 F06/F08。 |
| 额度、Operation、unknown、统一派发栅栏（§7） | 已完成（离线主体） | [src/rate-limiter.js](D:/Workespace/xiaofeiyu/src/rate-limiter.js)、[src/effect-gateway.js:430](D:/Workespace/xiaofeiyu/src/effect-gateway.js:430)；effect-gateway/rate-limiter/recovery-gates 测试支持；不等于容量条款已覆盖。 |
| B站 WBI/读取/评论/DM 协议（§8） | 部分完成 | [src/bilibili.js](D:/Workespace/xiaofeiyu/src/bilibili.js)、[src/adapters/platforms/bilibili.js](D:/Workespace/xiaofeiyu/src/adapters/platforms/bilibili.js)；Mock 协议覆盖，真实接口/账号回执未验收。 |
| 可选 Agent（§9） | 已完成（离线主体） | [src/agent.js](D:/Workespace/xiaofeiyu/src/agent.js)；环境 Key、不可信素材、JSON 解析、失败拒绝有 agent.test；配置缓存更新见 F09。 |
| Task 状态、结算、执行分离（§10） | 已完成（离线主体） | [src/task-manager.js](D:/Workespace/xiaofeiyu/src/task-manager.js)；task-manager/execution-recovery 测试；审批入口完成不代表任务实际执行。 |
| Browse（§11） | 部分完成 / 不一致 | [src/modules/browse.js:96](D:/Workespace/xiaofeiyu/src/modules/browse.js:96)；评分/只读/失败隔离存在；按账号去重与入口后置处理见 F04/F05。 |
| 评论（§12） | 部分完成 | [src/modules/comments.js](D:/Workespace/xiaofeiyu/src/modules/comments.js)；模块的草稿/auto/审批/防重/unknown 测试通过；HTTP/IM 批准后发送未接线，CLI 评论分支已接线。 |
| 白名单 DM（§13） | 已完成（离线） | [src/modules/direct-messages.js](D:/Workespace/xiaofeiyu/src/modules/direct-messages.js)；白名单、互关、自发/批量拒绝、额度和 resume 有测试；真实发送未验收。 |
| 公共/私人日记（§14） | 部分完成 | [src/modules/diary.js:348](D:/Workespace/xiaofeiyu/src/modules/diary.js:348)；归档投影/ACL/双阶段提交/父 epoch 有测试；afterBrowse、resolve 后自动更新与双账本调度缺口见 F07。 |
| Manual / External 投稿（§15） | 部分完成 | [src/modules/publisher.js:335](D:/Workespace/xiaofeiyu/src/modules/publisher.js:335)；Bundle、补录与 External unknown 有测试；用户入口批准后 prepare 未接线，真实发布器未验收。 |
| Coordinator（§16） | 与设计不一致 | [src/coordinator.js:148](D:/Workespace/xiaofeiyu/src/coordinator.js:148)；互斥、partial 聚合、手动入口一致性见 F04，运行开关见 F09。 |
| HTTP / 工具 / CLI（§17） | 部分完成 | [src/index.js:522](D:/Workespace/xiaofeiyu/src/index.js:522)、[src/command-service.js:217](D:/Workespace/xiaofeiyu/src/command-service.js:217)、[cli.mjs:272](D:/Workespace/xiaofeiyu/cli.mjs:272)；接口与权限有测试，但审批回流和 mode 贯通缺口是可用性问题。 |
| 错误码/脱敏（§18） | 已完成（离线） | [src/errors.js](D:/Workespace/xiaofeiyu/src/errors.js)、[test/safety-matrix.test.js](D:/Workespace/xiaofeiyu/test/safety-matrix.test.js)；映射与递归脱敏测试通过。 |
| 公共契约/请求幂等（§21） | 部分完成 | [src/contracts.js:65](D:/Workespace/xiaofeiyu/src/contracts.js:65)、[src/command-service.js:101](D:/Workespace/xiaofeiyu/src/command-service.js:101)；JCS/同键冲突支持；跨事务 pending 恢复见 F06。 |
| 身份、审批与 IM（§22） | 部分完成 | [src/identity.js](D:/Workespace/xiaofeiyu/src/identity.js)、[src/approval.js](D:/Workespace/xiaofeiyu/src/approval.js)、[src/adapters/channels/dsh-im.js:266](D:/Workespace/xiaofeiyu/src/adapters/channels/dsh-im.js:266)；契约有实现，自动通知/原子 outbox/真实宿主闭环未完成。 |
| Artifact（§23） | 部分完成 | [src/artifact-store.js](D:/Workespace/xiaofeiyu/src/artifact-store.js)；不可变对象、摘要、ACL、pending 恢复通过；两个链接/路径组合测试受环境阻断。 |
| 固定阶段生产/Runner（§24） | 部分完成 | [src/modules/production.js](D:/Workespace/xiaofeiyu/src/modules/production.js)、[src/adapters/execution/local.js](D:/Workespace/xiaofeiyu/src/adapters/execution/local.js)、[src/production/profiles/local-slideshow.js](D:/Workespace/xiaofeiyu/src/production/profiles/local-slideshow.js)；真实工具执行代码存在，当前用户入口有 F01/F03，本次真实媒体未复验。 |
| 停机迁移（§25） | 部分完成 | [src/migration.js](D:/Workespace/xiaofeiyu/src/migration.js)；双目录、源退役、目标暂停、逆向回滚与断电测试支持；真实跨 OS 与运行生命周期仍待验证。 |
| 轻量加载/长期容量（§26） | 部分完成 | [src/index.js](D:/Workespace/xiaofeiyu/src/index.js)、[src/command-service.js:420](D:/Workespace/xiaofeiyu/src/command-service.js:420)；零网络/零 spawn 测试通过，但静态加载可选模块、容量报告不足，见 F08/F10。 |
| 分层备份/定时复查（§27.1～3） | 部分完成 | [src/backup-recovery.js:417](D:/Workespace/xiaofeiyu/src/backup-recovery.js:417)；cut、ledger/full、保留和调度有测试；多进程索引、独立介质及时间目标未闭环。 |
| 只读灾备/证据/分 scope 解冻（§27.4～8） | 部分完成 | [src/backup-recovery.js:1453](D:/Workespace/xiaofeiyu/src/backup-recovery.js:1453)；新 epoch、hold、核查、授权断电续办离线通过；真实故障域/隔离证据与 SLA 未验收。 |
| 测试与交付签署（T11～T13/T19/T22） | 部分完成 | 自动测试 211/215；原记录仍保留外部 BLOCKED；本报告不代替真实验收或全量安全审计签署。 |
| 事实/偏好/经验记忆（TASKS §9） | 未实现，待批准规划 | 未发现 memory 条目、TTL、撤回链、memoryCoverage 或检索模块；这是 GATE-MEM 规划项，不计入当前 78 条 FR 的缺口。 |

## 与设计不一致的具体问题

### F01 — P1：审批通过后缺少原任务执行回流

设计：SPEC §15.1、§17.1、FR-IM-004、FR-PRO-003，审批绑定原 Task 后回流执行。

证据：[src/command-service.js:310](D:/Workespace/xiaofeiyu/src/command-service.js:310) 的 approval.decide 仅返回 ApprovalService.decide；[src/approval.js:146](D:/Workespace/xiaofeiyu/src/approval.js:146) 只改变任务为 running，没有调用 comments.send / production.run / publisher.prepare。[cli.mjs:272](D:/Workespace/xiaofeiyu/cli.mjs:272) 仅对 comment 执行 send，production/publish 无对应分支；CLI task resume 也只支持 production/comment/dm，production.resume 拒绝 running 状态并只签发新挑战。因此生产/发布从已暴露命令创建、批准后不能完成实际执行；HTTP/IM 评论也停在批准状态。单元测试直接调用模块 run/prepare，掩盖了入口缺口。定向探针确认统一审批没有调用生产执行。

建议：统一受信审批续办入口，重检权限、mode、配置、hold 和保护点后，按原 Task kind 派发；对重复批准保持幂等，不重复执行。补 CLI/HTTP/IM 入口级链路测试。

### F02 — P1：通知仅入队，无常规派发和后续状态回信

设计：FR-IM-005/008，可靠 outbox 与任务状态回信。

证据：[src/adapters/channels/dsh-im.js:377](D:/Workespace/xiaofeiyu/src/adapters/channels/dsh-im.js:377) 在 ingest 完成后创建通知，dispatchOutbox 仅定义于 436 行；src 中无调用者，测试显式手动调用。runtime.start 没有 outbox 泵，任务后续完成/失败也没有统一通知挂钩。故 Mock 的单次手工发送不能证明启动插件就能自动回信。

建议：在受控生命周期内驱动 pending 通知；unknown 保持核查而非重发；所有可通知任务变更统一生成 outbox。

### F03 — P1：生产请求外层干跑模式未传入模块

设计：SPEC §4.6、FR-PRO-003、FR-IM-003，显式 dry 是安全否决项。

证据：[src/command-service.js:289](D:/Workespace/xiaofeiyu/src/command-service.js:289) production.create 调用 production.create(request.input, principal)，未合并 request.mode。[src/modules/production.js:158](D:/Workespace/xiaofeiyu/src/modules/production.js:158) 使用 input.mode；IM 只检查 command.mode。因此外层 dry、内层 go 会按 go 创建审批任务，未传内层 mode 又会拒绝原本合法的统一 envelope。探针得到 outer=dry、模块 received=go。**没有证明立即绕过人类审批执行**，但干跑/入口契约确实冲突。

建议：只保留一处权威 mode/requestId，合并前拒绝冲突；核查 HTTP 的默认 mode 和生产输入 schema。

### F04 — P1：轮次互斥与统一浏览后置处理未实现完整

设计：SPEC §16，同类执行不能重入、候选交给后置模块、后置失败以 partial/未决集合呈现。

证据：[src/coordinator.js:149](D:/Workespace/xiaofeiyu/src/coordinator.js:149) 检查 active.has('browse')，167 行存入的是 Promise；diary 同样如此。探针并发两次均启动。[src/command-service.js:217](D:/Workespace/xiaofeiyu/src/command-service.js:217) 直接 browse.createTask/run，CLI/HTTP/工具手动浏览不经过 _consumeCandidates。Coordinator 把后置错误收进 skipped，却返回原 browse 的 succeeded Task，没有升级为规范要求的聚合 partial。

建议：按 kind 原子占位并在 finally 释放；统一手动与自动编排入口，调用 mode 贯通后置步骤；明确父 Task 的聚合结算。

### F05 — P2：浏览历史没有按稳定账号隔离

设计：FR-BRO-002/003、SPEC §5.2，账号切换使用独立命名空间。

证据：[src/modules/browse.js:96](D:/Workespace/xiaofeiyu/src/modules/browse.js:96) 与 163/174 行读取/写入 videos 的键为 bilibili:BV。A 账号 processedAt/lastFailureAt 会让 B 账号跳过或冷却同一视频。对比评论业务键包含 accountId，浏览没有。冷却虽可构造注入，但 createRuntime 未暴露该设置。

建议：键包含稳定 accountId；明确旧历史的兼容处理；补同 BV 两 MID 的测试。

### F06 — P1：请求、Task、事件与 outbox 没有同事务提交

设计：SPEC §6.2、FR-EXT-002、FR-IM-005 明确要求同一事务。

证据：[src/command-service.js:116](D:/Workespace/xiaofeiyu/src/command-service.js:116) 先登记 pending 请求，后 _dispatch 在模块内部创建 Task，再单独事务补 taskId/result；[src/adapters/channels/dsh-im.js:331](D:/Workespace/xiaofeiyu/src/adapters/channels/dsh-im.js:331) inbox、命令执行、通知又分成事务。中途崩溃可留下永久 pending、Task 已存在但请求没有 taskId、或任务已落账却没有通知；启动恢复没有请求 pending 的对应续办机制。

建议：同事务完成命令接纳与 Task/outbox 初始绑定；耗时执行放事务外；为必要多阶段流程建立可恢复的持久意图与幂等补偿。

### F07 — P2：日记自动更新配置未接线

设计：SPEC §14、默认 diary.afterBrowse=true、DESIGN D-09。

证据：全 src 中 afterBrowse 仅出现在 config 字段/白名单；Coordinator 浏览结束不生成日记。Operation resolve 未见跨日脏日期标记/自动重建调度。[src/coordinator.js:132](D:/Workespace/xiaofeiyu/src/coordinator.js:132) 每日生成只在 public/private 中二选一；两个 book 都开时只生成 public。生成失败仍更新 diaryLastDate，导致当日不再自动重试。

建议：浏览结束与核查事件登记待重建身份/日期；分别处理两个 book；只在成功后推进成功游标，并设置失败冷却。

### F08 — P1：归档无人常规驱动，容量硬门禁缺失

设计：SPEC §6.3、FR-LITE-003，10000 pending 保护；80MiB 预警停非必要生成，100MiB 停新业务和受保护派发，报告容量。

证据：[src/event-journal.js:67](D:/Workespace/xiaofeiyu/src/event-journal.js:67) 有 flush/archiveAll，但 runtime 仅 close 时 flush 一批，migration export 时 archiveAll；常驻调度没有定期归档。[src/store.js:516](D:/Workespace/xiaofeiyu/src/store.js:516) 只检查 pending 数；stateSizeBytes 有方法却没有调用者。未发现 80/100MiB 门禁或状态容量指标。长期运行即使归档磁盘正常，也可能因未驱动归档达到 pending 阈值而阻断新工作。

建议：运行时受控分批归档与关停收尾；接入容量计量、预警及派发/接纳硬限制；保留回执、备份、核查和恢复通道。

### F09 — P2：配置更新的事务与下一轮生效不完整

设计：SPEC §4.5、§16，配置与 revision 一致、失败不提交、下一轮生效。

证据：[src/config.js:689](D:/Workespace/xiaofeiyu/src/config.js:689) expectedRevision 和阶段检查在事务外，配置文件 rename 后才另开 Store 事务写 revision；并发更新/迁移之间有窗口。[src/coordinator.js:42](D:/Workespace/xiaofeiyu/src/coordinator.js:42) 只在 start 创建 timer，初始 scheduler=false 后 PATCH true 不会启动。Agent/BilibiliClient 保存构造时 config 对象，ConfigService.update 替换对象不会更新它们。网关旧 hash 拒绝可阻止部分陈旧外发，但不等于动态配置完整生效。

建议：配置更新用可恢复提交协议与事务内 CAS；统一配置读取/变更通知，按生命周期刷新 timer 和客户端。

### F10 — P2：DSH 挂载与按需加载偏离声明

设计：SPEC §3.2/3.3，入口消费 enabled、停止注销全部资源、可选适配器动态加载。

证据：[src/index.js:736](D:/Workespace/xiaofeiyu/src/index.js:736) apply 未检查挂载 enabled；仅 dataDir 或 schemaVersion=1 配置存在才创建 runtime。生命周期回调仅 runtime.close，而注销路由/工具在返回对象的 dispose 中；runtime.close 未停止 imBridge，runtime.stop 才停止 IM。是否由真实宿主调用 dispose 尚未验证。index 顶层静态导入平台/IM/生产模块；registry 的 lazy factory 未成为这些模块的加载边界。当前确无重 SDK，默认零网络/零 spawn 测试通过，所以是边界/接线问题，不宣称存在实际重依赖下载。

建议：实测宿主 schema，并统一 close/dispose 资源释放；明确 mount enabled 的入口行为，真正使用惰性工厂加载可选模块。

### F11 — P2：备份索引锁仅覆盖同一对象

设计：SPEC §6.2、§27.2/3，同机宿主与 CLI 可并行，保留/校验/恢复点状态必须一致。

证据：[src/backup-recovery.js:338](D:/Workespace/xiaofeiyu/src/backup-recovery.js:338) _withIndexLock 仅用对象内 Promise；多个 BackupService 或独立进程不共享锁。create/verify/prune 等对共同 index 的 read-modify-write 可能互相覆盖。现有实施记录只声明进程内串行化。本次为静态风险判断，尚未做多进程故障复现。

建议：备份库级文件锁/CAS，并在删除前复核索引版本和完整引用；补 CLI 与调度器并发测试。

## 明确未实现及不计入本期欠交的边界

- 待验收：T16.2/T12.1 真实 DSH/IM；T12.2 真实 B站评论/DM/External；T12.3 真实 Windows/Linux 迁移；T22 独立故障域、物理介质、实际 RPO/RTO。它们是交付缺口，不能以 Mock 替代。
- 记忆规划未实现：TASKS §9 的事实/偏好/经验、TTL、撤回链、恢复不复活、检索隔离与容量指标。需先完成 GATE-MEM；不应为提高现行交付率提前扩范围。
- 按设计不做：X/抖音生产适配器、remote 常驻执行、B站收件箱监听/自动回复、原生 UPOS、通用视频编辑器、双端自动接管。代码明确拒绝这些能力是符合设计，不算缺陷。
- 商业文案/生图/TTS 为可选契约；当前付费文本有注入替身与预算测试，真实商业服务未接入不等于本期本地素材生产未实现。
- 文档状态不同步：DESIGN/SPEC 引言及旧 report 仍描述“未实施”，TASKS §10 已记实施；建议保留历史证据，新增当前状态表与本次验证日期，不覆盖历史验收数据。

## 建议优先顺序

1. **P1，先修可用与安全契约**：F03 mode 一致性；F06 原子接纳/崩溃续办；F01 审批回流；F02 outbox 派发；F04 互斥；F08 归档与容量。补入口测试及故障注入，避免仅测试内部方法。
2. **P2，补运行一致性**：F05 账号隔离、F07 日记调度、F09 配置提交/动态生效、F10 宿主关闭、F11 多进程备份索引。修 Windows 测试路径和权限口径，在具备链接权限的环境补跑链接场景。
3. **再做真实环境验收**：先配置并验证独立恢复点；本地媒体真实输出与 TTY/宿主人类证明；再分别验收宿主、IM、B站、External、跨 OS 与灾备时间目标。需实际环境及明确外部操作授权。
4. **最后更新交付状态**：以当前测试/验收证据更新 TASKS，不以文件存在、accepted、Bundle 或 Mock 成功替代完成。记忆扩展另行排期。

## 附录：78 条 FR 逐项矩阵

以下完整保留每条 FR 的要求文本；同章节中未编号的强制条款另见上面的模块表与 F01～F11。相关测试文件链接是证据入口，不表示文件内每个断言独立证明整条长需求。

| 需求 / 设计要求 | 状态 | 代码 / 测试 | 判断依据 |
|---|---|---|---|
| [doc/SPEC.md:677](D:/Workespace/xiaofeiyu/doc/SPEC.md:677) **FR-BRO-001**：自动模式仅在 `browse.enabled=true` 且 scheduler 启用时运行。 | 已完成（离线） | [src/modules/browse.js](D:/Workespace/xiaofeiyu/src/modules/browse.js)；[test/browse.test.js](D:/Workespace/xiaofeiyu/test/browse.test.js) | 去重、字幕门槛、评分、失败隔离及只读行为有实现与测试。 |
| [doc/SPEC.md:678](D:/Workespace/xiaofeiyu/doc/SPEC.md:678) **FR-BRO-002**：候选按账号和 BV 去重，多来源同一 BV 只处理一次。 | 与设计不一致 | [src/modules/browse.js](D:/Workespace/xiaofeiyu/src/modules/browse.js)；[test/browse.test.js](D:/Workespace/xiaofeiyu/test/browse.test.js) | F05：持久视频键只有 platform/BV，没有 accountId。 |
| [doc/SPEC.md:679](D:/Workespace/xiaofeiyu/doc/SPEC.md:679) **FR-BRO-003**：已成功处理或核验为稳定账号自有内容的视频不得在每轮重复处理；自有内容直接过滤且不产生待互动候选，失败记录采用可配置冷却，不得立即死循环。 | 部分完成 | [src/modules/browse.js](D:/Workespace/xiaofeiyu/src/modules/browse.js)；[test/browse.test.js](D:/Workespace/xiaofeiyu/test/browse.test.js) | F05：已处理/失败冷却存在，但跨账号共享；失败冷却仅构造参数，运行配置未接入。 |
| [doc/SPEC.md:680](D:/Workespace/xiaofeiyu/doc/SPEC.md:680) **FR-BRO-004**：详情读取失败不计为“已看懂”；无字幕且未配置替代内容时必须按配置跳过。 | 已完成（离线） | [src/modules/browse.js](D:/Workespace/xiaofeiyu/src/modules/browse.js)；[test/browse.test.js](D:/Workespace/xiaofeiyu/test/browse.test.js) | 去重、字幕门槛、评分、失败隔离及只读行为有实现与测试。 |
| [doc/SPEC.md:681](D:/Workespace/xiaofeiyu/doc/SPEC.md:681) **FR-BRO-005**：单视频失败不得终止整轮；结果必须列出失败项。 | 已完成（离线） | [src/modules/browse.js](D:/Workespace/xiaofeiyu/src/modules/browse.js)；[test/browse.test.js](D:/Workespace/xiaofeiyu/test/browse.test.js) | 去重、字幕门槛、评分、失败隔离及只读行为有实现与测试。 |
| [doc/SPEC.md:682](D:/Workespace/xiaofeiyu/doc/SPEC.md:682) **FR-BRO-006**：确定性评分至少考虑关键词、时长、字幕充分度和来源；不得仅以播放量判断质量。 | 已完成（离线） | [src/modules/browse.js](D:/Workespace/xiaofeiyu/src/modules/browse.js)；[test/browse.test.js](D:/Workespace/xiaofeiyu/test/browse.test.js) | 去重、字幕门槛、评分、失败隔离及只读行为有实现与测试。 |
| [doc/SPEC.md:683](D:/Workespace/xiaofeiyu/doc/SPEC.md:683) **FR-BRO-007**：Browse 不得直接评论或私信，只输出 Candidate 和事件；评论/DM 在生成任何待审批草稿前还必须按已核验 accountRef 排除作者为自身的 Candidate，禁止自我评论或向自己分享。 | 已完成（离线） | [src/modules/browse.js](D:/Workespace/xiaofeiyu/src/modules/browse.js)；[test/browse.test.js](D:/Workespace/xiaofeiyu/test/browse.test.js) | 去重、字幕门槛、评分、失败隔离及只读行为有实现与测试。 |
| [doc/SPEC.md:684](D:/Workespace/xiaofeiyu/doc/SPEC.md:684) **FR-BRO-008**：默认不伪报播放进度；`markWatchHistory` 未实现真实播放前保持关闭。 | 已完成（离线） | [src/modules/browse.js](D:/Workespace/xiaofeiyu/src/modules/browse.js)；[test/browse.test.js](D:/Workespace/xiaofeiyu/test/browse.test.js) | 去重、字幕门槛、评分、失败隔离及只读行为有实现与测试。 |
| [doc/SPEC.md:702](D:/Workespace/xiaofeiyu/doc/SPEC.md:702) **FR-COM-001**：`comments.enabled=false` 时不得自动评论。 | 已完成（离线） | [src/modules/comments.js](D:/Workespace/xiaofeiyu/src/modules/comments.js)；[test/comments.test.js](D:/Workespace/xiaofeiyu/test/comments.test.js) | 草稿、审批、auto、正文/目标防重、额度及 unknown 保护有实现与测试；真实平台未验收。 |
| [doc/SPEC.md:703](D:/Workespace/xiaofeiyu/doc/SPEC.md:703) **FR-COM-002**：`approval` 模式只生成草稿，状态 `waiting_approval`；批准必须记录操作者/来源。 | 已完成（离线） | [src/modules/comments.js](D:/Workespace/xiaofeiyu/src/modules/comments.js)；[test/comments.test.js](D:/Workespace/xiaofeiyu/test/comments.test.js) | 草稿、审批、auto、正文/目标防重、额度及 unknown 保护有实现与测试；真实平台未验收。 |
| [doc/SPEC.md:704](D:/Workespace/xiaofeiyu/doc/SPEC.md:704) **FR-COM-003**：`auto` 模式才可由 Coordinator 自动发送。 | 已完成（离线） | [src/modules/comments.js](D:/Workespace/xiaofeiyu/src/modules/comments.js)；[test/comments.test.js](D:/Workespace/xiaofeiyu/test/comments.test.js) | 草稿、审批、auto、正文/目标防重、额度及 unknown 保护有实现与测试；真实平台未验收。 |
| [doc/SPEC.md:705](D:/Workespace/xiaofeiyu/doc/SPEC.md:705) **FR-COM-004**：无 Agent 且 `allowTemplate=false` 时，不得自动生成模板评论。 | 已完成（离线） | [src/modules/comments.js](D:/Workespace/xiaofeiyu/src/modules/comments.js)；[test/comments.test.js](D:/Workespace/xiaofeiyu/test/comments.test.js) | 草稿、审批、auto、正文/目标防重、额度及 unknown 保护有实现与测试；真实平台未验收。 |
| [doc/SPEC.md:706](D:/Workespace/xiaofeiyu/doc/SPEC.md:706) **FR-COM-005**：每条评论独立检查 `dailyLimit/perRound/sameVideoDays/maxLength`。 | 已完成（离线） | [src/modules/comments.js](D:/Workespace/xiaofeiyu/src/modules/comments.js)；[test/comments.test.js](D:/Workespace/xiaofeiyu/test/comments.test.js) | 草稿、审批、auto、正文/目标防重、额度及 unknown 保护有实现与测试；真实平台未验收。 |
| [doc/SPEC.md:707](D:/Workespace/xiaofeiyu/doc/SPEC.md:707) **FR-COM-006**：同 BV 同渠道在冷却期内不得重复，即使正文不同。 | 已完成（离线） | [src/modules/comments.js](D:/Workespace/xiaofeiyu/src/modules/comments.js)；[test/comments.test.js](D:/Workespace/xiaofeiyu/test/comments.test.js) | 草稿、审批、auto、正文/目标防重、额度及 unknown 保护有实现与测试；真实平台未验收。 |
| [doc/SPEC.md:708](D:/Workespace/xiaofeiyu/doc/SPEC.md:708) **FR-COM-007**：相同规范化正文不得用于不同视频进行批量灌水。 | 已完成（离线） | [src/modules/comments.js](D:/Workespace/xiaofeiyu/src/modules/comments.js)；[test/comments.test.js](D:/Workespace/xiaofeiyu/test/comments.test.js) | 草稿、审批、auto、正文/目标防重、额度及 unknown 保护有实现与测试；真实平台未验收。 |
| [doc/SPEC.md:709](D:/Workespace/xiaofeiyu/doc/SPEC.md:709) **FR-COM-008**：`mentionOwner=true` 时必须配置 owner.name，且最多 @ 一次。 | 已完成（离线） | [src/modules/comments.js](D:/Workespace/xiaofeiyu/src/modules/comments.js)；[test/comments.test.js](D:/Workespace/xiaofeiyu/test/comments.test.js) | 草稿、审批、auto、正文/目标防重、额度及 unknown 保护有实现与测试；真实平台未验收。 |
| [doc/SPEC.md:710](D:/Workespace/xiaofeiyu/doc/SPEC.md:710) **FR-COM-009**：干跑只预检和返回草稿，不创建已发送记录。 | 已完成（离线） | [src/modules/comments.js](D:/Workespace/xiaofeiyu/src/modules/comments.js)；[test/comments.test.js](D:/Workespace/xiaofeiyu/test/comments.test.js) | 草稿、审批、auto、正文/目标防重、额度及 unknown 保护有实现与测试；真实平台未验收。 |
| [doc/SPEC.md:711](D:/Workespace/xiaofeiyu/doc/SPEC.md:711) **FR-COM-010**：网络结果未知必须保留 Operation，不得自动重发。 | 已完成（离线） | [src/modules/comments.js](D:/Workespace/xiaofeiyu/src/modules/comments.js)；[test/comments.test.js](D:/Workespace/xiaofeiyu/test/comments.test.js) | 草稿、审批、auto、正文/目标防重、额度及 unknown 保护有实现与测试；真实平台未验收。 |
| [doc/SPEC.md:717](D:/Workespace/xiaofeiyu/doc/SPEC.md:717) **FR-DM-001**：实际发送时收件人必须在白名单中。 | 已完成（离线） | [src/modules/direct-messages.js](D:/Workespace/xiaofeiyu/src/modules/direct-messages.js)；[test/direct-messages.test.js](D:/Workespace/xiaofeiyu/test/direct-messages.test.js) | 白名单、互关、自发拒绝、独立业务键、额度与摘要记录有实现及 Mock 测试。 |
| [doc/SPEC.md:718](D:/Workespace/xiaofeiyu/doc/SPEC.md:718) **FR-DM-002**：默认检查互关；显式关闭互关检查也必须保留白名单。 | 已完成（离线） | [src/modules/direct-messages.js](D:/Workespace/xiaofeiyu/src/modules/direct-messages.js)；[test/direct-messages.test.js](D:/Workespace/xiaofeiyu/test/direct-messages.test.js) | 白名单、互关、自发拒绝、独立业务键、额度与摘要记录有实现及 Mock 测试。 |
| [doc/SPEC.md:719](D:/Workespace/xiaofeiyu/doc/SPEC.md:719) **FR-DM-003**：不得向 Cookie 对应账号自身发送。 | 已完成（离线） | [src/modules/direct-messages.js](D:/Workespace/xiaofeiyu/src/modules/direct-messages.js)；[test/direct-messages.test.js](D:/Workespace/xiaofeiyu/test/direct-messages.test.js) | 白名单、互关、自发拒绝、独立业务键、额度与摘要记录有实现及 Mock 测试。 |
| [doc/SPEC.md:720](D:/Workespace/xiaofeiyu/doc/SPEC.md:720) **FR-DM-004**：每轮/每日额度和同目标分享冷却必须在预留事务中检查。 | 已完成（离线） | [src/modules/direct-messages.js](D:/Workespace/xiaofeiyu/src/modules/direct-messages.js)；[test/direct-messages.test.js](D:/Workespace/xiaofeiyu/test/direct-messages.test.js) | 白名单、互关、自发拒绝、独立业务键、额度与摘要记录有实现及 Mock 测试。 |
| [doc/SPEC.md:721](D:/Workespace/xiaofeiyu/doc/SPEC.md:721) **FR-DM-005**：可复用 Browse Candidate 形成分享，但不得由 DM 模块重新浏览。 | 已完成（离线） | [src/modules/direct-messages.js](D:/Workespace/xiaofeiyu/src/modules/direct-messages.js)；[test/direct-messages.test.js](D:/Workespace/xiaofeiyu/test/direct-messages.test.js) | 白名单、互关、自发拒绝、独立业务键、额度与摘要记录有实现及 Mock 测试。 |
| [doc/SPEC.md:722](D:/Workespace/xiaofeiyu/doc/SPEC.md:722) **FR-DM-006**：评论和私信拥有不同渠道操作键；同一 Candidate 可分别配置，但不能在同渠道重复。 | 已完成（离线） | [src/modules/direct-messages.js](D:/Workespace/xiaofeiyu/src/modules/direct-messages.js)；[test/direct-messages.test.js](D:/Workespace/xiaofeiyu/test/direct-messages.test.js) | 白名单、互关、自发拒绝、独立业务键、额度与摘要记录有实现及 Mock 测试。 |
| [doc/SPEC.md:723](D:/Workespace/xiaofeiyu/doc/SPEC.md:723) **FR-DM-007**：日志和日记默认只记录收件人 mid 与摘要，不记录完整私信正文。 | 已完成（离线） | [src/modules/direct-messages.js](D:/Workespace/xiaofeiyu/src/modules/direct-messages.js)；[test/direct-messages.test.js](D:/Workespace/xiaofeiyu/test/direct-messages.test.js) | 白名单、互关、自发拒绝、独立业务键、额度与摘要记录有实现及 Mock 测试。 |
| [doc/SPEC.md:724](D:/Workespace/xiaofeiyu/doc/SPEC.md:724) **FR-DM-008**：不支持陌生人批量发送，不接受收件人数组遍历发送。 | 已完成（离线） | [src/modules/direct-messages.js](D:/Workespace/xiaofeiyu/src/modules/direct-messages.js)；[test/direct-messages.test.js](D:/Workespace/xiaofeiyu/test/direct-messages.test.js) | 白名单、互关、自发拒绝、独立业务键、额度与摘要记录有实现及 Mock 测试。 |
| [doc/SPEC.md:1075](D:/Workespace/xiaofeiyu/doc/SPEC.md:1075) **FR-EXT-001**：所有跨模块逻辑消息含 schemaVersion=1；兼容扩展放在明确的 extensions 对象，未知安全字段/动作和不支持版本拒绝，不能静默忽略授权参数。 | 部分完成 | [src/contracts.js](D:/Workespace/xiaofeiyu/src/contracts.js)；[test/contracts.test.js](D:/Workespace/xiaofeiyu/test/contracts.test.js) | 只验证 envelope 顶层；动作 input 由模块分别校验，生产 mode 双层冲突见 F03，不能认定未知安全字段全面拒绝。 |
| [doc/SPEC.md:1089](D:/Workespace/xiaofeiyu/doc/SPEC.md:1089) **FR-EXT-002**：请求键作用域为 workspace＋principal＋action＋requestId；同键同hash返回原taskId/result，同键异hash返回 IDEMPOTENCY_CONFLICT。请求去重与永久业务去重是两层；新requestId不能绕过业务键。 | 部分完成 | [src/contracts.js](D:/Workespace/xiaofeiyu/src/contracts.js)；[test/contracts.test.js](D:/Workespace/xiaofeiyu/test/contracts.test.js) | 请求防重存在，但 reservation、Task、结果分事务；崩溃可能永久 pending 且 taskId 未绑定，见 F06。 |
| [doc/SPEC.md:1102](D:/Workespace/xiaofeiyu/doc/SPEC.md:1102) **FR-EXT-003**：平台能力逐项声明 supported/reason/limits：read.content、read.comments、write.comment、dm.send、dm.receive、publish.manual、publish.external。未支持必须返回 CAPABILITY_UNSUPPORTED。B站本期dm.receive=false；X/抖音测试替身不得注册为正式启用适配器。 | 已完成（离线） | [src/contracts.js](D:/Workespace/xiaofeiyu/src/contracts.js)；[test/contracts.test.js](D:/Workespace/xiaofeiyu/test/contracts.test.js) | 版本、JCS 哈希、请求键、能力与身份隔离有实现；另见 registry、command-service、bilibili-adapter 测试。 |
| [doc/SPEC.md:1105](D:/Workespace/xiaofeiyu/doc/SPEC.md:1105) **FR-EXT-004**：凭据、业务键、额度和熔断按服务及稳定账号隔离；平台替换不能收到B站Cookie，公共错误不暴露平台原始秘密。 | 已完成（离线） | [src/contracts.js](D:/Workespace/xiaofeiyu/src/contracts.js)；[test/contracts.test.js](D:/Workespace/xiaofeiyu/test/contracts.test.js) | 版本、JCS 哈希、请求键、能力与身份隔离有实现；另见 registry、command-service、bilibili-adapter 测试。 |
| [doc/SPEC.md:1111](D:/Workespace/xiaofeiyu/doc/SPEC.md:1111) **FR-IM-001**：桥接来源与终端用户授权分开验证。宿主受信消息形成 adapterId、botAccountId、conversationId、senderRef、eventId、occurredAt、command、mode；principal从受信桥接上下文和本地bindings推导，不能来自正文role/approved/actorKind。 | 已完成（离线） | [src/adapters/channels/dsh-im.js](D:/Workespace/xiaofeiyu/src/adapters/channels/dsh-im.js)；[test/im-contract.test.js](D:/Workespace/xiaofeiyu/test/im-contract.test.js) | 可信 envelope、绑定、命令限制和审批契约有实现；另见 identity、approval、outbox 测试。 |
| [doc/SPEC.md:1126](D:/Workespace/xiaofeiyu/doc/SPEC.md:1126) **FR-IM-002**：幂等键为 adapterId＋botAccountId＋conversationId＋eventId，另保存命令hash和原taskId。无可靠eventId的通道只能受限只读；消息编辑不修改已接收任务，同键异内容拒绝。 | 已完成（离线） | [src/adapters/channels/dsh-im.js](D:/Workespace/xiaofeiyu/src/adapters/channels/dsh-im.js)；[test/im-contract.test.js](D:/Workespace/xiaofeiyu/test/im-contract.test.js) | 可信 envelope、绑定、命令限制和审批契约有实现；另见 identity、approval、outbox 测试。 |
| [doc/SPEC.md:1128](D:/Workespace/xiaofeiyu/doc/SPEC.md:1128) **FR-IM-003**：可执行动作白名单为生产草稿/干跑、本人任务查询、取消请求及受信人类审批。未经明确结构化确认的自然语言不得直接go；本期IM不能任意发送B站私信或创建已批准发布。 | 已完成（离线） | [src/adapters/channels/dsh-im.js](D:/Workespace/xiaofeiyu/src/adapters/channels/dsh-im.js)；[test/im-contract.test.js](D:/Workespace/xiaofeiyu/test/im-contract.test.js) | 可信 envelope、绑定、命令限制和审批契约有实现；另见 identity、approval、outbox 测试。 |
| [doc/SPEC.md:1130](D:/Workespace/xiaofeiyu/doc/SPEC.md:1130) **FR-IM-004**：对同一审批同决定幂等，冲突决定拒绝；干跑不消费真实执行批准。批准过期、输入变更、主体撤权、迁机后的旧挑战一律拒绝；保留审计，不让Agent补写approved:true。 | 部分完成 | [src/adapters/channels/dsh-im.js](D:/Workespace/xiaofeiyu/src/adapters/channels/dsh-im.js)；[test/im-contract.test.js](D:/Workespace/xiaofeiyu/test/im-contract.test.js) | 审批状态机与挑战测试通过；真实入口批准后未回流执行，见 F01。 |
| [doc/SPEC.md:1135](D:/Workespace/xiaofeiyu/doc/SPEC.md:1135) **FR-IM-005**：任务事件与 outbox 在同一事务提交。Notification至少含 notificationId、taskId、taskRevision、bindingId、conversationId、summary、status；status为pending/sending/sent/failed/unknown/suppressed。 | 与设计不一致 | [src/adapters/channels/dsh-im.js](D:/Workespace/xiaofeiyu/src/adapters/channels/dsh-im.js)；[test/im-contract.test.js](D:/Workespace/xiaofeiyu/test/im-contract.test.js) | F02/F06：Task 与 outbox 分事务，通知无常规自动派发调用。 |
| [doc/SPEC.md:1139](D:/Workespace/xiaofeiyu/doc/SPEC.md:1139) **FR-IM-006**：群聊只发summary或不发，不带完整脚本、私人日记、绝对路径、凭据或未经授权附件。首版产物回信仅含artifactId和摘要；不自行搭建公开下载链接服务。 | 已完成（离线） | [src/adapters/channels/dsh-im.js](D:/Workespace/xiaofeiyu/src/adapters/channels/dsh-im.js)；[test/im-contract.test.js](D:/Workespace/xiaofeiyu/test/im-contract.test.js) | 可信 envelope、绑定、命令限制和审批契约有实现；另见 identity、approval、outbox 测试。 |
| [doc/SPEC.md:1140](D:/Workespace/xiaofeiyu/doc/SPEC.md:1140) **FR-IM-007**：dsh-im只有在已验证宿主消息来源、发送方式、事件ID、生命周期及人类证明后启用相应能力。未验证时报告unavailable/BLOCKED，不另接未经授权的QQ微信SDK。 | 部分完成 | [src/adapters/channels/dsh-im.js](D:/Workespace/xiaofeiyu/src/adapters/channels/dsh-im.js)；[test/im-contract.test.js](D:/Workespace/xiaofeiyu/test/im-contract.test.js) | host 契约/probe 与缺宿主拒绝已实现；真实 DSH 来源、生命周期和人类证明未验收。 |
| [doc/SPEC.md:1141](D:/Workespace/xiaofeiyu/doc/SPEC.md:1141) **FR-IM-008**：MockChannel只能证明契约行为；真实IM交付至少验证一次授权消息→草稿Task→人类审批/拒绝→状态回信。真实消息发送需单独用户授权；无条件时交付报告必须列未实测/阻塞，不静默标完成。 | 未实现 | [src/adapters/channels/dsh-im.js](D:/Workespace/xiaofeiyu/src/adapters/channels/dsh-im.js)；[test/im-contract.test.js](D:/Workespace/xiaofeiyu/test/im-contract.test.js) | 真实授权消息→草稿→审批/拒绝→状态回信验收未完成；有 Mock 不等于此项完成。 |
| [doc/SPEC.md:1145](D:/Workespace/xiaofeiyu/doc/SPEC.md:1145) **FR-ART-001**：ArtifactRef={artifactId,sha256,sizeBytes,mediaType,role}。角色至少支持script/image/clip/audio/subtitle/video/cover；引用稳定且归workspace管理，物理路径映射不是业务身份。 | 已完成（离线） | [src/artifact-store.js](D:/Workespace/xiaofeiyu/src/artifact-store.js)；[test/artifact-store.test.js](D:/Workespace/xiaofeiyu/test/artifact-store.test.js) | 受管引用、授权、文件摘要和 pendingImport 恢复有实现；另见 migration-paths、publisher 测试。 |
| [doc/SPEC.md:1147](D:/Workespace/xiaofeiyu/doc/SPEC.md:1147) **FR-ART-002**：素材ID不提供目录读取能力。API/IM只传已授权artifactId；对共享素材必须显式ACL。生产临时目录由核心分配，Runner输出只允许该目录内的普通文件。 | 部分完成 | [src/artifact-store.js](D:/Workespace/xiaofeiyu/src/artifact-store.js)；[test/artifact-store.test.js](D:/Workespace/xiaofeiyu/test/artifact-store.test.js) | 授权、普通文件、越界检查存在；本轮相关组合测试在 symlink 创建处被环境阻断。 |
| [doc/SPEC.md:1148](D:/Workespace/xiaofeiyu/doc/SPEC.md:1148) **FR-ART-003**：Runner输出清单不是成功证据。核心核验文件、类型、大小、hash和配置要求后提交受管理产物；内容定稿后不可就地修改，变更创建新Artifact。 | 已完成（离线） | [src/artifact-store.js](D:/Workespace/xiaofeiyu/src/artifact-store.js)；[test/artifact-store.test.js](D:/Workespace/xiaofeiyu/test/artifact-store.test.js) | 受管引用、授权、文件摘要和 pendingImport 恢复有实现；另见 migration-paths、publisher 测试。 |
| [doc/SPEC.md:1149](D:/Workespace/xiaofeiyu/doc/SPEC.md:1149) **FR-ART-004**：发布前复核视频/封面摘要和授权，不能用审核后的旧hash发布被替换文件。受管理artifact目录可由本地管理员授权给生产/发布，不通过调用参数扩大sourceDirs。 | 已完成（离线） | [src/artifact-store.js](D:/Workespace/xiaofeiyu/src/artifact-store.js)；[test/artifact-store.test.js](D:/Workespace/xiaofeiyu/test/artifact-store.test.js) | 受管引用、授权、文件摘要和 pendingImport 恢复有实现；另见 migration-paths、publisher 测试。 |
| [doc/SPEC.md:1150](D:/Workespace/xiaofeiyu/doc/SPEC.md:1150) **FR-ART-005**：迁移包使用核心生成的相对路径，拒绝绝对路径、..、跨平台保留路径、软硬链接、未列出或重名碰撞的文件。引用式Bundle导出时必须包含实际字节，缺文件就失败，不能保持旧机路径假装可移植。 | 部分完成 | [src/artifact-store.js](D:/Workespace/xiaofeiyu/src/artifact-store.js)；[test/artifact-store.test.js](D:/Workespace/xiaofeiyu/test/artifact-store.test.js) | 相对清单/实际字节与校验存在；Windows symlink 场景未通过，真实跨 OS 未验收。 |
| [doc/SPEC.md:1151](D:/Workespace/xiaofeiyu/doc/SPEC.md:1151) **FR-ART-006**：临时产物提交采用pendingImport记录＋原子rename＋摘要恢复。pendingImport 至少包含 `{artifactId,sourceRealPath,tempFile,expectedSha256,expectedBytes,expectedMode,requestedRole,requestedVisibility,principalId,phase,createdAt}`，提交前复核授权、realPath、摘要/大小/权限。崩溃后只回收核心可证明拥有的临时文件；不自动删除已定稿产物、源素材或用户目录。迁移封存前完成所有pendingImport/日记pendingCommit。 | 已完成（离线） | [src/artifact-store.js](D:/Workespace/xiaofeiyu/src/artifact-store.js)；[test/artifact-store.test.js](D:/Workespace/xiaofeiyu/test/artifact-store.test.js) | 受管引用、授权、文件摘要和 pendingImport 恢复有实现；另见 migration-paths、publisher 测试。 |
| [doc/SPEC.md:1157](D:/Workespace/xiaofeiyu/doc/SPEC.md:1157) **FR-PRO-001**：生产可独立于Browse/B站账号触发，不默认联网或发布。生产Task归workspace，发布另建关联Task。 | 部分完成 | [src/modules/production.js](D:/Workespace/xiaofeiyu/src/modules/production.js)；[test/production.test.js](D:/Workespace/xiaofeiyu/test/production.test.js) | 本地生产独立于 B站成立；用户入口审批到执行链未闭合，见 F01。 |
| [doc/SPEC.md:1175](D:/Workespace/xiaofeiyu/doc/SPEC.md:1175) **FR-PRO-002**：profileId指向本地可信配方与工具绑定，不能由请求提交command、args或环境变量。Profile含id/version/backend、固定阶段、requiredInputs/Outputs、stage restartSafe/checkpoint能力、工具路径及版本范围、outputLimits、voiceMode、可选providerRefs。 | 已完成（离线） | [src/modules/production.js](D:/Workespace/xiaofeiyu/src/modules/production.js)；[test/production.test.js](D:/Workespace/xiaofeiyu/test/production.test.js) | 固定阶段、独立 Execution、审批/预算/取消/检查点有实现；另见 local-execution、production-budget、execution-recovery 测试。 |
| [doc/SPEC.md:1178](D:/Workespace/xiaofeiyu/doc/SPEC.md:1178) **FR-PRO-003**：go必须production.enabled、allowLocalProducer、有效人类审批、工具/素材/输出预检全部通过。global或production dryRun为true时只返回计划和blockedBy，不启动工具或Provider、不产生readyForPublish。 | 与设计不一致 | [src/modules/production.js](D:/Workespace/xiaofeiyu/src/modules/production.js)；[test/production.test.js](D:/Workespace/xiaofeiyu/test/production.test.js) | 底层 effectiveDryRun 有测试，但 CommandService 丢失外层 mode，见 F03。 |
| [doc/SPEC.md:1190](D:/Workespace/xiaofeiyu/doc/SPEC.md:1190) **FR-PRO-004**：stageRequest含workspaceId/taskId/executionId/stageId/attempt/requestId/inputHash/instanceId/profileId/inputArtifactRefs/limits；executionId由核心在持久预留时生成，后端返回相同ID。核心绑定可信临时目录和环境，网络/IM正文不能提供这些特权上下文。 | 已完成（离线） | [src/modules/production.js](D:/Workespace/xiaofeiyu/src/modules/production.js)；[test/production.test.js](D:/Workespace/xiaofeiyu/test/production.test.js) | 固定阶段、独立 Execution、审批/预算/取消/检查点有实现；另见 local-execution、production-budget、execution-recovery 测试。 |
| [doc/SPEC.md:1192](D:/Workespace/xiaofeiyu/doc/SPEC.md:1192) **FR-PRO-005**：本机协议使用固定runner入口、execFile参数数组和有界JSONL。单消息≤1MiB，stdout/stderr总量上限10MiB；超过限制收尾并按副作用状态判定，不阻塞宿主内存。环境白名单不传平台Cookie、秘密全集和账本路径。 | 已完成（离线） | [src/modules/production.js](D:/Workespace/xiaofeiyu/src/modules/production.js)；[test/production.test.js](D:/Workespace/xiaofeiyu/test/production.test.js) | 固定阶段、独立 Execution、审批/预算/取消/检查点有实现；另见 local-execution、production-budget、execution-recovery 测试。 |
| [doc/SPEC.md:1199](D:/Workespace/xiaofeiyu/doc/SPEC.md:1199) **FR-PRO-006**：可选付费Provider调用只经核心EffectGateway，调用前在事务中预留Operation及预算，实际发送前写dispatchAt。Runner不能自行持钥直调付费服务，第三方执行器仅在可信代码假设内支持。 | 已完成（离线） | [src/modules/production.js](D:/Workespace/xiaofeiyu/src/modules/production.js)；[test/production.test.js](D:/Workespace/xiaofeiyu/test/production.test.js) | 固定阶段、独立 Execution、审批/预算/取消/检查点有实现；另见 local-execution、production-budget、execution-recovery 测试。 |
| [doc/SPEC.md:1202](D:/Workespace/xiaofeiyu/doc/SPEC.md:1202) **FR-PRO-007**：cancelRequestedAt与真实停止分离；执行停止但有unknown时Task仍未结算，不可标已安全取消。成功回执先到则保留成功，已发生费用不回滚。 | 已完成（离线） | [src/modules/production.js](D:/Workespace/xiaofeiyu/src/modules/production.js)；[test/production.test.js](D:/Workespace/xiaofeiyu/test/production.test.js) | 固定阶段、独立 Execution、审批/预算/取消/检查点有实现；另见 local-execution、production-budget、execution-recovery 测试。 |
| [doc/SPEC.md:1204](D:/Workespace/xiaofeiyu/doc/SPEC.md:1204) **FR-PRO-008**：checkpoint含stageId/profileVersion/inputHash/outputRefs/lastConfirmedSeq及可恢复类型。只有持久化验证完成的阶段可跨端复用；profile或输入变更要新revision与审批。 | 部分完成 | [src/modules/production.js](D:/Workespace/xiaofeiyu/src/modules/production.js)；[test/production.test.js](D:/Workespace/xiaofeiyu/test/production.test.js) | 检查点复用与新审批已实现；resume 后审批回流仍受 F01 阻断。 |
| [doc/SPEC.md:1208](D:/Workespace/xiaofeiyu/doc/SPEC.md:1208) **FR-PRO-009**：最终manifest包含所有必需Artifact、媒体探测/解码验证结果、profile版本及阶段摘要；核心通过可信验证器检查实际文件、视频流、时长/尺寸/fps/字节上限、视频可解码及必需封面可读后才置succeeded/readyForPublish=true。仅ffprobe读到头部或Runner自报成功不足以通过；部分失败或干跑必须false。 | 部分完成 | [src/modules/production.js](D:/Workespace/xiaofeiyu/src/modules/production.js)；[test/production.test.js](D:/Workespace/xiaofeiyu/test/production.test.js) | 可信媒体探测/解码及 ready 门禁有代码与测试；本次未复验真实媒体，历史记录不作为本次实测。 |
| [doc/SPEC.md:1210](D:/Workespace/xiaofeiyu/doc/SPEC.md:1210) **FR-PRO-010**：remote仅预留同一逻辑协议。请求该backend明确CAPABILITY_UNSUPPORTED，不监听端口、不建心跳/任务传输/素材同步服务。未来需另行设计认证、租约/执行归属及断连核查，不能把本期本机协议称为远程实现。 | 已完成（离线） | [src/modules/production.js](D:/Workespace/xiaofeiyu/src/modules/production.js)；[test/production.test.js](D:/Workespace/xiaofeiyu/test/production.test.js) | 固定阶段、独立 Execution、审批/预算/取消/检查点有实现；另见 local-execution、production-budget、execution-recovery 测试。 |
| [doc/SPEC.md:1216](D:/Workespace/xiaofeiyu/doc/SPEC.md:1216) **FR-MIG-001**：只支持同插件、迁移manifest的schemaVersion=1、kind=migration、stateVersion=3及对应账本v3。未知版本/旧插件数据不自动导入；kind=backup即使文件齐全也不能走migration activate，不提供双端接管或网络共享JSON。 | 已完成（离线） | [src/migration.js](D:/Workespace/xiaofeiyu/src/migration.js)；[test/migration.test.js](D:/Workespace/xiaofeiyu/test/migration.test.js) | prepare/export/release/import/validate/activate、冻结与反向回滚有双目录离线证据；不代表真实跨 OS 验收。 |
| [doc/SPEC.md:1222](D:/Workespace/xiaofeiyu/doc/SPEC.md:1222) **FR-MIG-002**：prepare为人类本地管理动作，先在核心事务核验owner确认的健康恢复点及无匹配RecoveryHold，再原子冻结所有入口的新任务、平台/付费/通知派发及素材导入；包括尚在等槽位的reserved操作。真实prepare/activate不得以dryRun/go豁免，离线测试仅可使用隔离替身。允许已派发操作的回执、取消确认及事实落账，不能冻结收尾所必需的写入。 | 已完成（离线） | [src/migration.js](D:/Workespace/xiaofeiyu/src/migration.js)；[test/migration.test.js](D:/Workespace/xiaofeiyu/test/migration.test.js) | prepare/export/release/import/validate/activate、冻结与反向回滚有双目录离线证据；不代表真实跨 OS 验收。 |
| [doc/SPEC.md:1224](D:/Workespace/xiaofeiyu/doc/SPEC.md:1224) **FR-MIG-003**：导出前完成事件归档、日记pendingCommit和Artifact pendingImport恢复；sealed后业务快照不可再变。导出失败保留源端禁派发状态及错误，不删除源数据。 | 已完成（离线） | [src/migration.js](D:/Workespace/xiaofeiyu/src/migration.js)；[test/migration.test.js](D:/Workespace/xiaofeiyu/test/migration.test.js) | prepare/export/release/import/validate/activate、冻结与反向回滚有双目录离线证据；不代表真实跨 OS 验收。 |
| [doc/SPEC.md:1227](D:/Workespace/xiaofeiyu/doc/SPEC.md:1227) **FR-MIG-004**：release核对封存快照后将源instance持久标retired，再生成绑定migrationId/snapshotHash/targetInstanceId的交接回执。崩溃后仍保持禁写；回执生成可幂等重试，不因导出完成就自动恢复源端。 | 已完成（离线） | [src/migration.js](D:/Workespace/xiaofeiyu/src/migration.js)；[test/migration.test.js](D:/Workespace/xiaofeiyu/test/migration.test.js) | prepare/export/release/import/validate/activate、冻结与反向回滚有双目录离线证据；不代表真实跨 OS 验收。 |
| [doc/SPEC.md:1231](D:/Workespace/xiaofeiyu/doc/SPEC.md:1231) **FR-MIG-005**：只导入新的空目录，目标默认暂停；不覆盖活跃数据。验证版本、清单、全部摘要、跨平台路径冲突/越界/链接及容量，拒绝额外未列出文件；目标使用自己的instanceId，不复用旧PID/锁文件。 | 部分完成 | [src/migration.js](D:/Workespace/xiaofeiyu/src/migration.js)；[test/migration.test.js](D:/Workespace/xiaofeiyu/test/migration.test.js) | 新空目录/摘要/路径校验已有；symlink 测试因权限失败，跨系统验收未完成。 |
| [doc/SPEC.md:1233](D:/Workespace/xiaofeiyu/doc/SPEC.md:1233) **FR-MIG-006**：本机命令路径、目录授权、Profile工具绑定、模型/IM端点及环境秘密引用只能作为待确认提示，不自动启用。目标从安全默认配置开始，本地重新绑定并验证；业务额度与timeZone沿用，不能借安全配置重建清空历史用量。 | 已完成（离线） | [src/migration.js](D:/Workespace/xiaofeiyu/src/migration.js)；[test/migration.test.js](D:/Workespace/xiaofeiyu/test/migration.test.js) | prepare/export/release/import/validate/activate、冻结与反向回滚有双目录离线证据；不代表真实跨 OS 验收。 |
| [doc/SPEC.md:1235](D:/Workespace/xiaofeiyu/doc/SPEC.md:1235) **FR-MIG-007**：activate须核对健康恢复点、无匹配RecoveryHold、本地导入摘要、源交接回执、目标ID及操作者对源端已停写的确认。先持久记录激活决定，再开放本机允许的派发能力；断电后按同migrationId幂等恢复，不重新覆盖最新账本。相同票据不同目标拒绝。 | 已完成（离线） | [src/migration.js](D:/Workespace/xiaofeiyu/src/migration.js)；[test/migration.test.js](D:/Workespace/xiaofeiyu/test/migration.test.js) | prepare/export/release/import/validate/activate、冻结与反向回滚有双目录离线证据；不代表真实跨 OS 验收。 |
| [doc/SPEC.md:1240](D:/Workespace/xiaofeiyu/doc/SPEC.md:1240) **FR-MIG-008**：激活不自动重投旧queued/running任务、旧审批或旧outbox。旧任务置migrationHold，只有受信人类明确resume/重新批准后恢复安全阶段；unknown必须先核查。scheduler仍关闭，需另行本地启用。 | 部分完成 | [src/migration.js](D:/Workespace/xiaofeiyu/src/migration.js)；[test/migration.test.js](D:/Workespace/xiaofeiyu/test/migration.test.js) | 旧任务/审批/通知冻结已实现；production resume 新审批后仍无入口回流，见 F01。 |
| [doc/SPEC.md:1242](D:/Workespace/xiaofeiyu/doc/SPEC.md:1242) **FR-MIG-009**：release前只能通过 `migration abort` 进入aborted并作废封存包及激活资格。source release后不提供普通config开关解除retired；无论目标是否已激活，均先以`migration disable-target`持久禁用目标及原票据，再以`migration rollback`创建反向migrationId。最新账本位置是目标当前数据目录：已激活时包含激活后的新提交；未激活时为已导入快照及其后续核查记录，绝不能直接重启源端旧备份。无法取得目标状态/最新账本时普通迁移流程保持阻塞。 | 已完成（离线） | [src/migration.js](D:/Workespace/xiaofeiyu/src/migration.js)；[test/migration.test.js](D:/Workespace/xiaofeiyu/test/migration.test.js) | prepare/export/release/import/validate/activate、冻结与反向回滚有双目录离线证据；不代表真实跨 OS 验收。 |
| [doc/SPEC.md:1244](D:/Workespace/xiaofeiyu/doc/SPEC.md:1244) **FR-MIG-010**：测试须模拟两个不同instanceId及不同根目录，验证旧端禁写、账本连续、素材可用和跨平台路径；不能用同目录进程重启代替停机迁移验收。 | 部分完成 | [src/migration.js](D:/Workespace/xiaofeiyu/src/migration.js)；[test/migration.test.js](D:/Workespace/xiaofeiyu/test/migration.test.js) | 双根目录与不同实例测试通过；Windows/Linux 真实迁移未验收，路径测试有平台相关失败。 |
| [doc/SPEC.md:1248](D:/Workespace/xiaofeiyu/doc/SPEC.md:1248) **FR-LITE-001**：默认核心加载只注册能力描述，不import媒体/IM/平台重依赖，不spawn，不轮询、不请求whoami。status返回cached/unverified，不为显示状态发网络请求。 | 已完成（离线） | [src/index.js](D:/Workespace/xiaofeiyu/src/index.js)；[test/lite-loading.test.js](D:/Workespace/xiaofeiyu/test/lite-loading.test.js) | 默认无网络/进程/媒体探测及缺组件降级有离线证据。 |
| [doc/SPEC.md:1249](D:/Workespace/xiaofeiyu/doc/SPEC.md:1249) **FR-LITE-002**：可选模块未启用或依赖不可用时其他核心能力仍可使用；启用失败返回明确能力原因。只有显式生产预检会检查媒体工具，禁用后不保留新调度或孤儿任务。 | 部分完成 | [src/index.js](D:/Workespace/xiaofeiyu/src/index.js)；[test/lite-loading.test.js](D:/Workespace/xiaofeiyu/test/lite-loading.test.js) | 缺组件降级有测试；开关下一轮生效与停止生命周期仍有 F09/F10 缺口。 |
| [doc/SPEC.md:1250](D:/Workespace/xiaofeiyu/doc/SPEC.md:1250) **FR-LITE-003**：一个仓库、一个统一业务核心、按需本地进程；不引入消息中间件、微服务编排或实时远程调度来满足停机迁移。长期索引/归档容量需可观测，不将逻辑分文件误称资源零成本。 | 与设计不一致 | [src/index.js](D:/Workespace/xiaofeiyu/src/index.js)；[test/lite-loading.test.js](D:/Workespace/xiaofeiyu/test/lite-loading.test.js) | F08：缺容量指标及 80/100MiB 门禁，常规归档无人驱动。 |
| [doc/SPEC.md:1251](D:/Workespace/xiaofeiyu/doc/SPEC.md:1251) **FR-LITE-004**：基础核心、B站适配、IM桥接、生产profile、迁移、备份与灾备恢复分别报告已实现/未实现/不可用/未实测。至少一个真实本地视频产物是生产验收门槛；Mock平台/IM/remote测试不能冒充真实集成。 | 部分完成 | [src/index.js](D:/Workespace/xiaofeiyu/src/index.js)；[test/lite-loading.test.js](D:/Workespace/xiaofeiyu/test/lite-loading.test.js) | 已有分项实施记录，但历史状态与当前实现不一致；真实媒体本次未复验，真实集成未完成。 |
| [doc/SPEC.md:1257](D:/Workespace/xiaofeiyu/doc/SPEC.md:1257) **FR-DR-001**：本章用于主账本损坏、误删、介质丢失、最新迁移目标不可恢复等非计划故障。复用Store、ArtifactStore及manifest校验，但备份kind=backup不是迁移票据；恢复导入不需要伪造source release，也绝不直接授予派发权。没有有效备份时只能保全残存证据并报告RECOVERY_REQUIRED，不能初始化空账本伪装恢复。 | 已完成（离线） | [src/backup-recovery.js](D:/Workespace/xiaofeiyu/src/backup-recovery.js)；[test/recovery.test.js](D:/Workespace/xiaofeiyu/test/recovery.test.js) | 备份、恢复、hold、证据核查和授权实现存在；结合 backup-*、recovery-*、history-epoch、disaster-recovery.integration 测试；真实故障域未验收。 |
| [doc/SPEC.md:1276](D:/Workespace/xiaofeiyu/doc/SPEC.md:1276) **FR-DR-002**：每次真实平台写（含External）、生产付费调用和IM发送的预留及实际派发前，必须核验owner确认的独立故障域、验证通过且未超龄的ledger或full恢复点，并确认无匹配RecoveryHold。无策略/无有效点为unprotected，过期或校验失败为degraded，禁止上述新派发；go、普通config、任务审批和测试配置不能覆盖。只读、配置诊断和不触及受影响历史的新免费本地工作可单独授权，不假称已受灾备保护。 | 已完成（离线） | [src/backup-recovery.js](D:/Workespace/xiaofeiyu/src/backup-recovery.js)；[test/recovery.test.js](D:/Workespace/xiaofeiyu/test/recovery.test.js) | 备份、恢复、hold、证据核查和授权实现存在；结合 backup-*、recovery-*、history-epoch、disaster-recovery.integration 测试；真实故障域未验收。 |
| [doc/SPEC.md:1281](D:/Workespace/xiaofeiyu/doc/SPEC.md:1281) **FR-DR-003**：备份必须是同一捕获边界的逻辑快照，不对正在变化的整个dataDir直接递归复制。创建backupId并短暂设置checkpointFence，禁止新派发、新Artifact/日记多文件提交和归档清理；允许已有提交/回执收尾。等待已有pendingImport/pendingCommit到达可恢复边界，再在排他事务中捕获账本及其引用清单。 | 部分完成 | [src/backup-recovery.js](D:/Workespace/xiaofeiyu/src/backup-recovery.js)；[test/recovery.test.js](D:/Workespace/xiaofeiyu/test/recovery.test.js) | 一致 cut/checkpointFence 与复制故障测试通过；备份索引仅进程内锁，多进程协调仍需补齐，见 F11。 |
| [doc/SPEC.md:1291](D:/Workespace/xiaofeiyu/doc/SPEC.md:1291) **FR-DR-004**：BackupManifest至少含schemaVersion=1、kind=backup、tier=ledger/full、stateVersion=3、backupId、workspaceId、sourceInstanceId、sourceHistoryEpoch、cutEventSeq、cutAt、configRevision={version,sha256}、timeZone、sourceStateHash、snapshotHash、files、journalCoverage、mediaCoverage、excludedData、failureDomain、createdAt、completedAt。 | 部分完成 | [src/backup-recovery.js](D:/Workespace/xiaofeiyu/src/backup-recovery.js)；[test/recovery.test.js](D:/Workespace/xiaofeiyu/test/recovery.test.js) | ledger/full、hash、覆盖及保留有测试；索引并发与真实介质验证仍不足，见 F11。 |
| [doc/SPEC.md:1302](D:/Workespace/xiaofeiyu/doc/SPEC.md:1302) **FR-DR-005**：RecoveryService独立于损坏的普通Store启动，限受信本地人类入口。先保全受损文件，校验可信恢复点、kind/schema/state版本、完整账本/归档及路径安全；只导入新空目录，不合并到活跃数据目录，不执行来源包内脚本或命令。 | 已完成（离线） | [src/backup-recovery.js](D:/Workespace/xiaofeiyu/src/backup-recovery.js)；[test/recovery.test.js](D:/Workespace/xiaofeiyu/test/recovery.test.js) | 备份、恢复、hold、证据核查和授权实现存在；结合 backup-*、recovery-*、history-epoch、disaster-recovery.integration 测试；真实故障域未验收。 |
| [doc/SPEC.md:1310](D:/Workespace/xiaofeiyu/doc/SPEC.md:1310) **FR-DR-006**：RecoveryCase记录从最后可信cut到旧写者被实际隔离之间的uncertaintyRange；隔离时刻不能确认则右边界open。记录证据覆盖的epoch/seq区间和时间范围，但时钟相近或seq连续不是完整派发证明。 | 已完成（离线） | [src/backup-recovery.js](D:/Workespace/xiaofeiyu/src/backup-recovery.js)；[test/recovery.test.js](D:/Workespace/xiaofeiyu/test/recovery.test.js) | 备份、恢复、hold、证据核查和授权实现存在；结合 backup-*、recovery-*、history-epoch、disaster-recovery.integration 测试；真实故障域未验收。 |
| [doc/SPEC.md:1316](D:/Workespace/xiaofeiyu/doc/SPEC.md:1316) **FR-DR-007**：RecoveryEvidence含id、caseId、scope、source、sourceHash、coveredRange、capturedAt、reviewedBy、原operation/task/businessKey引用及结论。支持残存可信完整记录、平台只读回执、Provider计费/任务回执或明确来源的人工核查；证据读取须另行授权，默认不联网探测。证据正文位于 `<recoveryDir>/evidence/`，使用owner限定权限，对外只返回evidenceRef/hash/脱敏摘要；迁移包携带refs，附件需独立受控导出，不得通过HTTP/IM/Agent读取或夹带秘密。 | 已完成（离线） | [src/backup-recovery.js](D:/Workespace/xiaofeiyu/src/backup-recovery.js)；[test/recovery.test.js](D:/Workespace/xiaofeiyu/test/recovery.test.js) | 备份、恢复、hold、证据核查和授权实现存在；结合 backup-*、recovery-*、history-epoch、disaster-recovery.integration 测试；真实故障域未验收。 |
| [doc/SPEC.md:1322](D:/Workespace/xiaofeiyu/doc/SPEC.md:1322) **FR-DR-008**：recovery authorize不是migration activate。开放任何外部副作用前必须核验旧源、可能的迁移目标和关联执行器已经持久停止/隔离，旧票据或凭据无法继续外发；网络不通、PID不存在、租约超时或声明机器丢失都不是充分证明。 | 已完成（离线） | [src/backup-recovery.js](D:/Workespace/xiaofeiyu/src/backup-recovery.js)；[test/recovery.test.js](D:/Workespace/xiaofeiyu/test/recovery.test.js) | 备份、恢复、hold、证据核查和授权实现存在；结合 backup-*、recovery-*、history-epoch、disaster-recovery.integration 测试；真实故障域未验收。 |
| [doc/SPEC.md:1341](D:/Workespace/xiaofeiyu/doc/SPEC.md:1341) **FR-DR-009**：RecoveryCase至少含id、workspaceId、targetInstanceId、backupRef、parentHistory、newHistoryEpoch、revision、phase、holds、evidenceRefs、fencingEvidence、decisions、createdAt；phase为readonly/reconciling/restricted/released/blocked。released仅表示既定scope核查与许可完成，不等于所有旧任务已执行。 | 已完成（离线） | [src/backup-recovery.js](D:/Workespace/xiaofeiyu/src/backup-recovery.js)；[test/recovery.test.js](D:/Workespace/xiaofeiyu/test/recovery.test.js) | 备份、恢复、hold、证据核查和授权实现存在；结合 backup-*、recovery-*、history-epoch、disaster-recovery.integration 测试；真实故障域未验收。 |
| [doc/SPEC.md:1349](D:/Workespace/xiaofeiyu/doc/SPEC.md:1349) **FR-DR-010**：必须完成§19.5的故障注入矩阵，分别证明数据能恢复和副作用不会被误重放；记录实际恢复点年龄、只读恢复耗时、缺媒体范围和未解冻scope。仅backup create/verify成功不等于恢复演练通过。 | 部分完成 | [src/backup-recovery.js](D:/Workespace/xiaofeiyu/src/backup-recovery.js)；[test/recovery.test.js](D:/Workespace/xiaofeiyu/test/recovery.test.js) | 离线灾备故障注入存在且相关测试通过；真实介质/独立故障域、RPO/RTO 完整演练未完成。 |

