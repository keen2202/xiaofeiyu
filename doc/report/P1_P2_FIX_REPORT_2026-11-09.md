# P1/P2 缺口修复报告（2026-11-09）

- 修复日期：2026-11-09（Asia/Shanghai）
- 输入：`report/IMPLEMENTATION_AUDIT_2026-11-09_POSTFIX.md` §3.4/§4.1/§4.2（约 20 条 P1、约 50 条 P2）
- 协调基线：`report/FIX_PLAN_P1_P2_2026-11-09.md`（接口契约 I1～I11、文件所有权、逐项清单）
- 代码基线：git `e12b7d9` + 第一批修复（工作区未提交），修复后仍在工作区未提交
- 修复方式：5 个文件范围互斥的并行实现者 + Lead 集成/契约仲裁/回归与文档同步
- 验证结果：`npm run check` 98 文件通过；`npm test` **369 项、367 通过、0 失败、2 skipped**（2 项为 Windows 符号链接 fixture 权限限制，非代码失败）

## 一、变更规模

| 项目 | 修复前 | 修复后 |
|---|---|---|
| `src/` | 32 文件 / 17,962 行 | 32 文件 / 22,097 行（+4,135） |
| `test/` | 57 文件 / 8,454 行 | 63 文件 / 14,688 行（+6 文件 / +6,234，其中 5 个 `fix-*.test.js` + 1 个 helper） |
| 自动测试 | 229 项（227 通过、2 skip） | **369 项（367 通过、0 失败、2 skip）** |
| 跟踪文件改动 | — | 59 文件、+6,900 / −1,112 行（不含 6 个未跟踪测试/证据文件） |

## 二、P1 修复清单（全部完成）

> 验证列中 `T` 指对应 `test/fix-*.test.js` 与既有回归测试；所有项均已 `npm test` 全绿。

