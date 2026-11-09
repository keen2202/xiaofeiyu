# 生产/迁移/灾备审查

- 审查对象：工作区 `D:\Workespace\xiaofeiyu`，git HEAD `e12b7d9` + 未提交的第一批修复。本范围源码文件中仅 `cli.mjs` 有未提交改动；`src/artifact-store.js`、`src/adapters/execution/local.js`、`src/production/*`、`src/modules/production.js`、`src/migration.js`、`src/backup-recovery.js` 与 HEAD 一致；`test/artifact-store.test.js`、`test/migration-paths.test.js` 有未提交改动（测试，不影响下述结论）。§27.8 派发接线与门禁核实需要引用当前工作树中已修改的 `src/effect-gateway.js`、`src/contracts.js`、`src/task-manager.js`、`src/store.js`、`cli.mjs`，相关行号均来自本次实际读取，属当前工作树状态。
- 对照文档：`doc/SPEC.md` §19.5/§23/§24/§25/§27、`doc/DESIGN.md` §8.3/§8.6/§8.7/D-14/D-16/D-19/D-20、`doc/TASKS.md` T15/T17/T18/T20/T21/T22 与 §10.3。
- 方法：只读 `src/`、`test/`、`doc/`，逐函数阅读并以 `read`/`grep` 得到的真实行号为证据；另运行了允许的进程内定向 `node test/<file>.test.js`（见末节）。未运行 `npm test`/`npm run check`（Windows 沙箱 spawn EPERM 限制，非代码缺陷），未运行任何真实媒体/迁移/恢复命令。
- 历史报告中的 F11 与 TASKS §10.3 记录均已按当前代码重新核实，不以历史结论代替本次证据。

## 结论摘要（FR 计数）

范围：FR-ART-001～006（6）、FR-PRO-001～010（10）、FR-MIG-001～010（10）、FR-DR-001～010（10），合计 **36 条**。

| 状态 | 数量 | FR 列表 |
|---|---|---|
| 已完成（离线） | 13 | ART-001~005；PRO-001/003/006/009/010；MIG-009；DR-002/009 |
| 部分完成 | 22 | ART-006；PRO-002/004/005/007/008；MIG-002/003/004/005/006/007/008/010；DR-001/003/004/005/006/007/008/010 |
| 与设计不一致 | 1 | MIG-001（sealed 晚到回执/重新封存子条款缺失且 release 回执 cut 与快照脱钩） |
| 未实现 | 0 | — |
| 未验证（不在 FR 行计数内） | — | 真实媒体验收、真实故障域/物理介质、跨 OS、真实 TTY/宿主人类证明、真实平台写/付费 Provider、真实 RPO/RTO 实测 |

补充计数：
- §19.5 故障注入矩阵 14 行：离线测试已覆盖 7 行、部分覆盖 6 行、仅记录/未实测 1 行（详见第二节表格）。
- TASKS §10.3 的 14 条限制声明均未夸大当前实现；其中 #1 是纯文档状态声明、#9 处 runner 单消息上限与 SPEC 仍有残留偏差（见缺口 #08），其余与代码一致（个别外部条件本身仍需环境验证，声明已如实标注）。
- 已确认仍未修复的历史 F11：备份库索引只有**进程内 Promise 串行锁**，无跨进程文件锁/CAS（见缺口 #06）。

## 逐项对照表

### §23 ArtifactStore（FR-ART-001～006）

| FR/条款 | 状态 | 代码位置 file:line | 判断依据 | 备注 |
|---|---|---|---|---|
| FR-ART-001 ArtifactRef 七角色、受控导入 | 已完成（离线） | `src/artifact-store.js:45-53`、`:528-536`、`:125-166`、`:227`、`:289`；`src/utils.js:380-420` | `ROLE_EXTENSIONS` 覆盖 script/image/clip/audio/subtitle/video/cover 七角色；`publicRef` 恰为 `{artifactId,sha256,sizeBytes,mediaType,role}`；外部导入先校验七角色；`allowedSourceDirs` 为空直接拒绝（`:130-134`），`lstat` 拒软链（`:142`）、`nlink>1` 拒硬链（`:144`）、`realpath` 后 `ensureWithin` 拒越界（`:145-149`）、大小上限（`:159-164`）、`copyFileWithHash` 流式 hash 复制（`utils.js:380-420`）、只读取源不删除 | 角色集合在 `src/contracts.js:247` 的 `ARTIFACT_ROLES` 一致 |
| FR-ART-002 不提供目录读取能力、核心分配临时目录 | 已完成（离线） | `src/artifact-store.js:332-355`、`:357-374`；`src/modules/production.js:853-858`；`src/adapters/execution/local.js:80-84`；`src/production/runner.mjs:145-162` | 对外只按 artifactId 返回元数据，绝对路径解析 `resolveManagedPath` 仅内部使用；生产 workDir 由核心 `randomId('exec')` + `resolveInside(workDir)` 分配；Runner 只接受该 workDir 与 `allowedInputRoots`，输出路径 `isInside(workDir)` 才允许；`importManagedOutput` 只接受 `ensureWithin(workDir)` 内普通文件（`:191-194`） | 共享素材 ACL 实际为 workspace 归属 + `visibility=private` 仅人类可读（`:339-349`），未实现更细粒度逐项授权，属最小实现 |
| FR-ART-003 Runner 清单非成功证据 | 已完成（离线） | `src/modules/production.js:964-982`、`:991-1017`、`:1026-1035`；`src/production/profiles/local-slideshow.js:226-310` | Runner 成功回执仅做"路径安全性"结构检查；核心再以 ffprobe+ffmpeg 解码（`validateLocalMedia`）复核实际字节，然后 `importManagedOutput` 复核 hash/大小并提交受管理产物，最后才置 `readyForPublish=true`（`:1066-1093`） | 定稿后 `chmod 0444`（`artifact-store.js:270`）；账本以不可变 artifact 记录表达"内容定稿"，无就地修改 API |
| FR-ART-004 发布前复核摘要与授权 | 已完成（离线） | `src/modules/publisher.js:134-155`、`:369-374`、`:477`、`:699-702` | 创建发布任务时 `artifactStore.verify` 复核字节并绑定 production 的 video/cover artifactId；实际派发前再次 `verify` 并比对 `task.input.videoSha256/coverSha256`，不一致抛 `ARTIFACT_INVALID`；发布有独立 Approval/Operation 门禁 | 发布途经受保护派发（effect gateway） |
| FR-ART-005 迁移相对路径、实际字节、路径安全 | 已完成（离线） | `src/artifact-store.js:417-439`；`src/migration.js:225-231`、`:271-289`、`:303-304`；`src/migration.js:1364-1417`；`src/utils.js:267-300` | 导出用 posix 相对路径并复制实际字节；artifact 导出逐项 hash 复核；manifest 路径逐条 `isSafeRelativePath`、`platformPathCollision`、`resolveInside`；验证包拒绝对路径/`..`/保留名/软链/重复条目/未列出文件/摘要不符 | 未列出文件检查见 `migration.js:1400-1408` |
| FR-ART-006 pendingImport 字段与崩溃恢复 | 部分完成 | `src/artifact-store.js:241-256`、`:266-275`、`:276-309`、`:441-502`；`src/migration.js:190-195` | pendingImport 含 `{artifactId,sourceRealPath,tempFile,targetFile,expectedSha256,expectedBytes,expectedMode,requestedRole,requestedVisibility,principalId,sourceType,mediaType,phase,createdAt}`；`tmp` 内流式 copy→账本记录→原子 rename→chmod；`recoverPendingImports` 按 hash 识别 final/temp 并只回收受控 tmp；迁移导出遇到 pendingImport/pendingCommit 时直接 `MIGRATION_BLOCKED` | 偏差：①`expectedMode` 取值是 `import/derived` 语义，并非文件权限模式，提交前未复核 0444 权限；②提交前未重新校验 principal 授权/realPath（只复核 pending 存在与 hash）；③"迁移封存前完成 pendingImport/日记 pendingCommit"实现为阻止导出而不是先完成恢复 |

### §24 独立生产与 ExecutionBackend（FR-PRO-001～010）

