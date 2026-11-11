# 设计与当前实现逐项核对（2026-11-11）

> 本文为修复前审计快照，以下 F01–F10 反例对应原基线；本轮修复结果与当前缺口见 [优先级整改报告](PRIORITY_FIXES_2026-11-11.md)。原始探针结果保留不覆盖。

审查基线：工作区 `D:/Workespace/xiaofeiyu`，HEAD `0cfb4ae`；规范版本 0.2.1-draft。审查前工作区无已跟踪文件修改。本次只新增审查报告、隔离探针及结果，不修改业务代码、配置或历史报告。

规范来源：[DESIGN.md]、[SPEC.md]、[TASKS.md]。`doc/report` 中旧审查和修复报告仅作历史证据，不能用旧结论代替当前代码。2026-11-10 的真实 DM、QQ、DSH 报告按其具体范围采信；本轮没有重跑真实外发、登录、媒体生成或宿主操作。

## 1. 结论与口径

主体架构和主要模块已经实现，但尚不能称为按设计完整交付。剩余工作既包括真实验收，也包括本轮复现的代码缺陷：独立故障域保护失效、主体撤权后仍可派发、自动调度继承 owner、配置优先级颠倒、连续读取缺少等待、WBI 请求绕过读保护，以及迁移后业务能力重新启用流程缺失。

本文状态：

- **完成**：对应条款有代码与离线测试/直接实现证据，未在本次检查中发现反例。仅表示该行所列范围；不能推导整个模块已经真实验收。
- **部分**：主体存在，但子条款、运行接线、必需验收或本机验证证据尚有缺口。
- **不一致**：存在可定位的规范与实现冲突，或明确的规范同步遗漏。
- **未实现**：对应能力没有正式实现入口；与“实现存在但未实测”分开。

78 条编号 FR 的本次判定如下。它们不覆盖配置、BilibiliClient、Diary、Publishing 等全部未编号条款，必须与 §2、§3 合看，不能把这个比例称为整个项目完成率。

| 需求组 | 总数 | 完成 | 部分 | 不一致 | 未实现 |
|---|---:|---:|---:|---:|---:|
| Browse | 8 | 6 | 2 | 0 | 0 |
| Comments | 10 | 10 | 0 | 0 | 0 |
| DirectMessages | 8 | 8 | 0 | 0 | 0 |
| 公共契约 EXT | 4 | 4 | 0 | 0 | 0 |
| 身份/IM | 8 | 6 | 0 | 2 | 0 |
| Artifact | 6 | 5 | 1 | 0 | 0 |
| Production | 10 | 9 | 1 | 0 | 0 |
| Migration | 10 | 5 | 5 | 0 | 0 |
| Backup/Recovery | 10 | 6 | 3 | 1 | 0 |
| 轻量与交付 | 4 | 3 | 1 | 0 | 0 |
| **合计** | **78** | **62** | **13** | **3** | **0** |

编号 FR 均有实现落点；其中 **62/78（79.5%）在本文范围内判为完成**，13 条部分、3 条不一致。不能据此说“只有验收没做”或“剩余全部是环境问题”；下述未编号强制条款也有明确缺陷。不采用“部分算一半”的加权分数，以免掩盖关键门禁缺口。

整体状态：**主体实现较完整、离线回归通过、仍有关键正确性缺口，真实交付仅部分完成**。

## 2. 已确认的缺口及优先级

### F01 / P1：非独立故障域仍被判为 protected

- 设计：SPEC §27.1 / FR-DR-002、DESIGN D-19，真实平台写、付费调用和 IM 发送前，必须有 owner 确认的独立故障域与新鲜有效恢复点。不同盘符不等于独立物理介质。
- 实现：[备份策略校验]只要求 `failureDomain/verifiedBy` 为非空字符串；[保护状态计算]只检查策略、目录、verified 索引和年龄。[派发保护检查]直接接受 `status=protected`，没有独立性判定。
- 复现：策略明确写 `same-physical-disk; NOT independent`，创建隔离 ledger 点后仍返回 `protected`，见[探针结果]的 `sameDiskProtection`。
- 历史交叉证据：[真实 DM 报告]也明确记载 C:/D: 同物理盘，却以 protected 完成真实发送。因此单条 DM 的业务成功可以采信，但不能算满足全部灾备前置的合规验收。
- 建议：分离描述与结构化 owner 核验结果；未知/同故障域不能开启受保护派发。绑定核验的源、目的地及策略修订，统一复核 reserve/dispatch/migration/recovery 入口；同步修正接受同盘示例的[DM 验收脚本]和[验收预检脚本]。不能靠识别某几个字符串关键词解决独立性问题。

### F02 / P1：连续读链路没有等待时间槽，正常浏览容易自行失败

- 设计：SPEC §7.1、§8、§11 要求按读额度/时间槽运行热门、搜索、详情、字幕和评论读取。
- 实现：[默认读预留]调用 `reserveRead(enforceGap=true)`；[读限流器]在时间槽未到时抛错。[平台发现/内容读取]连续调用 popular→search、详情→字幕，没有等待或调度恢复；字幕异常被转为 `subtitle=null`。
- 复现：固定时钟、Mock 网络、真实 client/adapter/rateLimiter 的组合中，多来源发现立即报 `RATE_LIMITED`；详情后字幕返回 `subtitleError.code=RATE_LIMITED`，见[探针结果]。只在请求本身及事务耗时足够长时才可能自然越过间隔，不能依赖网络偶然变慢。
- 影响：默认要求字幕时可把本地限流误当成无字幕并跳过；失败来源可使整轮 discovery 失败；已有模块级 Mock 绕过 client 限流，因此全套测试通过不能排除此问题。字幕错误走 skipped，未写 `lastFailureAt`，还会绕过失败冷却。
- 建议：在读调度层等待合法槽位，等待时不持有 Store 锁；保留每次实际请求的额度和熔断核验。增加真实 client+adapter+Browse 的组合回归。

### F03 / P1：配置优先级与设计相反，可覆盖宿主强制 dryRun

