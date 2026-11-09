# 修复后全量复审：设计符合性与完成度

- 审查时间：2026-11-09（Asia/Shanghai）
- 代码基线：git `e12b7d9` + 工作区**未提交**的第一批修复（17 个已修改文件、1 个新增测试文件，见 §6.5）
- 文档基线：`doc/DESIGN.md`（640 行，标称 0.2.1-draft）、`doc/SPEC.md`（1352 行，0.2.1-draft）、`doc/TASKS.md`（957 行，0.2.1-draft）
- 审查对象：`src/` 32 个文件 17,962 行、`cli.mjs` 596 行、`test/` 57 个文件 8,454 行、入口配置与脚本
- 历史文档：`IMPLEMENTATION_AUDIT_2026-11-09.md` 是**修复前快照**；`IMPLEMENTATION_FIXES_2026-11-09.md` 是修复方自述。本报告是**修复后的全量复审**，其计数取代前一份；两份历史文档保留为过程证据。
- 详细逐条证据：`.audit-lead/` 下五份分域审查报告（核心、网关、业务模块、生产/迁移/灾备、入口），本报告是其汇总与复核。

---

## 一、总体结论

1. **主体代码已完成、离线测试充分**：78 条编号 FR 全部有代码落点（100%），离线自动测试 **229 项：227 通过 / 0 失败 / 2 skipped**（2 项为 Windows 符号链接权限限制，非代码缺陷），语法检查 92 文件通过。
2. **第一批修复确实落到代码**（F01 审批回流、F02 通知泵、F03 干跑传递、F04 互斥/手动浏览、F06 原子绑定、F08 归档/容量）。按本报告口径：F01/F02/F03/F08 **已闭合（离线）**；F04 **部分闭合**（仍有 P1 残余：已结算失败子任务不聚合）；F06 **部分完成**（Task 提交事务内原子绑定成立，但"请求预留"仍是独立 intent 事务，不满足"预留与 Task 同一次 store.transaction"的字面要求）。
3. **仍有 4 条编号 FR 与设计明确不一致**（浏览未按账号隔离、迁机/恢复旧审批失效无消费者、IM 动作白名单超出、迁移 sealed 语义缺失），并存在**去重后约 20 条 P1、约 50 条 P2 缺口**；其中 P1 集中在凭据变更 fail-closed、审批目标绑定、配置更新事务与动态生效、B 站风控/登录暂停、迁移封存与灾备解冻前置等安全与正确性语义。
4. **真实环境验收全部未完成**：T16.2 真实 DSH/IM 只读探测、T12.1 真实 IM 闭环、T12.2 真实 B 站写/External 发布、T12.3 真实跨 OS 迁移均无环境与授权（BLOCKED/未实测）；T17.3 真实媒体仅存历史记录，本机无 ffmpeg/ffprobe 无法复验；T22 仅完成临时目录故障注入，无真实故障域/物理介质/RPO-RTO 实测。
5. **文档状态与代码严重脱节**：DESIGN/SPEC/TASKS 状态行仍写"核心实施仍暂停/代码与运行接线尚未实现/核心未实施"，TASKS §10.2 仍记 215 项测试（现为 229）；且第一批修复、新测试与两份报告**均未提交**（HEAD 仍是 `e12b7d9`）。

> **总判断：离线实现基本完成（78 条 FR 均有实现，逐条加权满足度约 75%），但未达到 SPEC §19.4 的完整交付门槛。当前状态应定位为"离线实现完成、待关闭约 20 条 P1 + 完成真实环境验收 + 同步文档与提交"。**

---

## 二、完成度总览

### 2.1 78 条编号 FR（SPEC 中有 `FR-*` 编号的强制需求）

| 维度 | 结果 | 说明 |
|---|---|---|
| 已完成（离线） | **44 条（56.4%）** | 有实现且离线测试/直接证据完整 |
| 部分完成 | **29 条（37.2%）** | 实现存在，但子条款、接线或验收不完整 |
| 与设计不一致 | **4 条（5.1%）** | 有明确代码反例（详见 §3.4 D-01/07/19/09） |
| 未实现 | **1 条（1.3%）** | FR-IM-008 真实 IM 闭环（仅 Mock） |
| 代码落点覆盖率 | **78/78（100%）** | 每条 FR 都有对应实现；"有实现"不等于"逐条满足" |
| 逐条加权满足率 | **75.0%** | 已完成 ×1 + 部分完成 ×0.5 = (44 + 14.5) / 78 |

分组统计：

| 分组 | 总数 | 已完成 | 部分完成 | 不一致 | 未实现 |
|---|---|---|---|---|---|
| §11 Browse（FR-BRO） | 8 | 5 | 2 | 1 | 0 |
| §12 Comments（FR-COM） | 10 | 10 | 0 | 0 | 0 |
| §13 DirectMessages（FR-DM） | 8 | 7 | 1 | 0 | 0 |
| §21 公共契约（FR-EXT） | 4 | 3 | 1 | 0 | 0 |
| §22 身份/审批/IM（FR-IM） | 8 | 4 | 1 | 2 | 1 |
| §23 Artifact（FR-ART） | 6 | 5 | 1 | 0 | 0 |
| §24 Production（FR-PRO） | 10 | 5 | 5 | 0 | 0 |
| §25 Migration（FR-MIG） | 10 | 1 | 8 | 1 | 0 |
| §27 Backup/Recovery（FR-DR） | 10 | 2 | 8 | 0 | 0 |
| §26 轻量加载（FR-LITE） | 4 | 2 | 2 | 0 | 0 |
| **合计** | **78** | **44** | **29** | **4** | **1** |

> 口径说明：29 条"部分完成"中约一半是"实现基本可用但验收证据不足/真实环境不可测"（尤其 FR-MIG/FR-DR），并非代码缺失；因此 75% 不能直接读作"功能完成率"，它是**逐条需求的离线加权满足率**。

### 2.2 未编号强制条款（五路分域审查汇总）

五个分域共给出 **264 行判定**（含编号 FR 行，范围之间有交叉，不能简单相加为独立需求数）：

| 状态 | 数量 |
|---|---|
| 已完成（离线） | 165 |
| 部分完成 | 69 |
| 与设计不一致 | 14 |
| 未实现 | 9 |
| 未验证 | 7 |

其中 SPeC §19.5 灾备故障注入矩阵 14 行：离线测试已覆盖 7 行、部分覆盖 6 行、未验证 1 行（真实隔离演练与性能记录）。

### 2.3 其他交付维度

| 维度 | 结果 | 依据 |
|---|---|---|
| 离线自动测试通过率 | 227/229 = 99.1%（0 失败；2 skip 为 Windows 符号链接 fixture 权限） | `npm test`（§6.3） |
| 全源码语法检查 | 通过（92 个 .js/.mjs 文件） | `npm run check` |
| 真实环境验收（6 类） | **0/6 完成**；T17.3 真实媒体仅历史记录 | §3.3、§6.6 |
| 文档与交付状态 | 未同步；修复未提交 | §3.5、§6.5 |
| §9 记忆规划（GATE-MEM） | 未审核、未实施（设计明确不计入本期） | TASKS §9 |

---

## 三、逐项检查结果

> 状态取值：**已完成（离线）**＝有实现且离线测试/直接证据支撑，不代表真实服务验收；**部分完成**＝实现存在但接线、子条款或必要验收不完整；**与设计不一致**＝有明确代码反例；**未实现**＝明确的验收交付项未开展；**未验证**＝需真实环境/宿主证据才能判定。
> 下文代码位置为证据入口；更细的 file:line 见 `.audit-lead/` 五份分域报告。

### 3.1 已完成（离线）的功能