| FR/条款 | 状态 | 代码位置 file:line | 判断依据 | 备注 |
|---|---|---|---|---|
| FR-PRO-001 生产独立于 Browse/B 站 | 已完成（离线） | `src/modules/production.js:158-327`；`src/task-manager.js:65-93` | `create()` 只依赖 principal/inputs/output/profile，不触达 Browse/B 站账号；task kind=production、workspaceId 由账本绑定；发布另建 PublishTask（`publisher.js`） | — |
| FR-PRO-002 profile 固定、请求不可传 command/args/env | 部分完成 | `src/production/profiles/local-slideshow.js:11-32`、`:115-170`；`src/modules/production.js:158-195`、`:859-883` | profile 固定 `stages=['script','assets','voice','render','validate']`、restartSafe、outputLimits、toolVersionRange；请求字段仅 requestId/brief/profileId/inputs/output/mode/limits/providerRefs，无 command/args/env；stageRequest 的 tools/plan 由核心从 profile 与已校验输入生成；profileId 只允许 local-slideshow-v1 | 偏差：profile 缺规格要求的"可选 providerRefs"（providerRefs 改由请求提供并在 `:175-195` 校验）；`requiredInputs` 声明后被硬编码检查替代（`:145-148`）；profiles.json 可经 `deepMerge` 覆盖 stages/restartSafe（本地可信配置，风险低） |
| FR-PRO-003 三级 dry 与 go 前置 | 已完成（离线） | `src/contracts.js:168-187`；`src/modules/production.js:215-231`、`:294-308`、`:339-348` | `effectiveDryRun` 合并 global/production/invocation 三级；dry 只落 plan+blockedBy、不调 preflight/工具、`readyForPublish=false`；go 校验 production.enabled、allowLocalProducer、人类审批、profile preflight 后才启动 | 创建 dry 任务直接终态 succeeded(dry)，之后不因配置变化转 go，需重新提任务 |
| FR-PRO-004 不可变执行尝试与 stageRequest 字段 | 部分完成 | `src/modules/production.js:853-919`；`src/adapters/execution/local.js:89-99`、`:275-290` | executionId 由核心在持久预留时生成（`:853`）；先在同一事务持久化 execution 记录+输入 hash（`:884-919`）再 submit（`:923`）；seq 单执行递增、同 seq 同内容幂等、异内容失败、旧 attempt 回执忽略；terminal executionId 不允许重启（`local.js:91-93`） | 偏差：stageRequest 缺规格要求的 `workspaceId/requestId/instanceId/inputArtifactRefs` 字段（`:859-883` 只有 executionId/taskId/stageId/attempt/inputHash/profileId/tools/workDir/allowedInputRoots/limits/plan）；backend 对同 executionId 的重复 submit 直接去重返回，未按 `requestId/inputHash` 冲突拒绝（`local.js:89-99`） |
| FR-PRO-005 固定 runner、有界 JSONL、无 shell、环境白名单、maxConcurrent=1 | 部分完成 | `src/adapters/execution/local.js:8-9`、`:101-103`、`:145-151`、`:179-217`、`:255-263`；`src/production/runner.mjs:49-62`、`:247-255` | `spawn(node,[runnerPath],{shell:false})` 固定入口+参数数组；stdout JSONL 单行≤1MiB、总输出≤10MiB，超限收尾失败；env 白名单 PATH/LANG/LC_ALL/TMPDIR/TEMP/TMP/SystemRoot，不含 Cookie/账本路径；默认 maxConcurrent=1；runner 内 `execFile` 调用 ffmpeg/ffprobe 且环境再次收窄 | 偏差：runner 读 stdin 的单消息上限为 **4MiB**（`runner.mjs:251-253`），与 SPEC FR-PRO-005"单消息≤1MiB"不一致；`spawn` 与 DESIGN 的"execFile 无 shell"文字不同但 TASKS §10.3#9 已声明等价 |
| FR-PRO-006 付费 Provider 仅经网关与预算封顶 | 已完成（离线） | `src/modules/production.js:664-761`；`src/effect-gateway.js:314-346`、`:287-312`、`:431-571` | 付费文本调用先 `reserveOperation`（namespace=provider、protected、budget{amountMinor,capMinor}、approvalId+approvalAction）再 `dispatchOperation`；quote 必须是整数且 ≤ 授权上限、currency 不可换算；预算按 workspace:provider:budgetId 累计 `spent+reserved+unknown` 封顶；unknown 冻结且不可自动重试；runner 进程不接触 Provider | 业务键含 attempt，但预算累计在同一 budget key 上，resume 不重置；`test/production-budget.test.js` 4 项通过（本次实跑） |
| FR-PRO-007 cancel≠停止、unknown 不结算 | 部分完成 | `src/adapters/execution/local.js:418-432`、`:347-380`；`src/modules/production.js:566-568`、`:984-987`、`:1198-1214`、`:1158-1196` | cancel 只置 cancel_requested/发 SIGTERM，终态由 child 退出与证据决定；succeeded 先到不回滚；unknown 时任务置 unknown 且 `readyForPublish=false`；本地 cancelled 且无平台副作用时才终止 Task | 偏差：resume 创建新 executionId+attempt 但未记录规格要求的 `previousExecutionId/checkpointRef`（`production.js:853-855` 仅按历史执行数算 attempt）；`_cancelTask` 对 running 任务一律带 `provenUndispatched:true`（`:1170-1175`），对本地免费阶段成立，但命名/语义与平台侧不通用 |
| FR-PRO-008 checkpoint 复用条件 | 部分完成 | `src/modules/production.js:460-474`、`:609-618`、`:640-645`、`:806-818`、`:970-982`；`src/production/profiles/local-slideshow.js:17` | 阶段 checkpoint 含 inputHash/profileVersion/上游引用/媒体结果；仅"阶段 succeeded/skipped 且 checkpoint.inputHash===task.inputHash"才跳过；run 时校验 profile.version 与创建时一致，变化要求重批；跨端复用只认已持久化验证阶段 | 偏差：checkpoint 缺 `stageId/lastConfirmedSeq/可恢复类型` 字段；profile 的 `restartSafe` 声明在 src 中无任何消费点（grep 仅定义处），"只有 restartSafe 阶段才可显式重跑"未实现——resume 时 render（restartSafe=false）也会整体重跑 |
| FR-PRO-009 成功门禁与 manifest | 已完成（离线） | `src/modules/production.js:991-1094`、`:1036-1054`；`src/production/profiles/local-slideshow.js:226-310` | 核心侧 `validateLocalMedia` 用 ffprobe 检查宽高/fps/时长/大小/音轨/字幕/封面可读，再用 ffmpeg `-f null` 全片解码；通过后导入 video/cover 两个受管理 Artifact；manifest 含 schemaVersion/profileId/profileVersion/inputHash/stages 摘要/artifacts/media/validatedAt；仅在这些之后置 `readyForPublish=true` 并落 productions | 小偏差：`manifestHash` 用 `sha256Hex(JSON.stringify(manifest))`（`:1064`），不是 §21.1 的 `jcs-sha256-v1:` 带版本 JCS 散列；不影响本 FR 门禁语义，但跨 FR 规范格式不一致 |
| FR-PRO-010 remote 仅预留、明确拒绝 | 已完成（离线） | `src/config.js:354-370`；`src/index.js:212-223` | 配置枚举只允许 local/remote；显式 `production.backend='remote'` 时抛 `CAPABILITY_UNSUPPORTED{capability:'execution.remote'}`；src 中无端口监听/心跳/远程传输实现 | 满足"请求该 backend 明确 CAPABILITY_UNSUPPORTED" |

### §25 停机迁移（FR-MIG-001～010）