- 设计：SPEC §4.1：默认值 < 用户 JSON < DSH 注入配置 < 环境变量 < 单次显式参数。
- 实现：[配置加载]使用 `deepMerge(deepMerge(DEFAULT_CONFIG, injected), raw)`，使文件优先于注入配置。
- 复现：宿主注入 `{dryRun:true,browse:{perRound:7}}`，JSON 写 `{dryRun:false,browse:{perRound:2}}`，最终得到 `false/2`，见[探针结果]。
- 建议：按规范修复合并顺序，并核对 ConfigService 的加载、热更新、intent 恢复是否使用相同优先级。补同字段冲突测试，尤其是 dryRun、enabled 和限额。

### F04 / P1：WBI 冷缓存请求绕过读额度、暂停及熔断检查

- 设计：SPEC §7.1“每次读取前预留读额度与时间槽”、§7.4 熔断/人工暂停；§8.2 允许缓存 WBI key，但没有免除读保护。
- 实现：[WBI 获取]将 nav 请求标为 `read:false`。只有 `read:true` 的请求进入 `_beforeRead`，故 nav 跳过 quota、gap、authPaused 和 circuit 检查。
- 复现：先设置 circuit，再清空 WBI cache 调用 videoDetails，nav 仍被 Mock 网络收到，随后业务详情请求才被 RATE_LIMITED 拒绝，见[探针结果]的 `coldWbiDuringCircuit`。
- 建议：WBI 元数据也进入统一读保护；与 F02 一起解决连续读调度，避免用绕过保护的方法解决间隔冲突。

### F05 / P1：迁移后业务能力重验/启用流程不完整

- 设计：SPEC §25.3 / FR-MIG-006：目标重新绑定工具、路径和身份；允许先仅启用已验证的非平台能力，未验证平台必须禁止。
- 实现：[迁移运行时接线]没有传 `activationChecks`；[迁移 validate]默认只给 `core:read/core:write`。即便注入检查，硬编码白名单也只接受 core、production:local、publish:manual，不接受 B 站、IM、External 能力。全库正常迁移路径未找到后续受信能力扩充入口；account verify 只更新账号绑定，不更新 instance 能力。
- 影响：可以完成数据交接并显示 active，但正式入口不能完成“重新核验后恢复相应业务”的闭环。本地生产能力也没有在正式 validate 路径被授予。安全拒绝是正确行为，业务恢复能力仍属缺失。
- 建议：实现本地人类驱动的能力重验/激活步骤，逐项核对账号、profile、工具、IM 绑定和恢复点并持久更新许可；不直接把默认 capability 改成全量。补从正式 CLI/runtime 迁移后到任务安全 resume 的端到端测试。

### F06 / P2：full 超过媒体保护目标后没有明确过期状态

- 设计：SPEC §27.3 / FR-DR-004：最后可用 full 即使超龄也保留，同时报告过期；媒体目标默认 24h。
- 实现：[保护状态计算]只在不存在 full 时设 `mediaUnprotected=true`；存在旧 full 时不计算媒体年龄或 stale 原因。[备份状态]亦未明确报告 full 超龄。
- 复现：创建 full、推进 25h、再建新 ledger，输出仍为 `mediaUnprotected=false`、reason=null，仅携带旧 cut 时间。
- 建议：分别输出 ledger 与 full 的年龄、目标、健康状态，保留旧 full 并报告媒体覆盖滞后。新 ledger 可以满足账本年龄要求，但不能表示媒体也新鲜。

### F07 / P2：IM 动作白名单和示例配置已扩展，主规范未同步完整

- 设计：FR-IM-003 列出的动作是生产草稿/干跑、本人任务查询、取消、受信人类审批。
- 实现：[IM 动作入口]额外允许 `comment.draft`，并用于真实拒绝闭环。[真实 IM 报告]记载了当时用户对测试绑定的明确授权，因此不能据此说那次操作未经授权；问题是正式规范白名单尚未同步。
- SPEC §4.3 声称与示例配置一致，但代码/示例多出 `im.transport`、`im.onebot`，见[探针结果]。SPEC §22.3 已批准 OneBot 薄客户端方向，所以 transport 本身不是越界能力。
- 建议：把已批准的变更统一回写白名单、默认配置、绑定 scope、干跑语义与验收条款。不要因旧文档未同步而把整个 OneBot 接入误判为违规实现。

### F08 / P2：实施状态和验收口径仍互相矛盾

- [TASKS.md] §3 多数项仍为 PENDING，而 §10 已写实现完成；§10.3/10.6 的“真实 IM、DSH、DM 未验证”又被 11-10 新报告部分取代。
- T17.3 一处记真实 ffmpeg 6.1.1 通过，后续又记本机无工具/BLOCKED。本轮未运行真实媒体，不能以历史文字认定当前提交已完成真实媒体验收。
- 真实 DSH 挂载有[报告证据]；该报告同时记载启动时 OneBot 不在线、IM 未启动。只能说明当时状态，不能当作今天的实时状态。
- 建议：保留历史报告，建立一张以 commit、环境、命令、证据文件、功能范围为键的现行验收表；不要沿用历史测试数量或把 stub、真实独立桥接与 DSH 常驻组合混为一项。

### F09 / P1：审批后撤销主体，派发边界仍然放行

- 设计：SPEC §7.2 规定预留及实际派发前复核权限；FR-IM-004 要求主体撤权后旧批准不能继续使用。
- 实现：[审批] decide 时读取 principal.revokedAt，但 [批准可用性检查]只检查审批标记、inputHash、过期与使用记录；[平台派发边界]不重新读取 task/approval 所属主体的当前权限。Operation 也没有固化主体/绑定授权引用供其复核。
- 复现：使用真实 CommentsModule/ApprovalService/EffectGateway 创建并批准草稿，在隔离账本把批准主体标为 revoked，再调用 send；Mock 适配器收到 **1 次写调用**，Operation 为 **confirmed**。见[探针结果]的 `approvedThenRevoked`。没有真实外发。
- 建议：在预留和派发两个事务中验证当前 principal、scope、binding/撤权修订及批准主体，撤权后拒绝未派发操作，保留已发生回执的正常结算。补“批准→撤权→派发”“预留→撤权→派发”的组合回归。