| # | 能力 | 对应设计 | 相关代码 | 判断依据（摘要） |
|---|---|---|---|---|
| 1 | 包结构、Node≥22、Cordis 声明、轻核心零重依赖 | SPEC §3.1/3.2、FR-LITE-001、D-13 | `package.json`、`cordis.patch.yml`、`src/index.js` | `engines.node>=22`、无运行时 dependencies、仅可选 peer `@deepseek-ai/dsh-tools`；默认全功能关闭时零 fetch/零 spawn/零定时器（`test/lite-loading.test.js`） |
| 2 | v3 账本、跨进程 `wx` 锁、事务、损坏 fail-closed、bootstrap 双写 | SPEC §6.1/6.2 | `src/store.js` | 锁 payload 含 instanceId/ownerPid/processStartedAt/leaseToken；活属主/PID 不可判时 fail-closed；`test/store.test.js` 8 项通过 |
| 3 | 事件归档、`historyEpoch`/`eventId`/seq、64KiB payload 上限、归档段 fail-closed | SPEC §6.3 | `src/event-journal.js` | 段文件 `journal/<epoch>/<start>-<end>-<hash>.json`，临时文件 flush→rename→登记→删 pending；篡改/缺段/gap 抛 `JOURNAL_CORRUPTED`（`test/event-journal.test.js` 4 项） |
| 4 | 容量门禁与常规归档驱动（F08 闭合） | SPEC §6.3、FR-LITE-003 | `src/store.js`、`src/index.js`、`src/coordinator.js` | 80MiB 预警 / 100MiB 硬停（`assertBusinessAcceptance`）；`status.capacity` 暴露 state/journal/recovery 字节与 pending 数；maintenance 每 1s 分批归档、关停收尾；`test/entrypoint-reliability.test.js` 覆盖 |
| 5 | Task 状态白名单、`isSettled/executionActive`、unknown 未结算、父子聚合 | SPEC §10 | `src/task-manager.js` | 迁移矩阵与 SPEC 表格逐对一致；unknown/partial/failed 含未决项时不结算且 `finishedAt=null`（`test/task-manager.test.js` 6 项） |
| 6 | 配置默认值/校验/脱敏/三级 dry、示例配置一致 | SPEC §4.3–4.6 | `src/config.js`、`src/contracts.js`、`config.example.json` | 默认配置与 `config.example.json` 深比较一致；布尔严格、合法 0、`markWatchHistory=true` 拒绝、remote/autoPublish/requireApproval 强制；`effectiveDryRun` 三级合并返回 `blockedBy`（`test/config.test.js` 9 项、`test/contracts.test.js`） |
| 7 | 凭据字段/环境覆盖/原子保存/稳定身份/主体与人类证明基础 | SPEC §5、§22.1 | `src/credentials.js`、`src/identity.js` | Cookie 域名白名单、`credentialRevision=SHA256(SESSDATA)`、whoami 核验 MID；TTY 一次性挑战 + 常量时间比较 + 超时；binding 默认空 scopes（`test/credentials.test.js`、`test/identity.test.js`） |
| 8 | 公共契约：JCS 散列金标准、requestKey、inputHash/metadataHash、能力声明、信封校验 | SPEC §21 | `src/contracts.js`、`src/utils.js` | SPEC §21.1 三条金标准向量逐字符一致并实测通过；`requestId` 幂等同键异参冲突；Platform/Channel/Execution 三类契约方法齐全；B 站 `dm.receive=false` |
| 9 | Operation 状态机、统一派发栅栏、unknown 冻结、resolve、配额/预算分桶、熔断 | SPEC §7、§22.2 | `src/effect-gateway.js`、`src/rate-limiter.js` | 预留六步与派发前二次复核在事务内；`reserved→dispatching→confirmed/failed/unknown`；resolve 同事务更新 Operation/业务键/额度/Task/事件；B 站额度、Provider 预算、IM 通知预算分桶（`test/effect-gateway.test.js` 12 项、`test/rate-limiter.test.js` 3 项） |
| 10 | B 站协议：WBI、whoami/热门/搜索/详情/字幕/热评/relation、评论/DM 写与回执、Cookie 域名隔离 | SPEC §8 | `src/bilibili.js`、`src/adapters/platforms/bilibili.js` | `signWbi` 纯函数 + 10 分钟缓存、空 key 拒绝；成功依赖业务回执（rpid/msg_key/isLogin）；字幕仅 HTTPS 允许域名且不带 Cookie；写方法只接受核心签发的 OperationContext（`test/bilibili.test.js` 7 项、`test/bilibili-adapter.test.js` 3 项） |
| 11 | Browse 确定性评分、失败隔离、只读约束、候选结构 | SPEC §11（除账号去重） | `src/modules/browse.js` | 关键词/时长/字幕/来源/热评加权、不读播放量；单条失败不终止整轮并计入 failed；不导入评论/DM 写接口；`markWatchHistory=true` 直接拒绝 |
| 12 | 评论草稿/审批/auto、同 BV 冷却、同文跨视频防重、@owner、干跑、unknown 保护 | SPEC §12 | `src/modules/comments.js`、`src/coordinator.js` | approval 只出草稿 `waiting_approval`；`comment-target`/`comment-text`/`comment` 三层业务键；无 Agent 且 `allowTemplate=false` 拒绝生成；干跑零发送记录（`test/comments.test.js` 8 项） |
| 13 | 白名单 DM、默认互关、自发/批量拒绝、独立渠道键、摘要记录 | SPEC §13 | `src/modules/direct-messages.js` | 空/非白名单拒绝、`recipient===account` 拒绝、数组拒绝；`dm-target`/`dm` 独立键；事件/日志只留 `recipientMid/textHash`（`test/direct-messages.test.js` 7 项） |
| 14 | 日记 scope 身份、归档+pending 重建、>2000 事件、双阶段提交与崩溃恢复、隐私 | SPEC §14（除自动触发等） | `src/modules/diary.js` | `scopeKey=SHA256(workspaceId+'\n'+scope)` 路径；`pendingCommit` 登记→原子替换→确认，两个崩溃窗口可恢复；2100 事件重建测试通过；公共/私人 ACL |
| 15 | 发布：Artifact 复核、业务键、Manual Bundle、`publish complete`、External execFile/回执/unknown | SPEC §15（除元数据分工等） | `src/modules/publisher.js`、`src/effect-gateway.js` | 派发前重验视频/封面 hash，替换即拒绝；Manual 进入 `awaiting_manual` 不是 succeeded；只在无已派发/unknown 时创建唯一 `manual_confirmation` Operation；External 退出 0/ACK 不算成功（`test/publisher.test.js`，完整权限环境下通过） |
| 16 | ArtifactStore 不可变引用、受控导入、流式 hash、链接/越界/超限拒绝、pendingImport | SPEC §23（ART-001~005） | `src/artifact-store.js`、`src/utils.js` | 七类角色；`allowedSourceDirs` 为空拒绝；`lstat` 拒软链、`nlink>1` 拒硬链、realpath 越界拒绝；源文件不删除；定稿后 chmod 0444；迁移导出相对路径 + 实际字节 |
| 17 | 独立生产与本地执行：固定阶段、profile 不可传 command、三级 dry、Execution/attempt/seq、有界输出、环境白名单、媒体验证门禁 | SPEC §24（PRO-001/003/006/009/010） | `src/modules/production.js`、`src/adapters/execution/local.js`、`src/production/runner.mjs`、`src/production/profiles/local-slideshow.js` | 固定 `script/assets/voice/render/validate`；executionId 由核心持久预留；ffprobe 规格 + ffmpeg 全片解码 + hash 复核后才 `readyForPublish=true`；runner 环境白名单不含 Cookie/账本路径 |
| 18 | 停机迁移正向链路与 ABO/回滚 | SPEC §25（MIG-009 及多数子条款） | `src/migration.js` | prepare→export(seal)→release→import→validate→activate 双根双 instance 实测通过；`abort`/`disable-target`（要求 stop attestation 并回读）/`rollback`（从目标最新账本反向交接、prepared 决定、崩溃重试）通过（`test/migration.test.js` 11 项） |
| 19 | 分层备份、清单/hash、保护门禁、保留底线、只读恢复、RecoveryCase/Hold、两阶段 authorize | SPEC §27（DR-002/009 及多数子条款） | `src/backup-recovery.js` | 一致 cut + `checkpointFence`、ledger/full 分层、`sourceStateHash/snapshotHash` 为 JCS-SHA256、§27.8 各派发入口均接保护门禁；独立只读恢复 + 新 `historyEpoch` + parent；`authorize` 四步两阶段写入、断电续办（`test/backup*.test.js`、`test/recovery*.test.js`、`test/disaster-recovery.integration.test.js`） |
| 20 | 入口层：HTTP 15 路由、9 个工具、39 条 CLI、错误码/HTTP 双列、IM 契约与 outbox、`decideAndContinue` 回流 | SPEC §3.3/§17/§18/§22.3 | `src/index.js`、`cli.mjs`、`src/command-service.js`、`src/adapters/channels/dsh-im.js`、`src/errors.js` | 36 个稳定错误码全部有 HTTP 映射；写入口默认 fail-closed（无 trustedContext → 503）；敏感 CLI 无 TTY → 拒绝；F01/F02/F03 离线端到端测试（`test/dsh.test.js`、`test/cli.test.js`、`test/entrypoint-reliability.test.js`、`test/im-contract.test.js`、`test/outbox.test.js`） |

### 3.2 部分完成的功能（主要缺口）

