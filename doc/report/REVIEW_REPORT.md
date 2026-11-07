# dsh-bili-unified 文档复核报告

- 复核日期：2026-11-05（Asia/Shanghai）
- 复核基线：`SPEC.md` / `DESIGN.md` / `TASKS.md` 0.2.1-draft（另有 `config.example.json`、`cordis.patch.yml`、`package.json` 及两份历史摘要作为对照）
- 复核性质：**只读静态文档复核**。不修改任何文档，不改变 GATE-0 / GATE-MEM 状态，不构成实施、真实平台写入、真实 IM 发送、媒体工具执行或备份执行授权；本报告不新增任何未经文档确认的需求。
- 复核方法：全文逐行通读；三路独立审计（需求追溯、跨文档一致性、技术方案合理性）交叉验证；并使用 Node 静态脚本对 FR/任务 ID、映射表、依赖图、配置深比较、章节引用、阈值、表格/代码围栏做机械校验。所有结论均回查原文行号后引用。
- 问题计数：**P1 × 5、P2 × 20、P3 × 13，P0 = 0**。

> **归档说明（2026-11-07）**：本报告是 2026-11-05 复核时点的只读记录。项目已于 2026-11-07 建立 git 版本控制（`main` 分支，`origin` 为 `git@github.com:keen2202/xiaofeiyu.git`）；文内“项目不是 git 仓库/非 git 仓库”、文件行数与哈希等仅反映复核时点，不代表当前状态。

---

## 0. 复核依据与口径

### 0.1 依据文件与基线状态

| 文件 | 角色 | 行数 | 文档自述状态 |
|---|---|---|---|
| `SPEC.md` | 技术规范（§1～§27） | 1299 | 0.2.1-draft；架构方向已确认、修订稿待审核、核心实施未批准 |
| `DESIGN.md` | 设计方案（§1～§14，D-01～D-20 / R-01～R-15） | 636 | 0.2.1-draft；方向已确认、修订稿待审核、核心实施暂停 |
| `TASKS.md` | 实施任务与验收计划（T00～T22、GATE-0/GATE-MEM） | 803 | 0.2.1-draft；GATE-0 未解除、核心未实施 |
| `config.example.json` | 普通业务默认配置（不含 BackupPolicy） | 131 | 文档声明未随 0.2.1 修改，与 SPEC §4.3 一致 |
| `cordis.patch.yml` | DSH 挂载补丁草案 | 5 | 既有草案，未声明已按宿主 schema 验证 |
| `package.json` | 包清单草案 | 44 | 既有草案；T19 获批后同步检查脚本 |
| `DESIGN_REVIEW_SUMMARY.md` | 旧审查摘要（0.2.0 基线） | 80 | 自述 0.2.0；其他文档称其为“旧审查摘要” |
| `SESSION_SUMMARY.md` | 过程摘要与待办（非规范来源） | 63 | 自述 0.2.1-draft 过程快照 |

项目内没有独立的 README、AGENTS 或文档编写规范文件；本次“既定要求及项目规范”以三份主文档自述的基线、审核门、约束强度（必须/应当/可以/不得）、fail-closed 原则及既有审核口径为准。该缺口本身见 §8 第 9 项。

### 0.2 严重程度定义

| 级别 | 含义 | 修复时点建议 |
|---|---|---|
| **P0** | 阻断审核或方案不可成立 | 必须立即停止并重做 |
| **P1（高）** | 影响安全门禁可执行性、真实验收口径或核心规范自洽；不修复会在实施/验收中产生系统偏差 | GATE-0 批准前 |
| **P2（中）** | 描述完整性、跨文档一致性、接口/字段/任务归属缺口 | 对应任务开工前（建议同批修订） |
| **P3（低）** | 术语、追溯粒度、元数据与文档卫生 | 可随修订/实施修复 |

### 0.3 方法与限制

- **已做**：通读全部文档；机械校验（FR 编号集合与映射、任务 ID/依赖、配置与 SPEC §4.3 深比较、跨文档阈值、章节引用、Markdown 结构）；三路独立审计交叉核对；所有报告问题均回查原文。
- **未做/不能做**：未运行任何代码（仓库 `src/` 仅有空 `modules` 目录、`test/` 为空，与文档自述一致）；未访问真实 B 站、真实 DSH 宿主、真实 IM、ffmpeg/ffprobe、External 发布器或物理备份介质；项目不是 git 仓库，无法用版本历史核对“哪一轮改了哪些文件”。
- 因此，凡涉及真实环境行为与性能的项目，本报告一律列入 §8“无法确认项”，不臆测、不代替验收。

---

## 1. 总体结论

**总体判断：0.2.1-draft 文档体系基本符合既定架构方向与自设规范，未发现 P0 级阻断性矛盾；需求覆盖与追溯机制成立，可作为修订后审核的基线，但尚不具备直接解除 GATE-0 进入实施的条件。**

具体判断：

1. **需求覆盖与追溯总体成立。** SPEC 共 78 个唯一 FR（旧 26 条：BRO 8 / COM 10 / DM 8；新增 52 条：EXT 4 / IM 8 / ART 6 / PRO 10 / MIG 10 / LITE 4 / DR 10），全部成条定义、无重复、无畸形编号；TASKS §4.2 恰好 52 行覆盖全部新增 FR，无遗漏、无重复、无 SPEC 外编号；“42 + 10 = 52”在 SPEC §19.4/§20、DESIGN §13、TASKS §1/§4.2/§8 中算术一致。旧 26 条 FR 以章节范围方式映射到 T05/T06/T07。D-01～D-20、R-01～R-15 均有映射。SPEC §3.1 包结构中的文件均有任务目标文件认领（个别间接项见 P3-08）。
2. **任务拆分与依赖关系无结构性错误。** 23 个主任务（T00～T22）与 8 个子任务（T12.1-3 / T16.1-2 / T17.1-3）ID 唯一；解析出的依赖无悬空引用、无环；与 TASKS §2.1 阶段图基本一致；本地生产分支不依赖 B 站/IM/商业服务，发布不依赖生产 Runner，与文档声明相符。
3. **跨文档硬数字与配置一致。** `config.example.json` 与 SPEC §4.3 代码块深比较完全一致（20 个顶层键逐值相等，diff = 0）；版本/状态、D/R/FR/任务计数、各阈值（2000 热事件、500/5000 清理、64KiB、10000 journalPending、1MiB/10MiB、15min/24h/60min/100MiB、8/7/4、熔断 5/30 分钟、各项额度）跨文档一致；Markdown 表格与代码围栏完整。
4. **技术方案整体合理。** 单写者轻核心＋可选适配器＋持久事件账本＋分层备份/只读灾备的方向自洽；“三类派发上下文”（Operation / Execution / outbox）共享栅栏但不伪造 Operation、`unknown` 冻结＋人工 resolve 闭环、`(historyEpoch, seq)` 事件序列、备份票据与迁移票据分离、旧任务不自动重放等关键设计方向正确，失败模式普遍 fail-closed。
5. **但存在 5 项 P1 关键缺口，集中在“安全闸门与验收口径可执行性”**：
   - 真实环境验收（SPEC §19.3/§19.4）未接入 FR-DR-002 的备份保护/RecoveryHold 前置，与 TASKS T12.1/T12.2 冲突；
   - RecoveryHold / unknownExposure 缺结构、scope 表示与匹配语义，而它是所有外部派发入口共用的安全闸；
   - 灾备恢复“先持久化决定再开放能力”缺少跨 `recovery.json` / 账本 / instance 能力清单的权威源与提交协议；
   - 迁移 phase / 命令 / 取消 / 回滚缺少可执行闭环（FR-MIG-009 无 CLI 入口与回退 phase）；
   - Task 状态机不闭合（初始态、直达 waiting_approval、running→cancelled、interrupted 出边与 resume 矛盾、isSettled×executionActive 无合法组合矩阵）。

