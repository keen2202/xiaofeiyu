# 业务模块审查

- 审查范围：`src/modules/browse.js`、`comments.js`、`direct-messages.js`、`diary.js`、`publisher.js`、`src/coordinator.js`，以及 `test/browse|comments|direct-messages|diary|publisher|coordinator` 测试；对照 SPEC §11～§16、DESIGN §8.1/§8.3-8.4/D-08/D-09/D-10、TASKS T05～T09 与 T10 第 1-3 条。
- 代码基线：工作区当前内容（git HEAD `e12b7d9` + 未提交第一批修复）。本审查实际读到的 `src/coordinator.js`、`src/modules/browse.js` 含未提交改动（`git diff` 已核对：`_exclusive`/`executingKinds`、`deferCompletion`、`_consumeCandidates(mode)`）。只读审查，未修改任何源码/测试/文档。
- 方法：先读 SPEC §11～§16 与 DESIGN 对应段落、历史审查 F04/F05/F07，再逐文件 read/grep 核对实现与接线；随后运行可独立执行的 `node test/<file>.test.js`（未运行 `npm test`/`npm run check`，按约束避免 spawn EPERM），并做两个进程内 `node --input-type=module -` 行为探针（不写项目文件）。日志/临时目录由测试 harness 自行创建并清理。
- 状态口径：`已完成（离线）` = 有代码实现且有离线测试或本次直接证据支撑，不代表真实 B 站/宿主/外部发布器验收；`部分完成`/`未实现`/`与设计不一致`/`未验证` 按任务定义使用。

## 结论摘要（FR 计数）

共判定 65 行（编号 FR 26 条 + 未编号强制条款 39 条；后者含 §14～§16 共 36 条及 §11.1/§11.3/§12 草稿契约 3 条）：

| 状态 | 数量 |
|---|---|
| 已完成（离线） | 45 |
| 部分完成 | 14 |
| 与设计不一致 | 3 |
| 未实现 | 3 |
| 未验证 | 0 |

数量口径：编号 FR（§11 8 + §12 10 + §13 8 = 26）中 **已完成 22、部分完成 3（FR-BRO-003/004、FR-DM-004）、与设计不一致 1（FR-BRO-002）**；未编号条款（§14 12 + §15 16 + §16 8 = 36，合计表内 39 行含 §11.1/§11.3/§12 草稿契约 3 行）中已完成 23、部分完成 11、不一致 2、未实现 3。

总体判断：Comments/DM 两个渠道模块的实现与 §12/§13 基本对齐（审批、白名单、双渠道键、额度、unknown 保护均有代码+离线测试）；**F04 的互斥与手动入口部分已真正闭环，但"后置失败聚合为 partial"仍不完整（新增 P1 证据 M01）**；**F05 完全未修（P1）**；**F07 完全未修（P1）**；§14 日记双阶段提交/fail-closed/>2000 重建完成度较高，但 force 无效、叙述复用缺失、恢复缺口标注缺失；§15 Manual/External 代码路径基本齐全，但 External 执行链在本沙箱不可验证、输出未脱敏、Manual"确认未发布"入口缺失；§16 定时日记绕过 diary 类型锁。

### 历史问题 F04/F05/F07 核对

| 问题 | 当前结论 | 关键证据 |
|---|---|---|
| F04 互斥/手动入口/partial 聚合 | **部分闭环（P1 残余）**：同类原子占位✅；手动浏览走 `_consumeCandidates`✅；unresolved/skipped→partial✅；子任务完成后父任务重算✅；但"已结算失败子任务"不聚合❌、子任务全失败时父 Browse 被置 failed❌、superseded 未决审批阻塞子任务结算❌ | 已闭环：`src/coordinator.js:157-164,174-193`、`src/command-service.js:258-262`、`cli.mjs:239-247`、`src/index.js:743-756`、`test/entrypoint-reliability.test.js:185-202`、`test/coordinator.test.js:76-83`、`src/task-manager.js:241-287`、`test/integration.test.js:89-92`；残余：M01/M07/M11 |
| F05 浏览历史未按账号隔离 | **未修复** | `src/modules/browse.js:96,163,174` 键仍为 `bilibili:<BV>`；`failureCooldownMs` 仅构造参数（`browse.js:8,15`），`src/index.js:248` 未传入，`src/config.js:61-71` 无该配置字段；`test/browse.test.js` 仅单账号 |
| F07 日记自动更新未接线 | **未修复** | `afterBrowse` 仅在 `src/config.js:35,91,188`；无消费代码；resolve 不标待重建；`needsRebuild` 全 src 仅 `src/backup-recovery.js:1709` 置 true；每日只生成一个 book 且失败仍推进游标（`src/coordinator.js:121-143`） |

## 逐项对照表

### §11 Browse（含 §11.1 Candidate、§11.3 输出）