### F10 / P1：无人值守调度复用 human/owner 全权限主体

- 设计：SPEC §17.3、§22.1 要求无人值守进程使用显式服务主体，system/scheduler/agent 不继承 owner 身份或人工审批资格。
- 实现：[调度主体]调用 identity.ensureLocalOwner；[owner 创建]固定 kind=human、sourceKind=local_cli、role=owner、scopes=["*"]。tick/runBrowse 缺少传入主体时使用该结果。
- 复现：[探针结果]的 `schedulerPrincipal` 返回上述四个字段。现有 TTY proof 仍是独立检查，所以这不是“已经证明 scheduler 可伪造人工审批”，但权限隔离和审计归属确实不符合设计。
- 建议：建立持久 scheduler/service 主体，显式赋予必要 browse/comment/dm/diary 权限，继续由 auto 配置或白名单策略约束。禁止把系统调度记录成 local_cli 人类任务。

## 3. 未编号核心要求与模块整体状态

| 功能 | 设计要求 | 状态 | 代码与判断依据 |
|---|---|---|---|
| 包与轻核心 | SPEC §3，Node≥22 ESM、可选依赖 | 完成 | [package.json]、[入口]；无必装媒体/平台 SDK；lite-loading/dependency-preflight 测试通过 |
| 配置 schema/默认值/三级 dry | §4.3–4.6，严格类型、CAS、脱敏、动态刷新 | 部分/不一致 | [配置]有校验、intent 恢复、revision 与 onChange；F03 优先级错误、F07 示例结构漂移 |
| 凭据与稳定账号 | §5，Cookie 外置、whoami、credentialRevision、同 MID 连续 | 完成（离线） | [凭据]、[网关]；换凭据阻断 reserve/dispatch、账号暂停及人工恢复有回归；Windows NTFS ACL 未获本轮认证 |
| Store/bootstrap/并发 | §6，v3、缺损不初始化、wx 锁、事务 | 完成（离线） | [Store]；store/fix-core 测试覆盖初始化、损坏、锁、revision、状态校验 |
| 归档/容量 | §6.3，epoch 游标、永久引用、80/100MiB 门槛 | 完成（离线） | [归档]、[Store]、[入口]；归档幂等/损坏拒绝、维护与 prune 测试通过 |
| Operation/额度/unknown | §7，预留与派发双重门禁、未知不重发 | 部分 | [网关]、[限流]；账本/预算/resolve/cancel 闭环通过，但真实保护依赖 F01，读保护有 F02/F04，权限重验缺 F09 |
| B 站协议 | §8，读取/WBI/评论/DM/有效回执 | 部分 | [客户端]、[平台适配]；签名/风控/身份/写入回执有测试，真实 DM 有历史回读；连续读缺口见 F02/F04 |
| 可选 Agent | §9，兼容 chat/completions、环境 Key、不可信素材隔离 | 完成（离线） | [Agent]；generateText/Json、围栏 JSON、失败/禁用/热更新测试通过；未宣称商业服务实测 |
| Task 状态与聚合 | §10，pending/settled、取消、父子聚合 | 完成（离线） | [TaskManager]；unknown 不结算、失败子任务聚合、hold/revision/组合矩阵有回归 |
| Browse/后续互动 | §11、§16，确定性读、独立评论/DM | 部分 | [Browse]、[Coordinator]；候选/评分/隔离实现，F02 妨碍正常 client 组合链路 |
| 评论 | §12，草稿、审批、auto、去重 | 部分（整体验收） | [Comments]；10 条 FR 逻辑有测试；真实评论未实测，目标解析受 F02 影响 |
| DM | §13，单人白名单、互关、防重 | 部分（整体验收） | [DM]；8 条 FR 逻辑已实现，历史单条成功；灾备前置因 F01 不符合规范 |
| 公共/私人日记 | §14，按 scope、可靠事实、可修订、双阶段提交 | 完成（离线） | [Diary]、[Coordinator]；>2000 事件、双 book、afterBrowse、force、resolve dirty、父 epoch/缺口标记有测试 |
| Manual/External 投稿 | §15，Artifact 独立审批、Bundle 不等于发布 | 部分 | [Publisher]；人工补录/void、execFile/回执/unknown 原操作核查已实现；真实 Manual 流程和 External 投稿未验收 |
| DSH/HTTP/CLI | §3.3、§17–18，9 工具、路由信任、TTY 管理、卸载 | 部分 | [入口]、[CLI]、[命令服务]；路由/工具/错误码/注销测试通过，有真实挂载记录；完整宿主+稳定在线 IM 组合未证明，F05 缺入口 |
| 调度与生命周期 | §16–17，独立开关、同类单飞、服务主体 | 部分/不一致 | [Coordinator]、[入口]；停止收尾、日记游标和定时器刷新有回归；F10 调度主体误用 human/owner，长期墙钟负载未测 |
| 备份与灾备 | §27，cut、分层、保留、只读恢复、证据解冻 | 部分/不一致 | [备份恢复]；隔离故障注入/断点续办通过，F01/F06 与真实故障域/RPO/RTO 缺口仍在 |

## 4. 78 条 FR 逐项矩阵

表中代码链接定位到主要实现入口；测试名称对应本轮完整执行的文件。所有“完成”继承 §1 的范围限制，尤其不豁免 F01 或代表真实平台可上线。

### 4.1 Browse（SPEC §11）