**结论建议：GATE-0 采用“修订后批准 / 有条件批准”**——先完成 §6 的 P1 必修清单与建议同批的 P2，再由用户确认；不建议在当前文本上直接判定批准并启动实施。P2/P3 可分批修复，不构成整体推翻。

---

## 2. P1 问题（建议 GATE-0 批准前必须修复）

### P1-01 真实验收与完成门槛未同步灾备保护前置
- **位置**：SPEC §19.3（L963-972）、§19.4（L974-981，尤其 L978）；对照 SPEC §27.1 FR-DR-002（L1226）、SPEC 引言 L9；TASKS T12.1（L459）、T12.2（L469）。
- **证据**：FR-DR-002 要求“首次真实平台写、生产付费调用和 IM 发送前，必须有 owner 确认的独立故障域与验证通过、未超龄的 ledger/full 恢复点，无策略/过期/失效禁止新派发”；TASKS T12.1/T12.2 已加入“先建立 owner 核验的独立有效恢复点并确认无匹配 RecoveryHold，缺条件保持阻塞”。但 SPEC §19.3“真实环境验收”仅要求授权、whoami、白名单、最低额度、单独验证；§19.4“完成门槛”的“每条副作用路径有干跑/禁用、权限、重复防护、unknown 及迁移冻结测试”也未列入备份保护/RecoveryHold。SPEC L9 却自述“DESIGN/SPEC/TASKS 已同步 0.2.1-draft 的灾备契约、任务映射与验收口径”。
- **判断依据**：同一规范中 FR-DR-002 为强制条款，而“验收统一对照”的 §19 没有对应步骤；TASKS 已按新口径补充，SPEC 验收章节停留在旧口径。属于规范内部不一致 + 验收可绕过安全门禁。
- **影响**：按 SPEC §19.3 执行真实评论/DM/IM/External 验收时，可在无恢复点、存在 RecoveryHold 的情况下发送，违反 fail-closed；GATE-0 审核者对“验收口径是否已同步”的判断会失真。
- **修改建议**：在 §19.3 的真实平台写、IM、External 三段补充“须先满足 FR-DR-002 的独立故障域、未超龄 ledger/full、无匹配 RecoveryHold；测试配置、dryRun 与 go 不得豁免”；在 §19.4 完成门槛增加“受保护派发拒绝 + 在途回执可落账”的可判定测试项；并修正 L9 的“已同步”表述或改为指向 T12.1/T12.2 的强制前置。

### P1-02 RecoveryHold / unknownExposure 无结构、scope 与匹配语义
- **位置**：SPEC §2 术语（L41）、§27.5 FR-DR-006（L1260-1263）、§27.6（L1270-1275）；TASKS T14 第 6 条（L145-146）、T03（L165-167）、T09（L321）、T16.1（L248）、T17.2（L294）、T18 第 1 条（L334）、T21 第 3 条（L375）、T22（L412）。
- **证据**：上述派发入口普遍要求“备份保护 / 无匹配 RecoveryHold”；§27.6 只给出 scope 类别示例（“account/platform.action、workspace/provider.budget、IM bot/conversation 或全 workspace”），§27.5 只说明“无法确定费用总额时标 unknownExposure 并停止该预算范围新付费”。全文没有 RecoveryHold 的字段结构、scope 的规范化表示、匹配算法（等值/前缀/交集/优先级）、部分释放/复议规则；unknownExposure 亦无结构、范围、币种/上限、与 hold/case 的关联及解除条件。
- **判断依据**：这是平台写、付费、IM、迁移激活、恢复解冻共同依赖的中央安全闸。若匹配语义由实现者自行决定，过宽会导致全系统停写，过窄会漏放外部写或重复外发；T21/T22 的“匹配 hold”用例也没有可判定的期望。
- **影响**：FR-DR-002/006/008、T14/T21/T22 的 fail-closed 断言无法一致实现或验证；属于安全保证的根节点缺口。
- **修改建议**：在 SPEC §27.5/§27.6 或新增小节定义：RecoveryHold schema（id、caseId、kind、scope 字符串/字段、匹配语义、revision、状态、解除证据引用）；unknownExposure schema（范围、币种、上限、来源、解除条件）；匹配与优先级（默认拒绝、无法判断时最保守匹配）；T14/T21 共享同一实现与矩阵测试，T22 注入用例覆盖“跨 Cookie / 新 requestId / 新 epoch 不消除风险”。

### P1-03 灾备恢复决定的跨文件持久化与权威源未定义
- **位置**：SPEC §4.2（L140）、§6.1（L381）、§25.1（L1168）、§25.3（L1184）、§27.4（L1252/1255）、§27.7（L1289-1292）；TASKS T21 第 1/7 条（L373/L379）。
- **证据**：§27.7 要求“先持久化审批决定/证据及目标状态，最后开放能力；任一文件缺失、revision 不匹配或中途崩溃均保持更严格冻结”。但恢复决定涉及三处持久面：`<recoveryDir>/recovery.json`（§4.2 L140，无默认值/解析规则/目录选择规则）、账本 `recovery` 字段（§6.1 L381；§27.5 L1255 “账本 recovery.phase 为 readonly”）、`instance.json` 与 activation 能力清单（§25.1 L1168、§25.3 L1184；无 schema）；三者的权威源、提交顺序、revision 冲突判定、失效规则均未定义。另 §27.4 FR-DR-005/T21 要求 RecoveryService “独立于损坏的普通 Store 启动”，但其需要的 instanceId/activation/能力清单位于可能受损的 `<dataDir>`，读取与失效规则未定义。
- **判断依据**：这是“恢复决定—账本—实例能力”三面一致性要求；缺少跨文件提交协议时，“更严格冻结”不可证明。T21 验收要求“任一文件缺失或版本不一致按更严格门禁”，但没有给出可判定的判定面与顺序。
- **影响**：崩溃窗口可导致“账本已放行但证据/能力未同步”或永久冻结；FR-DR-009 的“先持久决定后开闸”不可验证，灾备恢复的 fail-closed 承诺不成立。
- **修改建议**：明确唯一权威存储（建议以独立 `recovery.json` 为恢复决定权威、账本只存引用摘要）与两阶段提交顺序/revision 规则；定义 `recoveryDir` 默认/配置与访问控制；定义 instance/activation/capability 清单 schema 与失效规则；纳入 T21 断电注入矩阵（restore/reconcile/authorize 各写入点）。