| FR/条款 | 状态 | 代码位置 file:line | 判断依据 | 备注 |
|---|---|---|---|---|
| FR-BRO-001 自动模式仅 browse.enabled+scheduler 启用 | 已完成（离线） | src/coordinator.js:115-120,167-171；src/modules/browse.js:20,43；test/coordinator.test.js:114-135 | tick 仅在 browse.enabled 时排程、scheduler 触发时 runBrowse 再查 scheduler.enabled；tick 测试通过 | 手动 CLI/HTTP 不受 scheduler 限制，符合"自动模式"限定 |
| FR-BRO-002 按账号和 BV 去重，多来源同 BV 只处理一次 | 与设计不一致 | src/modules/browse.js:89-94,96,163,174 | 轮内 `seenThisRound` 按 contentId 去重✅；持久历史键 `bilibili:<contentId>` 无 accountId，跨账号共享 | F05 未修；见 M02 |
| FR-BRO-003 已处理/失败冷却/自有过滤，冷却可配置 | 部分完成 | src/modules/browse.js:98-109,5,8,15；src/index.js:248；src/config.js:61-71 | 自有内容过滤✅、processedAt/lastFailureAt 冷却✅；冷却硬编码 6h 且 runtime 未传，持久键跨账号 | 见 M02 |
| FR-BRO-004 详情失败不计已看懂；无字幕按配置跳过 | 部分完成 | src/modules/browse.js:114-132；src/config.js:67 | readContent 失败进 failed 不算已看懂；字幕不足按 minSubtitleChars 跳过；但无"替代内容"配置项，仅能跳过 | 替代内容能力未实现 |
| FR-BRO-005 单视频失败不终止整轮并列出失败项 | 已完成（离线） | src/modules/browse.js:120-127,143-157,206-211；test/browse.test.js:53-93 | failed 收集与 partial 结算；测试覆盖单条失败+冷却 | — |
| FR-BRO-006 确定性评分含关键词/时长/字幕/来源，不只播放量 | 已完成（离线） | src/modules/browse.js:235-255；test/browse.test.js:26-51 | 关键词加权、字幕长度、source、duration、热评加分；未读取播放量 | — |
| FR-BRO-007 Browse 不直接评论/私信；评论/DM 排除自身作者 | 已完成（离线） | src/modules/browse.js:1-3（无 comments/DM 导入）；src/modules/comments.js:124-126；src/modules/direct-messages.js:88-90 | Browse 只返回 Candidate/事件；两模块在生成草稿/派发前用已核验 accountRef 拒绝自身内容 | 第二道防线依赖 candidate.author 被适配器填充 |
| FR-BRO-008 markWatchHistory 默认关闭且不伪报播放进度 | 已完成（离线） | src/config.js:28,314-318；src/modules/browse.js 无播放写入 | 默认 false；配置 true 直接 CONFIG_INVALID"not implemented" | — |
| §11.1 Candidate 结构 | 已完成（离线） | src/modules/browse.js:257-280 | compactCandidate 含 contentRef/title/description/author/durationSec/subtitle/topComments/score/source/platformData；platformData 透传 aid/cid | author 未 deepClone，无实质影响 |
| §11.3 轮次结果 skipped/partial 输出契约 | 部分完成 | src/modules/browse.js:145-157,199-220；test/browse.test.js:95-108 | 全部合理跳过→Task succeeded+result.status=skipped；有候选失败→partial；但 discovery 失败时 Task=failed 而 result.status=partial | 口径不一致，见 M12 |

### §12 Comments（含草稿字段/待审目标索引）

| FR/条款 | 状态 | 代码位置 file:line | 判断依据 | 备注 |
|---|---|---|---|---|
| FR-COM-001 enabled=false 不得自动评论 | 已完成（离线） | src/modules/comments.js:118,245,319 | createDraft/send/resume 均先 FEATURE_DISABLED | — |
| FR-COM-002 approval 模式只出草稿 waiting_approval，批准记录操作者/来源 | 已完成（离线） | src/modules/comments.js:209-220；src/approval.js:43-92,100-186 | 草稿建 challenge；decide 记录 decidedBy/decision，create 记录 principalId/source；TTL 约束 | 需人类证明（humanProof）在 approval.decide 中校验 |
| FR-COM-003 仅 auto 模式由 Coordinator 自动发送 | 已完成（离线） | src/coordinator.js:235-237；src/modules/comments.js:344 | 仅 `config.comments.mode==='auto' && !draft.dryRun` 才在浏览后置发送；approval 模式无自动发送分支 | 人工 comment.send 不算自动 |
| FR-COM-004 无 Agent 且 allowTemplate=false 不得自动生成模板 | 已完成（离线） | src/modules/comments.js:44-51；src/coordinator.js:204-226；test/comments.test.js（auto template 用例） | 无文本时非 allowTemplate 抛 AGENT_DISABLED；协调器侧进 skipped | — |
| FR-COM-005 每条评论独立检查 dailyLimit/perRound/sameVideoDays/maxLength | 已完成（离线） | src/modules/comments.js:58-60,74-95,385-386,409；src/coordinator.js:200-201；src/rate-limiter.js:90-120 | maxLength/sameVideoDays 模块内；dailyLimit 作为 actionQuota 在预留事务由 RateLimiter 强制；perRound 由协调器按轮切片 | perRound 不在模块内（编排层职责） |
| FR-COM-006 同 BV 同渠道冷却期内不得重复（即使正文不同） | 已完成（离线） | src/modules/comments.js:64-95,163；test/comments.test.js:34-70 | targetKey=`comment-target:platform:accountId:contentId`；unresolved/confirmed 冷却期拒绝 | — |
| FR-COM-007 相同规范化正文不得跨视频批量灌水 | 已完成（离线） | src/modules/comments.js:97-105,128-129,164,376-384；test/comments.test.js:72-85 | textKey=`comment-text:platform:accountId:textHash`；派发前再检 | — |
| FR-COM-008 mentionOwner 必须配置 owner.name 且最多 @ 一次 | 已完成（离线） | src/modules/comments.js:52-57；src/config.js:325-327 | 配置层强制 owner.name；正文最多一次，第二次抛错，缺失则追加 | — |
| FR-COM-009 干跑只预检返回草稿，不创建已发送记录 | 已完成（离线） | src/modules/comments.js:327-336；test/comments.test.js:87-105 | dry 提前返回 plan，不 reserve/不写 businessKey、不产生 operation | — |
| FR-COM-010 网络结果未知保留 Operation，不自动重发 | 已完成（离线） | src/modules/comments.js:324-326,376-384；src/effect-gateway.js:764-768,698-704；test/comments.test.js:107-131 | notSent→failed、其余异常→unknown；unknown 任务 unsettled、再次 send 终态 skipped | 依赖 effect-gateway 公共实现 |
| 草稿字段与待审目标索引 | 已完成（离线） | src/modules/comments.js:130-143,160-185,206,231-238；test/comments.test.js:34-50 | 响应含 taskId/inputHash/createdAt/status/expiresAt；input 含 contentRef/platformData/text；_findPendingDraft 按 targetKey 复用原 Task+新挑战 | 待审索引为任务扫描而非持久索引 |