| # | 缺口 / 审计编号 | 设计要求 | 实现证据（file:line） | 验证 |
|---|---|---|---|---|
| 1 | 评论审批目标可分离（G-E1） | SPEC §17.1 不接受裸 platformData；审批绑定 inputHash | `src/modules/comments.js:116-160,174-207`（拒绝调用方 platformData、adapter 解析 aid/cid 并入 hash、修正 aid 必填）；`src/command-service.js` comment.draft 不再转发 platformData | T fix-modules / comments |
| 2 | 凭据变更不 fail-closed（G-03/#G1） | SPEC §5.2 换 Cookie 重新 whoami、写 fail-closed | `src/credentials.js:136,168,204`（assertWriteAllowed/describeBinding/reconcileCredentialBinding）；`src/effect-gateway.js:229-246,546`（预留+派发事务内校验、Operation.credentialRevision）；`src/index.js:204` 启动对账 | T fix-core / fix-gateway |
| 3 | 412/429 非 JSON 不熔断（G-02） | SPEC §7.4 | `src/bilibili.js:11,339-342`（先按 status 判定、HTTP-date/秒 Retry-After、retryable=false） | T bilibili / fix-gateway |
| 4 | 登录失效无人工暂停（G-01） | SPEC §7.4 | `src/rate-limiter.js:70,88,102`；`src/bilibili.js:228,243,378,445`（写 `accounts[].authPaused*` + 事件）；`account resume` 清除（`cli.mjs`） | T rate-limiter / fix-gateway |
| 5 | 浏览历史未按账号隔离（F05/D-01） | FR-BRO-002/003 | `src/modules/browse.js:26-77,147-168,189-197,230-241`（`bilibili:<accountId>:<BV>`，旧键兼容迁移；`failureCooldownMinutes`/`allowNoSubtitle` 生效） | T fix-modules / browse |
| 6 | 父任务聚合失真（D-08/M01/M07） | SPEC §16/§10.2 | `src/coordinator.js:204-262,331-341`（已结算 failed/partial/unknown 子任务→partial/unknown、不降 failed、interactions 真实状态）；`src/task-manager.js`（recomputeParent、superseded 排除） | T fix-modules / coordinator |
| 7 | 日记自动更新缺失（F07/M03-M06） | SPEC §14/D-09 | `src/coordinator.js:152-180,268-284,379-424`（afterBrowse、双 book、成功才推进、`_exclusive`）；`src/modules/diary.js:123-129,176-235,237-280,454-486,555-582,584-698,713-780`（factsHash 复用、force、锁外生成、markDirty/`__pendingRebuild`、恢复标注） | T fix-modules / diary |
| 8 | 配置更新非原子/不动态（F09/D-02） | SPEC §4.5 | `src/config.js:677,720,807,852,1030`（`.next`→configIntent→rename→revision 事务、reconcile、onChange、sha+version 校验、expectedRevision 强制）；`src/index.js:619,698` 动态刷新调度器/客户端/维护任务 | T fix-core |
| 9 | 迁机/恢复旧审批可复用（G-05/D-07） | SPEC §22.2/FR-IM-004 | `src/approval.js:9,201-242`（失效标志/主体撤销在 decide 与 assertApproved 拒绝） | T approval / fix-gateway |
| 10 | 执行上下文契约未接线（G-04） | SPEC §21.2/§24.2 | `src/contracts.js:347`（createExecutionDispatchContext）；`src/effect-gateway.js:162,196,205`（签发/校验/一次性消费）；`src/modules/production.js:982`；`src/adapters/execution/local.js:26,106,116,196` | T fix-prodmig / local-execution |
| 11 | reserved Operation 无取消入口（G-06） | SPEC §7.3 | `src/effect-gateway.js:1013,1110`（cancelOperation：仅未派发、释放额度/业务键、审计、幂等）；CLI `operation cancel` | T fix-gateway / fix-entry |
| 12 | 迁移 sealed 晚到回执无重封（D-09/#01） | FR-MIG-001/DESIGN §8.6-2 | `src/migration.js:630`（noteLateLedgerWrite：sealed→quiescing、lateReceipts、作废封存包）；`:507,557,940`（release 回执 cut 取自 sealed manifest、导入摘要重验）；`src/effect-gateway.js:267-269` 同事务调用 | T fix-prodmig / migration |
| 13 | migration hold 无释放路径（D-10/#02） | FR-MIG-008 | `src/migration.js:661`（releaseTaskHold：kind=migration、审计、recompute）；CLI `migration release-hold` | T fix-prodmig / fix-entry |
| 14 | uncertaintyRange 不闭合（D-11/#03） | FR-DR-006 | `src/backup-recovery.js:2472,2598`（隔离证据写 coveredRange/endAt 并闭合）；authorize 校验证据覆盖区间 | T fix-prodmig / recovery-evidence |
| 15 | authorize 缺解冻前置（#04） | FR-DR-008 | `src/backup-recovery.js:1787`（区间覆盖、永久键/额度修复证据、账号重验、新 verified 恢复点 `protection.verify`） | T fix-prodmig / recovery |
| 16 | prepare 只见本进程执行器（D-12/#05） | FR-MIG-002 | `src/migration.js:133,158,198`（扫描存活执行属主、强制 executorStopEvidence、BLOCKED 时不置 quiescing）；CLI `migration prepare --executor-stop-evidence` | T fix-prodmig / fix-entry |
| 17 | 备份捕获不等待 pending（#10） | FR-DR-003 | `src/backup-recovery.js:556,623,644`（容量预检、prepareCapture、pendingExcluded）；`src/index.js:151-190` 注入恢复回调 | T fix-prodmig / backup |
| 18 | prune 引用/媒体/容量不足（#11） | FR-DR-004 | `src/backup-recovery.js:1206,1269,1327`（恢复引用 pin、删除后媒体覆盖校验、mediaUnprotected）；`:879,959,1152,1175` | T fix-prodmig / backup-retention |
| 19 | 备份索引跨进程覆盖（F11/#06） | SPEC §27.2/3 | `src/backup-recovery.js:368,501`（索引文件锁 + version CAS） | T fix-prodmig / backup |
| 20 | Artifact pendingImport 细节（ART-006） | FR-ART-006 | `src/artifact-store.js:249,272,308,312`（fileMode、提交前 principal/realPath/权限复核）；`src/migration.js:180-200` 导出前先恢复 pending | T artifact-store / fix-prodmig |
| 21 | 生产协议字段/检查点（PRO-004/005/007/008） | FR-PRO-004/005/007/008 | `src/modules/production.js:891,919,959,982,1047,1131,1135`（stageRequest 字段、previousExecutionId/checkpointRef、stageId/lastConfirmedSeq、JCS manifestHash、restartSafe）；`src/adapters/execution/local.js:139`（重复 submit 冲突）；`src/production/runner.mjs:15,253`（单消息 1MiB） | T fix-prodmig / production |
| 22 | HTTP 无信任栅栏（D-04/G-E2） | SPEC §17.1 | `src/index.js:1094-1260`（apply 消费宿主 `connection`/`trust`，缺失 fail-closed）；`src/index.js:43`（mode 缺失拒绝） | T fix-entry / dsh |
| 23 | CLI 人类证明不满足（D-05） | SPEC §17.3 | `cli.mjs:60,78,94`（展示 action/对象/摘要/hash，短语绑定与服务侧 binding 对齐）；`--confirm` 强制 | T fix-entry / cli |
| 24 | CLI 写命令绕过 CommandService（D-06） | TASKS T10 | `cli.mjs:158,176,244,348,394,522,555,578,669,771`（统一 `execute`、`cli-*` requestId、`sourceKind:'cli'`） | T fix-entry / cli |
| 25 | Cordis 挂载 enabled/生命周期/静态导入（F10/D-（G-E5）） | SPEC §3.3/FR-LITE-001/002 | `src/index.js:1094-1260`（enabled/httpPrefix 消费、lifecycle 注销、dsh-im/migration 动态 import）；`cordis.patch.yml:7`（schemaVersion） | T fix-entry / dsh / lite-loading |
| 26 | IM 动作白名单越界（D-19） | FR-IM-003 | `src/command-service.js:93`（IM_ACTIONS 移除 task.resume）；`src/identity.js:15`（IM_SCOPES 移除 task.resume.own，KNOWN_SCOPES 保留给本地/host 人类入口） | T command-service / im-contract / identity |
| 27 | Task revision 永不递增（D-13）/组合校验 | SPEC §21.1/§10.1 | `src/task-manager.js:411`（reviseInput）、resume revision+1、`hasUnknownOperation`、succeeded 计 pendingApprovals、`src/store.js:288` 组合校验接入 validateState | T fix-core / task-manager |
| 28 | 发布元数据硬编码（D-14） | SPEC §15.2 | `src/adapters/platforms/bilibili.js:15-26,268`（capabilities limits + validatePublishMetadata）；`src/modules/publisher.js:104-165`（优先适配器、回退） | T fix-modules / fix-gateway |
| 29 | 备份索引/媒体未受保护标志（DR-011） | FR-DR-004/§27.3 | `src/backup-recovery.js:879,959,1152,1175,1349-1359`（mediaUnprotected/reason 暴露） | T backup |
| 30 | 灾备现场保全缺失（DR-001/005） | FR-DR-001/005 | `src/backup-recovery.js:2337`（preserveCorruptSource：只读复制现场并记录 hash）；CLI `recovery preserve` | T fix-prodmig / fix-entry |