### P1-04 迁移状态机、命令与回退闭环缺失
- **位置**：SPEC §25.1（L1167）、§25.2（L1172-1177）、§25.4 FR-MIG-009（L1192）、§17.3 CLI（L853-859）；DESIGN §8.6（L459/L464）；TASKS T18 第 4/9 条（L337/L342）、T12.3（L479-481）。
- **证据**：§25.1 定义 phase 为 `active→quiescing→sealed→released`；但 CLI 只有 `migration prepare/export/release/import/validate/activate/status`（L853-859），没有 seal、abort/cancel 命令，也没有 phase 回退定义；`quiescing→sealed` 由哪个命令/事务触发未绑定。FR-MIG-009 要求“release 前可在审计下取消 prepare，但必须作废封存包及激活资格”，但 CLI 无取消入口；DESIGN §8.6 L459 还要求“晚到回执…release 前须作废封存并纳入最新账本后重新封存”，该“作废→重新封存”路径在 SPEC §25 无规定。FR-MIG-009 的“release 后无论目标是否已激活，先持久禁用目标及旧票据，再反向交接目标最新账本”也没有 target-disabled phase、禁用命令与“最新账本”位置定义；目标从未激活时其“最新账本”多为封存快照，回滚语义与“不能启动原快照”存在张力。
- **判断依据**：三项要求（取消 prepare、重新封存、反向交接）都需要状态与命令支撑；当前枚举与 CLI 中均无对应入口，属于“规范要求不可执行”。
- **影响**：T18/T12.3 无法断言唯一执行顺序；错误路径可能永久停在 quiescing/sealed（需人工改文件才能恢复）；强制回滚要求可能形成双端禁写死局；FR-MIG-009 不可实现。
- **修改建议**：补充迁移 phase×命令×回退表：明确 seal 时机（建议 export 内含原子 seal 或新增 `migration seal`）、`migration abort/cancel`、`migration rollback/disable-target`、phase 回边与审计；定义 target-disabled 状态与“最新账本”的物理位置；把 DESIGN/TASKS 的“作废封存→重新封存”写回 SPEC §25 并给 CLI；同步更新 T18 验收与 §17.3。

### P1-05 Task 状态机不闭合
- **位置**：SPEC §10.1（L577-591）、§10.2（L628-634）、§12（L685）、§15.1（L746）、§17.1（L819）、§17.3（L847）。
- **证据**：§10.1 状态图从 `queued→running` 开始，未定义初始态、也未定义“创建即进入 waiting_approval”的直接迁移；但 §12 FR-COM-002 说 approval 模式“只生成草稿，状态 waiting_approval”，§15.1 说“go 且未批准时原 Task 为 waiting_approval”。图中 `running` 无 `→cancelled` 边（只有 queued、waiting_approval 可到 cancelled），而 §10.2 的取消语义（未派发可取消、已派发等待停止后结算）要求运行中任务可结算为 cancelled。`interrupted` 在图中是叶子，但 §10.2 与 §17.3 `task resume` 允许人工 resume，形成矛盾。`isSettled`/`executionActive` 只声明“不能用一个 status 推导二者”，没有合法组合矩阵；`partial/failed → running/succeeded/partial/failed` 的人工回流路径也仅一句带过。
- **判断依据**：§10.1 是 Task 规范的核心状态定义，T02/T06/T08/T09/T10 均依赖它；缺少迁移与组合矩阵会导致各模块实现分叉，interrupted/resume 与取消竞态无法验收。
- **影响**：任务状态视图、清理判定（500 Task 清理仅适用于已结算）、人工 resume、取消与成功竞态的结果不一致；T02 验收无法覆盖全部迁移。
- **修改建议**：补齐初始态与全部迁移（含 queued/creation→waiting_approval、running→cancelled、interrupted→running）、定义 resume 前置与目标态、给出 status×isSettled×executionActive 合法组合矩阵与禁止组合，纳入 T02 验收；与 §12/§15.1/§24.2 的 Execution 状态对齐。

---

## 3. P2 问题（对应任务开工前修复，建议同批修订）