### §13 DirectMessages

| FR/条款 | 状态 | 代码位置 file:line | 判断依据 | 备注 |
|---|---|---|---|---|
| FR-DM-001 实际发送收件人必须在白名单 | 已完成（离线） | src/modules/direct-messages.js:74-78 | 白名单为空或不在列表直接 RECIPIENT_NOT_ALLOWED，在网络预检前 | 测试覆盖 |
| FR-DM-002 默认检查互关；关闭互关仍保留白名单 | 已完成（离线） | src/modules/direct-messages.js:95-100；src/config.js:33 | 非 dry 时 adapter.checkRecipient(requireMutual)；白名单检查始终执行 | 默认 requireMutual=true |
| FR-DM-003 不得向自身发送 | 已完成（离线） | src/modules/direct-messages.js:79-80 | recipient === active account → FORBIDDEN | 测试覆盖 |
| FR-DM-004 每轮/每日额度与同目标冷却在预留事务中检查 | 部分完成 | src/modules/direct-messages.js:174-183,234-251；src/effect-gateway.js:449-472,499-511；src/rate-limiter.js:90-120 | 额度 reserveWrite 在预留事务内✅；同目标冲突由 targetKey 业务键事务内原子拒绝✅；但 sameVideoDays 冷却窗口判定用事务外快照 | 未见重复外发路径，与字面"在预留事务中检查"有差距；见 M13 |
| FR-DM-005 可复用 Browse Candidate，不得重新浏览 | 已完成（离线） | src/modules/direct-messages.js:61-120；src/coordinator.js:254-265 | send 接收 content/recipient/text，不调用 discover/readContent；协调器传 Browse 候选 | — |
| FR-DM-006 评论/私信不同渠道操作键，同渠道不重复 | 已完成（离线） | src/modules/direct-messages.js:102-104,174-183；src/modules/comments.js:64-71 | dm:/dm-target: 与 comment:/comment-target:/comment-text: 前缀隔离，各自业务键 | — |
| FR-DM-007 日志/日记默认只记 mid 与摘要，不记完整正文 | 已完成（离线） | src/modules/direct-messages.js:105-114,224-230,266-298；src/modules/diary.js:216-217；test/direct-messages.test.js（records only a summary 用例） | 事件/结果只含 recipientMid/textHash/contentRef，不含 text；日记仅计数；完整正文仅存 Task.input 供幂等重放 | Task 状态必须保存正文，未外泄到日志/日记 |
| FR-DM-008 不支持陌生人批量/收件人数组遍历 | 已完成（离线） | src/modules/direct-messages.js:26-38,74；test/direct-messages.test.js | 数组直接 RECIPIENT_NOT_ALLOWED；单次单收件人 | — |

### §14 Diary