| FR/条款 | 状态 | 代码位置 file:line | 判断依据 | 备注 |
|---|---|---|---|---|
| FR-MIG-001 版本/kind/状态机/晚到回执 | 与设计不一致 | `src/migration.js:28-32`、`:455-471`、`:1364-1417`、`:180-375`、`:377-448`、`:413-414` | 版本门禁齐：manifest schemaVersion=1/kind=migration/stateVersion=3（`:460-465` 与 `:1366-1371`），kind=backup 被拒；源/目标阶段常量齐全；prepare/export/release/import/validate/activate/abort/disable-target/rollback 均实现 | **不一致点**：全库 grep `quiescing` 无任何 `sealed→quiescing` 回退/重新封存逻辑（仅 prepare/export/abort 使用），DESIGN §8.6-2 与 FR 明确要求"release 前晚到回执使 sealed 回到 quiescing、落账后重新 export 并更换 snapshotHash"；且 release 回执的 `cutEventSeq` 取 release 时刻 `state.eventSeq`（`:413-414`），而 sealed manifest 无 cutEventSeq 字段，若 sealed 后发生任何落账（结算路径 `effect-gateway.js:644-694` 无迁移门禁，晚到回执可写源账本），回执 cut 与快照内容脱钩；"release 后回执只交目标核查"也无实现（源端正常记账，无转交路径） |
| FR-MIG-002 prepare 原子冻结与执行器停止 | 部分完成 | `src/migration.js:127-174`；`src/contracts.js:194-205`；`src/effect-gateway.js:182-192`、`:431-571`、`:573-625`；`src/artifact-store.js:94-123`；`src/index.js:371-374` | prepare 先人类证明→workspace RecoveryHold→健康恢复点（`:127-139`），再事务内原子置 quiescing（`:142-167`）；新任务/配置/素材导入/平台写/付费/通知/本地阶段均被 `assertWritablePhase`/`_assertMigration`/`_assertInstance` 冻结；等待槽位的 reserved 操作在 `_prepareDispatch` 同样被 `_assertMigration` 拒绝；已派发回执仍可落账（结算无 phase 门禁） | 偏差：执行器"停止"仅读取**本进程** `executionBackend.active`（`index.js:371-374`），CLI 的 prepare 必然看到 0，无法证明另一常驻进程/外部发布器/发送器已停止；prepare 也不主动请求 stop/close，只在不满足时抛 BLOCKED（`:168-172`，且 migration 已置 quiescing，需 abort 解锁） |
| FR-MIG-003 一致快照、归档、manifest、字节 | 部分完成 | `src/migration.js:180-375`、`:305-327`、`:330-333` | 导出前 `journal.archiveAll`；复制后事务内复核 `eventSeq`/migrationId 未变才置 sealed；复制一律相对路径+`copyFileWithHash`+hash 校验；manifest 含 schemaVersion/kind/stateVersion/migrationId/workspaceId/source/target ID/historyEpoch/configRevision/timeZone/stableAccountRefs/recoveryRefs/createdAt/sealedAt/fileCount/totalBytes/files/snapshotHash；超 maxFiles/maxTotalBytes、路径冲突、文件缺失均失败且仅清理 tmp | 偏差：①pendingImport/pendingCommit 是阻止导出（`:190-195`）而不是"导出前完成恢复"；②manifest 缺规格列出的"profile 依赖"字段；③失败错误未持久化到 migration 记录（仅抛给调用者），源端保持 quiescing |
| FR-MIG-004 release 持久 retired、幂等 | 部分完成 | `src/migration.js:377-448` | 校验 sealed 包 snapshotHash 与账本一致（`:396-404`），写 receipt.json（`:405-418`），事务置 released（`:419-439`），再 `updateInstance` 置 retired 并清空 capabilities/递增 activationRevision（`:440-446`）；重复 release 走 `:382-395` 补齐 retired 并返回原回执；崩溃后 released phase 仍经 `_assertMigration` 禁派发 | 与设计文字顺序相反：DESIGN/FR 写"持久标 retired → 生成交接回执"，代码是"先写回执文件→账本 released→instance retired"；崩溃窗口仍 fail-closed（phase=released 已禁写），语义可接受但属实现偏差；release 前未重新 verify 整包字节（只核对 manifest.snapshotHash） |
| FR-MIG-005 只导入新空目录、不覆盖、不重放 | 部分完成 | `src/migration.js:455-586`、`:487-519`；`src/migration.js:1364-1417` | 目标目录必须不存在或为空（`:466-471`）；verifyMigrationPackage 校验版本/清单/逐文件 size+hash/相对路径/重复/软链/未列出文件/路径前缀冲突；新 targetInstanceId、paused、allowedCapabilities=[]、schedulerDisabled；approvals nonceHash=null+usableForAuthorization=false+invalidatedByMigration；bindings 置 requiresReverification；outbox pending/sending→suppressed；非终态任务加 migration hold 并 isSettled=false | 偏差：①import 阶段未重新执行 maxFiles/maxTotalBytes/目标容量检查（只在导出侧校验）；②`executions` 原样保留源 `ownerPid/processStartedAt`（sanitizeStateForMigration 未处理），目标启动的 `production.recoverInterrupted` 会按本机 PID 解释旧进程（`production.js:1216-1266`），与"旧执行 PID 仅审计、不按目标机器 PID 解释"不一致 |
| FR-MIG-006 目标重新绑定、能力受限 | 部分完成 | `src/migration.js:588-635`、`:602-610`；`src/config.js:733-737` | validate 用 `activationChecks` 产出能力清单，白名单只允许 `core:read/core:write/production:local/publish:manual`，默认 `blocked:['platform_unverified']`；configRevision 沿用 manifest，且配置变更在迁移态被禁（`config.js:733-737`），目标配置/秘密/工具路径不会被自动启用；未核验平台不入 allowedCapabilities | 偏差：真实 whoami/账号稳定 ID 重验与"本机目录/Profile 工具绑定/IM 端点重新绑定验证"依赖外部注入 `activationChecks`，默认实现未做（与 TASKS §10.3#8 的真实宿主未验证一致）；"业务额度与 timeZone 沿用"✓（state 保留 budgets/timeZone） |
| FR-MIG-007 activate 门禁与断电幂等 | 部分完成 | `src/migration.js:648-713`、`:637-646` | activate 校验：目标健康恢复点（`_targetProtection`，degraded→BACKUP_STALE）、workspace RecoveryHold、receipt kind/migrationId/snapshotHash/targetInstanceId 与包绑定、磁盘存储回执一致、state.migration.phase=validated；先写 `activationDecision.state=prepared` 到 state，再 instance active，再 state committed；phase=active+instance active 时幂等返回（`:658-660`），断电在两次写之间重跑可补齐（`test/migration.test.js` 有对应用例） | 偏差：未重新校验"本地导入摘要"（不调用 verifyMigrationPackage，读入的 state/instance/manifest 文件内容不做逐文件 hash 复核）；"操作者对源端已停写的确认"只隐含在 human proof 的绑定 {migrationId,snapshotHash} 中，无独立确认字段；activate 只使用回执，无法证明源端已 retired（跨机无中心协调） |
| FR-MIG-008 不自动重放、旧任务 hold | 部分完成 | `src/migration.js:495-519`；`src/task-manager.js:333-335`、`:148-150`、`:130-153`；`src/effect-gateway.js:493-498`、`:619-623`；`src/backup-recovery.js:2237-2247` | import 对非终态旧任务加 `kind=migration` hold（caseId=null）；任务 resume 与成功 transition 都拒绝 active hold；effect gateway 对 `task.holds` 任一未 released 拒绝 reserve/dispatch；outbox pending/sending 被 suppressed；旧审批 nonceHash 清空且 invalidated；schedulerDisabled=true；production readyForPublish=false+migrationHold | **重要缺口**：没有任何管理路径释放 `kind=migration` 的 task hold——`task-manager.releaseHold` 唯一调用方是 `RecoveryService`，且其过滤 `hold.kind==='recovery'`（`backup-recovery.js:2239`）；因此成功迁移后，所有导入的非终态旧任务在目标端永久冻结，无法按 FR"只有受信人类明确 resume/重新批准后恢复安全阶段"恢复（只能弃用）。另外旧通知恢复前受众/通道语义重验、旧执行 PID 仅审计也未见实现 |
| FR-MIG-009 abort / disable-target / rollback | 已完成（离线） | `src/migration.js:731-757`、`:759-836`、`:838-1031`、`:1033-1331` | abort 只允许 quiescing/sealed 并清理封存包；disable-target 要求 released + `targetStopped===true` 显式 attest + 非空证据字符串 + 可达目标最新账本（state.json/instance.json 匹配 migrationId/workspaceId），写 disabled 后回读校验，再把禁用时间/证据 hash 持久化到源账本；rollback 要求 released+targetDisabled+目标最新账本可达+`to` 为新空目录且与源/目标目录互不嵌套，以目标当前账本构建反向包（清理 pendingImport/日记 pendingCommit/in-flight、逐项 hash 校验），先持久化 prepared 反向决定再 import/validate/activate，重试复用同 reverseMigrationId/目的地，已激活只补记不二次激活；目标不可达时保持 MIGRATION_BLOCKED | `test/migration.test.js` 11 项（含 disable-target 证据缺失/目标不可达、反向包 artifact/journal 损坏、崩溃重试）本次实跑通过 |
| FR-MIG-010 双根/双 instance 测试与跨 OS 区分 | 部分完成 | `test/migration.test.js`；`test/migration-paths.test.js` | 测试用两个不同 dataDir 与不同 target instanceId 完成 prepare→export→import→validate→activate，以及 disable-target/rollback 反向搬迁；路径安全用相对路径/链接/未列出文件用例；无同目录进程重启冒充停机的测试形态 | 真实 Windows/Linux 跨 OS 未实测（本机为 Windows，未能在 Linux 侧运行）；docs/TASKS §10.3#4/#6 已声明该限制，代码与文档一致 |

### §27 可信备份与灾难恢复（FR-DR-001～010）