| # | 功能 / 要求 | 缺口摘要 | 关联编号 | 相关代码 |
|---|---|---|---|---|
| 1 | Browse 按稳定账号去重 / 失败冷却可配置（FR-BRO-002/003） | 持久键仍为 `bilibili:<BV>`，无 accountId；失败冷却硬编码 6h 且 runtime/config 未接入 | F05、M02 | `src/modules/browse.js`、`src/index.js`、`src/config.js` |
| 2 | Browse 无字幕"替代内容"与轮次失败口径（FR-BRO-004、§11.3） | 只支持跳过，无替代内容配置；discovery 失败时 Task=failed 而 result.status=partial | M12 | `src/modules/browse.js` |
| 3 | Coordinator 后置失败聚合（§16、§10.2，F04 残余） | 已结算失败子任务不聚合（父仍 succeeded）；子任务全失败会把父降为 failed；`superseded` 未决审批阻塞子任务结算；interactions 记录发送前旧状态 | M01/M07/M11、F04 | `src/coordinator.js`、`src/task-manager.js` |
| 4 | 日记自动更新与调度（§14、F07） | `afterBrowse` 无消费代码；resolve 不标"待重建"；每日只生成一个 book（public/private 二选一）且失败仍推进 `diaryLastDate`；`force` 形参无效；叙述在事实哈希比较前生成；恢复后日记无缺口/来源标注 | F07、M03/M04/M05/M06 | `src/coordinator.js`、`src/modules/diary.js`、`src/effect-gateway.js` |
| 5 | 配置更新的原子性与动态生效（§4.5、F09） | 先写配置文件、另开事务写 `configRevision`（非同事务），CAS/迁移阶段检查在事务外；`expectedRevision` 可选且命令通道不传；scheduler 由 false→true 不会创建定时器；Agent/BilibiliClient 持旧 config 对象；派发只核对 hash 不核对 version | F09、G2/G3/G4 | `src/config.js`、`src/coordinator.js`、`src/index.js`、`src/agent.js`、`src/bilibili.js` |
| 6 | 凭据变更后的 fail-closed 与凭据版本绑定（§5.2） | 换 Cookie/重启不自动 re-whoami；派发前不比对 `credentialRevision`；`requireWrite()` 无调用者；Operation 只固定 accountRef 不固定凭据版本 | G-03、#G1 | `src/credentials.js`、`src/index.js`、`src/adapters/platforms/bilibili.js`、`src/effect-gateway.js` |
| 7 | B 站风控与登录失效处置（§7.2/§7.4） | HTTP 412/429 非 JSON 响应不触发熔断且被当可重试（实测读请求重发 2 次）；-101/-111 登录失效无持久"人工暂停"；无按账号暂停状态与恢复入口 | G-01、G-02 | `src/bilibili.js`、`src/rate-limiter.js` |
| 8 | 三类派发上下文与取消入口（§7.2/§7.3、§21.2） | `ExecutionDispatchContext` 定义但全库无调用（本地执行裸 `stageRequest` 派发）；`cancelReserved` 无调用方，二次复核失败的 reserved 长期冻结额度/业务键 | G-04、G-06 | `src/contracts.js`、`src/effect-gateway.js`、`src/modules/production.js`、`src/adapters/execution/local.js` |
| 9 | 迁机/恢复后旧审批失效与主体撤权（§22.2、FR-IM-004） | `usableForAuthorization=false`/`invalidatedByMigration`/`requiresReverification` 只写不读；`assertApproved` 派发时不复核主体/标记；无 principal 撤销 API | G-05、G-07 | `src/migration.js`、`src/backup-recovery.js`、`src/approval.js` |
| 10 | Task 组合校验与迁移条件（§10.1） | `assertSettledCombination` 无生产调用者；`hasUnknownOperation` 从未赋值；succeeded 未计未决审批；`running` 未清 `finishedAt`；迁移条件依赖调用方布尔自证 | #G7、#G8、G-08 | `src/task-manager.js`、`src/store.js` |
| 11 | 读额度与时间槽（§7.1） | 读重试第二次不再预留额度（实测 beforeRead=1/fetch=2）；无读最小间隔；`rateLimit.minGapMs` 无消费者 | G-09 | `src/bilibili.js`、`src/rate-limiter.js` |
| 12 | 通知派发门禁完整性（§22.3） | `dispatchNotification` 缺 `_assertConfig`/`_assertInstance`（对比 Operation/本地执行） | G-14 | `src/effect-gateway.js` |
| 13 | CLI 统一入口与人类证明（§17.3、T10） | 多条写命令（diary/comment/dm/production/publish/task resume）直调模块、无 requestKey/幂等；browse sourceKind 写成 http；TTY 挑战只展示 bindingHash、不展示被批准内容、无 OS 会话核验；`--confirm` 多处未强制 | G-E3/G-E4/G-E9/G-E13 | `cli.mjs`、`src/identity.js`、`src/command-service.js` |
| 14 | HTTP 信任栅栏与 mode 契约（§17.1/§4.6） | 未实现 `connection.requestRejection` 等价信任机制（仅消费宿主注入的 trustedContext）；`/run/browse`、`/tasks/:id/resume`、`/approvals/decide` 缺省 mode=go；`dm/production/publish` 不强制显式 mode；`/comments/approve` 未限定 comment 审批；`/tasks/:id` 整 Task 返回 | G-E2/G-E6/G-E7/G-E14 | `src/index.js` |
| 15 | Cordis 挂载与惰性加载（§3.3、FR-LITE-001/002、F10） | `apply` 不消费挂载 `enabled`；`cordis.patch.yml` 的 config 无 schemaVersion，若不另传 dataDir 可能完全不注册路由/工具；可选模块仍静态 import；`lifecycle.onDispose` 不注销路由/工具；启用失败原因不可从 status 查询，禁用后定时器不撤销 | F10、G-E5/G-E10/G-E12 | `src/index.js`、`cordis.patch.yml`、`src/adapters/registry.js` |
| 16 | 请求预留与 Task 同事务（§6.2、FR-EXT-002） | Task 提交事务内已原子绑定 request.taskId/接纳事件/inbox/notificationTarget/outbox，但首个"请求预留"仍是独立 intent 事务 | F06、G-E10 | `src/command-service.js`、`src/store.js` |
| 17 | Artifact pendingImport 细节（FR-ART-006） | `expectedMode` 语义为 import/derived 而非权限；提交前未复核 principal 授权/realPath；迁移遇 pending 时阻止导出而非先完成恢复 | ART-006 | `src/artifact-store.js`、`src/migration.js` |
| 18 | 生产协议字段与检查点（FR-PRO-002/004/005/007/008） | `stageRequest` 缺 workspaceId/requestId/instanceId/inputArtifactRefs；重复 submit 不按 inputHash 冲突拒绝；resume 未记录 `previousExecutionId/checkpointRef`；checkpoint 缺 `lastConfirmedSeq/stageId`；`restartSafe` 声明零消费；runner 单消息上限 4MiB 与 SPEC 1MiB 不一致 | #07/#08/#09 | `src/modules/production.js`、`src/adapters/execution/local.js`、`src/production/runner.mjs`、`src/production/profiles/local-slideshow.js` |
| 19 | 发布元数据与 External 细节（§15.2/§15.5/§15.4） | 元数据校验硬编码在 publisher，未由 PlatformAdapter 按能力验证；External stderr 未脱敏即写 Operation.error；缺"人工确认未发布/作废"入口；input 未校验 schemaVersion/requestId、`approved:true` 被静默忽略 | M08/M09/M10/M14 | `src/modules/publisher.js`、`src/adapters/platforms/bilibili.js` |
| 20 | 迁移子条款（FR-MIG-001~008/010） | sealed 后晚到回执无回退重封、release 回执 cut 与快照脱钩；prepare 只查本进程执行器；export 遇 pending 直接阻塞、manifest 缺 profile 依赖；release 顺序与设计文字相反且未重验整包；import 未复核容量、旧 PID 未清理；activate 未重验导入摘要/无源端停写确认；migration hold 无释放路径；跨 OS 未测 | #01/#02/#05/#13/#14/#16、FR-MIG-001 | `src/migration.js`、`src/index.js`、`src/task-manager.js` |
| 21 | 灾备子条款（FR-DR-001/003/004/005/006/007/008/010） | 无"保全残存证据"动作；备份不等待 pendingImport/pendingCommit 到可恢复边界；prune 不查恢复引用/无容量预检/无媒体未受保护标志；uncertaintyRange 右界永不闭合且 authorize 不核对覆盖；authorize 未强制解冻前置（账号重验、修复证据、新 verified 恢复点）；not_sent 允许仅 note；恢复副本新备份无父恢复点/证据引用；真实演练缺失 | #03/#04/#10/#11/#12/#15/#17、FR-DR-006/008 | `src/backup-recovery.js`、`src/store.js`、`src/effect-gateway.js` |
| 22 | 备份库索引跨进程一致性（F11） | 索引仍只有进程内 Promise 串行锁，`_readIndex/_writeIndex` 无版本/CAS；服务内调度器与 CLI 并发可互相覆盖（丢 restoreTested/新恢复点，或 prune 后条目被写回） | F11、#06 | `src/backup-recovery.js` |
| 23 | X/抖音/remote 契约测试（FR-EXT-003、T14/T19） | 运行期结构上已拒绝（config 白名单、registry 未注册报错），但 T14 目标文件 `test/helpers/mock-platforms.js` 不存在，缺"测试替身不得注册"专项断言 | G-18、FR-EXT-003 | `test/helpers/`、`src/adapters/registry.js`、`src/config.js` |
| 24 | 分项交付与状态可观测（FR-LITE-004、FR-LITE-002） | TASKS §10 有分项记录，但真实项 BLOCKED 未汇总为最新交付说明；status 不报告 IM/执行后端能力与失败原因 | G-E12、FR-LITE-004 | `src/index.js`、`doc/TASKS.md` |
| 25 | 入口层测试覆盖（T10 验收） | `/run/diary`、`/comments/draft`、`/dm/send`、`/publish`、`/tasks/:id/cancel|resume` 无 HTTP 端到端；36 错误码仅 4~5 个走 handler 断言；CLI 审批 go 链、IM 审批链、runtime→imBridge pump 接线无自动化测试 | G-E15 | `test/dsh.test.js`、`test/cli.test.js`、`test/entrypoint-reliability.test.js` |
| 26 | 未编号条款级残余（核心/网关） | 归档并发可误报 `JOURNAL_CORRUPTED`；`store.prune`（500/5000 清理）无调用者；100MiB 硬门禁未覆盖 diary.generate；容量统计每事务递归扫描；`credentialRevision` 相关死代码；BilibiliClient 构造签名偏离 §8.1；DM `requireMutual` 协议层死参数；Cookie `redirect:'follow'` 未复核跳转域名；resolve 幂等不比较回执、external 未校验 BV；Task revision 永不递增 | #G5/#G6/#G10/#G12、G-08/G-10/G-11/G-12/G-13 | 见网关与核心分域报告 |

### 3.3 未实现 / 未验证（真实环境门槛，不以 Mock 冒充）

| # | 项 | 设计/任务要求 | 现状 | 结论 |
|---|---|---|---|---|
| 1 | 真实 dsh-im 宿主只读能力探测 | T16.2、FR-IM-007 | 离线只有 MockHost/MockChannel 与 1s pump；真实服务注册/消息来源/eventId/回执/人类证明均无证据 | **BLOCKED/未实测** |
| 2 | 真实 IM 合法消息→草稿 Task→人类审批/拒绝→状态回信 | T12.1、FR-IM-008 | 无真实宿主、无授权消息、无真实回信证据 | **未实现（BLOCKED）** |
| 3 | 真实 B 站评论/DM 写入与真实 External 发布 | T12.2、§19.3 | 全部 Mock；真实回执/平台限制/外部发布器协议未验证 | **BLOCKED/未实测** |
| 4 | 真实 Windows/Linux 停机搬迁 | T12.3、FR-MIG-010 | 仅双根目录 + 双 instance 模拟，无两系统实测 | **未实测** |
| 5 | 真实本地 MP4/封面媒体验收 | T17.3、FR-PRO-001/009 | 本机无 ffmpeg/ffprobe（`Get-Command` 未找到、`FFMPEG_PATH` 空），未运行 `test/manual/local-production.acceptance.mjs`；TASKS 记录的 ffmpeg 6.1.1 验收为历史记录，本次未复验 | **未验证** |
| 6 | 真实独立故障域/物理介质/RPO-RTO 演练 | T22、§19.5、FR-DR-010 | 仅临时目录故障注入；无真实介质损坏、异地恢复、15 分钟/24 小时/60 分钟实测 | **未验证** |
| 7 | 平台"人工暂停"状态与恢复入口 | SPEC §7.2 第 2 步、§7.4 | 仅熔断实现，无持久 `authPaused` 与人工恢复入口 | **未实现**（G-01 一部分） |
| 8 | Manual"确认未发布/作废"入口 | SPEC §15.4、DESIGN §8.4-6 | 只有 `publish complete`（登记已发布）与 `resolveExternal`，无人工确认未发布/作废路径 | **未实现**（M10） |
| 9 | §9 事实/偏好/经验记忆 | TASKS §9、GATE-MEM | 未审核、未写入主规范、无代码/账本字段 | **未实现（规划项，设计明确不计入本期）** |
| 10 | X/抖音平台适配器、remote ExecutionBackend、原生 UPOS 上传、B 站收件箱 | DESIGN §2.2/§12、R-13 | 明确不做，代码返回 `CAPABILITY_UNSUPPORTED` 且不注册 SDK | **符合设计，不计缺陷** |

### 3.4 与设计不一致的具体问题

> 编号 D-xx 为本报告新增；括号内为分域报告中的原始编号。P1 = 影响正确性/安全性/可用闭环；P2 = 一致性与可维护性。