## 三、P2 修复清单（全部完成）

| 主题 | 实现证据 |
|---|---|
| 读额度/时间槽（G-09） | `src/rate-limiter.js:157-187`（reserveRead enforceGap/readNextAllowedAt）；`src/bilibili.js:190,401-411`（每次读尝试预留） |
| BilibiliClient 构造签名/热更新（G-10） | `src/bilibili.js:142,182`（reconfigure、可选 store/rateLimiter 默认接线） |
| Cookie 重定向白名单（G-12） | `src/bilibili.js:272,330`（`redirect:'manual'` + 逐跳 host 校验） |
| resolve 幂等/External BV（G-13） | `src/effect-gateway.js:1156,1225`（回执比较、BV 校验、evidenceRef） |
| 通知派发门禁（G-14） | `src/effect-gateway.js:1762-1764`（`_assertConfig`/`_assertInstance`） |
| DM 互关协议层（G-11） | `src/bilibili.js:247,633`（mutualVerifier/mutualVerified）；adapter 传值 |
| X/抖音/remote 契约测试（G-18） | `test/helpers/mock-platforms.js`（新增）；`test/fix-gateway.test.js` 不注册/CAPABILITY_UNSUPPORTED 断言 |
| 删除适配器死代码（G-16） | `src/adapters/platforms/bilibili.js`（_beforeRead/_onRisk 已移除） |
| 并发归档幂等（#G6） | `src/event-journal.js`（同段同 hash 幂等成功，不再误报 JOURNAL_CORRUPTED） |
| 容量统计缓存（#G12） | `src/store.js:660`（allowCache，30s recovery 扫描缓存；status 默认 fresh） |
| prune 接线与保护（#G5） | `src/store.js:883`（prune 加固未结算/hold/审批/执行/请求/outbox/发布引用）；`src/index.js:512`（maintenance 30 tick 调用） |
| 100MiB 门禁统一（#G10） | `src/store.js` assertBusinessAcceptance + `src/command-service.js`（diary.generate 等本地生成接入） |
| 配置死代码（#G11） | `src/config.js`（空 fail-closed 块、ABSOLUTE_OR_EMPTY、allowForeignRevision 清理） |
| 归档/事件时间/内存 | `src/event-journal.js`、`src/store.js`（幂等、缓存、状态容量观测） |
| 日记 force/叙述/恢复标注（M04/M05） | `src/modules/diary.js:123-129,454-486,555-582,584-698,713-780` |
| External 输出脱敏（M09） | `src/modules/publisher.js:168-182,710-726`（redactSecrets） |
| Manual 作废入口（M10） | `src/modules/publisher.js:942-1038`（markNotPublished）；CLI `publish void` |
| publisher input schema（M14） | `src/modules/publisher.js:180-204`（schemaVersion=1、拒绝未知字段与 approved） |
| browse discovery 口径（M12） | `src/modules/browse.js:257-269`（Task/result 统一 partial） |
| DM 冷却入事务（M13） | `src/modules/direct-messages.js:174-186,259-262`；`src/effect-gateway.js:572`（reserveOperation cooldown） |
| notify/outbox capturedStatus | `src/backup-recovery.js:184`（在途通知保留原始状态并标 capturedStatus） |
| recovery exposureId 关联（#12） | `src/backup-recovery.js:2004,2035` |
| not_sent 证据收紧（DR-007） | `src/backup-recovery.js:2509`（需 receipt 或 coveredRange+sourceHash+note） |
| 迁移 manifest/import/activate（MIG-003/005/007） | `src/migration.js:426`（profileDependencies）、`:714,756`（import 容量）、`:1686`（旧 PID sanitize）、`:979,1021`（activate 重验+sourceStopped）、`:557`（release 顺序） |
| 恢复副本父链（#17） | `src/backup-recovery.js:651,822`（parentRecovery/case/evidence refs） |
| profile 声明（PRO-002） | `src/production/profiles/local-slideshow.js:17,20,36,204`（requiredOutputs/providerRefs/restartSafe 声明与校验） |
| outbox 捕获语义 | `src/backup-recovery.js:184,644`（capturedStatus/pendingExcluded） |
| Task 移除 IM resume scope | `src/identity.js:12-25`（IM_SCOPES 仅保留 FR-IM-003 白名单；task.resume.own 保留在 KNOWN_SCOPES 供本地/宿主人类入口） |
| 错误 message 脱敏/任务投影 | `src/errors.js`（toJSON message 脱敏）；`src/index.js:746-780`（status components/credentials、任务字段白名单投影） |
| CLI status 只读（D-18） | `src/identity.js:72`（findLocalOwner）+ `cli.mjs`（不再写账本；实测连续 status 后 state.json hash 不变） |
| 1MB body 字符串形态 | `src/index.js:809`（body 字符串解析后限长） |