| FR/条款 | 状态 | 代码位置 file:line | 判断依据 | 备注 |
|---|---|---|---|---|
| FR-DR-001 范围/无备份 fail-closed | 部分完成 | `src/store.js:247-309`、`:318-325`；`src/backup-recovery.js:1453-1503`；`src/migration.js:459-465` | 主 state 存在但 instance/journal 缺失、state 缺失但 instance.bootstrapComplete/journal 非空，均抛 `RECOVERY_REQUIRED`，不会初始化空账本（`store.js:249-277`）；standalone `recovery restore` 只接受 `kind=backup`（`backup-recovery.js:1503`）且要求新空目录；迁移包不能当灾备票使用；无云 SDK/双写 | 偏差："没有有效备份时只能保全残存证据"无自动化代码——不自动复制/隔离受损 state、journal、instance，仅拒绝启动并提示人工恢复；恢复入口本身也要求新空目录，"保全原件"由操作者负责 |
| FR-DR-002 保护状态与派发门禁 | 已完成（离线） | `src/backup-recovery.js:963-1001`、`:391-415`；`src/effect-gateway.js:252-285`、`:431-571`、`:573-625`、`:1340-1418`、`:1106-1118`、`:1206-1218`；`src/modules/comments.js:418`；`src/modules/direct-messages.js:238`；`src/modules/publisher.js:477`、`:699-702`；`src/modules/production.js:697`、`:724`、`:885`；`src/migration.js:109-125`、`:637-646` | `getProtection` 按 cutAt 算年龄，无策略/destination 不可达→unprotected、超龄→degraded、异常→invalid；`_protectionCheck` 对非 protected 一律拒绝（BACKUP_STALE/INVALID/UNPROTECTED），无 go/config/审批旁路参数；reserve 与 dispatch 两处都重新检查（防超龄漂移）；§27.8 所列入口均已接线：平台写（comments/DM→effect gateway）、External、Manual 补录（assertProtectedCompletionInTransaction）、IM 通知（dispatchNotification）、付费 Provider（production→reserve/dispatch）、本地免费阶段与迁移 prepare/activate（迁移/恢复冻结+恢复点） | `test/recovery-gates.test.js`（保护状态重新检查、在途回执仍结算）本次实跑通过；不同目录≠独立故障域只靠 owner 声明（failureDomain/verifiedBy），符合"记录人工核验"而非自动证明 |
| FR-DR-003 一致 cut、journalPending、ledger/full | 部分完成 | `src/backup-recovery.js:442-720`、`:482-518`、`:522-586`、`:722-747`；`src/backup-recovery.js:137-190` | 捕获在 store 排他事务中完成：同一事务写 checkpointFence+backups 记录并快照 sanitize 后的完整 state（含 journalPending/artifacts/outbox/inboxKeys/budgets）；随后立即清除 fence（`:509-518`）再在事务外复制 journal 段与 full 媒体，符合"大媒体复制在锁外"；journalPending 保留在 state 并计入 journalCoverage；ledger 不含媒体字节且 mediaCoverage.complete=false，full 缺任一必需对象即失败（`:552-574`）；复制/校验失败清理 tmp、清 fence、index 记 lastError、不覆盖最后有效点 | 偏差：①捕获前**不等待**已有 pendingImport/pendingCommit 到可恢复边界（代码无等待逻辑），pendingImport 的 tmp 字节不随备份，恢复副本中该导入无法恢复（如实记录为缺失）；②`_assertGateForBackup` 与迁移 prepare 之间无显式"等待/让位"协调，仅依赖 store 事务串行（prepare 不检查 checkpointFence）；③snapshot 的 outbox pending/sending 被改写为 suppressed（`:178-187`），丢失"捕获时在途发送"的原始状态 |
| FR-DR-004 manifest/JCS/verify/保留/prune | 部分完成 | `src/backup-recovery.js:587-632`、`:192-209`、`:248-310`、`:749-908`、`:910-1001`、`:1003-1103` | manifest 字段齐全（含 schemaVersion/kind/backupId/tier/stateVersion/workspaceId/sourceInstanceId/sourceHistoryEpoch/cutEventSeq/cutAt/configRevision/timeZone/sourceStateHash/snapshotHash/files/journalCoverage/mediaCoverage/excludedData/failureDomain/createdAt/completedAt）；`computeSourceStateHash`/`computeSnapshotHash` 为 `jcs-sha256-v1` JCS（`:192-209`），verify 重算 stateHash、逐文件 size/sha256、未列出文件、snapshotHash；create 完成即 verify 再写索引；dailyVerify 每 UTC 日复查最近 ledger/full；restore 成功后 `noteRestoreTest` 记 restoreTested；planPrune 保留 recent/daily/weekly 并集 + 最后 ledger/最后 full + pinned，prune 要求 planId+人类、重算 plan 防陈旧、拒绝删 last 点；fence 崩溃/复制失败不覆盖最后有效点 | 偏差：①prune 只识别手工 `pinned`，未检查未完成 RecoveryCase/恢复引用/共享对象引用，"删除后媒体覆盖"仅输出布尔 `fullRetained`；②create 无目的地剩余容量预检，"容量不足拒绝新备份"未实现（ENOSPC 只表现为本次失败+lastError）；③"从未有有效 full 必须报告媒体未受完整保护"无显式标志，仅 status.latestFull=null 可推断；④excludedData 是固定声明列表，未逐项校验 state 中确实无 cookie/key（当前 state 结构本身不含明文凭据） |
| FR-DR-005 只读恢复、新 epoch、parent、holds | 部分完成 | `src/backup-recovery.js:1453-1863`、`:1591-1630`、`:1649-1699`、`:1720-1804`；`cli.mjs:172-213` | standalone 入口在 CLI 中先于 runtime 初始化执行，`RecoveryService.restore()` 全文不访问 `this.store`（本次 grep 确认），可在普通 Store 损坏时独立运行；要求新空目录（已有 recovery.json 且 requestId 相同则幂等返回）；`verifyBackupDirectory` 校验 kind/schema/stateVersion/hash/路径；新 targetInstanceId+新 historyEpoch，parent={backupId,sourceHistoryEpoch,cutEventSeq,snapshotHash}；state.recovery.phase=readonly、初始 holds 覆盖 accounts×4 action、budgets、IM 会话、源 holds、以及非终态任务级 hold，无任何候选时回落 workspace hold；旧审批 nonce 清空/失效、bindings 清空、scopes 清空、outbox pending/sending→suppressed、queued/running 任务→interrupted 且持 hold、执行→interrupted、productions readyForPublish=false；ledger 缺媒体时 artifact availability=unavailable 并记 missingMedia，Task/永久键保留；旧 journal 段只复制为只读归档、新分支从 carriedPending 重排 seq=1..n | 偏差：无"先保全受损文件"动作（依赖操作者另存原件）；restore 目标若已有非空目录但不是本 case 会直接拒绝（符合"新空目录"）；日记正文不随备份（manifest 标 derived/rebuild，恢复置 needsRebuild），符合 §27.2 允许的 derived 路径 |
| FR-DR-006 不确定区间/Hold/UnknownExposure | 部分完成 | `src/backup-recovery.js:1509-1581`、`:1611-1630`、`:1772-1804`、`:1920-2105`；`src/contracts.js:398-562`；`src/effect-gateway.js:287-312`、`:580-584`、`:1124-1199` | Hold 结构 = {id,caseId,kind,scope,scopeKey,revision,status,evidenceRefs,createdAt,releasedAt,releaseDecisionRef}，scopeKey 用 `jcs-sha256-v1` 对规范化 scope 计算；scope 覆盖为结构化（workspace 覆盖全部、account_action 支持 action='*' 拆分、provider_budget/im 通配）；restore 为全部已知账号/预算/会话/源 hold/任务建立 active hold，无候选时 workspace 级；UnknownExposure 结构含 {id,caseId,scope,currency,maxMinor,source,operationRefs,evidenceRefs,status,revision,createdAt,resolvedAt}，未知费用 maxMinor=null 时 `_assertUnknownExposure` 阻止同预算付费；快照中 reserved/dispatching/unknown 操作全部标 `recoveryAmbiguous` 且 `_prepareDispatch` 拒绝；普通重启恢复在 readonly/reconciling/restricted/blocked 与 recoveryAmbiguous 下跳过 | 偏差：①`uncertaintyRange` 只在 restore 时写 `{startAt:cutAt,endAt:null,open:true}`（`:1623-1628`），**全文件没有任何代码在记录 isolation 证据后写 endAt/关闭区间**，也不在 authorize 校验证据 coveredRange 是否覆盖 cut→isolation；②hold 未携带规格要求的 `exposureId` 关联 UnknownExposure（功能上 effect gateway 用 exposure.scope 自行匹配，仍保守）；③无"缺失/非法 scope 按 workspace 级保守处理"的显式分支（normalizeScope 直接抛 RECOVERY_GAP，实际由 CLI/human 重试处理） |
| FR-DR-007 证据结构与事实修复 | 部分完成 | `src/backup-recovery.js:1920-2105`、`:2351-2372`；`src/effect-gateway.js:971-1103` | RecoveryEvidence 含 id/caseId/kind/scope/source/sourceHash/coveredRange/conclusion/operationRefs/taskRefs/businessKeys/repair/note/reviewedBy/capturedAt/recordedAt/revision；证据正文写 `<recoveryDir>/evidence/<id>.json`（0600，atomicWrite），inspect 只返回 id/sha256/revision/kind/createdAt；authorize 时重新读证据文件并比对 sha256；repair 必须 scope 覆盖 operation、引用 operationRefs/businessKeys、只允许 unknown/reserved/dispatching，已结算冲突直接拒绝；confirmed 要求结构化 receipt（external 还需 bvid/url+非 manual 验证），not_sent 要求 note 或 receipt；无原 ID 时只写 `recovery.recovered_fact` 事件、不伪造 operationId；同 case 重复证据幂等 | 偏差：①`not_sent` 允许仅 note 通过（`effect-gateway.js:1015-1017`），note 语义上接近"人工确认"，与"仅用户点击确认不够"存在张力（依赖 reconcile 的人类+source/sourceHash 约束兜底）；②旧 epoch 迟到记录没有自动进入证据区的入口（仅人工 reconcile 路径），"旧 epoch 迟到记录只进入证据区"未形成端到端流程 |
| FR-DR-008 旧写者隔离与分范围解冻 | 部分完成 | `src/backup-recovery.js:1920-2105`、`:2345-2396`、`:2399-2438`；`src/contracts.js:474-520` | authorize 强制要求 `fencingEvidence`（kind=isolation 且 conclusion=isolated、带 source/sourceHash、已写入 evidenceRefs），并校验授权证据存在/版本/文件 hash/scope 覆盖；refreeze 可对已解冻 scope 重新冻结并作废 prepared 决定；本地人类证明绑定具体 scope hash+evidenceId；操作者可用 `recovery reconcile` 记录停机/存储隔离类外部控制证据 | 偏差：authorize **未强制** FR 列出的解冻前置：不核对不确定区间是否被证据覆盖、不要求永久键/额度修复记录、不要求主体/账号重新验证、不要求先为修复后目标建立新的独立 verified 恢复点；隔离证据只校验自述结构，未验证"旧源+可能迁移目标+关联执行器"覆盖范围。`RecoveryManagedBackupService.createManagedCopy` 提供了 restricted/released 副本建点能力，但不是 authorize 的前置条件 |
| FR-DR-009 两阶段 authorize、入口限制、幂等 | 已完成（离线） | `src/backup-recovery.js:2264-2397`、`:2107-2166`、`:2168-2262`、`:1429-1446`；`cli.mjs:433-589`；`src/command-service.js:10-35`、`:220-226`；`src/index.js:576-719`、`:733-764`；`src/config.js:733-737`；`src/task-manager.js:333-335` | RecoveryCase 字段齐全（id/workspaceId/targetInstanceId/backupRef/parentHistory/newHistoryEpoch/revision/phase/holds/evidenceRefs/fencingEvidence/decisions/createdAt，另有 unknownExposures/uncertaintyRange/missingMedia/requestId/pendingDecision）；authorize 严格四步：①case.pendingDecision=prepared+nextRevision+scopeKey+evidenceId 写入 recovery.json（atomic+fsync）→②store 事务写同 revision recovery 摘要与 holds（含 task hold 释放）→③recovery.json pendingDecision=committed+decisions 审计→④最后 instance.update 写 allowedCapabilities/status=active/activationRevision；前三步期间 instance 仍 recovery-readonly/空能力，effect gateway 的 `_assertInstance`+`_assertRecoveryPhase`+hold 检查使派发保持关闭；崩溃断点由 pendingDecision 的 prepared/committed 分支续办（`:2281-2339`），`_verifyProjection` 校验 state/instance/recovery.json 三方 revision/phase 一致（`:1429-1446`）；管理命令只经 CLI（本地 TTY human proof），HTTP 路由无 management、Agent tools 白名单无 backup/recovery、IM 白名单不含迁移/灾备；config update/task resume/Operation resolve/migration activate 均不能绕过 hold | 本次实跑 `test/recovery-evidence.test.js` 5 项（含两处断电窗口续办、refreeze 作废旧决定）与 `test/recovery.test.js` 6 项通过 |
| FR-DR-010 验收矩阵与派发接线 | 部分完成 | `src/effect-gateway.js:431-571`、`:573-625`、`:1106-1118`、`:1206-1218`、`:1340-1418`；`src/modules/*`（见 FR-DR-002 行）；`src/backup-recovery.js:1816-1828` | §27.8 每个派发入口已接线（见 FR-DR-002 行）；restore 产出 `<target>/recovery/restore-record.json`（startedAt/finishedAt/elapsedMs/missingMedia/sourceBytes）为只读恢复耗时与媒体范围记录，status/inspect 暴露 cut 年龄、mediaCoverage、未 released hold 数；§19.5 的离线注入矩阵大部分有测试（见下节） | 未完成真实灾难演练：无真实独立介质/故障域、无真实 RPO/RTO 实测、无跨 OS；因此 FR-DR-010 要求的"记录实际 cut 年龄、元数据量、只读耗时…"目前只是离线临时目录上的结构记录，未构成验收结论 |