| 条款 | 状态 | 代码位置 file:line | 判断依据 | 备注 |
|---|---|---|---|---|
| 输入来自统一事件归档+pending，不重读 B 站/不调生产发布 | 已完成（离线） | src/modules/diary.js:138-169,376-378 | 只 journal.readEvents + store 快照；无 adapter/production/publisher 依赖 | — |
| 身份 workspaceId+scope+date+book；scopeKey 路径公式；切换不覆盖 | 已完成（离线） | src/modules/diary.js:111-132,71-84；test/diary.test.js:71-93 | scopeKey=sha256(workspaceId+'\n'+scope.raw)；路径 scopeKey/book/YYYY-MM-DD.md；account/workspace 隔离测试通过 | — |
| 内容含浏览/评论 DM 结果/生产阶段与产物/失败 unknown/投稿+TaskID；不把生产写为发布 | 部分完成 | src/modules/diary.js:182-295,297-345 | 浏览/评论/DM/失败/unknown/投稿记录/TaskID 有；production 仅列 readyForPublish=true 的产物，未含生产阶段明细；渲染明确"已就绪，但尚未自动发布" | 生产阶段欠详（events 有 task.stages 但日记未投影） |
| 自动日记截止 eventCursor 事实重建；Browse 后/每日/resolve 后可重建；次日标待更新 | 部分完成 | src/modules/diary.js:292,413,448;src/coordinator.js:121-143；src/effect-gateway.js:948-957 | eventCursor={historyEpoch,seq} 重建✅；afterBrowse 无消费、resolve 不标待更新 | F07 未修；见 M03 |
| diaries 存 contentHash/revision/lastGeneratedAt/eventCursor/pendingCommit；事实不变复用叙述 | 部分完成 | src/modules/diary.js:405-450,483-508 | 字段齐全✅；但每次先调模型生成叙述再比较 contentHash（379-406），事实未变仍调模型，叙述变化会递增 revision | 与"复用原叙述、不再次调用模型"不符；见 M04 |
| 大文本锁外生成、身份串行、短事务核对 revision/eventCursor、旧快照不覆盖 | 部分完成 | src/modules/diary.js:366-520,411-467 | 提交用短事务并校验 revision 与 pendingCommit✅；身份串行为进程内 `_withLocalLock`（596-611），叙述生成在锁内；跨进程仅靠 revision CAS（旧快照会被 conflict 拒绝但未实测） | 见 M05 |
| pendingCommit 双阶段 + 启动恢复 + 未恢复前不发布新修订 | 已完成（离线） | src/modules/diary.js:415-426,427-508,523-585；src/index.js:388；test/diary.test.js:125-182 | 字段与 phase 齐全；先登记→原子 rename→确认；generate 前 recoverPending；两个崩溃窗口测试通过 | — |
| 归档缺失/损坏 fail-closed；>2000 热事件完整重建 | 已完成（离线） | src/event-journal.js:149-248；src/modules/diary.js:376；test/diary.test.js:184-203 | readEvents 对缺段/损坏/seq gap 抛 JOURNAL_CORRUPTED；2100 条归档事件重建测试通过 | — |
| force=true 可重建 | 未实现 | src/modules/diary.js:348 | 形参 force 在函数体内无任何使用（grep 仅 348/480/580）；CLI 传 force（cli.mjs:255）但不生效 | 见 M04；T10 第 5 条要求 --force |
| 公共/私人隐私（无秘密/完整私信/敏感路径；私人无凭据） | 已完成（离线） | src/modules/diary.js:86-109,297-346 | 公共日记渲染来源限于事实摘要，无路径/凭据/DM 正文；私人 ACL 仅本地 owner 且 privateBook 开关 | — |
| 默认只写本地文件，不自动 IM/公开网页 | 已完成（离线） | src/modules/diary.js 无 outbox/IM 依赖 | generate 只写本地文件；不产生通知 | — |
| 灾备后仅用可信父恢复点+新 epoch 事实，明确标注缺口/来源 | 部分完成 | src/modules/diary.js:143-169,297-346,494-495；src/backup-recovery.js:1704-1712；test/recovery-diary.test.js（2 项通过） | 父 epoch 事件按 archived watermark 封顶合并✅；但渲染无恢复来源/缺口标注，recoveryDerived 置 true 后被清零且无消费 | 见 M05 |

### §15 Publishing

| 条款 | 状态 | 代码位置 file:line | 判断依据 | 备注 |
|---|---|---|---|---|
| §15.1 输入 schema、Artifact 校验 | 部分完成 | src/modules/publisher.js:115-156；src/contracts.js:63-104；src/artifact-store.js（verify） | mode/account/metadata/provider/artifact/productionTask 校验；envelope 层校验 schemaVersion；但 input.schemaVersion/requestId 未校验、未知 input 字段静默忽略 | 见 M14 |
| §15.1 不接受 approved:true；生产审批不继承 | 已完成（离线） | src/modules/publisher.js:115-333（无 input.approved 读取）；src/approval.js:4-24 | approved 无授权效力；发布审批 action=publish.prepare/external，与生产 production.run 分离 | 未显式拒绝该字段（见 M14 备注） |
| §15.1 go 未批准→原 Task waiting_approval 并回流 | 已完成（离线） | src/modules/publisher.js:295-307；src/command-service.js:329-338,422-459；test/entrypoint-reliability.test.js:101-115 | create 建 waiting_approval+challenge；decideAndContinue 按 kind 调 publisher.prepare，不新建 Task | F01 修复在入口层，本范围只核对模块接线 |
| §15.1 生产来源须真实成功且 readyForPublish=true | 已完成（离线） | src/modules/publisher.js:144-156 | 校验 productions[productionTaskId] 存在、succeeded、readyForPublish、artifact 匹配 | — |
| §15.1 未批准只形成草稿；不被 Browse/生产完成/IM 触发 | 已完成（离线） | src/config.js:381-382,722（autoPublish 必须 false）；src/modules/publisher.js 无自动调用方 | 无自动发布链；IM/工具只能 publish.create（须审批） | — |
| §15.2 Artifact 存在/受管/类型大小/派发前复验 | 已完成（离线） | src/modules/publisher.js:134-143,369-375；test/publisher.test.js:91-134 | create verify role/size；prepare 重验 sha256，替换即 ARTIFACT_INVALID | — |
| §15.2 元数据由 PlatformAdapter 按实际能力验证 | 与设计不一致 | src/modules/publisher.js:89-113；src/adapters/platforms/bilibili.js:10-16 | 硬编码 title≤80/desc≤2000/tags≤12×20/tid；适配器能力表无 metadata 校验接口 | 见 M08 |
| §15.2 业务键公式+metadataHash；待审/awaiting_manual 复用原 Task | 已完成（离线） | src/modules/publisher.js:162-187,188-227；src/contracts.js:149-166；test/publisher.test.js:210-226 | businessKey=`publish:platform:accountId:videoSha256:metadataHash`；metadataHash 含封面/目标/元数据/providerVersion；重复创建返回原 Task | — |
| §15.3 Bundle 元数据与 PUBLISH.txt，无绝对路径 | 已完成（离线） | src/modules/publisher.js:388-427 | metadata.json 含 schemaVersion/taskId/accountRef/artifacts/metadata/status/operationId:null/published:false；PUBLISH.txt 明示未发布；无绝对路径 | — |
| §15.4 Manual 审批后 awaiting_manual 非 succeeded；干跑不冒充已发布 | 已完成（离线） | src/modules/publisher.js:429-467,309-321 | prepare manual → awaiting_manual；dry 只出 plan、publish.status=dry_run、readyForPublish=false | — |
| §15.4 publish complete 本地受信人类/唯一 manual_confirmation Operation/幂等冲突 | 已完成（离线） | src/modules/publisher.js:656-795；cli.mjs:337；src/identity.js:213+ | humanProof.assert 绑定 taskId/inputHash/bvid/note；CLI 强制 --confirm；仅 Manual；拒绝 dispatched/unknown Operation；同/异回执幂等/冲突；同事务写 businessKeys+Publish+Task+事件；verification=manual_assertion | 本机 TTY/宿主证明属入口/真实环境验收 |
| §15.4 允许人类确认未发布/作废并保留 Bundle | 未实现 | src/modules/publisher.js 仅有 complete（656-795）与 resolveExternal（797-842）；src/command-service.js:498-513 | 无 manual "未发布/作废" 登记路径；cancelTask 只写 cancelRequestedAt，不更新 Publish | 见 M10 |
| §15.5 External 执行条件/execFile/占位符/超时/输出上限 | 部分完成 | src/modules/publisher.js:469-545,562-654 | allowExternalPublisher+successJson+approval+artifact 复核✅；execFile(shell:false)+env 白名单+占位符校验+timeout+maxBuffer✅；真实执行链本沙箱不可验证（EPERM） | 见 M09 |
| §15.5 stdout/stderr 脱敏 | 未实现 | src/modules/publisher.js:614-625 | stderr 截断 500 字直接进 operation.error，未用 errors.js:122-154 redactSecrets | 见 M09 |
| §15.5 最低回执校验/publisher_receipt/unknown 不降级/原 Operation resolve/未核销不得再发布 | 部分完成 | src/modules/publisher.js:626-653,614-625,797-842；src/effect-gateway.js:838-957 | 校验 ok+bvid 正则+https url→makeReceipt(verification=publisher_receipt)；启动后异常→unknown；无 Manual 降级；resolve 原 Operation；create 对同 businessKey unknown 返回原 Task/skip | 执行成功路径无法在沙箱取得真实证据；见 M09 |
| §15.6 限制声明：无原生上传，未配置只 Manual，Bundle/退出/生产完成不冒充成功 | 已完成（离线） | src/config.js:289-302；src/modules/publisher.js:123-133,388-427,656-795 | 适配器 publish.external=false；external 未配置拒绝；Bundle 标未发布；success 只来自结构化回执或人工断言 | — |