| 编号 | 优先级 | 设计要求 | 现状与证据 | 影响与建议 |
|---|---|---|---|---|
| D-01 | P1 | FR-BRO-002：候选按**账号和 BV** 去重；SPEC §5.2 账号切换独立命名空间 | `src/modules/browse.js` 中持久视频键仍为 `bilibili:<contentId>`，无 accountId；读取/写入 processedAt/lastFailureAt 共用同一键（原 F05 未修） | A 账号的已处理/冷却会让 B 账号跳过同一视频。建议键加入稳定 accountId 并定义旧键兼容/清理策略，补同 BV 两 MID 测试 |
| D-02 | P1 | SPEC §4.5：配置写入必须与 `configRevision` 在**同一 Store 事务**中完成；§16 配置下一轮生效 | `src/config.js` 先 `atomicWriteJson` 写配置文件，随后另开 `store.transaction` 写 revision；`expectedRevision`/迁移阶段检查在事务外（原 F09 未修）；`coordinator` 定时器只在启动时按 `scheduler.enabled` 创建 | 崩溃/并发可留下"新文件 + 旧 revision"；运行中打开 scheduler 不生效；Agent/BilibiliClient 持旧配置。建议实现可恢复提交协议并在配置变更后刷新定时器与客户端 |
| D-03 | P1 | SPEC §17.1 `/comments/draft`：接受 contentRef 或显式回复引用，**不接受裸 platformData 越权**；审批绑定 inputHash 后按该输入派发 | 路由把 `body.input`/`body` 整体传入；`createDraft` 把 `platformData` 拷入 Task input，但 `inputHash` 只覆盖 contentRef/text/root/parent，不含 `platformData.aid`；B 站实际写评论用 `oid=platformData.aid`。另 `createDraft` 的 aid 必填条件写反（bilibili 缺 aid 反而放行） | 批准的是 BV_A，实际可写到 aid 对应的视频 B，审批绑定与写入目标可分离。建议拒绝调用方 platformData（由适配器解析回填），或把 aid/cid 纳入 inputHash 与审批绑定并校验一致性 |
| D-04 | P1 | SPEC §17.1：写 API 必须经宿主信任栅栏（`connection.requestRejection` 或等价机制），无法建立可信主体则 fail-closed | `createHttpHandler` 只消费宿主注入的 `request.trustedContext`；全 src 无 `requestRejection`/`connection` 使用；apply 不校验上下文来源 | 信任完全依赖"宿主会正确注入"这一未验证假设。建议在 apply 中接入宿主信任 API 并补"信任服务缺失/伪造上下文拒绝"测试 |
| D-05 | P1 | SPEC §17.3：人类敏感命令须验证受信交互终端并**展示绑定内容**的确认挑战，或宿主人类证明；单有 `--confirm`/普通进程身份不足 | CLI 只要求 `stdin.isTTY` + 一次性短语 + bindingHash；TTY 只打印 hash 不打印被批准内容；无 OS 会话/宿主人类证明核验 | 能分配伪终端并捕获输出的 Agent 可自行完成"人类确认"；真实终端也看不到批准内容。建议展示 action/对象/摘要并接入宿主证明，缺失时真实 go 保持 BLOCKED |
| D-06 | P1 | TASKS T10：HTTP/工具/CLI 挂载到**同一 CommandService**；FR-EXT-002 请求幂等 | CLI 仅 browse 与 approval decide 经 CommandService；diary/comment draft/dm/production/publish/task resume 直调模块，无 requestKey/幂等；production 模块无请求去重；CLI browse 的 `sourceKind` 写成 `http` | 重复 `production --go` 可创建多个生产 Task；审计来源不准确。建议统一经 `execute(envelope, principal, {sourceKind:'cli'})`，仅管理/恢复保留专用本地入口 |
| D-07 | P1 | SPEC §22.2/FR-IM-004：批准过期、输入变更、主体撤权、**迁机后的旧挑战一律拒绝** | 迁移/恢复只写 `usableForAuthorization=false`/`invalidatedByMigration`/`requiresReverification`，全库无读取方；`assertApproved` 派发时不复核主体/标记；无 principal 撤销 API | 当前主要靠 task migration hold 兜底；一旦 hold 释放，旧批准仍可能被复用。建议 `assertApproved`/`decide` 拒绝失效标记，迁移/恢复后统一置 rejected 并留事件 |
| D-08 | P1 | SPEC §16/§10.2：后置步骤失败不撤销已成功步骤，Task 应为 **partial** 并记录未决集合 | Coordinator 最终结算只把"未结算子任务"和"本轮 skipped"计入 partial；已结算 failed 子任务不聚合 → 父 Browse 仍 succeeded；子任务全失败时 `recomputeParent` 会把父降为 failed（探针复现） | 有外发失败的轮次会被显示/记录为成功。建议把已结算 failed/partial/unknown 子任务纳入判定并记录真实发送状态 |
| D-09 | P1 | FR-MIG-001/DESIGN §8.6-2：release 前晚到回执使 sealed **回到 quiescing**，落账后重新 export 并更换 snapshotHash；release 后回执只交目标核查 | 全库无 `sealed→quiescing` 回退分支；release 回执的 `cutEventSeq` 取 release 时刻 `state.eventSeq`，而 sealed manifest 无该字段；结算路径无迁移 phase 门禁，晚到回执可继续写源账本 | 封存包与回执可能指向不同事件水位，目标丢失封存后的落账事实。建议在事务内回退重封并强制重新 export，release 回执从 manifest 读取 cut |
| D-10 | P1 | FR-MIG-008：旧任务置 migrationHold，"只有受信人类明确 resume/重新批准后恢复安全阶段" | import 给非终态任务加 `kind=migration` hold；唯一 `releaseHold` 调用来自 RecoveryService 且只过滤 `kind==='recovery'`；CLI 无 release 命令 | 成功迁移后所有非终态旧任务在目标端**永久冻结**，与 FR 给出的恢复路径不符。建议提供本地人类受信的 migration hold 释放入口（含重新审批/审计） |
| D-11 | P1 | FR-DR-006/008：记录 cut→旧写者隔离的 uncertaintyRange；解冻前须完成区间核查、永久键/额度修复、账号重验并建立新的 independent verified 恢复点 | `uncertaintyRange` 只在 restore 写 `{startAt, endAt:null, open:true}`，全文件无任何 `endAt` 写入；`authorize` 只校验 isolation 证据结构与 scope 覆盖，不核对区间覆盖/修复证据/账号重验/新恢复点 | 恢复 case 永远处于 open 区间，却可以仅凭自述隔离证据开放 scope 派发能力。建议 record isolation 时闭合区间，authorize 增加上述前置并缺失即 fail-closed |
| D-12 | P1 | FR-MIG-002：prepare 须等待/请求停止**全部**本地执行器、外部发布器与发送器，无法确认则 export 阻塞 | `executorStatus` 只读本进程 `executionBackend.active`；CLI 每次 prepare 新建 runtime，故检查恒为 0；外部发布器/IM 发送器不在计数内；prepare 不主动 close/stop | 常驻服务仍在渲染/发布时，另一进程 prepare 可能通过并封存。建议要求显式停止凭证（PID/启动时间/停止时间）或把运行中执行信息持久化供 CLI 核查 |
| D-13 | P2 | SPEC §21.1/§22.2：Task `revision` 随输入修订递增并失效审批挑战 | `task.revision` 创建时恒为 1，全库无写入点；`approval.taskRevision` 比较分支不可达（仅测试手工改 revision） | revision 绑定"看起来有、实际恒真"；改参失效实际靠 inputHash 兜底。建议在输入修订/resume 重建审批时递增 revision |
| D-14 | P2 | SPEC §15.2：标题/简介/标签/分区由 **PlatformAdapter 按实际能力验证**，未确认限制在适配器验收列明 | publisher 硬编码 title≤80/desc≤2000/tags≤12×20/tid；适配器能力表无 metadata limits/validate 接口 | 平台限制变化需改核心。建议增加适配器 metadata 能力并由 publisher 调用 |
| D-15 | P2 | SPEC §8.1：`new BilibiliClient({config, credentials, store, rateLimiter, fetchImpl, now, logger})` | 实际构造不接收 store/rateLimiter，改为注入 beforeRead/onRisk/operationContextVerifier/deviceId 等回调（接线在 index.js） | 按 SPEC 构造的调用方会被静默忽略参数。建议恢复入参或修订 SPEC §8.1 并拒绝未知构造参数 |
| D-16 | P2 | SPEC §11.3：全部候选合理跳过且无失败时 Task 以 succeeded 结算并在 result 记 `status=skipped`；存在失败为 partial | discovery 失败时 browse 置 `result.status=partial` 却把 Task 转 failed，测试固化了该行为 | 状态口径需同时判断两个字段。建议明确轮次级发现失败语义或统一为 partial |
| D-17 | P2 | FR-PRO-005：本机协议"单消息 ≤1MiB" | runner 读 stdin 上限为 4MiB（`src/production/runner.mjs`） | 协议上限与 SPEC 不符。建议改为 1MiB 或修订文档并说明 |
| D-18 | P2 | FR-LITE-001：status 只读、零副作用 | CLI `status` 先经 `ensureLocalOwner` 的 store 事务，实测同一 dataDir 连续两次 status 会使 `state.json` hash/mtime 变化（HTTP GET /status 无此问题） | 高频监控会持续改写账本并触发锁竞争。建议提供只读状态路径（owner 缺失才写） |
| D-19 | P2 | FR-IM-003：IM 可执行动作白名单为生产草稿/干跑、本人任务查询、取消请求、受信人类审批 | IM 动作集合与 `IM_SCOPES` 额外包含 `task.resume`；HTTP `/tasks/:id/resume` 不要求人类上下文，DM resume 会直接触发平台私信写 | 设计白名单不一致；若未来 IM 主体可拥有 DM 任务将变成 IM 直接外发通道。建议移除或强制宿主人类证明 |
| D-20 | P2 | FR-MIG-004：先持久标 retired，再生成交接回执 | 代码先写 receipt 文件 → 账本 released → 最后 instance retired（崩溃窗口由 phase=released 保证禁写） | 语义 fail-closed 未被破坏，但顺序与设计文字相反，审计解释成本高。建议调整顺序或更新设计文字 |

### 3.5 文档与交付状态问题

| # | 问题 | 证据 |
|---|---|---|
| 1 | DESIGN 仍声明"核心实施仍暂停/代码和策略实现仍未开始" | `doc/DESIGN.md` 状态行与 §13 尾注（"代码和策略实现仍未开始"） |
| 2 | SPEC 仍声明"未批准核心实施/代码与运行接线尚未实现" | `doc/SPEC.md` 状态行、§27.8 尾注 |
| 3 | TASKS 仍声明"GATE-0 未解除；核心未实施"，T02～T22 全部 `PENDING/BLOCKED`，但同文件 §10 又记录了完整实施结果 | `doc/TASKS.md` 状态行、§1、§3 vs §10 |
| 4 | TASKS §10.2 测试数字过时 | 记录"215 项通过"；本次实测 229 项（227 通过 + 2 skip） |
| 5 | 覆盖率数字未随第一批修复更新 | TASKS 记行 79.41%/分支 62.77%/函数 72.12%（历史）；本次未复跑覆盖率 |
| 6 | 第一批修复与新测试**未提交** | `git HEAD = e12b7d9`；11 个 src 文件 + `cli.mjs` + `scripts/run-tests.mjs` + 5 个测试文件已修改，`test/entrypoint-reliability.test.js` 未跟踪（见 §6.5） |
| 7 | 两份新报告未纳入版本控制 | `doc/report/IMPLEMENTATION_AUDIT_2026-11-09.md`、`IMPLEMENTATION_FIXES_2026-11-09.md` 未跟踪 |