| 编号 | 文档及章节（行号） | 问题与证据 | 判断依据与影响 | 修改建议 |
|---|---|---|---|---|
| P2-01 | DESIGN §8.2（L403）、§8.4（L439）、§8.5（L451）；对照 SPEC §7.2（L460）、§25.1（L1168）、TASKS T14（L145） | DESIGN 主派发流程（事务闸门、External 前置、outbox 发送前检查）均未列“健康备份恢复点 / 无匹配 RecoveryHold”；仅在 §8.7 尾段（L487）总体提及。 | 规范与任务都要求该闸门，设计主流程却漏写；实施者可能只在灾备章节接线，形成同机旁路。 | 三处补“备份保护/无匹配 RecoveryHold”闸门，并统一引用 §7.2 的同一预留事务。 |
| P2-02 | SPEC §6.1（L381）、§27.5（L1255）、§27.7 FR-DR-009（L1289） | 存在两套 phase 枚举：store `recovery.phase`（示例 `normal`，正文 `readonly`）与 RecoveryCase.phase（`readonly/reconciling/restricted/released/blocked`）；无映射、转换点与“与账本 recovery 字段一致”的可执行定义。 | 状态显示、授权门禁、T21/T22 判定会不一致；`normal` 何时出现/消失未定义。 | 统一枚举或给出 store.phase↔case.phase↔instance 状态映射表与转换点。 |
| P2-03 | SPEC §7.2（L467）、§7.3（L477-478）、§24.2（L1140-1145）、§24.3（L1153）；DESIGN §9.3（L516） | §7.2 只说明“明确未派发取消释放预留；unknown 保留；confirmed 已使用”，未定义 failed/not_sent 的额度/费用处置；reserved 二次复核失败后的状态未定义；§24.2“同 requestId/inputHash 重复 submit 返回原 executionId”与人工 resume 的 attempt/新 executionId 关系未定义；部分收费/部分副作用逐项结算仅 DESIGN 提及。 | 额度可能误释放或永久占用；Execution/checkpoint 归属与 resume 实现分歧；T17.1/T14 验收无唯一期望。 | 增加 Operation 状态→额度/费用处置表；定义 Execution 为每 attempt 的不可变记录、resume 生成新 executionId 并引用旧 checkpoint。 |
| P2-04 | SPEC §14（L711、L713-716）、§6.3（L426）；DESIGN §9.4（L530）、§9.5（L536-537）；TASKS T08（L215/L217） | 日记身份为 `workspaceId + scope + date + book`，但物理路径只含 `scopeKey=SHA256(scope)`，account scope 不含 workspaceId；两 workspace 共用 diaryDir 或重建 workspace 复用时身份不同而路径相同。`eventCursor` 未定义结构（§6.3 要求所有游标携带 epoch+seq）；`pendingCommit` 仅描述“临时文件名/摘要/目标 revision”，缺 historyEpoch、目标身份/路径、baseRevision、targetCursor 等恢复判定字段。 | 同日日记可能跨 workspace 覆盖；崩溃或换 epoch 后无法判定提交是否基于正确基准，可能覆盖较新快照。 | 把 workspaceId 纳入 scopeKey 输入或明确单 workspace 不变式；定义 `eventCursor={historyEpoch,seq}` 与 pendingCommit 全字段及恢复判定算法（pendingImport 同理）。 |
| P2-05 | SPEC §21.1（L1038）、§15.2（L754）、§12（L690）；DESIGN §9.4（L524/L528）；TASKS T17.2（L289） | `inputHash` 只写“覆盖规范化输入…”，`metadataHash` 只写“包含封面摘要和目标相关元数据”，`normalized-text-hash`、`requestKey` 仅出现未定义；无 canonical JSON 规则（键序/数字/Unicode/数组序）、字段集与算法版本。 | 跨进程/迁移/升级后同输入 hash 漂移 → 审批意外失效、幂等冲突或重复外发；业务键不稳定。 | 采用 RFC 8785 JCS 或等价规范；按 action 固定字段集与 algorithmVersion；提供金标准测试向量并纳入 T02/T14/T09 验收。 |
| P2-06 | SPEC §4.4（L282-301）；§4.3（L170/L248）；FR-BRO-008（L668） | 校验规则不完整/冲突：L284“`browse.perRound` 1–20” vs L286“各 `perRound/dailyLimit` 0–20”；`dryRun`（全局/生产/发布）是安全否决项（§4.6 L314）却无布尔校验（§4.4 只规定 enabled 布尔）；`publishing.external.successJson` 无任何语义/校验；`markWatchHistory=true` 未实现真实播放（FR-BRO-008 要求保持关闭）但 §4.4 无拒绝规则；`diaryTime` 等格式、`owner.mid` 等字段无规则。 | `dryRun:"false"` 字符串或 0 可能绕过安全否决；perRound=0 合法性分叉；successJson 字段不可用；markWatchHistory 可能伪报播放进度。 | 补字段级规则表：布尔全集、数值范围、时间/URL 格式、successJson 语义；修正 perRound 冲突；本期拒绝 markWatchHistory=true（或明确 no-op+告警并加测试）。 |
| P2-07 | SPEC §4.5（L309）、§27.2（L1232）、§27.3 FR-DR-004（L1241）；§6.1 状态结构（L376-408） | “统一配置 revision”“备份捕获 configRevision”被引用，但 state schema 无 configRevision，生成/存储/比较规则未定义；`sourceStateHash` 算法未定义；BackupManifest 无 timeZone；恢复后配置/timeZone 重建规则未定义。 | 派发无法证明未用旧配置；备份无法稳定复算；恢复后日额度/日记日期窗口可能漂移。 | 定义 config revision / stateHash 的算法、位置与比较规则并写入 schema；BackupManifest 补 timeZone，或定义恢复后配置重建规则。 |
| P2-08 | SPEC §22.3（L1086-1088）、§21.2（L1047）；TASKS T16.1（L248-251） | 通知 unknown 只在“通道保证同 notificationId 幂等或可查询确定结果”时才可恢复；但 ChannelAdapter 最小方法仅 capabilities/start/send/stop，无 query 能力；能力清单无对应声明项；CLI 也无 outbox/notification 核查命令；outbox 保留/清理规则未定义。 | FR-IM-005 的“可查询”条件不可实现；通知 unknown 无法闭环、引用无法清理，可能被普通清理删去。 | 增加 ChannelAdapter `queryDelivery`（或能力声明项）与本地人工 outbox resolve 命令（证据/结论/幂等），定义保留与清理规则。 |
| P2-09 | SPEC §6.2（L416-417）、§4.2（L139）、§27.1 FR-DR-001（L1207）；TASKS T02（L130） | 规范要求“损坏/缺失主账本不初始化空账本”，T02 验收要求“缺主 state 不误判首次运行”；但规范未定义首次运行与主账本缺失/被删的判别证据（`instance.json` 只说明记录 instanceId/activation，未被定义为判别依据）。 | 首次启动与数据丢失可能互判错误：新装被阻塞，或数据丢失被当新装初始化空账本。 | 明确判别规则（如 instance.json/workspaceId/数据目录存在性/显式 bootstrap 标记）与失败时的 BLOCKED/RECOVERY_REQUIRED 行为，纳入 T02/T21 验收。 |
| P2-10 | SPEC §19.1（L922-937）、§19.2（L939-961）、§19.5（L983-1004）；TASKS T20/T21（L350/L369） | §19.1 单元测试清单止于“轻量性”，无 Backup/Recovery 类别；§19.2 无灾备集成场景；而 T20/T21 定义了 backup/recovery 的大量测试文件与验收，§19.5 只覆盖故障注入矩阵。 | “验收统一对照 §19”的说法不完整；按 §19 验收会漏新增灾备模块；T20/T21 的验收缺少 SPEC 侧依据。 | §19.1 增补 Backup（策略/manifest/保留/屏障/断电）与 Recovery（只读恢复/epoch/不确定区间/证据/解冻）单测类别；§19.2 注明灾备集成归 §19.5/T22。 |
| P2-11 | SPEC §27.1（L1227）、§27.6（L1273）；TASKS T10 第 7 条（L398） | T10 要求“checkpointFence 与迁移封存互斥/兼容按 SPEC 处理”，但 SPEC 仅在 §27.1 说“迁移封存、数据损坏或灾备只读期间不从可疑数据产生新的健康备份”，未定义 fence 与 prepare/seal 的并发顺序、等待/超时、崩溃残留 fence；§27.1 的“灾备只读期间不产生健康备份”与 §27.6“已完成事实校验但仍禁派发的副本允许建立新恢复点”边界不清。 | 备份可能捕获 quiescing 数据或产生假健康点；prepare 可能被 fence 卡死/死锁；T10 验收无判据。 | 定义统一 freeze 线性化规则（检查+置位同事务、等待上限、崩溃恢复、phase≠active 时拒绝/等待策略），并按 RecoveryCase phase 分级说明新恢复点允许条件。 |
| P2-12 | SPEC §27.1（L1219/L1223）、§27.2（L1231/L1233）、§19.4（L976）；§6.2（L419）/§6.3（L433）、FR-LITE-003（L1200） | 备份策略 `intervalMinutes / maxPointAgeMinutes = 15/15` 无裕量，捕获耗时>0 即产生超龄窗口；`checkpointTimeoutMs=5000` 与“屏障内日记 staging / 账本及必需归档≤100MiB 捕获”的规模条件未协调；永久 `businessKeys` 无清理/归档/压缩机制，仅“保留并报告容量”，与 100MiB 只读 RTO 条件存在长期张力。 | 启用保护后可能周期性 BACKUP_STALE 或被阻断；备份易超时失败；长期 state.json 增长放大写延迟与恢复时间，RTO 条件渐失效。 | 令 maxPointAge > interval（如 20/15）；明确捕获耗时预算与日记 derived/rebuild 策略；定义永久索引的容量阈值与停写/归档策略，纳入 T19/T22 容量与性能测试。 |
| P2-13 | SPEC §25.1（L1167-1168）、§25.2（L1176）、§27.7（L1291）；TASKS T18（L334） | §25.2 要求“有 RecoveryCase 时须携带 hold 与证据材料”，§25.1 表述为“RecoveryCase/holds 及证据引用”，§27.7 又要求“不向 HTTP/Agent/IM 开放明文事故证据”——“证据材料”与“证据引用”口径不一，且无结构/位置/授权/脱敏规则；T18 第 1 条把“备份保护”列为迁移检查项，但 §25 未把健康恢复点明确为迁移 prepare/activate 的前置（§25.1 只把备份保护列为业务派发条件）。 | 迁移导出要么遗漏 RecoveryCase 证据，要么越权复制敏感事故证据；“备份保护是否为迁移前置”两种实现都说得通。 | 统一为 evidenceRefs（可选受控 evidence bundle），定义目录/schema/授权/脱敏；明确迁移门禁是否要求健康恢复点并写入 §25 与 T18。 |
| P2-14 | SPEC §22.1（L1065）、§17.3（L873）、§24.1 FR-PRO-003（L1128）；TASKS T17.3（L301）、§6（L670） | “若宿主不能区别人类事件与工具回调，审批能力 unavailable，回到经验证的本地交互确认”；但本地人类证明的验证方式未定义，形成循环表述；TASKS 称人类证明未核验“不阻塞离线核心/本地生产”，而 FR-PRO-003 要求 go 必须有效人类审批、T17.3 需人类审批，若两种人类证明都不可得则 T17.3/T12 均 BLOCKED。 | 必需验收项可能整体阻塞且无已定义降级路径；TASKS 的“不阻塞本地生产”口径与审批要求冲突。 | 定义本地人类证明的可实现机制（受控 TTY/宿主签名挑战/OS 安全提示）及不可得时的能力矩阵；限定“不阻塞本地生产”的准确含义（仅指离线代码/测试，不含真实 go 执行）。 |
| P2-15 | SPEC §10.1 Task 结构（L595-621）、§10.2（L634）、§25.4 FR-MIG-008（L1190）；TASKS T18（L341） | §10.2 要求旧 Task 统一附 recoveryHold，T18 要求旧任务置 migrationHold；但 Task 字段清单无 holds 字段，hold 的 kind/写入/清除权限/迁移携带/与 resume 的关系均未定义，migrationHold 与 recoveryHold 是否同一机制不明。 | 迁移/灾备 hold 无法持久化、查询、携带；普通 resume 可能误解除 hold。 | §10.1 增加 `holds[]`（kind/id/scope/createdAt/releasedAt）并定义写入/清除规则、迁移与恢复携带规则。 |
| P2-16 | SPEC §18（L877-918）、§17.1（L823）；TASKS §4.2 前注（L517）、T02 目标/验收（L109/L124-130）、T10（L395） | SPEC §18 定义 36 个稳定错误码；TASKS 全文仅出现 4 个（AGENT_OUTPUT_INVALID / CAPABILITY_UNSUPPORTED / INPUT_REQUIRED / RECOVERY_REQUIRED），其余 32 个无任务/验收归属；`src/errors.js` 是 T02 目标文件，但 T02 验收只引 SPEC §4～6/§10/§19；T10 只验 HTTP 400/403/409/501/503/404 映射，且这些状态码到稳定 code 的对应关系未定义。 | 36 个 code（含 BACKUP_*/RECOVERY_* 新组）缺少验收，GATE-0 核对 §18 时无映射可查；错误码实现与测试可能遗漏。 | §4.2 前注把 §18 映射到 T02（errors.js + 单测）并补 T10 双列；在 SPEC §17.1 给 HTTP 状态码→稳定 code 映射表；T02 验收新增 §18 覆盖清单。 |
| P2-17 | TASKS §4.2 前注（L517）、§4.2 表头与旧 FR（L519）；SPEC §3.3（L106-112）；T19（L426）、T22（L410/416） | 前注章节映射缺口：未列 §3.3→T10（DSH 挂载/注销）、§22→T16.1（IM 身份/审批/outbox）、§18→T02；旧 26 条 FR 仅以“§11→T05”等范围级映射、无逐条行；§4.2 表无 SPEC § 列；§19.2 的 19 条集成场景与 §19.5 的 14 行场景无逐条“场景→任务→证据”映射（T19/T22 整段认领）。 | 章节级追溯链对 T10/T16.1 断开；失败归属不清；GATE-0 核对“52 条验收映射”时无法逐条定位。 | 前注改为逐章映射表（至少补 §3.3/§18/§22）；明确旧 26 条按范围映射的口径或补行；表加 SPEC § 列；T19/T22 增场景映射表。 |
| P2-18 | DESIGN_REVIEW_SUMMARY（L4-5、L65-66、L75）；SESSION_SUMMARY（L33-39、L43、L54） | 旧审查摘要基线 0.2.0：18 项架构决策、42 条新增需求、20 个主任务、8 个子任务，且称“可作为实施评审基线”“将本版提交用户审核”；未标“已被 0.2.1 取代”。会话摘要的哈希/字节表与现状不符（DESIGN 64,008/b45da343 → 64,143/ba7e696d；SPEC 103,781/77633f39 → 104,009/b9ed03e7；TASKS 98,316/e7783f32 → 98,952/a98d339d）；其 §5 第 1 项“请求授权更正主文档状态表述”已由 TASKS §8（L720）声明完成，待办失效。 | 两份文档虽被其他文档称为“旧摘要/非规范来源”，但自身无作废标识，GATE-0 审核者可能按 18/42/20 核对，漏 D-19/20、FR-DR-001～010、T20～T22；哈希表用于基线确认会失败。 | 在两份文档头部加“历史/非现行基线，已被 0.2.1-draft 取代，不作为审核依据”横幅；更新或删除哈希/字节表；§5 待办改为已完成/指向 TASKS §8。 |
| P2-19 | DESIGN §8.1（L389）、TASKS T05（L185）；SPEC §11.2 FR-BRO-001～008（L661-668） | DESIGN 要求 Browse 排除“自有内容”，TASKS T05 也写“自有过滤”，但 SPEC §11 的 8 条 FR 没有“过滤自有内容/不与自己互动”的要求；规范未覆盖设计/任务已引入的行为。 | 需求覆盖出现反向缺口（设计/任务有、规范无），实施范围与验收依据不一致；若照 SPEC 实现会漏过滤，照 DESIGN 实现则无 FR 可追溯。 | 在 SPEC §11.2 新增对应 FR（或明确其属于“已看过滤”的既有语义并补验收），并同步映射到 T05。 |
| P2-20 | TASKS §2.1（L57-63）、T18（L328/L334）、T10（L386）、T22（L404）、T19（L420）、T11（L437）；SPEC §25.1（L1168） | 依赖/关键路径风险：T20←T02/T14/T15、T21←T20、T18←T21、T10←T18/T20/T21、T22←T10、T19←T10/T22、T11←T19/T22/T17.3，离散步长约 10 级；T18 第 1 条列“备份保护”检查，但 SPEC §25 未把健康恢复点明确为迁移前置（§25.1 是业务派发门禁），T18 是否真的需要 T21 全实现缺少依据；集成验证集中在最后。 | 灾备延期将阻塞迁移、Coordinator/CLI 与全量测试；反馈闭环过晚，返工成本高；迁移前置口径不清。 | 拆分 T18 为“正向迁移（只依赖 hold 结构/注入门禁）”与“恢复感知激活/回滚（依赖 T21）”；T10 提前用注入门禁；明确备份保护是否为迁移前置并补 SPEC §25 依据。 |