### §16 Coordinator

| 条款 | 状态 | 代码位置 file:line | 判断依据 | 备注 |
|---|---|---|---|---|
| 唯一自动调度入口 | 已完成（离线） | src/coordinator.js:91-151；src/command-service.js:39-47；src/index.js:340-350,743-756 | 定时器只调度 browse/diary；IM 只投递 CommandService；HTTP/工具/CLI 走同一 CommandService | — |
| 默认只 Browse/Diary；评论/DM 消费候选；生产/发布独立命令 | 已完成（离线） | src/coordinator.js:114-124,197-273 | tick actions 仅 browse/diary；生产/发布不被 tick 调用；评论/DM 只在 _consumeCandidates 内按配置 | — |
| 每类自动执行活跃锁；同类不重入；人工等待释放执行槽 | 部分完成 | src/coordinator.js:93,147-149,153-164,275-277 | browse/diary `_exclusive` 原子占位✅；但 tick 定时日记直接 `diary.generate`（133-140）绕过 `_exclusive('diary')`，可与手动 runDiary 并发（最终由日记身份锁串行） | 见 M06 |
| Browse 成功后候选按配置传评论/DM，各渠道最多 perRound | 已完成（离线） | src/coordinator.js:197-273 | comments.slice(0, perRound)、dms.slice(0, perRound)；agent/dry 策略接入 | — |
| 后置失败不撤销成功步骤，Task 为 partial 并记录未决集合 | 与设计不一致 | src/coordinator.js:182-193,238-243；src/task-manager.js:248-287 | unresolved/skipped→partial✅；但已结算失败子任务不纳入（探针 A：父 succeeded）；子任务全失败时 recomputeParent 把父置 failed | 见 M01/M07/M11 |
| start/stop 幂等；stop 停新任务等收尾，不伪装取消 | 已完成（离线） | src/coordinator.js:45-89；test/coordinator.test.js:70-92；test/entrypoint-reliability.test.js:185-202 | 重复 start/stop 去重；stop 设 stopping、清 timer、等待 active 完成（5s 上限），不取消在途；stop 后 runBrowse 拒绝 | — |
| 配置下一轮生效；派发再查 revision/权限/迁移栅栏 | 部分完成 | src/coordinator.js:94,167；src/config.js:766-773；src/effect-gateway.js:153-201,437-448,573-642 | 每轮读 configService.get()；reserve/dispatch 事务内 _assertConfig/_assertMigration/_assertFence/_assertInstance | 配置更新的原子性与监听属 F09（核心审查已报），本范围仅确认调度读取与派发复核 |
| IM 只投递 CommandService；生产执行器只上报，不建投稿/改账本 | 已完成（离线） | src/index.js:340-350,743-762；src/modules/production.js（无 publisher 调用） | ImBridge 构造接收 commandService；模型工具经 commandService；production 模块不创建 Publish/不直接改发布账本 | IM 真实宿主属 T16.2 BLOCKED |