## 四、接口契约落地（FIX_PLAN I1～I11）

| 契约 | 实现 |
|---|---|
| I1 凭据写门禁 | `credentials.assertWriteAllowed/describeBinding/reconcileCredentialBinding`；gateway 预留+派发事务内校验；Operation.credentialRevision |
| I2 配置提交/动态生效 | `config.update(reconcile/intent/onChange)`；`index.js` 注册 onChange 刷新 coordinator/agent/client/maintenance |
| I3 Task 修订与结算 | `taskManager.reviseInput`；resume revision+1；组合校验入 validateState；browse 父任务聚合 partial |
| I4 ExecutionDispatchContext | `contracts.createExecutionDispatchContext`；gateway issue/verify/consume；production 签发；local backend 校验 |
| I5 迁移晚到回执 | `migration.noteLateLedgerWrite`；gateway `_settleDispatch`/`resolve` 同事务调用 |
| I6 resolve→日记待重建 | `diary.markDirty`；gateway 同事务调用；diary.generate 消费 `__pendingRebuild` |
| I7 DM 冷却事务内 | `reserveOperation({cooldown})`；direct-messages 传入 |
| I8 发布元数据能力 | adapter `validatePublishMetadata` + capabilities limits；publisher 优先调用 |
| I9 受信本地命令 | `cancelOperation`、`markNotPublished`、`releaseTaskHold`、`preserveCorruptSource`、`clearAuthPause` + CLI/命令白名单 |
| I10 状态字段放行 | `store.validateExtendedNestedState`（缺省放行、存在则形状校验 fail-closed） |
| I11 维护/预约 | maintenance 30 tick `store.prune()`；CLI 稳定 requestId/sourceKind |

