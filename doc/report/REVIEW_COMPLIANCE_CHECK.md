# REVIEW_REPORT 落实情况复核报告（二次复核）

- 复核日期：2026-11-06 23:50（Asia/Shanghai）
- 复核对象：`doc/SPEC.md`（1352 行）、`doc/DESIGN.md`（640 行）、`doc/TASKS.md`（872 行）、`doc/report/DESIGN_REVIEW_SUMMARY.md`（82 行）、`doc/report/SESSION_SUMMARY.md`（59 行），对照 `doc/report/REVIEW_REPORT.md`（272 行，2026-11-05 版，未改动）
- 复核性质：**只读复核**；未修改 SPEC/DESIGN/TASKS，不改变 GATE-0 / GATE-MEM，不代表代码实施或真实环境验证。
- 本轮背景：2026-11-06 23:41 三份主文档再次修订（修订记录新增“2026-11-06 按二次复核…”），本次重点复核上轮 31/38 后遗留的 7 项（P2-05、P2-10、P3-06、P3-07、P3-10、P3-12、P3-13）及 P2-18 残留，并对全部 38 项做回归断言。

## 一、总体结论

**REVIEW_REPORT 的 38 项问题现已全部落实，本次修订闭环成立。**

| 级别 | 总数 | 已落实 | 部分落实 | 未落实 |
|---|---|---|---|---|
| P1（GATE-0 前必须修复） | 5 | **5** | 0 | 0 |
| P2（对应任务开工前修复） | 20 | **20** | 0 | 0 |
| P3（可随修订/实施修复） | 13 | **13** | 0 | 0 |
| **合计** | **38** | **38** | **0** | **0** |

结论：

1. 上轮遗留的 7 项已全部关闭（见 §2）；P2-18 的历史摘要残留也已清理。
2. 未引入新需求：FR 仍为 78 条（新增 52 条）、任务仍为 23 主＋8 子项、D-01～D-20 / R-01～R-15 不变；`config.example.json`、`package.json`、`cordis.patch.yml` 未改；`src/` 仅空 `modules`、`test/` 为空；GATE-0 / GATE-MEM 仍未解除。
3. 本轮未发现新的阻断性矛盾；仅有 4 条非报告项的轻微观察（§5），不影响“按 REVIEW_REPORT 完成修改”的结论。

## 二、上轮遗留项关闭证据（2026-11-06 修订）

| 上轮状态 | 编号 | 本轮关闭证据（当前文档位置） |
|---|---|---|
| 部分 → 已关闭 | P2-05 | `SPEC §21.1` L1076 新增：`requestKey` 统一为 `"jcs-sha256-v1:"+lowercaseHex(SHA256(JCS({workspaceId,principalId,action,requestId})))`，明确 requestId/requestKey 关系、作用域与“DESIGN 生产键/TASKS requestKey 均用此定义” |
| 未落实 → 已关闭 | P2-10 | `SPEC §19.1` L971-972 新增 **Backup**（策略/manifest/configRevision/timeZone/JCS/ledger-full/保留/fence/断电）与 **Recovery**（独立只读恢复/新 epoch/不确定区间/结构化 scope/unknownExposure/证据/两阶段 authorize/分 scope 解冻）两条单测类别；`§19.2` L999 新增“灾备集成统一归 §19.5 与 TASKS T22”指引 |
| 未落实 → 已关闭 | P3-06 | `TASKS` L842 已改为“这与 SPEC §27.4 的‘原审批挑战全部失效…’同口径”，与 SPEC §27.4 L1306 一致；全文无 §27.5 错指 |
| 部分 → 已关闭 | P3-07 | `SPEC §17.1` L829 明确 `/comments/approve` 为“评论动作兼容入口：仅把 comment 的 approvalId/decision/nonce/mode 转换为统一 `/approvals/decide` 调用，共用同一 ApprovalService/原 Task 回流，不另建审批状态”；与 L833 的通用决口关系已说明 |
| 部分 → 已关闭 | P3-10 | `TASKS` GATE-0 L19 已改为“15分钟账本间隔、20分钟最大恢复点年龄、**24小时媒体覆盖目标**及条件化60分钟只读RTO”；TASKS L419 同步；全文无“24小时媒体RPO” |
| 部分 → 已关闭 | P3-12 | `TASKS` L448 已改为“T11 须以 T19/T22/T17.3 等全部明示验收为前提，任何单项结束都不代表全量完成”；全文无“原T10/旧T10”残留 |
| 未落实 → 已关闭 | P3-13 | `DESIGN §8.6` L459 的 prepare 冻结清单已补“**素材/Artifact导入**”，与 SPEC FR-MIG-002 L1222、TASKS T18 L340 对齐 |
| 附注清理 | P2-18 | `SESSION_SUMMARY.md` L39 已标注“历史静态校验结果（仅适用于当时轮次）…不代表当前文件状态”；L50 已改为“主文档状态表述已完成后续更正…统一口径见 TASKS §8”；历史横幅 L3 保留 |