## 缺口详情

### M01 [P1] F04 残余：已结算失败的后置子任务未聚合，父 Browse Task 仍 succeeded

- 设计要求：SPEC §16 "一个后置步骤失败不撤销已成功步骤，Task 为 partial 并记录未决集合"；§10.2 "部分成功且存在失败/unknown 为 partial"；DESIGN §8.1-5 不宣称外发完成。
- 证据：`src/coordinator.js:182-192` 最终结算只把 `interactions.skipped.length || unresolved.length` 计入 partial；`unresolved` 定义为"未结算"子任务。`src/coordinator.js:238-243` 仅在发送抛异常时写 skipped。本次进程内探针（comments mode=auto、适配器 writeComment 抛 `notSent` → operation failed、子 comment task failed 且 isSettled=true）结果显示：父 `task.status=succeeded`、`isSettled=true`，`interactions.comments[0]={status:'queued', sent:'failed'}`。`src/task-manager.js:248-287` 的 recomputeParent 虽处理子任务失败，但父任务已被 transition 为 succeeded，后续无链接触发重算。
- 影响：§10.2/§16 的 partial 语义失真，调用方、日记、状态页会把"有外发失败"的轮次当成功；与"不宣称外发完成"冲突。
- 建议：最终结算把已结算 failed/partial/unknown 子任务纳入判定（partial/unknown 按 §10 优先）；`interactions` 记录发送后的真实状态；补 auto 发送失败的 coordinator 回归测试。

### M02 [P1] F05 未修：浏览历史未按稳定账号隔离，失败冷却不可配置

- 设计要求：FR-BRO-002 候选按账号和 BV 去重；FR-BRO-003 失败冷却可配置；SPEC §5.2 账号切换独立命名空间。
- 证据：`src/modules/browse.js:96` `videoKey=\`bilibili:${contentId}\``，`163/174` 读写同键，无 accountId；`src/modules/browse.js:5,8,15` failureCooldownMs 仅构造参数默认 6h；`src/index.js:248` 构造未传入；`src/config.js:61-71` browse 白名单无该字段；`test/browse.test.js` 全程单账号（bindMockAccount 固定 1001），无同 BV 两 MID 用例。
- 影响：切换账号后 A 的 processedAt/lastFailureAt 会让 B 跳过同一视频或进入冷却；旧历史键无账号信息，修复需迁移策略。
- 建议：video 键加入稳定 accountId（定义旧键兼容/清理策略）；冷却时长进 config 并在 runtime 注入；补两账号同 BV 测试。

### M03 [P1] F07 未修：日记自动更新未接线，resolve 不标待重建，定时只生成单 book 且失败推进游标

- 设计要求：SPEC §14 "每次 Browse 后、每日定时和 resolve 后可重建；核查发生在次日时，将原操作日期与核查日期标为待更新"；默认 diary.afterBrowse=true；DESIGN D-09。
- 证据：`afterBrowse` 仅 `src/config.js:35,91,188` 出现，全 src 无消费；`src/coordinator.js:121-143` 每日只生成 `config.diary.publicBook ? 'public' : 'private'` 一个 book，且 `generate().catch()` 后无条件写 `diaryLastDate=today`；resolve 路径 `src/effect-gateway.js:838-957` 只追加 operation.confirmed/not_sent 事件，无日记待重建标记；全 src `needsRebuild` 仅 `src/backup-recovery.js:1709` 置 true（`src/modules/diary.js:494` 置 false）。
- 影响：日记滞后于事实；次日核查不触发原日日记重算；public+private 双开时 private 永不自动生成；失败日不再自动重试。
- 建议：Coordinator 在 browse 结束按 diary.afterBrowse 触发（异步、同 kind 锁）；resolve 写日记待重建标记（原日+核查日）；两 book 分别生成；仅成功后推进游标并加失败冷却。

### M04 [P2] 日记 force 参数无效；叙述生成早于事实变化判断

- 设计要求：SPEC §14 "force=true 可重建，但不修改原事件"；"事实输入未变化时复用原叙述，不再次调用模型制造无意义修订；变化才递增 revision"。T10 第 5 条要求 diary 支持 --force 重建。
- 证据：`src/modules/diary.js:348` 形参 force 在 generate 内无任何使用（grep 仅 348/480/580，后两处为 fs.rm force）；CLI `cli.mjs:255` 传入但不生效。`src/modules/diary.js:379-406` 每次先调 `agent.generateText` 生成 narrative，再比较 contentHash；agent 启用且叙述每次不同时，事实未变也会 revision+1。
- 影响：--force 无法强制重建；启用 Agent 时产生无意义模型调用与修订。
- 建议：force=true 绕过 unchanged 短路；先基于事实快照（或 facts 哈希）判断是否变化，未变直接复用旧正文；叙述缓存绑定事实快照。

### M05 [P2] 日记"锁外生成"与灾备缺口/来源标注未满足

- 设计要求：SPEC §14 "大文本生成在锁外完成。提交时按日记身份串行"；"灾备后…明确标注缺口/恢复来源，不把旧正文声称为最新完整记录"。
- 证据：`src/modules/diary.js:366-520` `_withLocalLock` 包住叙述生成+文件写+提交；叙述调用在锁内（380-400），仅不在 store 事务内。`_readEvents` 合并父 epoch（143-169，cap=min(cutEventSeq,parentArchivedEnd)），`test/recovery-diary.test.js` 2 项通过；但 `_render`（297-346）无恢复来源/缺口提示；`src/backup-recovery.js:1711` 置 recoveryDerived=true 后被 `src/modules/diary.js:495` 清零且无其他消费。
- 影响：多进程下"按身份串行"仅靠 revision CAS 兜底（不会覆盖新版本，但可能浪费生成，未实测）；恢复后日记无法标示缺口与来源。
- 建议：模型生成移到身份锁外，提交短事务内校验 revision/cursor；渲染加入 recoveryDerived/父恢复点/缺口标注；补多进程写者测试。