## 五、Lead 集成修复（并行实现后的收口）

| 问题 | 修复 |
|---|---|
| `identity.IM_SCOPES` 仍含 `task.resume.own`，与 FR-IM-003 白名单不一致 | `src/identity.js:12-25`：从 IM_SCOPES 移除，保留在 KNOWN_SCOPES 供本地/宿主人类入口；`command-service` 的 IM 动作集已不含 task.resume |
| 全量测试出现 Windows 锁文件 EPERM 偶发失败（`_tryStealStaleLock` 读取 delete-pending 锁文件） | `src/store.js:572-600`：`EPERM/EACCES/EBUSY` 视为锁竞争并在 deadline 内重试，不再误报 `STORE_CORRUPTED` |
| `fix-prodmig.test.js` I4 用例在完整权限环境 EBUSY（子进程仍占用临时工作目录） | `test/fix-prodmig.test.js:25,374`：新增 `removeDirWithRetry`，并在 finally 中 `close()` 两个 backend 后再清理 |
| 文档状态与测试数字过时 | `DESIGN.md`、`SPEC.md`、`TASKS.md`：更新状态行、配置字段（`browse.failureCooldownMinutes/allowNoSubtitle`）、§4.5 配置提交协议、§17.1 信任栅栏/mode、§17.3 新 CLI 命令、§27.7 preserve/authorize 接口、§27.8 实现状态；TASKS §10.2 更新为 369/367/2，新增 §10.6 修复记录 |

## 六、未完成 / 未实测（真实环境门槛，未以 Mock 冒充）

- T16.2 真实 DSH/IM 只读探测：真实宿主服务注册、消息来源、人类证明语义未取得可核验证据 → BLOCKED。
- T12.1 真实 IM 闭环、T12.2 真实 B 站写/External 发布：无授权与真实环境 → BLOCKED/未实测。
- T12.3 真实 Windows/Linux 跨 OS 迁移：仅双目录/双 instance 模拟 → 未实测。
- T17.3 真实本地 MP4/封面：本机无 ffmpeg/ffprobe，未运行真实媒体验收；历史记录不作为本次证据。
- T22 真实故障域/物理介质/RPO-RTO：仅临时目录故障注入 → 未实测。
- `§9` 记忆规划：GATE-MEM 未审核，不实施。
- 覆盖率：本次未复跑；TASKS 历史数字（79.41%/62.77%/72.12%）不适用于新代码规模。

## 七、验证方法

```bash
# 语法检查（98 个 .js/.mjs）
node scripts/check.mjs

# 全量离线测试（369 项；2 项 skip 为 Windows 符号链接权限）
npm test

# 逐文件回归（沙箱内可用；spawn 依赖用例需完整权限）
node test/fix-core.test.js && node test/fix-gateway.test.js \
  && node test/fix-modules.test.js && node test/fix-prodmig.test.js && node test/fix-entry.test.js
```

结果：369 项、367 通过、0 失败、2 skipped、22.0s；`node scripts/check.mjs` 输出 `98 files syntax-checked; OK`。

## 八、残留风险与注意事项

1. **未提交**：所有修复仍在工作区（HEAD 仍为 `e12b7d9`），建议按工作项分组提交并附本报告与测试日志。
2. **真实环境未验收**：本报告中所有"已修复"均为离线行为与单元/集成测试证据，不构成真实 B 站/IM/External/媒体/跨 OS 验收。
3. **测试环境敏感**：`local-execution` 与 `publisher` external 用例依赖真实子进程；受限沙箱内会报 EPERM，需要在完整权限环境运行（本次已在完整权限下确认全绿）。
4. **2 项 skip**：Windows 需 Developer Mode/符号链接权限才能构造 fixture；**未记为通过**，具备权限的环境应复跑。
5. **覆盖率**：新代码规模显著增长（+4,135 行 src/+6,234 行 test），旧覆盖率数字不能沿用，建议重跑 `npm run test:coverage`。
6. **真实闭环前的剩余验证建议**：优先按 T17.3（真实媒体）→ T16.2（真实宿主只读探测）→ T12.1/T12.2 → T12.3 → T22 的顺序逐项申请环境与授权并单独出具证据。