| FR | 设计要求摘要 | 状态 | 相关代码、判断依据 |
|---|---|---|---|
| FR-BRO-001 | 自动浏览同时检查 browse/scheduler 开关 | 完成 | [Coordinator] runBrowse/tick 双检查；coordinator.test |
| FR-BRO-002 | 按账号/BV 去重、多来源去重 | 完成 | [Browse] `_videoKey` 带 accountId；[平台适配] discover 去重；fix-modules/browse.test |
| FR-BRO-003 | 成功/自有内容过滤、失败冷却 | 部分 | [Browse] 有 processedAt、own_content、配置冷却；字幕读取错误被降为 skipped，不进失败冷却，见 F02 |
| FR-BRO-004 | 详情失败不冒充理解、无字幕按配置处理 | 部分 | [Browse] 有 allowNoSubtitle/fallback；[平台适配] 的限流失败被当字幕缺失，正常读链路未完成，见 F02 |
| FR-BRO-005 | 单条失败不终止整轮并列失败项 | 完成 | [Browse] 逐条 try/catch、failed[]；browse.test |
| FR-BRO-006 | 关键词/时长/字幕/来源确定性评分 | 完成 | [Browse] scoreCandidate，不以播放量评分；browse.test |
| FR-BRO-007 | Browse 不写平台、互动排除自有内容 | 完成 | [Browse] 仅输出候选；[Comments]/[DM] 再查作者；fix-modules.test |
| FR-BRO-008 | 不伪造观看进度 | 完成 | [配置]拒绝 markWatchHistory=true；无播放上报实现，按设计禁用 |

### 4.2 Comments（SPEC §12）

| FR | 设计要求摘要 | 状态 | 相关代码、判断依据 |
|---|---|---|---|
| FR-COM-001 | 禁用时不自动评论 | 完成 | [Comments] createDraft/send 检查 enabled；comments.test |
| FR-COM-002 | approval 只建待审批草稿并记录操作者 | 完成 | [Comments] waiting_approval、[审批]保存来源/决定；approval/comments.test |
| FR-COM-003 | 仅 auto 策略允许自动发送 | 完成 | [Coordinator] 的 auto 分支、[Comments]记录 policy；coordinator.test |
| FR-COM-004 | 无 Agent 且禁模板时不生成模板 | 完成 | [Coordinator]/[Comments] 拒绝无模型模板；comments.test |
| FR-COM-005 | 每条检查轮次/日额度/冷却/长度 | 完成 | [Comments]与[网关]事务预留，Coordinator 限轮次；comments/fix-gateway.test |
| FR-COM-006 | 同 BV 同渠道冷却，不由改正文绕过 | 完成 | [Comments] targetKey 与 primaryKey 分开；comments.test |
| FR-COM-007 | 同规范化正文不能跨视频灌水 | 完成 | [Comments] textKey/normalizedTextHash；comments.test |
| FR-COM-008 | owner 名称有效且最多 @ 一次 | 完成 | [配置]/[Comments]校验及 prepareText；comments.test |
| FR-COM-009 | dry 仅计划、不记录已发送 | 完成 | [Comments] effectiveDryRun、预检后返回；comments/integration.test |
| FR-COM-010 | 网络 unknown 保留 Operation、不重发 | 完成 | [网关] unknown 与永久键；comments/effect-gateway.test |

### 4.3 DirectMessages（SPEC §13）

| FR | 设计要求摘要 | 状态 | 相关代码、判断依据 |
|---|---|---|---|
| FR-DM-001 | 实际收件人必须在白名单 | 完成 | [DM]/[平台适配]两层校验；direct-messages.test |
| FR-DM-002 | 默认互关，关闭互关仍保留白名单 | 完成 | [DM] checkRecipient→mutualVerified；bilibili-adapter/direct-messages.test |
| FR-DM-003 | 不向当前账号自身发送 | 完成 | [DM] recipient 与稳定 accountRef 比较；direct-messages.test |
| FR-DM-004 | 轮次/日额度及目标冷却在预留内检查 | 完成 | [DM]/[网关] quota、cooldowns、businessCheck；fix-gateway/fix-modules.test |
| FR-DM-005 | 复用 Candidate、不重新浏览 | 完成 | [DM]直接消费 candidate；[Coordinator]传递已有候选 |
| FR-DM-006 | 评论/DM 使用不同渠道操作键 | 完成 | [DM] dm/dm-target 与 Comments 键隔离；direct-messages.test |
| FR-DM-007 | 默认日志/日记不存完整私信 | 完成 | [DM]事件写 recipient/textHash；[Diary]事实投影不展开私信正文 |
| FR-DM-008 | 不接受收件人数组批量发送 | 完成 | [DM] `_parseRecipient` 拒绝数组；direct-messages.test |

### 4.4 公共契约（SPEC §21）

| FR | 设计要求摘要 | 状态 | 相关代码、判断依据 |
|---|---|---|---|
| FR-EXT-001 | schemaVersion=1、拒绝未知安全字段/动作 | 完成 | [契约] normalizeRequestEnvelope 及动作 schema；contracts/command-service.test |
| FR-EXT-002 | requestKey 四元作用域、同参复用/异参冲突 | 完成 | [命令服务]与[TaskManager]绑定请求/任务；command-service/entrypoint-reliability.test，业务键另在网关保护 |
| FR-EXT-003 | 声明平台能力，未支持明确拒绝 | 完成 | [平台适配]/[注册表]；B 站 dm.receive=false，X/抖音仅 test/helpers |
| FR-EXT-004 | 凭据/键/额度/熔断按服务和稳定账号隔离 | 完成 | [凭据]/[网关]/[限流]按命名空间分桶；contracts/fix-gateway.test；WBI 单个读路径的例外另见 F04 |

### 4.5 身份、审批和 IM（SPEC §22）

| FR | 设计要求摘要 | 状态 | 相关代码、判断依据 |
|---|---|---|---|
| FR-IM-001 | 可信传输身份与本地绑定，不信正文 role | 完成 | [身份]/[IM] resolveImPrincipal、trusted envelope；identity/im-contract/onebot-channel.test |
| FR-IM-002 | 四元消息去重、无可靠 ID 仅只读 | 完成 | [IM] inboxKeys、commandHash、重复前复核绑定；im-contract.test |
| FR-IM-003 | 严格动作白名单、自然语言不直接 go | 不一致 | [IM 动作入口]增加 comment.draft，主 FR 未同步；本次测试的单独授权有历史记录，见 F07 |
| FR-IM-004 | 决定幂等、过期/改输入/撤权/迁机失效 | 不一致 | [审批]已查迁机标记/过期/hash，但派发前不复查主体撤权；F09 复现批准后撤权仍发送 |
| FR-IM-005 | Task 事件与 outbox 同事务、unknown 不盲重发 | 完成 | [TaskManager]/[网关]/[IM]有事务通知、pump/query/resolve；outbox/entrypoint-reliability.test |
| FR-IM-006 | 群仅摘要或不发，不泄漏正文/私密/路径 | 完成 | [网关]通知投影与 groupReplies；当前 [OneBot]仅私聊，拒绝群事件 |
| FR-IM-007 | 按已验证宿主能力启用，缺人类证明拒绝审批 | 完成 | [IM]/[OneBot] capability probe；OneBot humanAssurance=unverified，真实负例拒绝；真实 IM/挂载报告 |
| FR-IM-008 | 至少一次真实入站→草稿→人类批准或拒绝→回信 | 完成（历史拒绝路径） | [真实 IM 报告]有原 Task、TTY reject、两条 outbox 回执及 get_msg 核对；未把 approve/真实评论算完成，完整门禁前置另审 |