### §19.5 故障注入矩阵（离线证据）

| §19.5 场景 | 离线证据（本次实跑/代码） | 状态 |
|---|---|---|
| 主 state 损坏/丢失、仅有可信旧点 | `store.js:249-277` 拒绝初始化空账本；`recovery.restore` 只读新目录（`backup-recovery.js:1453-1503`）；无自动化"保全原件" | 部分 |
| 无目的地/同盘未核验/过期 → unprotected/degraded，新派发 0 | `test/backup.test.js`（stale 降级、corrupt invalid）、`test/recovery-gates.test.js`（派发时复查、在途回执仍结算）通过 | 覆盖 |
| 捕获时有 reserved/渲染/日记/Artifact 提交 → 同 cut 一致 | `test/backup.test.js` 一致 cut；`test/recovery-evidence.test.js` reserved at cut 歧义；pendingImport 边界见缺口 #10 | 部分 |
| 复制中断、manifest 缺字节、摘要错、磁盘满 | `test/backup.test.js` 失败复制不覆盖最后有效点；corrupt 判 invalid；磁盘满仅由注入 copy 失败模拟 | 部分 |
| ledger 有效但视频对象缺失 | `test/recovery.test.js` ledger restore 报 missingMedia、readyForPublish=false | 覆盖 |
| 新 ledger 挤出唯一 full / 删除命中共享对象 | `test/backup-retention.test.js` 保护 last ledger/full；无 dedupe/共享对象场景 | 部分 |
| 10:00 恢复点、10:05 外发成功、10:06 丢账 | `test/disaster-recovery.integration.test.js` 通过（恢复后不重复外发、businessKeys 不出现） | 覆盖 |
| 备份中 reserved 无 dispatchAt 之后已派发 | `test/recovery-evidence.test.js`（reserved at cut 不可派发、可被证据证明 not_sent） | 覆盖 |
| 仅事件摘要/伪造确认/冲突回执 | reconcile 对冲突结算拒绝（`effect-gateway.js:995-998`）；`test/recovery-evidence.test.js` 修复原 Operation；仅摘要反推未做 | 部分 |
| 新 epoch 旧迟到回执/同裸 seq | `test/history-epoch.test.js` 同裸 seq 不覆盖旧归档；旧 epoch 迟到记录无自动入口（缺口 #07 备注） | 部分 |
| 源/迁移目标失联且无法证明隔离 | `test/migration.test.js` disable-target 目标不可达→BLOCKED；灾备只读 | 覆盖 |
| reconcile/authorize 各步断电、重复调用 | `test/recovery-evidence.test.js` 两断电窗口 + `test/recovery.test.js` authorize 幂等 | 覆盖 |
| 旧权限/旧 nonce/旧迁移票据/改 dryRun 不能取权 | 迁移 import 清 nonce/bindings（`migration.js:487-494`）；activate 校验 receipt 绑定；迁移无 dryRun 旁路 | 覆盖 |
| 隔离恢复演练与性能记录 | restore-record.json 计时/缺失媒体；无真实演练与真实介质性能记录 | 未验证 |

### TASKS §10.3 14 条限制声明核对