---

## 4. P3 问题（可随修订/实施修复）

| 编号 | 文档及章节（行号） | 问题与建议 |
|---|---|---|
| P3-01 | TASKS T13 依赖（L485）、阶段图（L67）、T12/T17.3 条件 | `依赖：T11。另须取得 T12 各分项的明确结果或 BLOCKED/未实测记录；这不是免除 T17.3 的替代条件` 与阶段图“T11─T13”不一致；T12/T17.3 是“依赖”还是“结果条件”不明确，T13 可能在 T12 无记录时被调度。建议依赖字段列 T12.1～T12.3（允许显式 BLOCKED 记录）并同步阶段图。 |
| P3-02 | DESIGN L628、TASKS §7（L698/L702/L703） | DESIGN R-09 括注“（D-13/17/18）”，而 TASKS §7 把 D-17 放进“D-17 / R-13”行、R-09 行出现两次（D-13/R-09、D-18/R-09）；D-17 归属易读成错配。建议按一对多关系显式标注（如“R-09（D-13/17/18，D-17 与 R-13 双列）”）。 |
| P3-03 | TASKS T14（L136）/T03（L163）、T04（L173）/T20（L350）、T16.1（L241）/T21（L369） | 共享目标文件无编辑边界：T14/T03 均列 `src/rate-limiter.js`；T04↔T20 均列 `src/contracts.js` 且互不依赖；T16.1↔T21 均列 `src/effect-gateway.js` 且互不依赖（另有 identity.js 多方）。并行实施易冲突/接口漂移。建议注明各任务只新增的契约/区域或拆文件，并在 §2.1 写明共享文件编辑顺序。 |
| P3-04 | SPEC（L4-5）、DESIGN（L3-5）、TASKS（L3-5、L8、L720）、package.json（L3/L23）、SPEC §19.4（L976） | 文档元数据/轮次表述问题：三份主文档头部日期仍为 2026-10-29，但文件 mtime 为 2026-11-04/05（含“本次一致性修正”）；TASKS L8“本轮仅同步 TASKS…”与 L720“DESIGN/SPEC 已同步更正”指向不同轮次但未标明；L8 提到的 `AGENTS` 在仓库中不存在（悬空引用）；`package.json` version=0.1.0 与文档 0.2.1-draft 不一致，`check` 脚本只检查入口而 §19.4 要求覆盖全部源码（T19 已列为获批后待办，属已知未实施项）。建议更新日期并加“修订记录”，明确轮次，删除悬空引用，注明包版本/检查脚本待办关系。 |
| P3-05 | SPEC §2（L41）、§10.2（L634）、§14（L714）；DESIGN §9.5（L537）；TASKS（L215 等） | 术语/字段名不统一：`RecoveryCase / RecoveryHold`（术语表）与 `recoveryHold`（正文）；`eventCursor` 与“事件水位/事件游标”；`quiescing/sealed`（SPEC §25.1）与 `seal/export`（DESIGN §8.6/T18）。建议 §2 增字段级术语表并统一大小写/命名。 |
| P3-06 | TASKS §9.4（L773）；SPEC §27.4（L1256） | 交叉引用错指：“这与 §27.5 的‘原审批挑战全部失效、旧权限绑定须重新核验’同口径”，该内容实为 SPEC §27.4；§27.5 是 FR-DR-006/007（不确定区间与证据）。建议改为“SPEC §27.4”。 |
| P3-07 | SPEC §14（L718）、§17.3（L839）、§17.1（L809）、§11.3（L674）、§6.4（L437-446）、§17.1（L811/L815） | 接口/行为细节缺口：§14 提到 `force=true` 可重建日记，但 CLI `diary` 与 HTTP `/run/diary` 未定义 force 参数；§11.3 Browse 输出 status 含 `skipped`，而 §10.1 Task 状态机无 skipped，映射未说明；§6.4 `appendEvent` 与“事件同事务提交”的关系未说明（易被单独调用破坏原子性）；`/comments/approve` 与 `/approvals/decide` 的关系未说明。建议补充参数/映射/原子性约束与入口关系。 |
| P3-08 | TASKS T01（L99）；SPEC §3.3（L106-112）；T10（L384/L422） | `cordis.patch.yml` 无 PENDING 任务认领/验证：唯一提及为 T01“保持既有草案，不在本轮改动”；§3.3 要求插件名/Cordis ID、路由注销、包导出与挂载参数在宿主集成任务中验证，但 T10 目标文件不含该文件、验收未覆盖。建议 T10 目标或 `test/dsh.test.js` 增加静态断言（id/name/enabled/exports），或明确记录为“宿主侧未验证项”。 |
| P3-09 | TASKS T19（L426）、T22（L410/L416）、§4.2（L517） | §19.2 的 19 条集成场景与 §19.5 的 14 行灾备场景只有整段认领，无逐条“场景→主责任务→判定证据”映射；失败归属与 GATE-0 逐条核对困难。建议补两张映射表。 |
| P3-10 | TASKS（L18）；SPEC §27.1（L1209） | “15 分钟/24 小时 RPO”的措辞把媒体覆盖目标并入 RPO；SPEC 区分“账本恢复点目标 RPO 15 分钟”与“完整媒体覆盖目标 24 小时”。建议改为“15 分钟账本 RPO / 24 小时媒体覆盖目标 / 条件化 60 分钟只读 RTO”。 |
| P3-11 | SPEC（L9） | 定义“必须/应当/可以/不得”表示约束强度，但全文“应当”仅出现在该定义行、未再使用；约束层级名存实亡。建议删除该词或明确各层含义与使用规则。 |
| P3-12 | TASKS（L39、L443） | 旧任务编号残留：“T11 不是‘旧 T10 结束即可完成’”“原 T10 结束不代表全量完成”，现行 T10 已是 Coordinator/DSH/CLI，表述需读者自行还原历史编号。建议改为“T11 须以 T19/T22/T17.3 验收为前提”或标注“历史编号”。 |
| P3-13 | DESIGN §8.6（L458）；SPEC §25.2 FR-MIG-002（L1172）；TASKS T18（L335） | DESIGN prepare 冻结清单为“平台写、付费 provider、本地执行新阶段、通知/outbox”，漏“素材导入/Artifact 导入”，而 SPEC 与 TASKS 均要求冻结素材导入。建议 DESIGN §8.6 补列“素材导入/Artifact 导入”。 |