### M06 [P2] Coordinator 定时日记绕过 diary 类型锁

- 设计要求：SPEC §16 "每类自动执行必须有活跃锁；正在执行的同类轮次不能重入"。
- 证据：`src/coordinator.js:133-140` tick 直接 `this.diary.generate(...)`，不经过 `runDiary`/`_exclusive`（275-277）；tick 自身有 `_tickPromise` 防重（93,147-149），但手动 runDiary/CLI diary.generate 可与定时生成并发（最终由 diary 身份锁串行）。
- 影响：类型锁语义不完整；与 Browse 路径不一致。
- 建议：tick 走 `runDiary`/`_exclusive('diary')`。

### M07 [P2] 父任务结算边界：子任务全失败→父 Browse failed；superseded 未决审批阻止子任务 settle

- 设计要求：SPEC §16 后置步骤失败应 partial；§10.2 父任务汇总子任务；§14 日记"旧的待审不重复"与结算一致性。
- 证据：`src/task-manager.js:275-278`：子任务 failed 且无 succeeded 时把 parent.status 置 failed（父 Browse 已成功仍被降级）；`src/task-manager.js:197-199` pendingApprovals 只过滤 `!approval.decidedAt`，未排除 `supersededAt`；`src/approval.js:56-65` 新建挑战将旧挑战置 supersededAt。探针 B（重复 createDraft 后旧挑战被 supersede、随后发送失败）显示 failed 子任务 isSettled=false、父 unresolved 永久保留。
- 影响：父任务状态误导或永不 settle；重复浏览每轮为同一待审目标建新挑战会累积 superseded 记录。
- 建议：recomputeParent 对 browse 父任务失败只降 partial；pendingApprovals 排除 supersededAt（或显式 decision 状态）；补回归。

### M08 [P2] Publisher 元数据校验硬编码，未按 PlatformAdapter 能力验证

- 设计要求：SPEC §15.2 "标题、简介、标签和分区由 PlatformAdapter 按实际能力验证；未确认的平台限制在适配器验收中列明"。
- 证据：`src/modules/publisher.js:89-113` 硬编码 title≤80/desc≤2000/tags≤12×20/tid 正整数；`src/adapters/platforms/bilibili.js:10-16` 能力表仅 publish.manual{nativeUpload:false}，无 metadata limits/校验方法；publisher 不查询 adapter。
- 影响：平台限制变化时只改核心；"适配器验证/列明"分工未落地。
- 建议：增加适配器 metadata 能力/validate 接口并由 publisher 调用；未验证限制在能力表或验收文档列明。

### M09 [P2] External 发布输出未脱敏；真实执行链在本环境不可验证

- 设计要求：SPEC §15.5 "必须限制 stdout/stderr 总量并脱敏"；"启动后超时、输出损坏、无有效回执或不能证明未执行的非零退出均为 unknown"。
- 证据：`src/modules/publisher.js:604-611` 有 maxBuffer 2MiB；`614-625` 错误 details 直接截断 stderr 500 字写入 operation.error，未使用 `src/errors.js:122-154` 的 redactSecrets。本次 `node test/publisher.test.js` 中 external 成功用例失败（期望 confirmed、实际 unknown）；独立探针 `node -e "execFile(...)"` 得到 `Error: spawn EPERM`，EPERM 不属 ENOENT/EACCES/ENOTDIR → `_runExternalCommand` 判 OPERATION_UNKNOWN，故该失败是沙箱禁止 spawn 的环境因素，不是代码缺陷；同理 invalid-after-start 用例因 EPERM 也判 unknown 而"偶然通过"。
- 影响：脱敏缺失可能把外部脚本 stderr 中敏感内容持久化进 Operation.error；external 验收不能宣称完成。
- 建议：落 error 前用 redactSecrets 过滤 stdout/stderr；在有 spawn 权限环境重跑 publisher external 用例并区分启动前失败/启动后 unknown/成功。

### M10 [P2] Manual "确认未发布/作废"入口缺失

- 设计要求：SPEC §15.4 "允许人类确认未发布/作废，但保留 Bundle、状态历史，不抹掉未决 Operation"；DESIGN §8.4-6。
- 证据：`src/modules/publisher.js` 只有 complete（登记已发布 BV，656-795）与 resolveExternal（797-842）；`src/command-service.js:498-513` cancelTask 仅 requestCancel（写 cancelRequestedAt/事件），不更新 publishes 记录，awaiting_manual 任务无后续结算路径。
- 影响：人工确认未发布只能留 cancelRequest，Publish/Task 状态与 Bundle 索引不一致。
- 建议：增加本地人类 manual-not-published/void 入口，同事务更新 Publish/Task/事件并保留 Bundle 与状态历史。

### M11 [P2] interactions 记录的是发送前旧状态

- 设计要求：轮次结果需"明确引用未决任务，不宣称外发完成"。
- 证据：`src/coordinator.js:238-243` push `status: draft.task.status`（createDraft 返回的 queued 快照），发送后不刷新；探针 A 显示 `{status:'queued', sent:'failed'}` 而子任务实际 failed。
- 影响：状态报告自相矛盾，排查困难。
- 建议：发送后重读任务或使用 send 返回的 task.status。