| # | 声明 | 与代码一致性 |
|---|---|---|
| 1 | GATE-0/GATE-MEM 原文档状态未改写 | 文档性声明，与代码无关；`SPEC.md:1351` 仍写"代码与运行接线尚未实现"，与当前实现状态不一致（文档同步问题，非本范围代码缺陷） |
| 2 | 真实 B 站写/External/真实 IM 未授权 BLOCKED | 一致：测试均为 Mock/替身，无真实凭据路径 |
| 3 | T17.3 用注入测试 human verifier；真实人类证明需 TTY/宿主 | 一致：`test/manual/local-production.acceptance.mjs:6-7` 自述；生产 `TtyHumanVerifier` 未在本机 TTY 实测 |
| 4 | disable-target/rollback/reconcile 已闭环离线 | 一致：`migration.js:759-836`、`:1033-1331`、`backup-recovery.js:1920-2105` 与实跑测试相符 |
| 5 | T20 调度/每日复查/restoreTested 已闭环离线 | 一致：`backup-recovery.js:1110-1278`、`:787-908`；`test/backup-scheduler.test.js` 6 项通过 |
| 6 | T22 仅临时目录故障注入，真实介质/跨 OS 未测 | 一致：本机无真实介质与 Linux 环境 |
| 7 | 付费 Provider 仅 Mock | 一致：`production.js:664-761` 通过注入 `paidProvider`，src 无商业 SDK |
| 8 | DSH 真实宿主 API 未验证 | 一致：`index.js:772-833` 只是可选注册薄契约 |
| 9 | 本地执行用 spawn 参数数组（等价 execFile 语义），未用 execFile API 名 | 一致：`local.js:145-151`；但 runner 单消息 4MiB 与 SPEC 1MiB 不同（缺口 #08） |
| 10 | config.example 无 BackupPolicy，策略在 `<dataDir>/backup-policy.json` | 一致：`config.example.json` 无 backup 字段；`config.js:502` 路径一致 |
| 11 | 恢复后日记合并父 epoch 归档事实 | 一致：`test/recovery-diary.test.js` 2 项通过；本任务未逐行复核日记实现 |
| 12 | resume/证据修复范围，authorize 两个断电窗口 | 一致：`backup-recovery.js:2281-2339`；测试 5 项通过 |
| 13 | 恢复/迁移失败清理 | 一致：restore marker 清理（`backup-recovery.js:1463-1475`、`:1859-1861`）；migration import 失败清理（`migration.js:577-585`）；rollback prepared 重试复用（`:1081-1166`） |
| 14 | 调度器授权边界：只建点、不 prune | 一致：`_runTick` 只调用 createScheduled/dailyVerify（`backup-recovery.js:1218-1277`），无 prune 调用 |

## 缺口详情

### #01 [P1] FR-MIG-001：sealed 后晚到回执不会回退重新封存，release 回执 cut 与快照脱钩
- 设计要求：SPEC §25.1"release 前晚到回执使 sealed 回到 quiescing，落账后重新 export 并更换 snapshotHash，release 后回执只交目标核查"；DESIGN §8.6-2 同义。
- 证据：`src/migration.js:28-32` 定义 sealed 状态；全库 grep `quiescing` 只出现在常量定义（`:31`）、prepare 写入（`:144`/`:162`）、export 前置（`:185`）、seal 事务（`:345`）、abort 判断（`:735`），无 sealed→quiescing 回退分支；`src/migration.js:413-414` 的 release 回执 `sourceHistoryEpoch/cutEventSeq` 取 **release 时** `state.eventSeq`，而 sealed manifest（`:305-326`）没有 cutEventSeq 字段；`src/effect-gateway.js:644-694` 的 `_settleDispatch` 无迁移 phase 门禁，故 sealed 后的晚到回执可继续写源账本、越过封存快照。
- 影响：封存包与 release 回执可能指向不同事件水位；迁移目标只拿到旧快照，源端已落账的晚到事实不会进入目标，而回执声称的 cut 更晚；无重新封存/换 snapshotHash 能力，违反设计明确的停机迁移语义。
- 建议：sealed 状态下收到会改账的结算时在事务内回退 quiescing（审计事件），落账后要求重新 export；release 回执的 cutEventSeq/snapshotHash 从 sealed manifest 读取；补"sealed 后晚到回执→重新 export→换 hash"回归测试。

### #02 [P1] FR-MIG-008：导入的 migration hold 没有释放路径，旧任务在目标端永久冻结
- 设计要求：旧任务置 migrationHold，"只有受信人类明确 resume/重新批准后恢复安全阶段"。
- 证据：`src/migration.js:495-519` 给非终态任务加 `makeMigrationHold`（kind=migration、caseId=null）；`src/task-manager.js:333-335` 的 resume 与 `:148-150` 的 succeeded 转换都拒绝 active hold；`src/effect-gateway.js:493-498`、`:619-623` 对任务 hold 拒绝 operation；唯一释放调用 `releaseHold` 在 `src/backup-recovery.js:2244`，且该循环只处理 `hold.kind === 'recovery'`（`:2239`）；`cli.mjs` 无 release-hold 命令。
- 影响：成功迁移后，所有迁移时未终结的旧任务永远无法 resume/重新批准，只能人工弃用；与 FR 明确给出的恢复路径不一致（安全侧不放松，但功能过度冻结）。
- 建议：提供本地人类受信入口（CLI）对指定 migration hold 显式 release，要求输入新审批/身份核验并审计；或让 `task resume` 在人类证明下先释放该 case 的 migration hold。

### #03 [P1] FR-DR-006：uncertaintyRange 右界永不闭合，authorize 不核对证据覆盖区间
- 设计要求：记录最后可信 cut 到旧写者实际隔离之间的 uncertaintyRange，右边界不能确认则 open；解冻前须完成该 scope 的不确定区间核查。
- 证据：`src/backup-recovery.js:1623-1628` 仅写 `{startAt:cutAt,endAt:null,open:true,sourceCutEventSeq}`；全文件 grep `endAt` 只有此一处；`reconcile` 记录 isolation 证据时（`:2023-2031`）只写 `fencingEvidence`，不更新 uncertaintyRange；`authorize`（`:2345-2372`）只要求 fencingEvidence 存在/来源一致/证据 hash 与 scope 覆盖，完全不比较 `coveredRange` 与 uncertaintyRange。
- 影响："旧写者何时被隔离"没有事实记录，恢复 case 永远处于 open 不确定区间；authorize 可以在未证明 cut 之后动作已被核查的情况下开放 scope，与"证据驱动、分范围解冻"的设计核心不符。
- 建议：record isolation 证据时在同一 case revision 写 `uncertaintyRange.endAt/coveredRange/evidenceId`；authorize 要求该范围被当前证据覆盖（否则 raise revision/refreeze），并补对应测试。

### #04 [P1] FR-DR-008：authorize 未强制解冻前置核查与新恢复点
- 设计要求：解冻前须完成该 scope 的不确定区间核查、永久键与额度保守修复、主体/账号重新验证、必要素材及依赖检查，并为修复后的目标建立新的独立 verified 恢复点；证明不足维持只读。
- 证据：`src/backup-recovery.js:2345-2396` 的 authorize 只校验 fencingEvidence、授权证据存在/版本/hash/scope 覆盖、human proof 绑定，随后直接 `_applyAuthorizationState`+`_commitAuthorization` 开放 capabilities；无对 uncertaintyRange 覆盖、永久键修复、账号 re-verify、素材检查或"新 verified 恢复点"的检查；`RecoveryManagedBackupService.createManagedCopy`（`:2458-2467`）存在但不是前置。
- 影响：只要有一份自述 isolation 证据，就可以在未完成上述核查和重新建点的情况下给 scope 开放真实派发能力（尤其 workspace scope 会一次给全部能力），与 §27.6/§27.8 的严格解冻条件不符。
- 建议：authorize 前置校验/记录：不确定性覆盖、permanentKeys/budgets 修复证据、账号 whoami 重验、依赖检查、目标独立恢复点 backupId；缺失即 RECOVERY_FENCING_REQUIRED/BACKUP_UNPROTECTED。

### #05 [P1] FR-MIG-002：prepare 只能看到本进程执行器，无法证明其他进程/外部发布器/发送器已停
- 设计要求：等待或请求停止全部本地执行器、外部发布器和发送器，确认无继续修改产物的子进程；不能确认则 export 阻塞。
- 证据：`src/index.js:371-374` 的 `executorStatus` 只读 `executionBackend.active`；`src/migration.js:141`、`:186-189` 只消费该值；CLI 每次 `migration prepare` 都会新建 runtime（`cli.mjs:215-220`），所以该检查在 CLI 场景恒为 `stopped:true`；外部发布器（execFile）与 IM 发送器不在该计数内；prepare 也不主动调用 `backend.close()`/`stop()`，只在不满足时抛错（`migration.js:168-172`）。
- 影响：常驻服务仍在渲染/外部发布时，另一进程的 `migration prepare` 可能通过并封存，随后重复上面 #01 的晚到回执问题；FR-MIG-002 的"证明停止"不成立。
- 建议：prepare 前要求调用方显式停止/关闭执行器与发布器并返回可验证状态（PID/进程启动时间/停止时间），或把运行中执行信息持久化到账本供 CLI 核查；不满足必须 BLOCKED 且不得先置 quiescing（或在 BLOCKED 时保留可 abort 提示）。