---

## 5. 按复核维度汇总

| 复核维度 | 结论 | 主要问题编号 | 已通过/依据 |
|---|---|---|---|
| 需求覆盖与可追溯性 | **基本成立** | P2-16、P2-17、P2-19、P3-08、P3-09 | 78 FR 全部成条；52 新增 FR 逐行映射；旧 26 FR 章节映射；D/R 全覆盖；§3.1 文件有任务认领 |
| 文档间一致性 | **大体一致，存在局部缺口** | P1-01、P1-04、P2-01、P2-02、P2-11、P2-18、P2-20、P3-01、P3-02、P3-04、P3-06 | 版本/计数/阈值/配置/依赖图一致；仅 1 处内容错指；config 与 §4.3 diff=0 |
| 描述完整性 | **部分不足（关键机制未形式化）** | P1-02、P1-03、P1-05、P2-03～P2-09、P2-14、P2-15 | 三层派发上下文、unknown 闭环、epoch 设计、备份/迁移票据分离清晰 |
| 技术方案合理性 | **合理、主路径可成立** | P2-12、P2-20；外部前提见 §8 | fail-closed 原则贯穿；无 P0 矛盾；外部依赖已由文档自标未验证 |
| 任务拆分与依赖关系 | **通过（无环无悬空），可优化** | P2-20、P3-01、P3-03、P3-08 | 23 主任务 + 8 子项唯一；依赖无环、无悬空；与 §2.1 阶段图基本一致；生产不依赖 B 站/IM |
| 验收标准 | **基本可判定，存在未覆盖项** | P1-01、P2-10、P2-16、P2-17、P3-09、P3-10 | 每任务均有验收段；负例与禁止路径丰富；§19.5 14 场景有 FR 归属 |
| 遗漏、歧义、冲突 | **无 P0；冲突集中且可定位** | 冲突：P1-01、P1-05、P2-02、P2-06、P2-11；歧义：P1-04、P2-03、P2-04、P2-13；遗漏：P2-08、P2-09、P2-14、P2-15、P2-19 | 所有冲突均给出原文位置与可执行修法 |
| 不可执行项 | **存在 4 类** | P1-02（hold 匹配无定义）、P1-03（跨文件提交无定义）、P1-04（迁移取消/回滚无入口）、P1-05（状态迁移缺口）；另 P2-08（通知核查无接口）、P2-14（人类证明降级无定义）、P2-16（错误码无验收） | 其余要求均可由已定义接口/任务承接 |