---

## 四、主要缺口（按优先级，去重后）

### 4.1 P1（约 20 条，建议优先关闭）

| # | 缺口 | 编号 | 建议动作 |
|---|---|---|---|
| 1 | 评论审批绑定与实际写入目标可分离（裸 platformData / aid 未入 hash） | D-03、G-E1 | 拒绝调用方 platformData 或把 aid/cid 纳入 inputHash/审批绑定；修正 aid 必填条件 |
| 2 | 凭据变化不 fail-closed、不重新 whoami | G-03、#G1 | 派发事务内比对 credentialRevision；不一致要求 `account verify`；Operation 记录凭据版本 |
| 3 | B 站 412/429 非 JSON 不熔断、登录失效无人工暂停 | G-01、G-02 | 先按 status 触发熔断；风险错误 `retryable=false`；增加按账号 `authPaused` 持久位与恢复入口 |
| 4 | 浏览历史未按账号隔离、失败冷却不可配置 | D-01、F05、M02 | 视频键加入 accountId（含旧键兼容）；冷却进 config 并在 runtime 注入；补双 MID 测试 |
| 5 | 已结算失败子任务不聚合，父任务仍 succeeded | D-08、M01/M07 | 结算时纳入 failed/partial/unknown 子任务；superseded 审批不阻塞；interactions 记录真实发送状态 |
| 6 | 日记自动触发/双 book/失败游标/force 失效 | D-（F07）、M03/M04 | browse 后按 afterBrowse 触发；resolve 标待重建；两 book 分别生成；仅成功后推进游标；实现 force |
| 7 | 配置更新非同事务、动态生效不完整 | D-02、F09、G2/G3 | 可恢复提交协议 + 事务内 CAS；配置变更后启停 timer、刷新 Agent/Client |
| 8 | 旧审批失效标记无消费者；ExecutionDispatchContext 未接线 | D-07、G-04/G-05 | `assertApproved` 拒绝失效审批；核心签发并校验 ExecutionDispatchContext |
| 9 | reserved Operation 无取消入口 | G-06 | 增加受信 `operation.cancel`（要求未派发证据）并接线 `cancelReserved` |
| 10 | 迁移 sealed 晚到回执无回退重封 | D-09、#01 | sealed 下结算事务内回退 quiescing→重新 export 换 hash；release 回执从 manifest 取 cut |
| 11 | 迁移 migration hold 无释放路径 | D-10、#02 | 增加本地人类受信的 migration hold 释放入口（含重新审批/审计） |
| 12 | 灾备 uncertaintyRange 不闭合、authorize 缺解冻前置 | D-11、#03/#04 | 记录隔离证据时闭合区间；authorize 强制区间覆盖+修复证据+账号重验+新 verified 恢复点 |
| 13 | prepare 只能看到本进程执行器 | D-12、#05 | 要求显式停止凭证或持久化执行信息；无法证明时不得先置 quiescing |
| 14 | HTTP 写 API 无宿主信任栅栏 | D-04、G-E2 | 接入 `connection.requestRejection` 或等价机制；补伪造上下文拒绝测试 |
| 15 | CLI 人类证明不满足 | D-05、G-E4 | 展示绑定内容摘要；接入宿主人类证明或 OS 会话核验；缺失保持 BLOCKED |
| 16 | CLI 写命令绕过 CommandService | D-06、G-E3 | 统一经 `execute(envelope, principal, {sourceKind:'cli'})`；CLI 生成稳定 requestId |
| 17 | Cordis 挂载 enabled 未消费、静态 import | D-（F10）、G-E5 | apply 消费 `ctx.config.enabled/httpPrefix`；可选模块动态 import；实测宿主挂载后再定稿 |
| 18 | 备份库索引无跨进程锁/CAS | F11、#06 | 备份库级文件锁或索引 version+CAS；prune 删除前锁内复核引用 |
| 19 | B 站协议层"互关"只是死参数、Cookie 重定向未复核域名、resolve 幂等不比较回执 | G-11/G-12/G-13 | 协议层前置校验互关；带 Cookie 请求 `redirect:'manual'` 或逐跳校验；resolve 冲突比较关键回执字段 |
| 20 | 评论草稿路由的 aid 校验反写 | G-E1 | 修正 `comments.js` 的 aid 必填条件（bilibili 必须要求 aid 或由适配器解析） |

### 4.2 P2（约 50 条，归纳）

- **核心/Store**：`store.prune` 无调用者；并发归档可误报 `JOURNAL_CORRUPTED`；100MiB 硬门禁未覆盖 diary.generate；容量统计每事务递归扫描（性能）；`assertSettledCombination`/`hasUnknownOperation` 未接线；Task 迁移条件依赖调用方布尔自证；`synchronous` 死代码（ConfigService 的 fail-closed 空块、`ABSOLUTE_OR_EMPTY` 未引用）。
- **网关/平台**：Task revision 永不递增；读重试不重预留额度且无读时间槽（`minGapMs` 死配置）；`BilibiliClient` 构造签名偏离 SPEC；DM `requireMutual` 协议层死参数；Cookie 重定向；resolve 幂等/external BV 校验；通知派发缺 config/instance 复核；适配器内 `_beforeRead/_onRisk` 死代码；权限/dryRun 复核不在预留事务内；X/抖音契约测试缺失。
- **业务模块**：日记 `force` 无效/叙述先于哈希比较/锁内生成/恢复缺口标注缺失；定时日记绕过 diary 类型锁；父任务失败降级与 superseded 审批；publisher 元数据硬编码/External 输出未脱敏/Manual 作废入口缺失/input 未校验 schemaVersion；DM 冷却在事务外；Browse discovery 失败口径。
- **生产/迁移/灾备**：stageRequest 缺字段与重复 submit 冲突；runner 4MiB；resume 缺 previousExecutionId/checkpointRef；restartSafe 零消费；checkpoint 字段不全；迁移 export/import/activate 的 pending 处理、容量复核、旧 PID 清理、摘要重验、manifest 缺 profile 依赖；release 顺序；pendingImport `expectedMode` 语义；prune 引用检查/容量预检/媒体未受保护标志；`exposureId` 未关联；恢复副本新备份缺父恢复点/证据引用；"保全残存证据"动作缺失。
- **入口**：缺省 mode 不一致；`/comments/approve` 未限定 comment；`/tasks/:id` 整 Task 返回；错误 message 未脱敏；`SCHEMA_UNSUPPORTED` 映射未在 SPEC §17.1 表声明；CLI `--confirm` 未强制、migration import 可用 `--go`；status 非只读；启用失败原因不可查、禁用后定时器不撤销；lifecycle 不注销路由/工具；入口测试覆盖缺口。

### 4.3 真实环境与交付（需外部条件）

1. 提供受信 ffmpeg/ffprobe、本地 profile 与执行授权 → 复验 T17.3（真实 MP4/封面、无配音路径、缺工具 BLOCKED）。
2. 取得 DSH 宿主可核验证据（服务注册/人类证明/消息语义）→ T16.2，再谈真实 IM。
3. 单独授权真实 IM 测试会话/主体/消息/回信 → T12.1。
4. 单独授权 B 站账号/动作/额度与 External 发布器 → T12.2。
5. 提供 Windows/Linux 两系统环境 → T12.3。
6. owner 确认独立故障域目的地与介质 → T20/T22 真实恢复演练与 RPO/RTO 实测。
7. 文档同步与提交：更新三份文档状态行、TASKS §10.2 数字与当前状态表，提交第一批修复、新测试与报告。

---

## 五、优先处理建议

1. **第一批（P1，纯离线可完成，建议 1～2 个迭代）**：D-03 审批目标绑定 → G-03 凭据 fail-closed → G-01/G-02 风控与登录暂停 → D-01/F05 浏览账号隔离 → D-08/M01 父任务聚合 → F07 日记触发 → F09 配置事务与动态生效 → G-04/G-05 上下文与旧审批失效 → G-06 取消入口 → 迁移/灾备 P1（D-09/D-10/D-11/D-12）→ 入口 P1（D-04/D-05/D-06、G-E5）→ F11 备份索引锁。
2. **第二批（P2，与第一批并行或紧随其后）**：按 §4.2 分类清理，优先补"测试可判定"的一致性问题（D-13/D-14/D-15/D-16/D-17/D-18/D-19/D-20）与死代码/错误契约，避免后续真实验收时误判。
3. **第三批（真实环境验收）**：按 §4.3 逐项申请环境与授权，每项单独出具"通过/未实测/BLOCKED"证据；在此之前不得宣称全功能交付，也不得用 Mock 通过替代。
4. **交付与文档**：修复完成后一次性提交（附测试日志），更新 DESIGN/SPEC/TASKS 状态行与 TASKS §10.2/§10.3，新增"当前状态与本次复审"小节，保留历史报告作为过程证据。

---

## 六、审查方法与验证

### 6.1 方法

- 以 `doc/DESIGN.md`、`doc/SPEC.md`、`doc/TASKS.md` 为基线，逐条抽取要求（78 条编号 FR + 各章节未编号强制条款）。
- 只读审查 `src/`、`cli.mjs`、`test/`、入口配置；所有结论给出当前工作树真实 file:line；对"已修复"声明一律以当前代码重新核实，不采信修复记录自述。
- 运行可用验证：`npm run check`、`npm test`（完整权限环境）、单文件 `node test/<file>.test.js`（进程内，沙箱内可行）、隔离 dataDir 下的只读 CLI、以及少量不联网的进程内探针（412 非 JSON、-101 登录失效、读重试预留、审批后生产执行次数等）。
- 真实平台/IM/External/媒体/跨 OS/真实故障域一律标注未验证，不以 Mock 替代。

### 6.2 五路分工