### #06 [P2] F11（历史）：备份库索引只有进程内 Promise 锁，无跨进程文件锁/CAS
- 设计要求：同机宿主与 CLI 可并行，恢复点/保留/校验状态必须一致（F11 原判断；SPEC §27.2/3）。
- 证据：`src/backup-recovery.js:335-353` `_withIndexLock` 只是 `this._indexLock` Promise 链；`:361-384` `_readIndex/_writeIndex` 是无版本/CAS 的 read-modify-write（`atomicWriteJson` 仅原子替换文件，不比较旧内容）；write 点 `:679-684`、`:756-766`、`:769-777`、`:813-818`、`:856-883`、`:1083-1100`；`:453-465` 的 requestId 幂等读取在锁外。TASKS §10.3#8 与 §10.5#8 也自述"进程内串行锁"。
- 影响：服务内调度器与 CLI `backup verify/prune/create` 并发时，索引 read-modify-write 可互相覆盖：可能丢失新恢复点条目（保护状态回退为 stale/unprotected）、丢失 restoreTested/每日复查记录、prune 后旧条目被并发写回（reverify 判 invalid），或同一 requestId 产生两个点。多数失败方向偏保守，但状态不一致违反 §27.2/3 与 F11 设计要求。
- 建议：备份库级文件锁（stale-owner 校验）或索引 version+CAS；prune 删除前在锁内复核引用与版本；补 CLI 与调度器并发故障注入测试。本次未做多进程实测，属静态判断。

### #07 [P2] FR-PRO-004：stageRequest 缺字段；重复 submit 未按 inputHash 冲突拒绝
- 设计要求：stageRequest 含 workspaceId/taskId/executionId/stageId/attempt/requestId/inputHash/instanceId/profileId/inputArtifactRefs/limits；只有仍处于 accepted/running/cancel_requested 的相同 requestId/inputHash/executionId 重复 submit 才返回原记录。
- 证据：`src/modules/production.js:859-883` 缺 workspaceId/requestId/instanceId/inputArtifactRefs；`src/adapters/execution/local.js:89-99` 对已存在的非终态 executionId 直接返回去重，不比较 inputHash/requestId（虽然 `_applyEvent` 有事件侧校验）。
- 影响：执行协议自描述不完整；若调用方误用同一 executionId 提交不同计划，后端会静默复用旧执行返回 accepted，而非 IDEMPOTENCY_CONFLICT。
- 建议：补齐字段并在 backend 记录中保存 requestId/inputHash，重复 submit 不一致时拒绝。

### #08 [P2] FR-PRO-005：runner 单消息上限 4MiB 与"单消息≤1MiB"不一致
- 设计要求：本机协议"单消息≤1MiB，stdout/stderr 总量上限 10MiB"。
- 证据：`src/production/runner.mjs:249-255` 在 stdin 累计超过 4MiB 才失败；`src/adapters/execution/local.js:8-9`、`:179-217` 对输出实现 1MiB/10MiB。核心→runner 的请求 JSON 目前很小（plan/segments），实际风险低。
- 影响：协议上限与 SPEC 不符，边界行为无法按 SPEC 验收。
- 建议：runner 改为 1MiB 或修订文档并说明理由。

### #09 [P2] FR-PRO-007/008：resume 未记录 previousExecutionId/checkpointRef；restartSafe 声明未使用；checkpoint 字段不全
- 设计要求：人工 resume 创建新 executionId、递增 attempt 并记录 previousExecutionId/checkpointRef；checkpoint 含 stageId/profileVersion/inputHash/outputRefs/lastConfirmedSeq 及可恢复类型；只复用"持久化验证完成/restartSafe"阶段。
- 证据：`src/modules/production.js:853-855` 只按历史 execution 数计算 attempt，未写 previousExecutionId；checkpoint 对象见 `:609-618`、`:640-645`、`:806-818`、`:970-982`（无 lastConfirmedSeq/stageId/可恢复类型）；`src/production/profiles/local-slideshow.js:17` 声明 `restartSafe`，src 内无消费点（grep 仅定义）；复用条件 `:472` 只看 succeeded/skipped+inputHash，profile 版本仅在 run() 入口校验。
- 影响：审计无法追溯一次尝试的前驱；非 restartSafe 阶段（render）也可在 resume 后整体重跑，与"restartSafe 阶段才可显式重跑"的设计约束不同（本地免费阶段实际风险低）。
- 建议：resume/execution 记录加入 previousExecutionId/checkpointRef；实现 restartSafe 校验或修订文档；补 lastConfirmedSeq/stageId。

### #10 [P2] FR-DR-003/§27.2：备份不等待 pendingImport/pendingCommit 到可恢复边界
- 设计要求：等待已有 pendingImport/pendingCommit 到达可恢复边界，再在排他事务中捕获账本；journalPending 可随快照保留；日记 pendingCommit 收尾。
- 证据：`src/backup-recovery.js:442-518` 的捕获事务直接快照 state（包含 artifactPendingImports/diaries.pendingCommit），没有等待或先行恢复；`src/backup-recovery.js:534-586` 仅复制 journal 段与 artifacts（`state.artifacts` 内的已定稿对象），pendingImport 的 `tmp/<id>.part` 字节不在 files 中；恢复时 target 的 `artifactPendingImports` 原样带入但对应 tmp 字节缺失（`backup-recovery.js:1583-1608` 只重置 checkpointFence/backups/migration/recovery）。
- 影响：备份在导入/日记提交中途捕获时，该导入无法在恢复副本中完成（该 artifact 永久缺失），只能视为未导入；与 §27.2"等待到可恢复边界"不一致。
- 建议：捕获前先调用 `recoverPendingImports`/日记 recover 并确认无 pending；或在 manifest 中显式把未完成导入标为不可恢复并从"所需对象"排除并报告。

### #11 [P2] FR-DR-004：prune 引用检查与容量/媒体保护报告不足
- 设计要求：清理须重新检查引用，不得删除故障调查固定点、未完成恢复引用或尚需的共享对象；不得删除最后有效 ledger/full；prune 必须验证删除后的账本与媒体覆盖；容量不足拒绝新备份/报告 degraded；若从未有有效 full 必须报告媒体未受完整保护。
- 证据：`src/backup-recovery.js:1003-1069` 的 keep 集合 = recent/daily/weekly ∪ lastLedger/lastFull ∪ 手工 `pinned`，未查询任何 RecoveryCase/恢复引用（恢复 case 不写 index pinned）；`mediaAfterPrune` 仅 `{fullRetained:Boolean(lastFull)}`（`:1052-1054`）；`prune`（`:1071-1103`）删除后不重新 verify 索引点的媒体覆盖；`create` 无剩余容量检查；`status`/`getProtection` 不输出"media_unprotected"理由（仅 latestFull=null 可推断）。
- 影响：若 owner 用删除计划清理，可能删掉仍被未完成恢复/证据调查引用的点；容量不足时无预检；运行者需自行从 null 推断媒体未受完整保护。
- 建议：planPrune 纳入 recoveryDir 当前 case 的 backupRef/evidence 引用自动 pinned；输出并校验删除后的媒体覆盖集合；create 前检查 destination 剩余空间并产出明确 degraded 原因。

### #12 [P2] FR-DR-006：UnknownExposure 未与 hold.exposureId 关联
- 设计要求：以 `hold.exposureId` 关联 UnknownExposure。
- 证据：`src/backup-recovery.js:1509-1552` 生成的 hold 只有 scope，无 exposureId 字段（`makeRecoveryHold` 在 `contracts.js:505-520` 也无该字段）；`:1554-1581` 的 UnknownExposure 有 `id/scope`；`effect-gateway.js:287-312` 改为遍历 exposure.scope 自行构造匹配。
- 影响：结构偏差，但功能上仍能按预算范围冻结未知费用；跨工具读取 hold 时无法直接定位 exposure。
- 建议：hold 增加 exposureId（或 exposure 增加 holdRef）并在结构校验中保持引用一致。

### #13 [P2] FR-MIG-003：pendingImport/日记 pendingCommit 是阻止导出而非先完成恢复；manifest 缺 profile 依赖
- 设计要求：导出前完成事件归档、日记 pendingCommit 和 Artifact pendingImport 恢复；manifest 含 profile 依赖。
- 证据：`src/migration.js:190-195` 对 pending 状态直接 `MIGRATION_BLOCKED`，未调用 `artifactStore.recoverPendingImports`/日记 recover；manifest（`:305-326`）无 profile 依赖字段（只有 files 中的 artifacts/journal/diary/posts）。
- 影响：有 pending 时导出持续阻塞；目标无法从 manifest 预知 profile 版本/工具依赖（只能靠 state）。
- 建议：export 前执行核心安全恢复流程（同启动恢复），失败才阻塞；manifest 增 profileDependencies。