## 三、全部 38 项状态（本轮断言结果）

> 断言方式：以当前文档原文关键词/字段逐项校验（38/38 PASS）。P1 行号为本轮复核时点。

### 3.1 P1（5/5 ✅）

| 编号 | 要求摘要 | 状态 | 证据 |
|---|---|---|---|
| P1-01 | §19.3/§19.4 接入 FR-DR-002 备份保护与 RecoveryHold 前置 | ✅ | SPEC L1008 每次受保护真实派发前由 T20/T21 核验；L1017 完成门槛含备份/恢复门禁测试 |
| P1-02 | RecoveryHold/unknownExposure schema、scope 与匹配语义 | ✅ | SPEC §2 L42-44；§27.5 L1312-1314（字段/scope 变体/scopeKey/覆盖匹配/部分解冻/unknownExposure） |
| P1-03 | recovery.json 权威源与两阶段提交 | ✅ | SPEC §27.7 L1342-1343；§4.2 L142-145；§27.4 L1305 |
| P1-04 | 迁移 phase/命令/取消/回滚闭环 | ✅ | SPEC §25.1 L1217；§25.4 L1242；§17.3 L891-893；DESIGN §8.6 L459/L465；TASKS T18 L347 |
| P1-05 | Task 状态机迁移表与组合矩阵 | ✅ | SPEC §10.1 L594-606；Task JSON L635 `holds[]`；TASKS T02 L122 |

### 3.2 P2（20/20 ✅）

| 编号 | 要求摘要 | 状态 | 证据 |
|---|---|---|---|
| P2-01 | DESIGN 主流程补备份/RecoveryHold 闸门 | ✅ | DESIGN L404/L406/L440/L452/L457 |
| P2-02 | 统一 recovery phase 枚举/映射 | ✅ | SPEC §27.4 L1305 |
| P2-03 | Operation/Execution 结算与 resume 语义 | ✅ | SPEC §7.3 L481-488；§24.3 L1203；DESIGN L553 |
| P2-04 | 日记身份/路径、eventCursor、pendingCommit | ✅ | SPEC §14 L729-734；DESIGN L540-542 |
| P2-05 | requestKey 规范化定义 | ✅ | SPEC §21.1 L1076（本轮新增） |
| P2-06 | 配置校验冲突/缺口 | ✅ | SPEC §4.4 L286-294 |
| P2-07 | configRevision/stateHash/timeZone | ✅ | SPEC §4.5 L316；§6.1 L388；§27.3 L1291-1292 |
| P2-08 | 通知 unknown 闭环接口 | ✅ | SPEC §21.2 L1097；§22.3 L1136；CLI L881；DESIGN L368/L453 |
| P2-09 | 首次运行 vs 主账本缺失判别 | ✅ | SPEC §4.2 L145；TASKS T02 L121 |
| P2-10 | §19.1/§19.2 灾备测试类别与指引 | ✅ | SPEC L971-972、L999（本轮新增） |
| P2-11 | checkpointFence×迁移封存 | ✅ | SPEC §27.1 L1277 |
| P2-12 | 备份间隔/屏障/容量 | ✅ | SPEC §27.1 L1269/L1273；§27.2 L1283；§6.3 L441 |
| P2-13 | 迁移证据口径与迁移前置健康点 | ✅ | SPEC §25.2 L1222/L1226；§25.3 FR-MIG-007 L1235 |
| P2-14 | 人类证明降级路径 | ✅ | SPEC §22.1 L1115 |
| P2-15 | Task holds 字段与生命周期 | ✅ | SPEC §10.1 L635；§2 L43；§27.5 L1312 |
| P2-16 | §18 错误码任务/验收归属与 HTTP 映射 | ✅ | SPEC §17.1 L841-853；TASKS T02 L129、T10 L400 |
| P2-17 | §4.2 章节映射与追溯粒度 | ✅ | TASKS L522-541 章节表、L545 起 FR 表（含 SPEC § 列） |
| P2-18 | 历史摘要过期标识与哈希清理 | ✅ | DRS L3；SESSION L3/L39/L50 |
| P2-19 | 自有内容过滤须有 SPEC FR | ✅ | SPEC FR-BRO-003 L679 |
| P2-20 | 关键路径/依赖拆分 | ✅ | TASKS §2.1 L60-63；T13 L490 |

### 3.3 P3（13/13 ✅）