### M12 [P2] §11.3 discovery 失败时 Task=failed 与 result.status=partial 不一致

- 设计要求：SPEC §11.3 "全部候选均合理跳过且无失败时 Task 以 succeeded 结算…存在失败时为 partial"。
- 证据：`src/modules/browse.js:145` 置 status=partial，`199-205` 却 transition failed；`test/browse.test.js:95-108` 固化该行为。
- 影响：状态口径需同时判断两个字段；字面要求未满足。
- 建议：明确轮次级发现失败语义（修订 SPEC 或统一为 partial）。

### M13 [P2] DM 同目标冷却窗口在预留事务外检查

- 设计要求：FR-DM-004 "每轮/每日额度和同目标分享冷却必须在预留事务中检查"。
- 证据：`src/modules/direct-messages.js:174-183` 用 snapshot 判断 sameVideoDays 冷却；预留事务内只做业务键可用性/额度（`src/effect-gateway.js:449-472,499-511`）。未发现重复外发路径（同 targetKey 事务内原子拒绝），但与"事务中检查"字面不符。
- 建议：把 targetKey 的 confirmedAt+sameVideoDays 窗口判定移入预留事务（或网关支持 cooldown 策略）。

### M14 [P2] §15.1 输入 schemaVersion/requestId 未校验

- 设计要求：SPEC §15.1 投稿输入含 schemaVersion/requestId；FR-EXT-001 未知安全字段不能静默忽略。
- 证据：`src/modules/publisher.js:115-133` 未读取 input.schemaVersion/requestId；`src/contracts.js:63-104` 只校验 envelope 顶层未知字段，input 由模块自校验；`approved:true` 被静默忽略（无授权效力，但未显式拒绝）。
- 影响：输入契约严格性不足；与 §15.1 schema 声明不一致。
- 建议：publisher.create 显式校验 input.schemaVersion===1 并拒绝未知安全字段（含 approved:true）。

## 无法确认项

1. 真实 B 站浏览/评论/私信/互关接口行为（无凭据、无网络）：本次仅 Mock 适配器与代码路径证据，账号隔离修复后行为、平台限制均未真实验证。
2. External 发布器真实执行链：沙箱禁止 spawn（独立探针 EPERM），成功回执、超时、输出损坏、unknown 判定只有代码证据；`test/publisher.test.js` 的 external 成功用例在受限环境失败、invalid-after-start 用例因 EPERM 偶然通过。
3. 日记多进程并发写同一身份：仅有进程内锁 + revision CAS 代码证据，无多进程测试；"旧生成者不覆盖新版本"未实测。
4. 灾备后日记"明确标注缺口/恢复来源"：当前实现无该标注，无法验证目标呈现；父 epoch 合并仅由 `test/recovery-diary.test.js` 2 项佐证。
5. §12 的 perRound 单模块边界：模块内无 perRound 自检，判断为协调器/编排层职责，SPEC 未明确到模块级。
6. §15.2 "PlatformAdapter 按实际能力验证"：适配器能力表当前未定义 metadata limits，真实平台限制无法核对。

## 实际运行的定向测试与结果

未运行 `npm test`/`npm run check`（约束：Windows 沙箱下 runner spawn 会 EPERM）；以下均以 `node test/<file>.test.js` 进程内执行，并记录实际结果：

| 命令 | 结果 | 说明 |
|---|---|---|
| `node test/browse.test.js` | 3/3 通过 | 去重/自有/冷却/评分/失败隔离/发现失败 |
| `node test/comments.test.js` | 8/8 通过 | 审批/同文/干跑/unknown/模板/自身与@/resume |
| `node test/direct-messages.test.js` | 7/7 通过 | 白名单/互关/自身/数组/干跑/回执摘要/resume |
| `node test/diary.test.js` | 6/6 通过 | 重建/隔离路径/私人 ACL/两个崩溃窗口/2100 事件 |
| `node test/publisher.test.js` | 6 通过 / 1 失败 | 失败：external 成功用例期望 confirmed、实际 unknown；根因为沙箱 spawn EPERM（见 M09），未计为代码缺陷；invalid-after-start 用例同因偶然通过 |
| `node test/coordinator.test.js` | 3/3 通过 | start/stop 幂等与待审批不阻塞、auto 模板、scheduler 窗口 |
| `node test/integration.test.js` | 2/2 通过 | browse→approval→send→父任务重算 succeeded/unresolved=[]、日记含评论事实 |
| `node test/entrypoint-reliability.test.js` | 11/11 通过 | 手动浏览接回 Coordinator、同类并发拒绝、stop 后拒绝、dry 不自动评论、容量门禁 |
| `node test/task-manager.test.js` | 6/6 通过 | 结算/unknown/父任务未结算（补充核对） |
| `node test/recovery-diary.test.js` | 2/2 通过 | 恢复后父 cut 前事实并入日记（补充核对） |
| 进程内探针 A（`node --input-type=module -`） | 已复现缺口 | comments mode=auto + 写接口 notSent 失败 → 父 task succeeded、子 comment failed/isSettled=true、interactions[0]={status:'queued',sent:'failed'}（M01/M11） |
| 进程内探针 B（同上） | 已复现缺口 | 重复 createDraft 后旧挑战 superseded、发送失败 → failed 子任务 isSettled=false、父 unresolved 永久保留（M07） |

探针仅使用测试 harness 与 os.tmpdir 临时目录，未写任何项目文件；探针脚本经 stdin 执行，未落盘。