| 范围 | 覆盖要求 | 判定行数 | 已完成/部分/不一致/未实现/未验证 | 报告 |
|---|---|---|---|---|
| 核心状态层 | SPEC §4/§5/§6/§9/§10/§18 | 54 | 38 / 12 / 2 / 0 / 2 | `.audit-lead/findings-core.md` |
| 网关与平台层 | SPEC §7/§8/§21/§22.1-2 | 58 | 39 / 10 / 3 / 4 / 2 | `.audit-lead/findings-gateway.md` |
| 业务模块 | SPEC §11～§16 | 65 | 45 / 14 / 3 / 3 / 0 | `.audit-lead/findings-modules.md` |
| 生产/迁移/灾备 | SPEC §23/§24/§25/§27/§19.5 | 36（FR）+ §19.5 矩阵 14 | 13 / 22 / 1 / 0 / 0；矩阵 7/6/1 | `.audit-lead/findings-prodmig.md` |
| 入口层 | SPEC §3/§17/§18/§22.3/§26 | 51 | 30 / 11 / 5 / 2 / 3 | `.audit-lead/findings-entry.md` |

### 6.3 本次验证结果

| 命令/项 | 结果 |
|---|---|
| `npm run check` | `92 files syntax-checked; OK` |
| `npm test`（完整权限，Windows，Node v24.18.0） | **229 项：227 通过 / 0 失败 / 2 skipped / 0 cancelled**；耗时 78.5s |
| 2 项 skip 原因 | `artifact file symlink` 与 `migration file symlink`：Windows 需 Developer Mode 或 `SeCreateSymbolicLinkPrivilege` 才能构造 fixture；未记录为通过 |
| 定向单文件执行（五路合计 40+ 文件） | 约 256 项通过；5 项因沙箱禁止带管道 stdio 的 `spawn` 而 EPERM（环境限制，非代码失败），已在完整权限 `npm test` 中通过 |
| 覆盖率 | **未复跑**；TASKS 历史记录 79.41%/62.77%/72.12% 仅供参考 |
| 真实媒体/平台/IM/External/跨 OS | 未执行（无工具、无授权、无环境） |
| 环境限制说明 | Windows 沙箱下测试 runner 的子进程 `spawn` 会被拦截（EPERM），故完整套件需在非受限环境执行；沙箱内以单文件进程内执行替代，不将 EPERM 记为代码缺陷 |

### 6.4 历史缺口 F01～F11 状态变化

| 编号 | 修复前问题 | 本次结论 | 关键证据 |
|---|---|---|---|
| F01 | 审批通过后缺少原任务执行回流 | **已闭合（离线）** | CLI/HTTP/IM 汇入 `decideAndContinue`，按 kind 派发 comments.send/production.run/publisher.prepare；continuation 持久认领；HTTP 有端到端测试，CLI/IM 链路仅代码审阅 |
| F02 | 通知仅入队，无常规派发 | **已闭合（离线）** | Task 提交事务内 `commitObservers` 生成 outbox；`ImBridge.start` 建立 1s pump（unref），stop/close 清理；unknown 不重发、群聊 none 抑制 |
| F03 | 生产外层 dry 未传入模块 | **已闭合（离线）** | envelope.mode 权威；production.create 内层冲突创建前 `CONFIG_INVALID`；模块统一 `effectiveDryRun`；CLI 直调模块仍有静默覆盖（归入 G-E3） |
| F04 | 轮次互斥与后置处理不完整 | **部分闭合** | 同类原子占位、手动浏览接回 Coordinator、unresolved→partial、子任务完成后父任务重算已实现；已结算失败子任务不聚合（M01）、子任务全失败降级父任务（M07） |
| F05 | 浏览历史未按账号隔离 | **未修** | 视频键仍无 accountId；冷却硬编码且未接 config |
| F06 | 请求/Task/事件/outbox 未同事务 | **部分完成** | Task 提交事务内原子绑定 request/inbox/outbox/事件；但请求预留仍是独立 intent 事务 |
| F07 | 日记自动更新未接线 | **未修** | `afterBrowse` 无消费；resolve 无待重建标记；每日只生成单 book 且失败推进游标 |
| F08 | 归档无人驱动、容量门禁缺失 | **已闭合（离线，主缺口）** | maintenance 定期归档、80/100MiB 与 10000 pending 门禁、status 容量暴露、预警停调度；残余 P2（prune 未接线、并发归档误报、统计开销） |
| F09 | 配置更新事务与动态生效 | **未闭合** | 文件写与 revision 提交分离；检查在事务外；scheduler/Agent/Client 不随配置更新刷新 |
| F10 | DSH 挂载与按需加载偏离 | **部分完成** | `runtime.close` 已停 imBridge、定时器清理；但 apply 未消费 enabled、可选模块静态 import、lifecycle 不注销路由/工具、真实宿主未验证 |
| F11 | 备份索引锁仅覆盖同一对象 | **未修** | `_withIndexLock` 仅进程内 Promise 链；`_readIndex/_writeIndex` 无版本/CAS |

### 6.5 工作区与提交状态

- `git HEAD = e12b7d9`；工作区存在**未提交**改动：
  - 已修改（17）：`cli.mjs`、`scripts/run-tests.mjs`、`src/adapters/channels/dsh-im.js`、`src/command-service.js`、`src/coordinator.js`、`src/effect-gateway.js`、`src/event-journal.js`、`src/index.js`、`src/modules/browse.js`、`src/store.js`、`src/task-manager.js`、`test/artifact-store.test.js`、`test/config.test.js`、`test/coordinator.test.js`、`test/credentials.test.js`、`test/integration.test.js`、`test/migration-paths.test.js`
  - 未跟踪（新增）：`test/entrypoint-reliability.test.js`、`doc/report/IMPLEMENTATION_AUDIT_2026-11-09.md`、`doc/report/IMPLEMENTATION_FIXES_2026-11-09.md`、本次审查证据目录 `.audit-lead/`、`doc/report/IMPLEMENTATION_AUDIT_2026-11-09_POSTFIX.md`
- 结论：第一批修复与验证测试**尚未进入版本历史**，存在丢失风险，建议尽快提交（提交信息注明对应 F 编号与测试结果）。

### 6.6 局限与无法确认项

1. **真实 DSH 宿主契约**：`connection.requestRejection`/等价信任机制是否存在、`webServer.registerHandler` 的请求形态、`trustedContext`/`trustedHumanContext` 由谁填充、宿主调用 `dispose` 还是仅 `lifecycle.onDispose`——均无真实证据。
2. **真实 B 站/IM/External/付费 Provider**：全部 Mock；回执字段为 Mock 假设，平台限制未核对。
3. **真实媒体验收**：本机无 ffmpeg/ffprobe，T17.3 历史记录未复验。
4. **真实故障域/物理介质/跨 OS**：仅临时目录故障注入与双目录迁移模拟。
5. **多进程/并发**：F11 为静态判断，未做多进程故障复现；多进程归档误报亦为静态推断。
6. **Windows ACL**：凭据/state 文件的 NTFS 实际权限未验证（Node mode 位在 Windows 无语义）。
7. **覆盖率**：未复跑，历史数字不随修复更新。
8. **§9 记忆规划**：GATE-MEM 未审核，本报告不将其计入缺口或完成度。

---

## 附录 A：78 条编号 FR 逐项矩阵

> 状态：完成＝已完成（离线）；部分＝部分完成；不一致＝与设计不一致；未实现。证据入口为关键代码文件；更细 file:line 见分域报告。

### §11 Browse（8）

| FR | 设计要求（摘要） | 状态 | 关键代码 | 依据要点 |
|---|---|---|---|---|
| FR-BRO-001 | 自动模式仅在 `browse.enabled` 且 scheduler 启用时运行 | 完成 | `src/coordinator.js`、`src/modules/browse.js` | tick 仅在 enabled 时排程，scheduler 触发时再校验 |
| FR-BRO-002 | 候选按**账号**和 BV 去重，多来源同 BV 只处理一次 | 不一致 | `src/modules/browse.js` | 轮内按 contentId 去重成立；持久键 `bilibili:<BV>` 无 accountId（F05） |
| FR-BRO-003 | 已处理/自有过滤、失败冷却可配置、不自死循环 | 部分 | `src/modules/browse.js`、`src/config.js` | 已处理/自有过滤成立；冷却硬编码 6h、runtime 未接入、键跨账号 |
| FR-BRO-004 | 详情失败不算已看懂；无字幕按配置跳过/替代 | 部分 | `src/modules/browse.js` | 失败不计已看懂；字幕不足跳过；无"替代内容"配置能力 |
| FR-BRO-005 | 单视频失败不终止整轮并列出失败项 | 完成 | `src/modules/browse.js` | failed 收集、partial 结算、测试覆盖 |
| FR-BRO-006 | 确定性评分含关键词/时长/字幕/来源，不只播放量 | 完成 | `src/modules/browse.js` | 多维加权，不读播放量 |
| FR-BRO-007 | Browse 不直接评论/DM；评论/DM 排除自身内容 | 完成 | `src/modules/browse.js`、`src/modules/comments.js`、`src/modules/direct-messages.js` | Browse 无写接口导入；两模块在草稿/派发前排除自身 |
| FR-BRO-008 | 默认不伪报播放进度，`markWatchHistory` 保持关闭 | 完成 | `src/config.js`、`src/modules/browse.js` | 默认 false；true 直接 CONFIG_INVALID |

### §12 Comments（10）

| FR | 设计要求（摘要） | 状态 | 关键代码 | 依据要点 |
|---|---|---|---|---|
| FR-COM-001 | `comments.enabled=false` 不得自动评论 | 完成 | `src/modules/comments.js` | createDraft/send/resume 均先 FEATURE_DISABLED |
| FR-COM-002 | approval 模式只出草稿 `waiting_approval`，记录操作者/来源 | 完成 | `src/modules/comments.js`、`src/approval.js` | 草稿建挑战；decide 记录 decidedBy/source |
| FR-COM-003 | 仅 auto 模式由 Coordinator 自动发送 | 完成 | `src/coordinator.js` | 仅 `mode==='auto' && !draft.dryRun` 后置发送 |
| FR-COM-004 | 无 Agent 且 `allowTemplate=false` 不得自动生成模板 | 完成 | `src/modules/comments.js` | 无文本且未允许模板 → AGENT_DISABLED |
| FR-COM-005 | 每条评论独立检查 dailyLimit/perRound/sameVideoDays/maxLength | 完成 | `src/modules/comments.js`、`src/rate-limiter.js` | 长度/冷却模块内；日额度作为 actionQuota 在预留事务；perRound 编排层 |
| FR-COM-006 | 同 BV 同渠道冷却期内不重复（即使正文不同） | 完成 | `src/modules/comments.js` | `comment-target` 键 + 冷却期拒绝 |
| FR-COM-007 | 相同规范化正文不得跨视频批量灌水 | 完成 | `src/modules/comments.js` | `comment-text` 键 + 派发前复检 |
| FR-COM-008 | `mentionOwner` 必须配置 owner.name，最多 @ 一次 | 完成 | `src/modules/comments.js`、`src/config.js` | 配置层强制；正文最多一次 |
| FR-COM-009 | 干跑只预检返回草稿，不创建已发送记录 | 完成 | `src/modules/comments.js` | dry 提前返回 plan，不 reserve/不写业务键 |
| FR-COM-010 | 网络结果未知保留 Operation，不自动重发 | 完成 | `src/modules/comments.js`、`src/effect-gateway.js` | notSent→failed、其余异常→unknown；unknown 任务未结算且不再发 |