### #14 [P2] FR-MIG-005/007：import/activate 摘要与旧 PID 复核不足
- 设计要求：import 校验容量、合法版本/摘要；目标不复用旧 PID/锁文件，旧执行 instance/PID 仅审计、不按目标机器 PID 解释；activate 核对本地导入摘要与操作者对源端已停写确认。
- 证据：`src/migration.js:455-586` 未重新检查 maxFiles/maxTotalBytes/目标剩余容量；`sanitizeStateForMigration`（`:1334-1362`）不清理 `executions.ownerPid/processStartedAt`；`src/modules/production.js:1216-1266` 的目标启动恢复会 `isProcessAlive(execution.ownerPid)`；`_activate`（`migration.js:653-713`）不调用 `verifyMigrationPackage`，也不校验源端停写声明（仅 human proof 绑定 snapshotHash）。
- 影响：超限包可被导入（若绕过导出侧）；目标按本机 PID 解释旧执行（影响方向保守，可能把本可审计的旧执行标 interrupted）；activate 前无法发现导入后文件被篡改/缺失。
- 建议：import 复用策略上限并检查目标容量；sanitize 时清空/改写旧 execution 属主字段为审计字段；activate 前重新 verify 导入目录摘要；activate 入参加入显式 sourceStopped 证据（由 human proof 绑定）。

### #15 [P2] FR-DR-001/005：缺少"保全残存证据"动作
- 设计要求：没有有效备份时只能保全残存证据并报告 RECOVERY_REQUIRED；恢复前先保全受损文件。
- 证据：`src/store.js:249-277` 只抛 RECOVERY_REQUIRED；`cli.mjs:172-213` 的 restore 直接写新目录，不复制/封存受损 state/journal/instance；`backup-recovery.js:1453-1503` 只读备份源。
- 影响：修复数据是否被误覆盖取决于操作者手工流程；软件层没有可审计的保全步骤。
- 建议：增加只读损坏现场导出/标记命令（复制受损文件到 recoveryDir/corrupt-...，记录 hash）作为恢复前置。

### #16 [P2] FR-MIG-004：release 顺序与设计文字相反
- 设计要求：先持久标 retired 再生成交接回执。
- 证据：`src/migration.js:405-418` 先写 receipt.json，`:419-439` 账本置 released，`:440-446` 最后 instance retired；若崩溃在 released 之后 retired 之前，重复 release 会补齐 retired 并返回原回执（`:382-395`），禁写由 phase=released 保证（`effect-gateway.js:182-192`）。
- 影响：语义 fail-closed 未被破坏，但与设计文字顺序不一致，审计解释成本高。
- 建议：调整顺序或更新设计文字并注明崩溃窗口处理。

### #17 [P2] §27.6：恢复期间新建的备份 manifest 无父恢复点/证据引用字段
- 设计要求：新备份必须携带父恢复点、未决 RecoveryCase/holds 和证据引用。
- 证据：`src/backup-recovery.js:137-190` 的 sanitize 保留/强制 recovery.holds active、unknownExposures，并标 `secretsExcluded`；manifest（`:587-631`）无 parentRecoveryRef/recoveryCaseRef/evidenceRefs 字段；`RecoveryManagedBackupService`（`:2458-2467`）只做 phase 判断后调用普通 create。
- 影响：恢复副本上的新恢复点无法从 manifest 追溯到父恢复点和证据，与 §27.6 的父链要求不符（state 内 holds 仍会阻止派发）。
- 建议：restricted/released 副本建点时在 manifest 写 parent={backupId,caseId,revision,snapshotHash} 与 evidenceRefs 摘要。

## 无法确认项

1. **真实媒体验收（T17.3）**：本机 `Get-Command ffmpeg`/`ffprobe` 均未找到，环境变量 `FFMPEG_PATH/FFPROBE_PATH` 为空，无法运行 `test/manual/local-production.acceptance.mjs`。该脚本默认 `/usr/bin/ffmpeg`、`/usr/bin/ffprobe`（`:27-28`），工具缺失时在 `:40-43` 抛 BLOCKED（fail-closed 代码已读，但本次未实测该分支执行）；`test/local-slideshow.test.js` 与 `test/production.test.js` 均用注入 runTool/FakeExecutionBackend/注入 mediaValidator，不是真实 ffmpeg。TASKS §10.2/§10.3 记录的"真实 ffmpeg/ffprobe 6.1.1 验收通过"为**历史记录，本次未复验**。
2. **真实故障域/物理介质**：备份目的地仍为临时目录/同机目录；真实磁盘损坏、独立挂载介质、加密介质、目录 fsync/rename 的介质耐久性未实测。
3. **跨 OS**：Windows/Linux 真实跨 OS 迁移与恢复未实测；仅离线双目录+双 instance 路径语义测试。本机为 Windows，`test/migration-paths.test.js` 的 symlink 用例受平台权限影响（测试代码已按 OS 条件处理，本次 2 项通过）。
4. **真实人类证明**：T17.3/离线测试使用注入 test verifier；生产 `TtyHumanVerifier`/宿主挑战未在本机真实 TTY/宿主验证；因此"真实 prepare/activate/authorize 由本地人类完成"未验证。
5. **真实平台写/External/IM/付费 Provider**：全部 Mock；§19.5 场景 13（旧权限/旧票据/改 dryRun 不能取权）在真实账号/真实票据下未验证。
6. **真实 RPO/RTO**：`restore-record.json` 的 elapsedMs、status 的 ageMs 只在临时目录小数据量下产生，未按 §27.1 的 15 分钟/24 小时/60 分钟目标做真实演练与测量。
7. **多进程备份索引并发**：F11 为静态阅读结论（代码无文件锁/CAS、TASKS 自述进程内锁），本次未做多进程并发故障复现，实际丢更新概率/数据影响以实测为准。
8. **runner 真实运行路径**：`test/local-execution.test.js` 4 项在本次因 Windows 沙箱 `spawn EPERM` 失败（环境限制，非代码缺陷），因此 Runner 的真实 node 子进程路径本次未复验；`test/execution-recovery.test.js` 2 项（不 spawn）通过。
9. **文档状态**：`doc/SPEC.md:1350-1352`、`doc/DESIGN.md:640` 仍称"代码与运行接线尚未实现"，与当前源码状态不一致（文档同步问题，不计入代码缺陷，但应更新）。
10. **§27.2 的 100MiB 元数据/80MiB 预警**：`store.js:239` 有 80/100MiB 容量限制与 `:550` 硬限制记账，但"达到 100MiB 停止新业务、仅允许归档/恢复收尾"的具体例外路径本次未逐行复核（与 FR-DR-003 相关但非本任务主证据）。

## 实际运行的定向测试与结果

说明：按要求未运行 `npm test`/`npm run check`（Windows 沙箱下测试 runner spawn 会 EPERM，非代码缺陷）；以下为在仓库根目录用 `node test/<file>.test.js` 进程内执行的实测结果（2026-11-09 本会话）。

| 测试文件 | 结果 |
|---|---|
| `node test/artifact-store.test.js` | pass 6 / fail 0 |
| `node test/migration.test.js` | pass 11 / fail 0 |
| `node test/migration-paths.test.js` | pass 2 / fail 0 |
| `node test/backup.test.js` | pass 5 / fail 0 |
| `node test/backup-policy.test.js` | pass 1 / fail 0 |
| `node test/backup-retention.test.js` | pass 2 / fail 0 |
| `node test/backup-fence.test.js` | pass 1 / fail 0 |
| `node test/backup-scheduler.test.js` | pass 6 / fail 0 |
| `node test/recovery.test.js` | pass 6 / fail 0 |
| `node test/recovery-gates.test.js` | pass 2 / fail 0 |
| `node test/recovery-evidence.test.js` | pass 5 / fail 0 |
| `node test/recovery-diary.test.js` | pass 2 / fail 0 |
| `node test/recovery-cleanup.test.js` | pass 2 / fail 0 |
| `node test/history-epoch.test.js` | pass 1 / fail 0 |
| `node test/disaster-recovery.integration.test.js` | pass 1 / fail 0 |
| `node test/production.test.js` | pass 5 / fail 0 |
| `node test/production-budget.test.js` | pass 4 / fail 0 |
| `node test/local-execution.test.js` | pass 1 / fail 4（4 项均 `spawn EPERM`：Windows 沙箱禁止带管道 stdio 的 spawn，属环境限制；代码路径见 `src/adapters/execution/local.js:145-156`） |
| `node test/execution-recovery.test.js` | pass 2 / fail 0 |
| `node test/local-slideshow.test.js` | pass 3 / fail 0 |

合计：**68 项通过 / 0 项代码失败**；`local-execution` 的 4 项失败全部为沙箱 EPERM（环境限制），不计为缺陷。未运行真实媒体/迁移/恢复命令，未运行 `npm run test:coverage`。