| 编号 | 要求摘要 | 状态 | 证据 |
|---|---|---|---|
| P3-01 | T13 依赖与交付输入一致 | ✅ | TASKS L490、§2.1 L70 |
| P3-02 | D/R 一对多映射标注 | ✅ | TASKS L767/L771/L772 |
| P3-03 | 共享目标文件编辑边界 | ✅ | TASKS §2.1 L75 |
| P3-04 | 日期/轮次、AGENTS、package 版本说明 | ✅ | 三文档 2026-11-06 修订记录；无 AGENTS；TASKS T19 L429 |
| P3-05 | 术语统一 | ✅ | SPEC §2 L42-44；DESIGN L526/L553 |
| P3-06 | §27.4/§27.5 交叉引用 | ✅ | TASKS L842（本轮修正） |
| P3-07 | 接口细节（端点关系/appendEvent/skipped/force） | ✅ | SPEC L829（本轮补充）、L454、L688、L869 |
| P3-08 | cordis.patch.yml 与 §3.3 验证归属 | ✅ | TASKS L393/L400/L527 |
| P3-09 | §19.2/§19.5 场景逐条映射 | ✅ | TASKS T19-01～19（L606-624）、T22-01～14（L630-643） |
| P3-10 | RPO 措辞 | ✅ | TASKS L19（本轮修正）、L419 |
| P3-11 | 约束词使用 | ✅ | SPEC L10“必须/可以/不得”，全文无“应当” |
| P3-12 | 旧任务编号残留 | ✅ | TASKS L448（本轮修正），全文无“原T10/旧T10” |
| P3-13 | DESIGN prepare 冻结清单补素材导入 | ✅ | DESIGN L459（本轮修正） |

## 四、机械回归校验（本轮）

| 校验项 | 结果 |
|---|---|
| 38 项断言 | **38 PASS / 0 FAIL** |
| FR 计数 | SPEC 78 个唯一 FR（旧 26＋新增 52）；TASKS FR 表 52 行、无重复/遗漏 |
| 任务计数 | 23 主任务（T00～T22）＋8 子项，唯一、无重复 |
| D/R 计数 | D-01～D-20（20）、R-01～R-15（15），DESIGN/SPEC/TASKS 一致 |
| 配置一致性 | `config.example.json`（`668a614e`）与 SPEC §4.3 深比较 **diff = 0** |
| 章节引用 | 显式 SPEC/DESIGN/TASKS § 引用无悬空 |
| Markdown 结构 | 表格列数异常 0；代码围栏成对（SPEC 36 / TASKS 14 / DESIGN 6 个标记） |
| 场景映射 | T19 19 行、T22 14 行均在表 |
| 代码/配置状态 | `src/` 仅空 `modules`、`test/` 为空；`package.json`（`2501e7ad`）、`cordis.patch.yml`（`a6eb6fc4`）未变 |
| 文件基线（本轮实测） | SPEC `fd22e521`/120,779B/1352 行；DESIGN `220f7a32`/68,012B/640 行；TASKS `0029ae9d`/111,473B/872 行；SESSION `2d901986`/9,809B；DRS 未变 `59a87389`/8,306B；`REVIEW_REPORT.md` 未变 `c2aef99b`/51,469B |

## 五、非报告项的轻微观察（不影响“完成”结论）

1. `SESSION_SUMMARY.md` L35 仍写“以…2026-11-05 修订记录为准”，而主文档现已新增 2026-11-06 修订记录；该摘要已明确标注历史/非现行基线，属可忽略的措辞滞后。
2. TASKS §4.2 的“§19”章节行仍列 T11/T12/T17.3/T19/T22；§19.1 新增 Backup/Recovery 类别的实现任务为 T20/T21，可选地在章节行补列 T20/T21（FR 表已通过 FR-DR-* 映射 T20/T21，追溯链未断）。
3. ~~迁移 hold 的 caseId 未写明 null/省略~~ **已在本轮修订中关闭**：SPEC §27.5 L1312 已明确迁移 hold 使用相同字段结构但 `caseId=null`，不得伪造恢复 case。
4. 归档的 `REVIEW_REPORT.md` 附录 A 仍以旧根目录路径与旧哈希描述文件（该报告未改动）；作为历史证据可接受，若作为现行基线引用建议加“归档”说明。

## 六、结论

- **结论：REVIEW_REPORT 的 38 项问题已全部按描述完成修改；本次复核闭环成立。** 报告中的 P1 必修项（安全闸门、恢复决定一致性、迁移/状态机闭环）与全部 P2/P3 项均已落实，且未引入新需求、未改动配置/代码/审核门。
- **建议**：可标记为“按 REVIEW_REPORT 完成（38/38）”；GATE-0 是否批准仍由用户决定，本次修订不构成实施、真实平台写、IM 发送、媒体工具执行或备份执行授权。
- 本报告已覆盖此前版本（31/38），之后如主文档再次变更，应以最新文件哈希与本清单重新复核。

---

*本复核只读、未修改 SPEC/DESIGN/TASKS；仅更新本报告文件；未运行代码或真实环境验证；不改变 GATE-0/GATE-MEM。*