### 4.6 Artifact（SPEC §23）

| FR | 设计要求摘要 | 状态 | 相关代码、判断依据 |
|---|---|---|---|
| FR-ART-001 | 稳定 ArtifactRef、七类角色、workspace 归属 | 完成 | [Artifact]角色/摘要/大小/媒体类型元数据；artifact-store.test |
| FR-ART-002 | ID 不提供任意目录权限、ACL/受控工作区 | 完成 | [Artifact] allowedSourceDirs/ACL/realPath；artifact-store/safety-matrix.test |
| FR-ART-003 | 核验实际文件，定稿不可原地修改 | 完成 | [Artifact]流式 hash/大小/普通文件校验；[Production]核心验证后导入 |
| FR-ART-004 | 发布前重查视频/封面摘要与权限 | 完成 | [Publisher]再 resolveManagedPath(verify:true)；publisher.test 篡改拒绝 |
| FR-ART-005 | 便携包带字节，拒路径/链接/碰撞/缺文件 | 部分 | [Artifact]/[迁移]路径与摘要检查存在；本轮符号链接 2 项、硬链接 1 项因环境跳过，跨 OS 未验收 |
| FR-ART-006 | pendingImport+rename+摘要恢复，有限清理 | 完成 | [Artifact] recoverPendingImports 与 fileMode；artifact-store/fix-prodmig.test |

### 4.7 Production（SPEC §24）

| FR | 设计要求摘要 | 状态 | 相关代码、判断依据 |
|---|---|---|---|
| FR-PRO-001 | 独立于 Browse/Cookie，不自动发布 | 完成 | [Production] workspace 任务、Publisher 独立；production/lite-loading.test |
| FR-PRO-002 | 可信 profile 绑定固定阶段/工具，拒请求 command | 完成 | [Profile]固定 local-slideshow-v1、声明/工具路径校验；local-slideshow/fix-prodmig.test |
| FR-PRO-003 | go 要开关/审批/预检，三级 dry 不启进程或付费 | 完成 | [Production] create/run/blockedBy；production/safety-matrix.test |
| FR-PRO-004 | 核心生成 executionId，可信上下文绑定协议字段 | 完成 | [Production]/[本地后端]/[网关]签发消费 dispatchContext；fix-prodmig/fix-gateway.test |
| FR-PRO-005 | 固定 Runner、无 shell、有界 JSONL、环境白名单 | 完成 | [本地后端]/[Runner]参数数组 spawn、1MiB/总量限制；local-execution.test。spawn(shell=false)满足进程语义，非接口名称缺陷 |
| FR-PRO-006 | 付费 Provider 经网关预留预算、未知冻结 | 完成（契约） | [Production] `_runPaidTextProvider` + [网关]；production-budget.test，商业生图/TTS 可选而非本期必需 |
| FR-PRO-007 | cancel 请求与真实停止分离，成功/费用不回滚 | 完成 | [Production]/[本地后端] cancelRequested 与实际终态；execution-recovery/local-execution.test |
| FR-PRO-008 | 仅复用已验证 checkpoint，输入/profile 改变重审 | 完成 | [Production] resume 与阶段哈希/version；production/fix-prodmig.test |
| FR-PRO-009 | 实际 MP4/封面探测和解码验证后 ready | 部分 | [媒体验证] ffprobe+ffmpeg 解码及 [Production]核心确认已实现；当前提交真实媒体必需验收未复验，历史记录矛盾 |
| FR-PRO-010 | remote 仅预留、明确拒绝、不启服务 | 完成 | [配置]拒绝 remote；contracts/lite-loading/safety-matrix.test |

### 4.8 Migration（SPEC §25）

| FR | 设计要求摘要 | 状态 | 相关代码、判断依据 |
|---|---|---|---|
| FR-MIG-001 | 只收本插件 v3/migration、保留 epoch | 完成 | [迁移] kind/schema/stateVersion 校验，backup 不能激活；migration.test |
| FR-MIG-002 | 人类 prepare、保护前置、冻结新派发、收尾/停止证据 | 部分 | [迁移]prepare/活执行扫描/停止证据有测试；独立保护前置受 F01 影响 |
| FR-MIG-003 | pending 收尾、封存、完整字节/manifest | 完成 | [迁移]export、late write 回到 quiescing；fix-prodmig/migration.test |
| FR-MIG-004 | release 持久退役源后发绑定回执 | 完成 | [迁移]release、sealed manifest cut、幂等；migration/fix-prodmig.test |
| FR-MIG-005 | 空目录导入、哈希/路径/容量核验、去秘密权限 | 部分 | [迁移]import、sanitized snapshot、容量测试通过；链接跳过/跨 OS 环境验证缺口 |
| FR-MIG-006 | 目标重绑并按验证结果启用能力 | 部分 | [迁移 validate]/[迁移运行时接线]只接 core 默认能力，缺后续业务重验启用，见 F05 |
| FR-MIG-007 | 保护点/hold/回执/源停写确认后幂等激活 | 部分 | [迁移]activate 重验/两阶段恢复有测试；目标保护依赖 F01，完整业务激活受 F05 限制 |
| FR-MIG-008 | 激活不自动重放，旧任务 hold 后人工恢复 | 部分 | [迁移]/[TaskManager]hold、release-hold/resume 有实现；正常业务能力无法重新开放，端到端恢复未闭环 |
| FR-MIG-009 | release 前 abort，之后禁目标、从最新账本反迁 | 完成（离线） | [迁移]disableTarget/rollback prepared 与重试；migration.test 包含目标新提交/断点场景 |
| FR-MIG-010 | 两根目录/两 instanceId 模拟迁移 | 完成（离线） | migration.test/migration-paths.test 使用两个目录和实例；不等于 T12.3 跨 OS 完成 |