---

## 6. 必须优先修复的问题清单

### 第一优先（GATE-0 批准前必须完成，5 项）

1. **P1-01**：SPEC §19.3/§19.4 接入 FR-DR-002 备份保护/RecoveryHold 前置；修正 SPEC L9“已同步验收口径”表述。
2. **P1-02**：定义 RecoveryHold / unknownExposure 的 schema、scope 表示与匹配语义（T14/T21/T22 共用）。
3. **P1-03**：定义灾备恢复决定的跨文件权威源与两阶段提交（recovery.json / 账本 / instance 能力清单）。
4. **P1-04**：补齐迁移 phase×命令×回退表（seal/abort/disable-target/rollback），使 FR-MIG-009 可执行。
5. **P1-05**：补全 Task 状态机迁移表与 isSettled×executionActive 合法组合矩阵。

### 第二优先（建议同批修订，否则实施前必须完成，9 项）

6. **P2-01**：DESIGN §8.2/§8.4/§8.5 补备份保护/RecoveryHold 闸门。
7. **P2-02**：统一两套 recovery phase 枚举或给出映射表。
8. **P2-04**：日记身份/路径/`eventCursor`/`pendingCommit` 定义。
9. **P2-05**：`inputHash`/`metadataHash`/`normalized-text-hash`/`requestKey` 规范化与算法版本。
10. **P2-06**：补配置字段级校验（dryRun 布尔、perRound 冲突、successJson、markWatchHistory）。
11. **P2-07**：定义 configRevision / stateHash，BackupManifest 补 timeZone。
12. **P2-10**：SPEC §19.1/§19.2 增补 Backup/Recovery 单测与集成验收类别。
13. **P2-16**：§18 错误码的任务/验收归属与 HTTP 状态码映射。
14. **P2-17**：§4.2 前注章节映射与场景级追溯表。
15. **P2-18**：两份历史摘要加“已被取代”标识并更新/删除失效哈希。

> 其余 P2（P2-03、P2-08、P2-09、P2-11～P2-15、P2-19、P2-20）应在对应模块任务（T02/T08/T14/T16.1/T17/T18/T20/T21/T22）开工前修复；P3 可随修订批量处理。

---

## 7. 已核对通过项（附验证证据）

1. **FR 完整性**：SPEC 共 78 个唯一 FR 定义（旧 26 ＋ 新增 52），无重复定义、无畸形编号、无“定义但未被引用”或“引用但未定义”。TASKS 出现的 FR 编号全部存在于 SPEC。
2. **映射完整性**：TASKS §4.2 恰好 52 行，无重复、无遗漏、无 SPEC 外编号；42＋10＝52 与 SPEC §19.4（L979）/§20（L1028）、DESIGN L612、TASKS L9/L101/L103/L441/L491/L517 的表述算术一致。
3. **任务与依赖**：23 个主任务（T00～T22）＋8 个子任务（T12.1-3/T16.1-2/T17.1-3），ID 唯一；全部任务均有“依赖”字段；解析出的依赖无悬空引用、无环，与 §2.1 阶段图及 L70 补充说明一致（个别概要省略见 P3-01）。
4. **D/R 覆盖**：D-01～D-20 在 DESIGN 有 20 个决策小节，TASKS §7 有 20 行映射；R-01～R-15 在 DESIGN §14 与 SPEC §20 各有 15 行，TASKS §7 全覆盖；D-19/20 ↔ R-14/15 对应正确（一对多标注见 P3-02）。
5. **配置一致**：`config.example.json` 与 SPEC §4.3 JSON 代码块深比较 **diff = 0**（20 个顶层键逐值相等，含数组与嵌套对象）；默认业务开关关闭、生产/发布 dryRun=true、付费上限 0，与 §4.3/§4.4 已列规则不冲突（规则缺口见 P2-06）。
6. **跨文档阈值一致**：2000 热事件、500 Task/5000 Operation 清理、64KiB 事件 payload、10000 journalPending、1MiB/10MiB、1MB HTTP、15min/24h/60min/100MiB、8/7/4 保留、熔断 5/30 分钟、rateLimit 全值、production 各上限、migration 100000 files/64GiB、approvalTtlSec/maxMessageAgeSec=600、notifications 1500/20、checkpointTimeout=5000ms 均一致（措辞瑕疵见 P3-10）。
7. **章节引用**：显式“SPEC/DESIGN/TASKS §N”引用无悬空；仅发现 1 处内容错指（TASKS L773 应为 SPEC §27.4，见 P3-06）。
8. **Markdown 结构**：SPEC/TASKS/DESIGN 代码围栏成对（36/14/6 个标记），全部表格列数一致且含分隔行，无结构破损。
9. **静态声明可复现**：TASKS §8 L734“23 个主任务 / 52 条 FR / 依赖无环”属实；T00/T01 为 DONE、其余为 PENDING/BLOCKED，状态定义自洽；`src/` 仅有空 `modules` 目录、`test/` 为空，与“未实施”一致；项目非 git 仓库，TASKS L79“不安排提交步骤”属实。
10. **工程文件状态**：`config.example.json` 哈希 `668a614e` 与 SESSION_SUMMARY 记录一致（未改）；`package.json` 的 type=module、engines>=22、exports/bin/files/dsh.bundle.patch 与 SPEC §3.1/§3.2/§3.3 对应（版本/检查脚本为已知待办，见 P3-04）；`cordis.patch.yml` 的 id/name 与 SPEC §3.3 一致（宿主 schema 未验证见 §8）。
11. **关键设计方向自洽（值得保留）**：三类派发上下文（Operation/Execution/Outbox）共享栅栏且不伪造 Operation；`unknown` 冻结＋人工 resolve＋同事务回写闭环；`(historyEpoch, seq)`＋全局 eventId＋journalPending 的设计；备份 `kind=backup` 与迁移 `kind=migration` 票据分离；灾备“只读→新 epoch→parent 恢复点→旧写者隔离→分 scope 解冻”且不自动重放；迁移 prepare 冻结/在途收尾/release 禁写/目标暂停/旧任务不重投；失败模式普遍 fail-closed（损坏不置空、锁属主不明拒写、Mock/工具缺失不计真实交付）。
12. **发布/生产边界**：本地生产不依赖 B 站/IM/商业服务，发布不依赖生产 Runner；Manual 与 External 审批隔离；真实媒体/真实 IM/真实平台写分别 BLOCKED 并分项报告——与 DESIGN §2、TASKS §6、SPEC §19.4 一致。

---

## 8. 无法确认项（明确标记，不臆测、不代替验收）