### §13 DirectMessages（8）

| FR | 设计要求（摘要） | 状态 | 关键代码 | 依据要点 |
|---|---|---|---|---|
| FR-DM-001 | 实际发送收件人必须在白名单 | 完成 | `src/modules/direct-messages.js` | 空/不在列表直接拒绝 |
| FR-DM-002 | 默认检查互关；关闭互关仍保留白名单 | 完成 | `src/modules/direct-messages.js`、`src/config.js` | 非 dry 时 checkRecipient；白名单始终检查 |
| FR-DM-003 | 不得向自身发送 | 完成 | `src/modules/direct-messages.js` | recipient === active account 拒绝 |
| FR-DM-004 | 每轮/每日额度与同目标冷却在**预留事务中**检查 | 部分 | `src/modules/direct-messages.js`、`src/effect-gateway.js` | 额度/业务键在事务内；`sameVideoDays` 窗口用事务外快照判断（M13） |
| FR-DM-005 | 可复用 Browse Candidate，不得重新浏览 | 完成 | `src/modules/direct-messages.js`、`src/coordinator.js` | send 接收候选，不调用 discover/readContent |
| FR-DM-006 | 评论/私信不同渠道键，同渠道不重复 | 完成 | `src/modules/direct-messages.js`、`src/modules/comments.js` | `dm:`/`dm-target:` 与 `comment:` 前缀隔离 |
| FR-DM-007 | 日志/日记只记 mid 与摘要，不记完整正文 | 完成 | `src/modules/direct-messages.js`、`src/modules/diary.js` | 事件/结果不含正文，日记仅计数 |
| FR-DM-008 | 不支持陌生人批量/收件人数组遍历 | 完成 | `src/modules/direct-messages.js` | 数组直接拒绝，单次单收件人 |

### §21 公共契约（4）

| FR | 设计要求（摘要） | 状态 | 关键代码 | 依据要点 |
|---|---|---|---|---|
| FR-EXT-001 | 消息含 schemaVersion=1；extensions 边界；未知安全字段/动作/版本拒绝 | 完成 | `src/contracts.js` | 信封白名单、版本/动作校验、extensions 深拷贝；JCS 三条金标准通过 |
| FR-EXT-002 | 请求键作用域与同键同参/异参语义；accepted 仅在持久提交后返回 | 完成 | `src/contracts.js`、`src/command-service.js` | requestKey 四字段 JCS；同键异 hash 冲突；预留/提交后才 accepted（F06 残余另计） |
| FR-EXT-003 | 能力逐项声明 supported/reason/limits；B 站 dm.receive=false；X/抖音替身不得注册 | 部分 | `src/contracts.js`、`src/adapters/platforms/bilibili.js`、`src/adapters/registry.js` | 能力声明齐全、dm.receive=false；缺 X/抖音替身注册专项测试（G-18） |
| FR-EXT-004 | 凭据/业务键/额度/熔断按服务与稳定账号隔离，公共错误不泄露平台秘密 | 完成 | `src/rate-limiter.js`、`src/effect-gateway.js`、`src/errors.js` | 三桶独立 key；错误 details 递归脱敏 |

### §22 身份、审批与 IM（8）

| FR | 设计要求（摘要） | 状态 | 关键代码 | 依据要点 |
|---|---|---|---|---|
| FR-IM-001 | 桥接来源与终端授权分开；principal 来自可信上下文而非正文 | 完成 | `src/index.js`、`src/identity.js` | 只从 `request.trustedContext.principal` 取；body 伪造拒绝 |
| FR-IM-002 | 幂等键 adapter+bot+conversation+eventId；同键异内容拒绝 | 完成 | `src/adapters/channels/dsh-im.js` | 四元防重、冲突拒绝、过期/未来时间校验（`test/im-contract.test.js`） |
| FR-IM-003 | 可执行动作白名单为草稿/干跑、本人查询、取消、受信审批 | 不一致 | `src/adapters/channels/dsh-im.js`、`src/command-service.js`、`src/identity.js` | IM 动作集与 IM_SCOPES 额外允许 `task.resume`（D-19） |
| FR-IM-004 | 同决定幂等/冲突拒绝；过期/改参/撤权/迁机旧挑战全部拒绝；干跑不消费 | 不一致 | `src/approval.js`、`src/migration.js`、`src/backup-recovery.js` | 幂等/过期/改参/dry 成立；迁机/恢复失效标记只写不读（D-07） |
| FR-IM-005 | Task 事件与 outbox 同事务；状态枚举与发送前复查；unknown 不重发；本地 resolve | 完成 | `src/effect-gateway.js`、`src/adapters/channels/dsh-im.js`、`src/store.js` | commitObservers 同事务入队；pump 只发 pending；发送前复查 binding/hold/预算；群聊 none 抑制 |
| FR-IM-006 | 群聊只发 summary/none；不带脚本/日记/路径/凭据/未授权附件 | 完成 | `src/adapters/channels/dsh-im.js` | 回信仅 taskId/status；无附件/下载链接 |
| FR-IM-007 | 真实宿主只读探测后启用；未验证报 unavailable/BLOCKED，不自研 SDK | 部分 | `src/adapters/channels/dsh-im.js` | 代码具备 probe/BLOCKED 语义与离线测试；真实宿主未验证（T16.2） |
| FR-IM-008 | 真实 IM 授权消息→草稿→人类审批/拒绝→状态回信 | 未实现 | `test/im-contract.test.js` 等 | 仅 Mock，无真实宿主/消息/回信证据（T12.1 BLOCKED） |

### §23 Artifact（6）

| FR | 设计要求（摘要） | 状态 | 关键代码 | 依据要点 |
|---|---|---|---|---|
| FR-ART-001 | 七类角色、稳定 ArtifactRef、受控导入、拒绝链接/越界/超限、不删源 | 完成 | `src/artifact-store.js`、`src/utils.js` | 角色集合、allowedSourceDirs 空拒绝、软/硬链接与 realpath 越界拒绝、流式 hash |
| FR-ART-002 | 素材 ID 不提供目录读取能力；Runner 只用核心分配临时目录 | 完成 | `src/artifact-store.js`、`src/modules/production.js` | 对外只返回元数据；workDir 由核心分配并 `resolveInside` |
| FR-ART-003 | Runner 清单不是成功证据；核心核验后提交，定稿不可就地改 | 完成 | `src/modules/production.js`、`src/artifact-store.js` | 核心 ffprobe/ffmpeg/hash 复核后 `importManagedOutput`；定稿 chmod 0444 |
| FR-ART-004 | 发布前复核视频/封面摘要与授权，不能用旧 hash 发布被替换文件 | 完成 | `src/modules/publisher.js` | create/prepare 两次 verify 并比对 hash |
| FR-ART-005 | 迁移用相对路径与实际字节；拒绝绝对/越界/跨平台碰撞/链接/额外文件 | 完成 | `src/migration.js`、`src/artifact-store.js` | 导出相对路径 + hash；验证包逐项校验路径/链接/未列出文件 |
| FR-ART-006 | pendingImport 全字段、提交前复核、崩溃恢复；封存前完成 | 部分 | `src/artifact-store.js`、`src/migration.js` | 字段基本齐全、崩溃恢复可用；`expectedMode` 语义偏差、提交前未复核授权/realPath、迁移遇 pending 直接阻塞而非先恢复 |

### §24 独立生产（10）

| FR | 设计要求（摘要） | 状态 | 关键代码 | 依据要点 |
|---|---|---|---|---|
| FR-PRO-001 | 生产独立于 Browse/B 站触发，不默认联网或发布 | 完成 | `src/modules/production.js` | 只依赖 principal/inputs/output/profile；发布另建 Task |
| FR-PRO-002 | profileId 指向本地可信配方；请求不可传 command/args/env | 部分 | `src/modules/production.js`、`src/production/profiles/local-slideshow.js` | 固定阶段/工具版本；请求无 command/args/env；profile 缺 providerRefs（改由请求提供）、requiredInputs 被硬编码替代 |
| FR-PRO-003 | go 需 enabled/allowLocalProducer/人类审批/预检；三级 dry 否决 | 完成 | `src/modules/production.js`、`src/contracts.js` | `effectiveDryRun` 三级；dry 只出 plan/blockedBy，不启动工具、不 ready |
| FR-PRO-004 | executionId/attempt/seq、stageRequest 绑定、不可变尝试 | 部分 | `src/modules/production.js`、`src/adapters/execution/local.js` | executionId 持久预留、seq 幂等/冲突/旧 attempt 忽略；stageRequest 缺 workspaceId/requestId/instanceId/inputArtifactRefs；重复 submit 不按 inputHash 冲突拒绝 |
| FR-PRO-005 | 固定 Runner、有界 JSONL、无 shell、环境白名单、并发 1 | 部分 | `src/adapters/execution/local.js`、`src/production/runner.mjs` | spawn 参数数组/shell:false、输出 1MiB/10MiB、env 白名单、并发 1；runner 读 stdin 上限 4MiB 与 SPEC 1MiB 不符 |
| FR-PRO-006 | 付费 Provider 只经网关、先 Operation+预算、零预算/无上限拒绝 | 完成 | `src/modules/production.js`、`src/effect-gateway.js` | 先 reserveOperation+预算封顶；unknown 冻结；runner 不接触 Provider |
| FR-PRO-007 | cancelRequestedAt 与真实停止分离；unknown 未结算；成功先到保留 | 部分 | `src/modules/production.js`、`src/adapters/execution/local.js` | cancel 只请求、终态依证据；resume 未记录 previousExecutionId/checkpointRef |
| FR-PRO-008 | checkpoint 绑定 stage/profile/inputHash/确认 seq；仅验证完成/restartSafe 阶段可复用 | 部分 | `src/modules/production.js`、`src/production/profiles/local-slideshow.js` | inputHash/profileVersion 绑定与跳过逻辑成立；缺 stageId/lastConfirmedSeq/可恢复类型；`restartSafe` 零消费 |
| FR-PRO-009 | manifest/媒体探测/解码/封面校验通过才 ready；dry/partial 必须 false | 完成 | `src/modules/production.js`、`src/production/profiles/local-slideshow.js` | ffprobe 规格 + ffmpeg 全片解码 + 封面可读 + hash 复核后才 `readyForPublish=true`（真实媒体未复验） |
| FR-PRO-010 | remote 仅预留，请求明确 CAPABILITY_UNSUPPORTED，不降级 local | 完成 | `src/config.js`、`src/index.js` | 显式 remote 抛 CAPABILITY_UNSUPPORTED；无端口/心跳实现 |