### 4.9 Backup/Recovery（SPEC §27）

| FR | 设计要求摘要 | 状态 | 相关代码、判断依据 |
|---|---|---|---|
| FR-DR-001 | 非计划损失走独立恢复，无备份不建空账本 | 完成 | [Store]/[备份恢复] RECOVERY_REQUIRED、独立 restore；recovery/disaster-recovery.integration.test |
| FR-DR-002 | 独立故障域、新鲜 verified 点、无 hold 才派发 | 不一致 | [备份策略校验]/[保护状态计算]接受明确同盘策略，F01 有复现与历史实际发送记录 |
| FR-DR-003 | 一致 cut/fence、锁外复制、ledger/full 分层 | 完成（离线） | [备份恢复] create/capture/staging/hash；backup-fence/backup.test |
| FR-DR-004 | manifest/去秘密/verify/保留底线/媒体过期报告 | 部分 | [备份恢复]主体及锁+CAS/prune 实现；F06 缺 full 超龄状态，介质耐久性/ACL未实测 |
| FR-DR-005 | 新目录只读恢复、新 epoch、旧权限不复活 | 完成（离线） | [备份恢复] restore、RecoveryCase、disabled bindings/hold；history-epoch/recovery-cleanup.test |
| FR-DR-006 | cut 后不确定区间、scope 冻结、不把缺记录当未发 | 完成（离线） | [备份恢复] unknownExposures/holds/range；recovery-evidence/disaster-recovery.integration.test |
| FR-DR-007 | 证据驱动核查、原 Operation 与 recoveredFact 分开 | 完成（离线） | [备份恢复] reconcile + [网关]原操作修复；recovery-evidence/fix-prodmig.test |
| FR-DR-008 | 隔离旧写者、完整核查后逐 scope 解冻 | 部分 | [备份恢复]区间覆盖/账号与预算前置已有测试；独立恢复点仍依赖 F01，真实隔离演练缺失 |
| FR-DR-009 | case 权威、多阶段授权、revision 一致、不重放 | 完成（离线） | [备份恢复] authorize 与断电续办；recovery-evidence.test 验证 state→case、case→instance 窗口 |
| FR-DR-010 | 故障注入矩阵及实际恢复测量 | 部分 | disaster-recovery.integration/recovery 系列覆盖临时目录故障；独立介质、实际 RPO/RTO、大媒体覆盖未验收 |

### 4.10 轻量加载（SPEC §26）

| FR | 设计要求摘要 | 状态 | 相关代码、判断依据 |
|---|---|---|---|
| FR-LITE-001 | 默认零网络/媒体进程/探测，status 用缓存 | 完成 | [入口]/[注册表]惰性依赖，lite-loading.test；仅指默认正常账本状态，不含显式修复流程 |
| FR-LITE-002 | 可选能力失败不拖垮核心，显式预检工具 | 完成 | [入口]/[Profile]记录组件错误、隔离失败；dependency-preflight/fix-entry.test |
| FR-LITE-003 | 单核心、无分布式服务、容量可观测 | 完成 | [Store]/[入口]容量与归档指标；无 worker 服务实现，lite-loading.test |
| FR-LITE-004 | 分项真实报告，不用 Mock 冒充真实媒体/集成 | 部分 | 真实报告已区分 stub/DM/拒绝路径；主状态表仍过期，T17.3 当前验收证据不足，见 F08 |

## 5. T00–T22 与真实验收核对

| 任务 | 当前结论 | 主要依据/剩余事项 |
|---|---|---|
| T00 | 完成（历史研究） | DESIGN 参考插件分析已存在；不代表当前代码完成 |
| T01 | 草案完成，现行状态未统一 | 三份规范齐全；GATE-0 的历史标记与实施记录须对齐 |
| T02 | 部分 | Store/Task/归档已实现；配置优先级 F03、默认配置同步 F07 |
| T03 | 部分 | 平台协议实现；F02 连续读与 F04 WBI 读保护 |
| T04 | 完成（离线/可选契约） | AgentClient + Provider 预算接口；商业服务未承诺实装 |
| T05 | 部分 | Browse 逻辑齐全，真实 client 组合读链路有缺口 |
| T06 | 离线实现完成、真实写未验收 | 草稿/审批/auto/去重；真实评论无验收回执 |
| T07 | 实现完成、单条真实业务成功 | DM 有 11-10 平台回读；完整保护前置不符合 F01 |
| T08 | 完成（离线） | 日记重建/双 book/隐私/恢复测试 |
| T09 | 部分 | Manual/External 代码与 Mock 发布器通过；真实投稿未验收 |
| T10 | 部分 | HTTP/CLI/9 工具、真实 DSH 挂载；迁移能力恢复入口缺失，调度主体误用 owner |
| T11 | 部分 | 本轮 check/test 通过；3 skip，T17.3/T22 依赖尚未全部满足，不能标完整交付审查完成 |
| T12 | 部分 | T12.1 拒绝闭环有历史证据；T12.2 仅 DM 单动作；T12.3 跨 OS 未验收 |
| T13 | 部分 | 分项报告很多，但现行状态及证据口径未统一；本报告补充本轮审查，不代替正式验收 |
| T14 | 部分 | 契约/身份/审批/网关已接；保护决策 F01、主体撤权 F09、调度权限 F10 未闭环 |
| T15 | 部分（验证缺口） | Artifact 实现通过主要测试；链接 fixture 跳过，跨 OS 未验收 |
| T16 | 部分（组合交付） | T16.1 离线契约完成；T16.2 有真实 NapCat 入出站和 DSH 挂载记录，但后者的常驻 IM 当时未启动 |
| T17 | 部分 | T17.1/17.2 流水线及后端通过离线测试；T17.3 真实媒体仅有旧记录，当前工具与版本未复验 |
| T18 | 部分 | 双目录封存/交接/反迁实现；F05 业务重启用缺口，跨 OS 未验收 |
| T19 | 部分 | 默认轻量/依赖检查通过；完整交付依赖未完成 |
| T20 | 部分/不一致 | ledger/full/调度/保留实现；F01 独立域判定、F06 媒体健康缺口 |
| T21 | 部分 | 只读恢复/证据解冻/崩溃恢复已有代码；保护真实性与真实隔离演练未闭环 |
| T22 | 部分 | 临时目录故障注入通过；物理介质/独立域/跨 OS/RPO-RTO 未验收 |