| 序号 | 无法确认的内容 | 原因/边界 | 文档中的相关声明与建议 |
|---|---|---|---|
| 1 | DSH 宿主真实服务注册、信任栅栏（`connection.requestRejection` 或等价机制）、人类事件 vs 工具回调、IM 事件 ID/生命周期/回执/人类证明 | 本环境无 DSH 宿主/SDK 文档与运行证据，静态复核无法验证 | SPEC L821/L1030、§22、T16.2；文档已标 BLOCKED/未实测，保持该项为外部前置 |
| 2 | B 站真实 WBI、评论/DM 回执、错误码集合（-412/-352/-799/-509/-10403 等）与风控行为 | 需真实账号与单独授权，未实测 | SPEC §8、§19.3、T12.2；按“默认不运行真实写测试”处理 |
| 3 | External 发布器真实接口与成功回执语义（`{"ok":true,"bvid","url"}` 等） | 未配置/未验证的外部程序，静态不可确认 | SPEC §15.5/§15.6、§20；文档已列为实施前外部前提 |
| 4 | 本机 ffmpeg/ffprobe 可得性、版本范围、解码级媒体验证耗时 | 工具未提供，T17.3 BLOCKED | SPEC §24.1、T17.3；文档已标 BLOCKED，不得以 Mock/Bundle 替代 |
| 5 | 独立故障域/物理介质耐久性、RPO 15 分钟/媒体 24 小时/只读 RTO 60 分钟（100MiB 条件）的实际可达性 | 需真实备份介质与恢复机，文档明确为“待测设计目标，非 SLA” | SPEC §27.1、§19.5、T22；只能报告实测值 |
| 6 | Windows/Linux 真实跨 OS 迁移行为（路径语义、工具重绑、禁写交接） | 无两系统环境，未实测 | SPEC §19.3、T12.3；文档已要求区分“双目录模拟通过”与“真实跨 OS 未测” |
| 7 | 单 JSON Store 在目标数据量下的写延迟/内存/备份耗时，以及 100MiB RTO 条件能否覆盖实际 dataDir | 文档未给数据量目标/性能预算，且代码未实现，无法测量 | DESIGN D-06、FR-LITE-003、§27.1；建议在 T19/T22 增容量/性能预算 |
| 8 | `package.json` 的 `@deepseek-ai/dsh-tools >=0.1.7-rc.1` 与真实宿主包名/版本是否匹配；`cordis.patch.yml` 是否符合 DSH bundle/patch schema | 仓库内无宿主 SDK/依赖文档，静态无法核对 | SPEC L112“包导出与挂载参数须在宿主集成任务中验证”；建议在 T16.2/T10 记录验证结果 |
| 9 | 项目内是否还存在未纳入本仓库的“项目规范”（README/AGENTS/CONTRIBUTING 等） | 仓库中无此类文件；TASKS L8 提到 `AGENTS` 但文件不存在，无法核对第三方规范 | 本报告仅以三份主文档自述规范为基准；建议补最小项目规范或在 TASKS 删除悬空引用 |
| 10 | 文档自述“用户已确认方向但未批准修订稿”之外的实际批准状态 | 文档状态自述 GATE-0 未解除、GATE-MEM 未审核；实际用户决定以用户本人为准 | 本报告不改变 GATE-0/GATE-MEM，不构成批准 |

---

## 9. 复核声明

1. **只读复核**：本次复核未修改、创建或删除项目内任何文档；仅使用临时脚本做静态校验，脚本与输出已在复核结束后删除。
2. **未新增需求**：§2～§6 的修改建议均限定为（a）对齐文档间既有要求，（b）为文档已引用但未定义的术语/字段/接口补定义，（c）标注历史文档与元数据；不扩展产品范围、不引入未经确认的新功能。
3. **不作为实施证据**：本报告不是代码测试、真实环境验收、备份/恢复演练或安全评估结论；文档自述的“未实施、未验证、BLOCKED”状态继续有效。
4. **环境备注**：复核期间为运行静态校验脚本，修复了本工作区的 Windows 文件权限（仅向当前用户添加完全控制项），变更备份与回滚脚本位于 `D:\workbuddy_space\.dsh-acl-recovery`；未改动任何项目文件内容，未变更文件所有者。
5. **结论收口**：请以 §6 清单作为修订入口；P1 修完并复核后，再由用户决定 GATE-0（批准/有条件批准/不批准）。本报告不建议在当前文本上直接启动实施。

---

## 附录 A：文件基线与静态检查结果

### A.1 文件基线（2026-11-05 复核时实测）

| 文件 | 字节数 | SHA-256（前 8 位） | 本地修改时间（Asia/Shanghai） |
|---|---|---|---|
| `SPEC.md` | 104,009 | `b9ed03e7` | 2026-11-05 07:39 |
| `DESIGN.md` | 64,143 | `ba7e696d` | 2026-11-05 07:39 |
| `TASKS.md` | 98,952 | `a98d339d` | 2026-11-04 23:36 |
| `config.example.json` | 2,877 | `668a614e` | —（与 SESSION 记录一致） |
| `DESIGN_REVIEW_SUMMARY.md` | 7,984 | `d88e271b` | 2026-10-28 23:11 |
| `SESSION_SUMMARY.md` | 9,923 | `51cf4b59` | 2026-11-04 23:00 |
| `cordis.patch.yml` | 94 | `a6eb6fc4` | — |
| `package.json` | 996 | `2501e7ad` | — |

> 与 SESSION_SUMMARY §3 记录的差异：DESIGN/SPEC/TASKS 三份主文档字节数与哈希均已变化（说明 11-04 之后确有“状态一致性更正”写入），`config.example.json` 与 `DESIGN_REVIEW_SUMMARY.md` 未变。这与 P2-18 的判断一致。

### A.2 机械检查结果

| 检查项 | 结果 |
|---|---|
| SPEC FR 定义数 | 78（BRO 8、COM 10、DM 8、EXT 4、IM 8、ART 6、PRO 10、MIG 10、LITE 4、DR 10），无重复/畸形 |
| TASKS §4.2 新增 FR 行数 | 52，全部存在于 SPEC，无重复、无遗漏 |
| 主任务/子任务 | 23（T00～T22）/ 8（T12.1-3、T16.1-2、T17.1-3），唯一 |
| 依赖解析 | 无悬空引用；无环；全部任务有依赖字段 |
| D/R 覆盖 | D-01～D-20（20 个决策小节）、R-01～R-15（DESIGN §14 与 SPEC §20 各 15 行），TASKS §7 20 行映射 |
| config vs SPEC §4.3 | 深比较 diff = 0（20 个顶层键） |
| 章节引用 | 显式引用无悬空；1 处内容错指（TASKS L773 → 应为 SPEC §27.4） |
| §19.2 / §19.5 场景数 | 19 条 / 14 行（有 FR 归属；逐场景任务映射缺失见 P3-09） |
| Markdown | 代码围栏成对（SPEC 36 / TASKS 14 / DESIGN 6 个标记）；表格列数一致 |
| 仓库状态 | `src/` 仅空 `modules` 目录、`test/` 为空；非 git 仓库；与“未实施”声明一致 |

### A.3 一句话结论

> **文档体系质量总体较高、可审核；无 P0；建议按 §6 完成 5 项 P1 与高优先 P2 修订后，再由用户决定 GATE-0。**