### §25 停机迁移（10）

| FR | 设计要求（摘要） | 状态 | 关键代码 | 依据要点 |
|---|---|---|---|---|
| FR-MIG-001 | 仅兼容 schema/state 版本；阶段机；release 前晚到回执回退重封 | 不一致 | `src/migration.js` | 版本/kind/阶段齐全；无 sealed→quiescing 回退；release 回执 cut 与 sealed manifest 脱钩（D-09） |
| FR-MIG-002 | prepare 原子冻结所有新派发/导入；等待执行器停止，无法确认则阻塞 | 部分 | `src/migration.js`、`src/effect-gateway.js`、`src/index.js` | 事务内 quiescing + 各入口门禁成立；执行器检查只看本进程（D-12） |
| FR-MIG-003 | 归档/提交收尾后一致快照；manifest 与全部字节/hash | 部分 | `src/migration.js` | 归档后复制、事务复核 eventSeq、相对路径+hash；pending 是阻止导出而非先恢复；manifest 缺 profile 依赖 |
| FR-MIG-004 | release 持久 retired、票据绑定、幂等、重启仍禁写 | 部分 | `src/migration.js` | 幂等与禁写成立；顺序与设计文字相反、未重验整包（D-20） |
| FR-MIG-005 | 只导入新空目录、暂停、不覆盖；拒绝路径/链接/额外文件 | 部分 | `src/migration.js` | 空目录/暂停/路径校验成立；import 未复核容量上限、旧 execution PID 未清理 |
| FR-MIG-006 | 目标重新绑定秘密/目录/profile/身份；未核验能力不开放 | 部分 | `src/migration.js`、`src/config.js` | 能力白名单/默认 blocked/platform_unverified 成立；重绑依赖外部注入的 activationChecks，默认未做 |
| FR-MIG-007 | activate 核验恢复点/票据/摘要/目标/人类确认，先记决定后开闸 | 部分 | `src/migration.js` | prepared→instance→committed 与断电续办成立；未重验导入摘要、无独立源端停写确认 |
| FR-MIG-008 | 不自动重放旧任务/审批/outbox；migrationHold 待人工 resume | 部分 | `src/migration.js`、`src/task-manager.js` | hold/审批失效/scheduler 关闭成立；migration hold 无释放路径（D-10） |
| FR-MIG-009 | abort/disable-target/rollback 闭环，从目标最新账本反向交接 | 完成 | `src/migration.js` | stop attestation+回读、prepared 反向决定、重试复用、损坏拒绝（`test/migration.test.js` 11 项） |
| FR-MIG-010 | 双 instance/双根目录验证禁写/账本/素材/路径；跨 OS 未测须区分 | 部分 | `test/migration.test.js`、`test/migration-paths.test.js` | 双根+双 instance 模拟通过；真实跨 OS 未实测（T12.3） |

### §27 可信备份与灾难恢复（10）

| FR | 设计要求（摘要） | 状态 | 关键代码 | 依据要点 |
|---|---|---|---|---|
| FR-DR-001 | 备份不是迁移票据；无有效点只保全证据并报 RECOVERY_REQUIRED，不建空账本 | 部分 | `src/store.js`、`src/backup-recovery.js` | 损坏/缺失 fail-closed 成立；缺"保全残存证据"动作 |
| FR-DR-002 | 平台写/付费/IM/External 预留与派发前须独立故障域+未超龄有效点+无 hold | 完成 | `src/effect-gateway.js`、`src/backup-recovery.js`、`src/modules/*` | `getProtection` 年龄判定；`_protectionCheck` 无旁路；§27.8 各入口接线；`test/recovery-gates.test.js` |
| FR-DR-003 | 一致 cut、journalPending 保留、ledger/full 分层、大媒体锁外复制、失败不成新点 | 部分 | `src/backup-recovery.js` | 一致 cut + fence + 锁外复制成立；不等待 pendingImport/pendingCommit 到边界；outbox 在途状态被改写 suppressed |
| FR-DR-004 | manifest 全字段/JCS 两 hash/verify/每日复查/retain 底线/prune 引用检查 | 部分 | `src/backup-recovery.js` | manifest/hash/verify/dailyVerify/restoreTested/保留底线成立；prune 未查恢复引用、无容量预检、无媒体未受保护标志 |
| FR-DR-005 | 独立只读恢复到新空目录，新 epoch/parent，旧审批/通知/scheduler 关闭 | 部分 | `src/backup-recovery.js` | 独立入口/新 epoch/parent/holds/旧权限失效成立；无"先保全受损文件"动作 |
| FR-DR-006 | uncertaintyRange、结构化 RecoveryHold/UnknownExposure、新请求/换 Cookie/新 epoch 不清风险 | 部分 | `src/backup-recovery.js`、`src/contracts.js` | hold/scope 匹配/exposure 冻结成立；`endAt` 永不写入、authorize 不核区间、`exposureId` 未关联 |
| FR-DR-007 | 证据结构与事实修复：有原 Operation 则更新，缺原 ID 只记 recoveredFact；not_sent 需证明 | 部分 | `src/backup-recovery.js`、`src/effect-gateway.js` | 证据结构与 recoveredFact 成立；`not_sent` 允许仅 note；旧 epoch 迟到记录无自动入证据区入口 |
| FR-DR-008 | authorize≠migration activate；旧写者隔离证据 + 分 scope 人类确认；无 force 开关 | 部分 | `src/backup-recovery.js` | isolation 证据强制/scope 确认/refreeze 成立；未强制区间核查、键/额度修复、账号重验、新恢复点 |
| FR-DR-009 | RecoveryCase 字段/phase；recovery.json 两阶段四步 authorize；入口限本地人类；幂等 | 完成 | `src/backup-recovery.js`、`cli.mjs`、`src/index.js` | 四步顺序与断电续办、三方 revision 校验、管理入口限制成立（`test/recovery-evidence.test.js` 5 项） |
| FR-DR-010 | §19.5 故障注入矩阵逐条通过并报告年龄/耗时/缺口；create/verify 不等于演练 | 部分 | `test/disaster-recovery.integration.test.js` 等 | 离线注入 7 覆盖/6 部分/1 未验证；无真实介质/故障域/RPO-RTO |

### §26 轻量加载（4）

| FR | 设计要求（摘要） | 状态 | 关键代码 | 依据要点 |
|---|---|---|---|---|
| FR-LITE-001 | 默认加载不 import 重依赖、不 spawn/poll/whoami；status 只读 cached/unverified | 完成 | `src/index.js`、`src/config.js` | 默认全关闭时零 fetch/零定时器；status `loginProbe:false`；`test/lite-loading.test.js` |
| FR-LITE-002 | 可选组件未启用/不可用不影响核心；启用失败原因明确；禁用后无新调度 | 部分 | `src/index.js`、`src/adapters/registry.js` | 隔离与 CAPABILITY_UNSUPPORTED 成立；status 不报告组件失败原因、禁用后定时器不撤销（G-E12） |
| FR-LITE-003 | 一仓库一核心、按需本地进程；容量/积压可观测 | 完成 | `src/store.js`、`src/index.js` | `status.capacity` 全字段与 80/100MiB 门禁；无中间件/微服务 |
| FR-LITE-004 | 分项报告已实现/未实现/不可用/未实测；真实媒体是生产门槛 | 部分 | `doc/TASKS.md` §10、本报告 | TASKS §10 有分项记录；真实 IM/媒体/跨 OS 仍 BLOCKED/未实测，T13 未完成 |

---

## 附录 B：详细证据文件索引

| 文件 | 内容 | 覆盖要求 |
|---|---|---|
| `.audit-lead/findings-core.md` | 核心状态层逐项对照（54 行）、缺口 #G1～#G12、定向测试 57 项 | SPEC §4/§5/§6/§9/§10/§18 |
| `.audit-lead/findings-gateway.md` | 网关/契约/审批/限流/B 站协议（58 行）、缺口 G-01～G-18、JCS 金标准复算与 3 个探针 | SPEC §7/§8/§21/§22.1-2 |
| `.audit-lead/findings-modules.md` | 业务模块（65 行）、缺口 M01～M14、F04/F05/F07 专项核对、2 个进程内探针 | SPEC §11～§16 |
| `.audit-lead/findings-prodmig.md` | 生产/Artifact/迁移/备份灾备（36 条 FR + §19.5 矩阵 14 行 + §10.3 核对）、缺口 #01～#17 | SPEC §23/§24/§25/§27 |
| `.audit-lead/findings-entry.md` | 入口层（51 行）、缺口 G-E1～G-E15、F01/F02/F03/F06/F10 专项核对、CLI 实测矩阵 | SPEC §3/§17/§18/§22.3/§26 |

> 说明：以上为审查过程证据，含真实 file:line 与定向测试结果；其中 5 项 `spawn EPERM` 与 2 项 skip 均已说明为 Windows 沙箱/符号链接权限的环境限制，非代码缺陷。证据文件当前位于工作区未跟踪状态，是否纳入版本控制由用户决定。

---

## 附录 C：状态口径

| 状态 | 判定标准 |
|---|---|
| 已完成（离线） | 有代码实现且有离线测试/直接代码证据支撑，未发现反例；不代表真实 B 站/IM/宿主/媒体/跨 OS 验收通过 |
| 部分完成 | 实现存在，但接线、入口、运行时驱动、子条款或必要验收不完整 |
| 与设计不一致 | 有明确代码反例，可指出设计原文与实现行为的冲突 |
| 未实现 | 明确的验收交付项未开展（含仅有 Mock、只有历史记录不能复验的情形） |
| 未验证 | 需要真实环境/宿主/介质证据才能判定，代码本身不构成反例 |