真实证据需分开理解：

1. **DSH 挂载**：[报告证据]记录真实 desktop profile 安装、9 工具注册和 HTTP 路由准入；属于已发生的有限范围集成证据。本轮未检查宿主在线状态。
2. **QQ/IM**：[真实 IM 报告]满足“批准或拒绝”中的拒绝路径，不要求为了该条 FR 再发一条真实评论。OneBot 不能证明人类身份，IM 内审批拒绝属于设计要求，不是待修 Bug。
3. **B 站 DM**：[真实 DM 报告]和[DM 证据 JSON]支持单条成功；独立备份前置不合格，不能称整体 T12.2 通过。
4. **真实评论、Manual/External 投稿**：未验收；代码存在，不能列为“完全没实现”。
5. **真实本地媒体**：[媒体验收脚本]存在，旧 TASKS 报告曾记录 ffmpeg 6.1.1 成功；后续报告记 BLOCKED。本轮 PATH 未发现 ffmpeg/ffprobe，没有扫描用户外部工具目录或执行真实媒体，当前提交的验收仍待补。
6. **跨 OS 迁移、独立故障域及灾备性能**：仅有离线模拟，不能推导真实 Windows/Linux 或物理丢盘可恢复。

## 6. 未实现与本期排除项

| 项目 | 分类 | 依据 |
|---|---|---|
| 事实/偏好/经验记忆、版本化、撤回/遗忘链、跨恢复一致性 | 未实现，待单独设计批准 | TASKS §9/GATE-MEM；未发现 MemoryEntry、记忆存储/检索/变更入口；日记和事件归档不等于该能力，不计入 78 FR 分母 |
| 正常迁移后的业务能力重验和扩充管理入口 | 未实现的子流程 | F05；Migration/CLI/account verify 未形成该闭环，不等于整个迁移模块未实现 |
| 计划中的独立人工验收脚本 `test/manual/im.acceptance.mjs`、`bilibili.acceptance.mjs`、`migration.acceptance.mjs` | 文件未实现/交付形式变化 | 当前 manual 下只有本地媒体脚本；DM 改由 scripts/acceptance/real-dm.mjs 承担，IM 有人工证据，不因缺原文件名否认实际验收 |
| 原生 UPOS、B 站收件箱监听/自动回复、陌生人批量 DM | 本期明确不做 | DESIGN §2.2、SPEC §1/§15.6；不得当成漏实现 |
| X/抖音正式 SDK、remote worker、双端自动接管、旧插件数据导入 | 本期只保留契约或排除 | FR-EXT-003、FR-PRO-010、FR-MIG-001；拒绝能力是正确实现 |
| 商业生图/TTS、通用剪辑器、完整设置 UI、跨 DSH 会话聚合 | 可选扩展/非目标 | 不应为追求“100%”擅自扩大本期范围 |

## 7. 本轮验证与可复查材料

- Windows / PowerShell，Node `v24.18.0`；满足 Node≥22，但不等于已分别在 Node 22 和 Linux 验证。
- `npm run check`：**106 个文件语法检查通过**。
- `npm test`：**393 项，390 通过、0 失败、3 跳过**，约 56.3 秒。跳过为 Artifact 符号链接、Artifact 硬链接、Migration 符号链接 fixture 的本机权限/文件系统限制。跳过不计通过。
- [完整测试日志]保留原始结果；未重测覆盖率，不引用旧覆盖率数字。
- [隔离复现脚本]：`node doc/report/audit-probes-2026-11-11.mjs`；在工作区内创建临时根、注入固定时钟/Mock fetch/测试人类验证器，最后清理自建临时目录；无真实账号/外发/媒体执行。
- [探针结果]包含 F01/F02/F03/F04/F06/F07/F09/F10 的具体返回；F05 为正式接线与全库能力写入路径的静态证据。
- 测试通过只说明已有断言通过。上述复现揭示了现有测试未覆盖的“真实模块组合”问题；本报告并非安全证明或每个崩溃窗口的穷尽验证。

## 8. 建议实施顺序

1. **首先修复 F01、F09/F10、F03、F04**：它们影响灾备前置、权限撤销、调度身份、宿主控制优先级和平台风控。用负例断言“明确同盘仍可备份但不能授予受保护派发”“撤权后未派发动作拒绝”“scheduler 不是 owner”“宿主强制 dryRun 不被文件覆盖”“熔断/暂停时冷 WBI 也零网络”。
2. **紧接修复 F02**：统一读等待，覆盖 popular→search→详情→字幕→热评的组合路径，防止全套模块 Mock 测试掩盖浏览不可用。
3. **补齐 F05**：从正式 CLI/runtime 验证迁移后重新绑定、能力激活、hold 释放和安全 resume，优先证明“搬过去还能在重新授权后继续工作”。
4. **修复 F06，统一 F07/F08 文档**：显式媒体覆盖过期，更新默认配置、IM 动作范围与唯一现行任务表。
5. **再开展缺失验收**：先本地真实 MP4/封面及链接测试，再真实独立介质恢复与实际 RPO/RTO、Windows/Linux 双向迁移，最后按单独授权范围补评论/投稿和 DSH+IM 稳定组合。每项固定 commit、环境、命令和脱敏回执。
6. **记忆能力后置**：等 GATE-MEM 明确范围并补主规范后单独实施；不作为当前核心缺陷修复的前置条件。

[DESIGN.md]: D:/Workespace/xiaofeiyu/doc/DESIGN.md
[SPEC.md]: D:/Workespace/xiaofeiyu/doc/SPEC.md
[TASKS.md]: D:/Workespace/xiaofeiyu/doc/TASKS.md
[package.json]: D:/Workespace/xiaofeiyu/package.json
[入口]: D:/Workespace/xiaofeiyu/src/index.js
[CLI]: D:/Workespace/xiaofeiyu/cli.mjs
[配置]: D:/Workespace/xiaofeiyu/src/config.js
[配置加载]: D:/Workespace/xiaofeiyu/src/config.js:638
[凭据]: D:/Workespace/xiaofeiyu/src/credentials.js
[Store]: D:/Workespace/xiaofeiyu/src/store.js:438
[归档]: D:/Workespace/xiaofeiyu/src/event-journal.js:68
[限流]: D:/Workespace/xiaofeiyu/src/rate-limiter.js
[读限流器]: D:/Workespace/xiaofeiyu/src/rate-limiter.js:153
[网关]: D:/Workespace/xiaofeiyu/src/effect-gateway.js:606
[派发保护检查]: D:/Workespace/xiaofeiyu/src/effect-gateway.js:387
[客户端]: D:/Workespace/xiaofeiyu/src/bilibili.js
[默认读预留]: D:/Workespace/xiaofeiyu/src/bilibili.js:184
[WBI 获取]: D:/Workespace/xiaofeiyu/src/bilibili.js:429
[平台适配]: D:/Workespace/xiaofeiyu/src/adapters/platforms/bilibili.js
[平台发现/内容读取]: D:/Workespace/xiaofeiyu/src/adapters/platforms/bilibili.js:109
[Agent]: D:/Workespace/xiaofeiyu/src/agent.js
[契约]: D:/Workespace/xiaofeiyu/src/contracts.js
[注册表]: D:/Workespace/xiaofeiyu/src/adapters/registry.js
[命令服务]: D:/Workespace/xiaofeiyu/src/command-service.js:126
[身份]: D:/Workespace/xiaofeiyu/src/identity.js
[审批]: D:/Workespace/xiaofeiyu/src/approval.js:113
[批准可用性检查]: D:/Workespace/xiaofeiyu/src/approval.js:234
[平台派发边界]: D:/Workespace/xiaofeiyu/src/effect-gateway.js:754
[调度主体]: D:/Workespace/xiaofeiyu/src/coordinator.js:39
[owner 创建]: D:/Workespace/xiaofeiyu/src/identity.js:87
[TaskManager]: D:/Workespace/xiaofeiyu/src/task-manager.js:121
[Coordinator]: D:/Workespace/xiaofeiyu/src/coordinator.js:105
[Browse]: D:/Workespace/xiaofeiyu/src/modules/browse.js:98
[Comments]: D:/Workespace/xiaofeiyu/src/modules/comments.js:167
[DM]: D:/Workespace/xiaofeiyu/src/modules/direct-messages.js:61
[Diary]: D:/Workespace/xiaofeiyu/src/modules/diary.js:713
[Publisher]: D:/Workespace/xiaofeiyu/src/modules/publisher.js:179
[Artifact]: D:/Workespace/xiaofeiyu/src/artifact-store.js
[Production]: D:/Workespace/xiaofeiyu/src/modules/production.js:169
[Profile]: D:/Workespace/xiaofeiyu/src/production/profiles/local-slideshow.js
[媒体验证]: D:/Workespace/xiaofeiyu/src/production/profiles/local-slideshow.js
[本地后端]: D:/Workespace/xiaofeiyu/src/adapters/execution/local.js
[Runner]: D:/Workespace/xiaofeiyu/src/production/runner.mjs
[IM]: D:/Workespace/xiaofeiyu/src/adapters/channels/dsh-im.js
[IM 动作入口]: D:/Workespace/xiaofeiyu/src/adapters/channels/dsh-im.js:5
[OneBot]: D:/Workespace/xiaofeiyu/src/adapters/channels/onebot-qq.js
[迁移]: D:/Workespace/xiaofeiyu/src/migration.js
[迁移 validate]: D:/Workespace/xiaofeiyu/src/migration.js:894
[迁移运行时接线]: D:/Workespace/xiaofeiyu/src/index.js:481
[备份恢复]: D:/Workespace/xiaofeiyu/src/backup-recovery.js
[备份策略校验]: D:/Workespace/xiaofeiyu/src/backup-recovery.js:75
[保护状态计算]: D:/Workespace/xiaofeiyu/src/backup-recovery.js:1157
[备份状态]: D:/Workespace/xiaofeiyu/src/backup-recovery.js:1102
[真实 DM 报告]: D:/Workespace/xiaofeiyu/doc/report/REAL_DM_ACCEPTANCE_2026-11-10.md
[DM 证据 JSON]: D:/Workespace/xiaofeiyu/doc/report/real-dm-evidence-1794317989745.json
[真实 IM 报告]: D:/Workespace/xiaofeiyu/doc/report/T12_1_IM_APPROVAL_LOOP_2026-11-10.md
[报告证据]: D:/Workespace/xiaofeiyu/doc/report/DSH_DESKTOP_MOUNT_2026-11-10.md
[DM 验收脚本]: D:/Workespace/xiaofeiyu/scripts/acceptance/real-dm.mjs:10
[验收预检脚本]: D:/Workespace/xiaofeiyu/scripts/acceptance/preflight.mjs:54
[媒体验收脚本]: D:/Workespace/xiaofeiyu/test/manual/local-production.acceptance.mjs
[隔离复现脚本]: D:/Workespace/xiaofeiyu/doc/report/audit-probes-2026-11-11.mjs
[探针结果]: D:/Workespace/xiaofeiyu/doc/report/audit-probe-results-2026-11-11.json
[完整测试日志]: D:/Workespace/xiaofeiyu/doc/report/audit-test-results-2026-11-11.txt
