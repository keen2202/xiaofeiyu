# dsh-bili-unified 实施任务与验收计划

- 版本：**0.2.1-draft**
- 状态：**方向已确认；修订稿待审核；GATE-0 未解除；核心未实施**
- 日期：2026-11-07
- 修订记录：2026-11-05 按 `report/REVIEW_REPORT.md` 同步任务依赖、验收映射和共享文件编辑边界；2026-11-06 按二次复核修正引用、RPO措辞和旧编号；2026-11-07 建立 git 版本控制并推送 GitHub 远程，更新版本控制与提交步骤表述。均不改变 GATE-0/GATE-MEM，不代表代码实施或真实环境验证。
- 项目根目录：`D:/workbuddy_space/dsh-bili-unified`
- 版本控制：git 仓库（默认分支 `main`），远程 `origin` 为 `git@github.com:keen2202/xiaofeiyu.git`；基线提交 `ce38d5a`。
- 基线：`DESIGN.md`、`SPEC.md` 的 0.2.1-draft；普通业务配置参考既有 `config.example.json`，规范验收统一对照 SPEC §19。
- 历史轮次：此前已将账本 v3、可信备份及灾备建议拆为任务与验收；2026-11-05 本轮依据复核报告同步修订 DESIGN/SPEC/TASKS 和两份历史摘要，不修改 config、package、代码或权限，当时尚未建立 git 仓库、未做提交（2026-11-07 已建立仓库并提交基线）。下列源码、测试、策略与产物路径均为获批后的实施目标，不表示已实现或接线；config.example.json 没有独立 BackupPolicy，`<dataDir>/backup-policy.json` 仍是未来实现对象。
- 当前规范范围：一个轻核心＋可选平台/IM/执行适配器＋ArtifactStore；独立真实视频生产；同插件兼容 schema 停机迁移；分层可信备份、只读灾备及证据驱动的分 scope 解冻。保留上一版42条新增需求，本次加10条，共52条逐项映射；不是微服务、旧插件导入、远程 worker 或自动接管。
- 用户另已选择“事实＋偏好＋经验”的记忆范围；§9为本轮新增的待审核规划，不等于完整对话留存授权、记忆实现完成或已修改DESIGN/SPEC。记忆机制经GATE-MEM审核并回写主规范后才进入实现，不擅自升级账本v3或扩大原52条FR基线。

## 1. 审核门与完成口径

### GATE-0：批准修订基线后才能实施

- [ ] 审核 DESIGN D-01～D-20、R-01～R-15，以及 SPEC §20 的对应决策。
- [ ] 核对 SPEC 保留的 §1～20 与 §21 公共/平台、§22 身份审批 IM、§23 Artifact、§24 Production/Execution、§25 Migration、§26 轻量加载、完整 §27 可信备份恢复及 §19.5 故障验收。
- [ ] 核对配置默认值、三级 dryRun、账本v3/historyEpoch、人工审批、费用/额度分桶、停机交接、独立BackupPolicy/故障域、RecoveryHold与52条验收映射；15分钟账本间隔、20分钟最大恢复点年龄、24小时媒体覆盖目标及条件化60分钟只读RTO均为待测设计目标。
- [ ] 复核第 8 节已统一的跨文档口径；没有批准前不得自行更改权限、回滚或账本语义。
- [ ] 用户明确批准 **0.2.1-draft 修订稿**（有条件批准须明确可执行范围），才可启动相应 PENDING 项。

**当前：未批准实施。** 不再询问是否选择停机迁移/远程执行、是否引入独立生产等已确认方向。修订方向确认不是 GATE-0 解除，也不是对真实平台写入、IM 发消息、运行媒体工具的授权。

### GATE-MEM：记忆规划单独审核

- [ ] 审核 §9 的事实/偏好/经验分层、来源与证据要求、版本化与纠错、遗忘及跨备份恢复的撤回一致性、检索与私有边界、验收场景和待定事项。
- [ ] 批准后先回写 DESIGN/SPEC、新增 FR 编号与任务映射，才允许建立实施任务 ID；未批准前不实施、不升级账本 schema、不保存对话原文、不占用 D/R 编号。

**当前：未审核。** GATE-0 批准不自动授予记忆范围；无论是否批准，记忆都不产生授权、不替代人工审批挑战，也不绕过 dryRun、额度、迁移栅栏或恢复门禁。

### 状态与分项交付

- `DONE`：该工作项的明确产出与验收均完成；文档/研究项只表示文档/研究完成，不能推导代码完成。
- `PENDING`：未开始；全部实施项继承 GATE-0 和列出的前置依赖。
- `BLOCKED`：已知缺少审核、宿主/工具、身份保证或授权条件；须记录原因、受影响能力和解除条件，不静默替换为 Mock。
- `IN_PROGRESS`：仅在获批后开始工作且验收未完成时使用；本修订稿没有代码项处于此状态。
- `DEFERRED`：只可由用户批准移出本期；本期必需能力不能因环境缺失自行移走。

代码验收、真实本地媒体、IM 契约、真实 IM、平台真实写入、双目录迁移、隔离灾备演练、物理故障域/介质耐久性、真实跨 OS 分开报告。T11 必须在 T10、T22 等全部明示依赖完成后才可验收；T13 不能用文档交付或 Mock 通过宣称全功能交付。真实 IM 条件未满足只阻塞该接入，不阻塞核心、本地生产或离线迁移/灾备测试。

## 2. 实施顺序与统一工作方式

### 2.1 无环阶段图

保留 T00～T19 及所有子项 ID，新增 T20～T22；**编号不代表执行顺序**。聚合项完成取决于子项，后续任务可只依赖明确的离线子项。下图为阶段摘要，各项的“依赖”字段为完整依赖清单；其中“正向/基础/完整”的条件式依赖以文中语义为准，只有完整验收条件全部满足才可标记对应任务 DONE。

```text
GATE-0
  └─ T02 核心状态/配置/epoch归档
       └─ T14 公共契约/身份/审批/CommandService/EffectGateway
            ├─ T03 B站协议 ─ T05 Browse ─ T06 Comments / T07 DM
            ├─ T04 可选 Agent ─ T08 Diary（另需 T02/T14）
            ├─ T15 Artifact ─ T17.1 Local Execution ─ T17.2 Production
            │                                      └─ T17.3 真实本地媒体验收
            └─ T16.1 IM契约/outbox ─ T16.2 宿主只读探测与真实绑定

T02 + T14 + T15 ─ T20 备份/保护健康 ─ T21 独立只读灾备/核查/解冻
T03 + T15 ─ T09 Publishing（不依赖生产Runner或ProductionTask）
T08 + T09 + T15 + T16.1 + T17.2 ─ T18 正向停机迁移（注入保护门禁）
T20 ─ T18 真实 prepare/activate；T21 ─ T18 恢复感知激活/回滚及完整验收
T05～T09 + T16.1 + T17.2 + T18正向 ─ T10 Coordinator/DSH/CLI基础接线（注入备份/恢复门禁）
T20 + T21 + T18完整 ─ T10 完整门禁接线
T20 + T21 + T18 + T10 ─ T22 灾备集成与隔离演练
T10 + T22 ─ T19 轻量与跨模块验收
T19 + T22 + T17.3 ─ T11 全量测试/审查
T11 + T16.2 + 独立IM授权及保护条件 ─ T12.1 真实IM闭环
T11 + 独立平台授权及保护条件 ─ T12.2 真实B站/External
T11 + 两系统环境 ─ T12.3 真实跨OS迁移
T11 ─ T13 分项交付（显式依赖并汇总 T12.1/T12.2/T12.3/T22 的通过/阻塞/未实测证据）
```

T06 另依赖 T04；T07 不依赖 Agent。T14 承担通用 Operation/预算与门禁接口，T03 只补 B 站协议/策略；T17.1～T17.3 不依赖 T03、Cookie、Browse、IM 或商业服务，T09 也不依赖生产Runner/ProductionTask。T14 可注入备份健康/恢复门禁测试替身，但实际服务缺失或未配置时受保护派发默认 fail-closed，不能把替身注册为生产服务；不反向依赖 T20/T21。T20/T21 复用通用快照、提交屏障、Artifact和身份接口，单元测试注入日记/执行/outbox参与者，不依赖完整迁移、业务模块或DSH壳；T18/T10负责后续接入，T22验证真实模块组合。T16.1 使用注入的 CommandService，不依赖 T10；T10 不依赖 T16.2 的真实宿主条件，避免循环。

**共享文件编辑边界**：先完成 T14 在 `contracts.js/identity.js/effect-gateway.js` 中的公共类型、principal/capability 与上下文基座；T04 只在 contracts 的 Provider 类型区追加定义，T20 只在备份/恢复类型区追加定义。T03 仅在 rate-limiter 增加 B 站策略，不覆盖 T14 的通用分桶。T16.1 的 outbox 上下文和 T21 的恢复检查分别置于独立导出/区段，按 T14 → T16.1/T21 → T10 的顺序集成；禁止并行整文件重写或搬动既有导出。

### 2.2 每项统一执行步骤（仅获批后）

下列目标文件均相对于上述绝对项目根目录，实施前先确认已有文件并优先编辑；只创建任务必需文件。

1. 在该项指定测试文件逐条写验收场景，先运行并记录预期失败，确认失败不是路径/语法错误造成。
2. 实现使场景通过的最小代码；所有适配器使用注入接口，不复制权限、账本或调度逻辑。
3. 重跑该项测试与相关回归；修复失败，不使用 skip 或 Mock 掩盖本来要求真实验证的能力。
4. 记录测试命令、结果、限制及阻塞原因，满足全部本项条件再改状态。
5. 按工作项边界提交并推送：项目已纳入 git 版本控制（`main` 分支，`origin` 为 `git@github.com:keen2202/xiaofeiyu.git`）。每个工作项使用可追溯的独立提交，提交信息注明任务/FR 编号及测试结果；推送前确认不包含 Cookie、密钥、真实数据目录或未脱敏证据。

单元/集成测试只用临时目录、固定时钟、测试主体和 Mock 网络；任何意外真实网络请求直接失败。普通自动测试使用假执行器，真实媒体仅走显式本地验收；真实 IM/平台测试必须独立授权。测试身份只证明权限逻辑，不能作为生产环境人类身份已验证的证据。

## 3. 工作项

### T00：参考源码分析【DONE，历史研究完成】

**依赖**：无。

**目标文件**：`DESIGN.md` §3～5（历史研究产出，不在本轮修改）。

**工作/产出**：已分析 scroll、whale、dafeiyu、feiyu 的接口、依赖、冲突与复用边界；固定源码快照 `4af9839 / 8b0009f / 4458ec2 / c1b6916`。历史 DONE 保留，不代表统一核心已实现。

**验收**：上述章节保留源码来源、证据、缺口和不采用范围，不运行参考项目安装脚本。

### T01：设计与规范修订稿【DONE，文档草案已编制，待审】

**依赖**：T00。

**目标文件**：`DESIGN.md`、`SPEC.md`、`TASKS.md` 及 `report/DESIGN_REVIEW_SUMMARY.md`、`report/SESSION_SUMMARY.md`；`config.example.json`、`package.json`、`cordis.patch.yml` 保持既有草案，不在本轮改动。

**工作**：在历史 0.2.1-draft 基线上按复核报告补齐安全闸门、状态机、字段/接口契约、迁移与恢复闭环、任务追溯及历史文档标识；保留42条原新增FR和10条FR-DR，不改变既有功能范围，明确默认禁发、真实生产、IM、迁移及灾备交付边界。

**验收**：本任务表已编制，但用户审核未完成；D/R 编号齐全，52条新增 FR 有具体工作、SPEC 章节和计划测试。第 8 节记录确定规则与静态检查口径；T01 DONE 只表示文档草案工作完成，不表示已接线、测试通过或解除 GATE-0。

### T02：核心配置、稳定身份存储、Task 与事件归档【PENDING】

**依赖**：GATE-0。

**目标文件**：`src/errors.js`、`src/utils.js`、`src/config.js`、`src/credentials.js`、`src/store.js`、`src/task-manager.js`、`src/event-journal.js`；`test/config.test.js`、`test/credentials.test.js`、`test/store.test.js`、`test/task-manager.test.js`、`test/event-journal.test.js`。

**工作**

1. 结构化错误、稳定序列化/hash、安全 JSON、IANA 时区；按 SPEC §4 配置优先级深合并，保留 0、拒绝未知安全键、递归脱敏、原子更新和统一 config revision。
2. 按 §5 保存秘密引用与 credentialRevision；账号键为 whoami 核验后的 `platform + accountId`（B 站 MID 十进制字符串），不是 Cookie hash。以注入的验证接口测试身份，实际 B 站调用由 T03 提供；稳定 workspaceId 支持 activeAccountRef=null 的首次无 Cookie 运行。
3. 同 MID 换 Cookie 复用 quota/businessKeys/unknown；核验失败/owner 或声称 MID 不一致暂停平台写，不删账本。经明确流程换不同账号分区隔离，既有 Operation 固定原账号与凭据版本。
4. 实施真实 `version=3` 账本及historyEpoch/configRevision/recovery={id,phase,revision,holds}、RecoveryHold持久结构；instance.json 记录 bootstrapComplete/activationRevision/allowedCapabilities，首次空目录 bootstrap 与 state 同事务，已有初始化标记或归档而 state 缺失必须返回 RECOVERY_REQUIRED。`schemaVersion=1` 配置/接口与manifest分域，迁移/备份manifest显式stateVersion=3/configRevision/timeZone。旧v1/v2、未知或只改版本号的伪v3拒绝，不提供自动升级器。跨进程 `wx` 锁、属主启动标识/leaseToken/PID 校验、每次事务重读；写入flush并按系统能力同步目录，不把rename当跨文件事务或断电零丢失，不在锁内等待网络/渲染。
5. 持久 Task、请求/永久业务键、审批/outbox/Artifact/Execution 索引基础；保留 pendingOperationIds、holds[]、isSettled、executionActive、cancelRequestedAt与恢复hold/证据引用。按 SPEC §10 白名单实现状态迁移和字段组合矩阵，覆盖 waiting_approval/awaiting_manual/unknown/interrupted/running/partial/failed/cancelled；partial/failed 含 unknown 或待人工仍未结算，原 Task 批准/resolve/resume 回流，不因显示终态清理，恢复hold不能被普通resume/resolve解除。
6. 业务变更、epoch内递增seq、全局唯一eventId、journalPending 与 outbox 意图同事务；appendEvent 仅允许在 transaction 回调内随 draft 一次提交。归档目录/索引为 `journal/<historyEpoch>/<startSeq>-<endSeq>-<hash>.json`，flush/rename后登记摘要再清pending。所有游标、日记截止点、检查点带(epoch,seq)，禁止跨epoch裸seq比较/覆盖。2000仅热缓存上限，500 Task/5000 Operation清理不动未结算引用、永久键及恢复证据；归档积压暂停接纳而非删事实，元数据80MiB预警、100MiB停止新业务，只允许保留永久引用的压缩/归档和恢复收尾。
7. 纯普通同机重启只在历史完整且可证明属主消失时将无dispatchAt的reserved转cancelled，有派发边界转unknown，均不自动重放。从备份恢复优先T21：损坏/误删已初始化账本不置空、不自动选旧点续写；新建workspace与损坏恢复须区分，旧reserved/queued/审批可能已在cut后执行，不能推定not_sent。
8. 提供通用短checkpointFence、提交参与者/引用固定和恢复元数据接口供T20/T21使用；普通重启及正常迁移保持epoch，灾备新epoch保留父恢复点/旧分支。事件归档仅事实投影，不作为完整WAL重建全部账本。

**先写失败测试与验收**

- SPEC §4～6、§10、§18、§19.1/19.2：0 值、非法布尔/时区/版本、配置失败零写入；SPEC §18 每个错误码均有构造与序列化测试；示例 JSON 与默认配置深比较一致，默认所有业务开关/外发关闭，平台声明不触发登录。
- 两进程竞争不能覆盖/双预留；活锁属主、PID 复用不明不抢锁；损坏状态拒绝写，不重置为空账本。
- 无 Cookie 可建 workspace Task；同 MID 凭据轮换后额度、unknown、防重不变，跨 MID 不串用。
- 注入状态提交前后、归档 rename 前后崩溃；凭eventId及(epoch,seq)去重。插入超过2000事件仍完整读事实；缺段、摘要错、同epoch seq冲突拒绝重建/激活；不同epoch同seq的段/游标/日记/检查点互不覆盖，旧裸seq不能重用为新历史水位。
- 按 SPEC §10 白名单逐对测试 Task 合法/非法迁移及 `status/isSettled/executionActive/finishedAt` 组合；Operation 压缩后永久键仍防重；partial/failed 含 unknown、等待审批/人工、未决 outbox 依赖的 Task 归属/权限索引不被清理，通知不改变业务结算；父子 Task 未决状态正确汇总，恢复不自动重放。
- 单事件 payload 超64KiB须转受管引用而非静默截断；journalPending达10000条阻止新业务但允许收尾与归档恢复，不丢事实。
- 同一reserved样本分别走完整历史普通重启与旧备份恢复：前者满足属主证据才cancelled，后者保留待核查/RecoveryHold；缺主state不误判首次运行。v2/仅改version的假v3、丢epoch/hold及仅事件摘要重建均失败；损坏原件不改动，恢复分支另由T21验证。

### T14：公共契约、身份/审批及副作用网关基础【PENDING】

**依赖**：T02。

**目标文件**：`src/contracts.js`、`src/identity.js`、`src/approval.js`、`src/command-service.js`、`src/effect-gateway.js`、`src/rate-limiter.js`、`src/adapters/registry.js`；`test/contracts.test.js`、`test/identity.test.js`、`test/approval.test.js`、`test/command-service.test.js`、`test/effect-gateway.test.js`、`test/rate-limiter.test.js`、`test/helpers/mock-platforms.js`。

**工作**

1. 定义 RequestEnvelope、AccountRef/ContentRef/Receipt、PlatformAdapter、ChannelAdapter、ExecutionBackend 和 ArtifactRef 契约；schemaVersion、公共 extensions 与平台数据边界按获批 SPEC §21 固定，公共核心不解析 BV/aid/cid/tid。
2. 核心绑定可信 workspace/principal/sourceKind；规范 inputHash 覆盖素材摘要、目标、规格、profile/Provider 版本和费用上限。请求键 `workspace+principal+action+requestId` 同参复用、异参冲突，accepted 仅在持久事务完成后返回；请求防重不能替代永久业务防重。
3. 轻量声明式能力注册：逐能力 supported/reason/limits；X/抖音/remote 仅测试替身，正式调用返回 CAPABILITY_UNSUPPORTED，不注册 SDK 或自动降级。
4. 主体与平台账号分开、scope/所有者/会话 ACL、默认空权限、本地绑定/撤销接口；验证本地交互人类上下文或宿主人类证明的接入方式，`--confirm`、body 身份、同 OS 进程、模型文本本身都不是人类证明。不声称能抵抗同 OS 账号任意代码执行。
5. ApprovalService 挑战绑定 task/action/inputHash/revision/principal/nonceHash/expires；同决定幂等、冲突拒绝，过期/改参/撤权/迁机失效，干跑不消费 go 授权。批准在事务中回流原 Task；生产/发布审批隔离，auto 只记显式 policy，不伪造人类审批。
6. 将原 T03 通用 Operation 提前：实例激活/能力、权限/审批/最新配置/dryRun、迁移/短checkpointFence、备份保护/匹配RecoveryHold、业务键及预算预留同事务，等槽位后再次检查并持久dispatching。平台写/付费使用OperationContext，免费本地阶段使用ExecutionDispatchContext，通知使用OutboxDispatchContext；共享适用栅栏但不重复建Operation。以注入契约读取保护状态/恢复门禁，实际未配置默认拒绝受保护派发，不依赖T20/T21实服务完成。
7. B 站额度、workspace/provider 付费预算、IM 通知预算分桶。付费以整数最小货币单位和可封顶成本预留，零预算/不可封顶拒绝；unknown 冻结跨窗口/凭据/attempt 的占用；缺失动作/金额由scope hold与unknownExposure覆盖，不只匹配可见operationId。
8. confirmed/明确 failed/unknown/cancelled/not_sent 恢复区分普通重启与灾备；本地人类 resolve 同事务更新原 Operation、永久键、费用/额度、关联 Task、事件/outbox，但不授予恢复写权。无健康恢复点阻止平台写/付费/IM新派发，不阻断在途回执及必要归档收尾；只读及不涉及受损历史的新免费本地工作可单独授权，仍受激活/迁移/hold等其余门禁约束。

**先写失败测试与验收**

- FR-EXT-001～004、FR-IM-001/004 的公共基础、FR-PRO-006、SPEC §7/22：未知版本/动作/安全字段拒绝；Mock 非 B 站 ID 不需 BV，Cookie/额度/熔断不串服务。
- HTTP/CLI/IM 同键并发只创建一个 Task；新 requestId 仍不能绕过业务键；提交失败不返回 accepted。
- 伪造 principal/role/actorKind/approved:true、Agent 消费挑战、错主体/会话、过期/改参/nonce 重放、撤权后派发全部拒绝；重复同决定仅幂等返回，不重复消费。
- 同事务竞争额度上限；prepare/checkpointFence/RecoveryHold 与 reserved→dispatching线性化，冻结后零新派发。超时unknown自动重发计数为0；只有可信未发送证据才not_sent。
- 付费调用前无 Operation/预算不发送；resume 不清零成本；预算未知冻结，local 渲染不占 B 站额度。resolve 同结果幂等、冲突拒绝，保留原 Task/Operation 链。
- 注入健康→过期、无服务/无策略、scope冻结替身：预留时与发送前均拒绝平台/付费/IM，go/审批/config/resume/resolve不能覆盖；跨Cookie/requestId/新预算窗口不能绕过，其他独立scope不误消费额度。在途收尾可落账，符合条件的新免费本地工作无需平台备份健康，但不能越过匹配hold。
- 基础审批/CommandService 不 import dsh-im 或 DSH 外壳；缺宿主人类证明仅相应入口不可用，已验证本地人类路径可独立运行。替身只用于离线契约，实际服务接入及同机多入口无旁路由T10/T22验收。

### T03：可选 B 站协议与平台策略【PENDING】

**依赖**：T14。

**目标文件**：`src/bilibili.js`、`src/adapters/platforms/bilibili.js`、`src/rate-limiter.js`；`test/bilibili.test.js`、`test/bilibili-adapter.test.js`、`test/helpers/mock-fetch.js`。

**工作**：实现 WBI/nav/whoami/popular/search/view/subtitle/comments/relation，B 站字段归一到公共契约；评论/DM 写接口及稳定 dev_id、业务回执归一；所有读写走 T14 网关/限流，不在协议层另建 Operation 账本。写接口必须持有效OperationContext并经过备份保护/RecoveryHold复检，协议调用不能成为旁路；明确授权的只读核查不自动外发。声明dm.receive=false，发布能力按Provider声明；WBI缓存、读重试最多1次、412/429/风控熔断及登录人工暂停。

**先写失败测试与验收**：SPEC §7～8/27、FR-EXT-003/004。固定时间验证 WBI；非0 code无成功，缺可信回执/派发后超时unknown、零自动重试；仅允许域名收到Cookie，字幕HTTPS/CDN/Agent无Cookie。用注入门禁验证无保护/超龄/账号scope冻结时评论DM零新发送，换Cookie/新请求不绕过、迟到回执仍入账；实际组合见T22。平台不可用不阻断workspace生产。所有协议测试Mock fetch，不访问真实B站。

### T04：可选 AgentClient 与商业扩展接口【PENDING】

**依赖**：T14。

**目标文件**：`src/agent.js`、`src/contracts.js`；`test/agent.test.js`、`test/paid-provider-contract.test.js`、`test/helpers/mock-providers.js`。

**工作**：实现显式启用的 OpenAI 兼容 text/JSON 客户端、环境变量 Key、围栏处理、超时/长度/结构校验与不可信素材边界；为生产文案/生图/TTS 只提供可选契约与 Mock，真实生产付费调用必须经过 EffectGateway。浏览/日记可不依赖模型；不把商业服务集成设为首期必需。

**先写失败测试与验收**：SPEC §9、FR-PRO-001/006。非法 JSON 为 AGENT_OUTPUT_INVALID；禁用时零网络且确定性降级；不泄漏 Key/Cookie，不因模型失败绕过审批。生产 dry 模式零模型/生图/TTS 调用；付费 Mock 验证预算预留与 unknown，报告不得称商业服务已集成。

### T05：Browse 模块【PENDING】

**依赖**：T03。

**目标文件**：`src/modules/browse.js`、`test/browse.test.js`。

**工作**：按稳定平台/账号/内容引用汇总热门/搜索、多来源去重，已看/失败冷却/自有过滤；详情/字幕/可选热评、确定性评分、失败隔离和事实事件；只返回 Candidate，不发送评论/DM，不虚报观看进度。

**先写失败测试与验收**：FR-BRO-001～008 全覆盖；开关/调度约束、多来源同 BV 只处理一次、无字幕按策略跳过、详情失败不计已看懂、单条失败整轮 partial；证明 Browse 没有调用任何评论/DM 写接口。

### T06：Comments 与统一审批【PENDING】

**依赖**：T03、T04、T05、T14。

**目标文件**：`src/modules/comments.js`、`test/comments.test.js`。

**工作**：草稿含 taskId/inputHash/expiresAt，待审目标索引避免每轮重复草稿；统一 ApprovalService 消费可信挑战并回流原 Task；auto 使用独立显式策略。实现模板禁止默认值、长度/@Owner、同 BV 冷却、跨视频同文保护、每轮/每日额度；批准/派发重检最新权限、输入、额度和去重。

**先写失败测试与验收**：FR-COM-001～010、FR-IM-004。审批模式不自动外发，裸 approved 无效；草稿过期/改参重审；同 BV 不同正文仍拒绝、同文跨视频拒绝；无 Agent 且模板未允许不自动生成；dry 不写已发送记录，unknown 不再发送且保留原 Operation。

### T07：DirectMessages 白名单发送【PENDING】

**依赖**：T03、T05、T14。

**目标文件**：`src/modules/direct-messages.js`、`test/direct-messages.test.js`。

**工作**：复用 Candidate，不重新 Browse；白名单/默认互关/拒绝自己、稳定 dev_id、独立额度/同目标冷却及回执。所有入口经主体动作权限与事务预留；不接收批量收件人数组，不监听 B 站收件箱，日志/事件只留摘要。

**先写失败测试与验收**：FR-DM-001～008。手动/Agent 也不能越过白名单；关闭互关仍保留白名单；两渠道可各一次，同渠道重复拒绝；超时 unknown 零重发，完整私信不进入日记/日志。IM 控制通道与本模块没有隐式互通。

### T08：scope 日记与可恢复双阶段提交【PENDING】

**依赖**：T02、T04、T14。

**目标文件**：`src/modules/diary.js`、`test/diary.test.js`。

**工作**：依据 SPEC §14 的 workspaceId/scope/date/book、scopeKey 路径，从完整归档＋pending 的(epoch,seq)截止游标快照重建；包含生产/产物ready、失败/unknown/投稿等事实，不把生产写为发布。锁外生成、按身份跨进程串行，核对revision/eventCursor，pendingCommit→正文原子替换→索引确认；启动修复。通过通用提交接口遵守短checkpointFence，备份正文须屏障内staging或明确derived/rebuild。事实未变化复用叙述，变化递增revision；核查跨日标记原操作日与核查日，灾备旧分支及缺口不能被叙述抹平。

**先写失败测试与验收**：SPEC §14/19/27。不同MID/workspace同日不覆盖；超过2000热事件仍完整重建；unknown resolve只增加必要修订；旧生成者不能覆盖新版本。注入三个提交窗口崩溃，按摘要完成/撤销并重建，不追加重复事实；缺档fail-closed，跨epoch裸seq拒绝、缺正文标待重建。公共/私人均无凭据，公共无完整私信/敏感路径，查询按scope ACL；不自动通过IM发送日记，不从日记摘要反推永久键。模块测试用事件/屏障样本，跨模块验证在T19/T22，不反向依赖备份实现。

### T15：ArtifactStore 与受控素材导入【PENDING】

**依赖**：T14。

**目标文件**：`src/artifact-store.js`；`test/artifact-store.test.js`、`test/artifact-recovery.test.js`。

**工作**：实现 script/image/clip/audio/subtitle/video/cover 的不可变 ArtifactRef、流式 hash/复制、来源/派生记录、scope/共享 ACL；只允许可信本地人类从 allowedSourceDirs 导入，空列表拒绝。校验普通文件、实际路径、重解析点/软硬链接、类型/字节上限。Runner 输出只在核心分配工作目录内，经独立校验后 pendingImport→rename→账本确认；导出使用相对路径和实际字节，不携带旧机绝对路径身份。提供提交屏障及固定引用/释放接口，备份期间禁止回收已捕获对象，未确认渲染输出不算定稿；缺媒体元数据明确unavailable，不伪造ready。

**先写失败测试与验收**：FR-ART-001～006。同内容引用稳定且不可原地替换；API/IM 不能用 artifactId 读目录或越 scope；越界、盘符/UNC、链接、超限、hash 不符、缺引用字节、跨平台重名冲突均失败。崩溃恢复 pendingImport 只回收可证明归属的临时文件，不删源/定稿/用户目录。发布前复核摘要并测试审批后文件替换拒绝；迁移封存前无未完成导入；注入短屏障/固定引用验证提交与回收竞态，实际ledger/full在T20/T22验收。

### T16：IM 契约与宿主薄桥接【BLOCKED，真实宿主能力尚未验证】

**依赖**：T16.1、T16.2。

**目标文件**：`src/adapters/channels/dsh-im.js`、`src/command-service.js`、`src/identity.js`；测试文件见子项。

**工作/验收**：分别完成离线契约和真实宿主绑定，真实授权消息闭环另计 T12.1。T16.1 通过只表示契约完成，不将 T16 或真实 IM 标为全功能完成；T16.2 缺条件不阻塞 T17 或其他离线模块。

#### T16.1：IM 入站契约、命令防重与 outbox【PENDING】

**依赖**：T14。

**目标文件**：`src/adapters/channels/dsh-im.js`、`src/command-service.js`、`src/effect-gateway.js`；`test/im-contract.test.js`、`test/outbox.test.js`、`test/helpers/mock-channel.js`。

**工作**

1. 经受信 ChannelAdapter envelope 和本地 bindings 绑定 principal；正文不能覆盖身份。按 adapterId/botAccountId/conversationId/eventId 记命令 hash/原 Task；新消息验发生时间，重复消息先复查当前权限，同键异内容冲突，无可靠 eventId 仅受限只读。
2. 默认权限空，白名单仅生产草稿/干跑、自有任务查询/取消、可信人类挑战决策；自然语言只形成候选草稿。不开放配置/秘密/执行器/迁移/备份/灾备核查授权/人工补录/resolve/任意B站DM，不返回明文事故证据；调用T14审批基础，不自己建立审批系统。
3. 接纳、请求/Task变更、消息索引/游标、事件及通知outbox同事务；内部事件游标带epoch，通道消息四元防重键不因新epoch重置，索引覆盖重投/有效时间窗、未决不清理。可见回信也走outbox，而非将内部accepted当送达。
4. 发送预留与实际发送前均复查binding/会话受众、独立通知额度、实例/迁移/checkpointFence、备份健康及bot/conversation恢复hold，保存发送键、payloadHash、状态和回执；允许在途回执落账。实现ChannelAdapter capabilities.delivery.query/idempotent与queryDelivery(notificationId,receipt)，查询不可用/超时保持unknown；提供本地人类outbox resolve，不开放IM/Agent。仅明确未发送可有限重试；unknown无已验证通道幂等/查询保证则不重发，不换新键规避。
5. 只合并未发送旧进度，终态/人工待办保留；通道关闭保留，撤权suppressed；pending/sending/unknown永不按留存清理，已结算通知仅可在保留Task/事件/回执摘要引用后清理正文。群聊summary/none、产物只回artifactId/摘要，不发完整脚本/私人日记/绝对路径/凭据/公开下载链接。备份恢复后的旧outbox/权限/审批不激活，不凭快照queued或无发送边界推定没发过；scope解冻不自动重发。

**先写失败测试与验收**：FR-IM-001～006及§27。两进程重投只创建一个Task；未知主体/错群/撤权/超时/未来时间/body伪造拒绝；输入编辑不变更已接纳任务。审批干跑不消费go、查询不能看他人任务；完整历史普通重启outbox不漏终态，灾备旧outbox留hold；通知失败/unknown不重跑生产、不回滚业务。无策略/超龄/发送scope hold时所有回信零新派发，在途回执可记；换bot能力/新消息键不绕过原scope，撤销过的绑定不能由旧备份复活。测试注入门禁，实服务接线见T22；默认无宿主服务明确unavailable，Mock不注册成真实通道。

#### T16.2：真实 dsh-im 只读能力探测与薄适配【BLOCKED】

**依赖**：T16.1；另需可访问的真实宿主及允许的只读观察条件。

**目标文件**：`src/adapters/channels/dsh-im.js`、`test/dsh-im-adapter.test.js`；真实证据写入获批后的交付记录，不采集秘密/无关聊天正文。

**工作**：先只读核对实际服务注册、消息来源、bot/sender/conversation/eventId、生命周期、发送接口及回执语义、人类证明/工具回调区别；不靠发消息试探权限。基于证据实现最薄映射和 start/stop，不假定 SPEC 内部方法名就是宿主 SDK，不安装 QQ/微信 SDK。

**先写失败测试与验收**：FR-IM-007。把脱敏真实结构固化为回归样本，验证映射和注销；缺任一前提则对应能力 unavailable/BLOCKED，不能用 Mock 成功解除。无可信人类来源时 IM 审批 fail-closed，仅可转经验证本地人类流程；读探测通过不等于消息已发送或真实 IM 已交付，继续等待 T12.1 单独授权。

### T17：独立生产与本地执行【BLOCKED，真实媒体工具/执行授权尚待提供】

**依赖**：T17.1、T17.2、T17.3。

**目标文件**：`src/adapters/execution/local.js`、`src/production/runner.mjs`、`src/production/profiles/local-slideshow.js`、`src/modules/production.js`；测试见子项。

**工作/验收**：本地执行、业务流水线、真实媒体分项验收；T17.1/17.2 的代码可在 GATE-0 后独立推进，但没有 T17.3 的 MP4/封面证据不得声称生产能力完成。没有平台 Cookie、B 站适配器、IM 或商业服务仍须可生产。

#### T17.1：Local ExecutionBackend、Runner 与回执【PENDING】

**依赖**：T14、T15。

**目标文件**：`src/adapters/execution/local.js`、`src/production/runner.mjs`；`test/local-execution.test.js`、`test/execution-recovery.test.js`、`test/helpers/fake-runner.mjs`。

**工作**：核心先持久executionId/request映射，固定可信runner、execFile参数数组、有界JSONL（单条≤1MiB、stdout/stderr合计≤10MiB）、环境白名单、受控cwd、maxConcurrent=1。分离accepted/进度/完成，记录task/stage/attempt/执行seq/inputHash及checkpoint关联的historyEpoch/事件水位；执行seq不是跨epoch事件seq。每个executionId是不可变尝试：进行中的相同executionId重复submit返回原记录，interrupted/FAILED/CANCELLED的resume创建新executionId、递增attempt并引用前一执行与已验证检查点，不能把终态改回运行态。cancel/close只请求停止并收尾。新阶段遵守checkpointFence/匹配RecoveryHold，已开始渲染可写未提交工作文件，不能把它们列为备份中已确认产物。本协议不用于平台上传；External由T09独立执行，生产Runner不获平台凭据。

**先写失败测试与验收**：FR-PRO-004/005/007/008/010。同 seq 同内容幂等、异内容冲突、乱序/旧 attempt 不覆盖；持久记录到 spawn 间崩溃先查属主，不能盲重开；ACK/退出 0 不代表业务完成。interrupted/终态resume生成新executionId并验证同task/stage/inputHash重绑定，旧checkpoint及检查点artifact哈希不匹配则拒绝，相同executionId重复submit不重启。超限输出有界收尾；参数含 shell 字符不执行注入；生产 Runner 环境无 B 站 Cookie/秘密全集/账本路径。取消与成功竞态保留事实，无法确认停止不释放槽位；remote 明确不支持、零端口/心跳/网络 worker。

#### T17.2：ProductionTask 与 local-slideshow-v1【PENDING】

**依赖**：T17.1。

**目标文件**：`src/modules/production.js`、`src/production/profiles/local-slideshow.js`；`test/production.test.js`、`test/local-slideshow.test.js`、`test/production-budget.test.js`。

**工作**

1. 独立 workspace 生产请求和 requestKey；按 script/assets/voice/render/validate 固定串行阶段，不建通用 DAG。脚本 Artifact＋至少一个已导入图片/片段为必需，缺输入 INPUT_REQUIRED，不转付费生成。
2. 可信本地 profile 绑定 id/version/backend、阶段/安全重启/checkpoint、工具绝对路径/版本范围、voiceMode、规格上限和可选 providerRefs；请求不能传 command/args/env。显式配置 ffmpeg/ffprobe，不扫描 PATH、不安装、不启动时探测；输入协议仅file/pipe，清单由受控路径生成，拒绝网络URL、外部播放列表、任意滤镜/脚本及参数注入，并写失败测试。
3. 用户脚本生成确定性时序、素材校验；音轨/字幕可选但须匹配格式/时长。无配音仅在 profile 显式允许并校验后带证据 skipped；TTS 失败或工具缺失不是合法跳过。
4. 全局/功能/调用三级 dryRun 否决、强制生产人类审批、allowLocalProducer、预算/耗时/容量上限；干跑只出计划/阻断原因，零工具/生成服务调用、零付费预留、readyForPublish=false。
5. local-slideshow-v1 调固定 ffmpeg 合成真实 MP4 和封面，处理已选音轨/字幕；ffprobe 检查视频流/时长/尺寸/fps，可信解码校验与封面检查。核心独立验清单/文件/hash，再提交 Artifact/manifest。
6. 可选付费provider只走T14网关，要求有效备份保护且无对应恢复hold；免费本地生产仍不绑定平台或商业服务。resume核对旧执行已停、unknown/费用、输入/profile/权限/审批及recoveryHold，只复用已验证阶段产物。灾备媒体缺失保持unavailable/ready=false；重新生成是新attempt并经批准，不能以存在旧metadata标成功。checkpoint的事件水位带epoch，旧分支结果只作证据，不自动推进新执行。
7. 全部必需阶段完成或经规则允许跳过才 succeeded/readyForPublish；生产不自动建/批准 PublishTask，发布失败不重做生产。

**先写失败测试与验收**：FR-PRO-001～009。空 Cookie、禁用 B 站/Browse/IM/Agent 的环境可接受生产；脚本/素材缺失、奇数/越界尺寸、非法 fps/时长/输出超限拒绝。缺工具只该 profile BLOCKED，不影响核心状态/日记。Mock 覆盖每阶段失败、缺封面、伪 manifest、损坏视频、hash 替换、合法无配音和非法 skip；任何不合格产物 ready=false。已付费/unknown 预算不随新 attempt 或取消释放；生产审批不能批准发布。真实产物必须另通过 T17.3，不能用 Mock 补足。

#### T17.3：必需的真实本地 MP4/封面验收【BLOCKED】

**依赖**：T17.2；另需用户显式提供受信 ffmpeg/ffprobe、授权目录和本地 profile 执行/人类审批。

**目标文件**：`test/manual/local-production.acceptance.mjs`、`test/helpers/media-fixtures.js`；产物仅写隔离临时目录/测试 ArtifactStore，不写真实用户状态。

**工作**：先写不能被 Bundle/假文件通过的断言，再用项目测试素材（合法生成的图片/短片、脚本文本、可选测试音轨/字幕）走真实导入→批准→固定阶段→核心验证流程。覆盖带音轨/字幕、图片/片段，以及显式无配音路径；清空平台凭据并禁用全部平台和商业 provider。

**验收**：真实 MP4 可被 ffprobe 识别且完整解码，视频流、计划时长/偶数尺寸/fps/容量符合 profile，封面可读且 hash 与 manifest 一致；字幕/音轨与配置相符，无配音确有合法 skipped 证据。保存命令、工具版本、探测结果、产物 hash、阶段/Task ID 与 ready 标记，不以目录/脚本/Bundle 或外部发布器替代。再测缺工具/损坏输出使能力 BLOCKED/失败且核心仍可查。**这是生产交付必过项，不是 T12 的可选真实 B 站测试；缺工具不得 skip 后记通过。若 SPEC §22.1 的本地人类证明机制也不可用，则真实 go/人工审批同样 BLOCKED，但离线编码与替身测试仍可继续。**

### T09：基于 Artifact 的独立 Publishing【PENDING】

**依赖**：T03、T14、T15。

**目标文件**：`src/modules/publisher.js`、`test/publisher.test.js`、`test/helpers/fake-publisher.mjs`。

**工作**

1. 只接受授权 ArtifactRef、目标稳定账号与平台元数据；已有视频导入后可直接投稿，不要求 ProductionTask。引用生产结果时确认真实成功且 ready；派发前重验视频/封面 hash、类型/大小/ACL。
2. 发布永久键包含平台/账号/视频 hash/含封面摘要的 metadataHash；待审/awaiting_manual 索引复用原 Task，审批绑定 inputHash/Provider 版本，任何变更重审。调用 T14 审批回流原 Task，生产批准及 approved:true 均无效。
3. 仅明确选择 manual 才生成 metadata.json/PUBLISH.txt，Artifact 引用可免复制但迁移须带实际字节；awaiting_manual 不是 succeeded。External 缺失不自动降级 Manual。
4. 实现 SPEC §15.4 的本地受信人类 complete：展示 task/input/account/回执证据并验证人类确认，Manual断言记 verification=manual_assertion，不冒充平台回读。待人工期间只保留Publish/Task和pending业务索引；仅无已派发/unknown操作的Manual任务在补录时创建唯一 manual_confirmation confirmed Operation，同结果幂等、冲突拒绝，不靠PID/取消释放待人工保护。
5. External在核心OperationContext、有效备份保护及无匹配RecoveryHold条件下使用固定程序、受控execFile、无shell、参数占位/环境白名单和输出总量限制；不依赖生产Runner/profile。仅发布适配器获必要平台凭据。有效Receipt才confirmed，退出0/ACK不够；启动后不能证明未发则unknown。
6. External unknown只能由本地人类resolve原Operation，禁止转Manual complete再造。事务更新永久键、原Publish/Task、额度、事件/outbox，但resolve不解除恢复scope冻结。灾备缺原Operation时转T21证据/recoveredFact，不伪造旧ID；Manual登记也不能成为绕过恢复hold重新投稿的入口。T10仅包装本地人类CLI。

**先写失败测试与验收**：SPEC §15、FR-ART-004/005、FR-IM-004、FR-PRO-009。已有视频无生产任务可投稿、已批准文件被替换拒绝；重复审批仍为原 Task。Manual Bundle 永不直接已发布，假人类/无证据补录拒绝；External Mock 覆盖成功/启动前失败/启动后 unknown，核查保持原 operationId，禁止改 Provider 绕过冻结；全部路径不删源、不通过 shell。未验证的实际发布器及原生 UPOS 不算交付。

### T18：同插件兼容 schema 停机迁移【PENDING】

**依赖**：正向迁移为 T08、T09、T15、T16.1、T17.2，可使用 T02/T14 的 holds 结构与注入保护门禁；真实 prepare/activate 另需 T20 健康恢复点，恢复感知激活/回滚及 T18 完整验收另需 T21。T10/T22/T12.3 依赖的是 T18 完整验收，不得把正向部分完成当作 T18 DONE。

**目标文件**：`src/migration.js`、`src/store.js`、`src/effect-gateway.js`、`src/artifact-store.js`；`test/migration.test.js`、`test/migration-crash.test.js`、`test/migration-paths.test.js`。

**工作**

1. 仅接收kind=migration、schemaVersion=1、stateVersion=3的同插件manifest和真实v3账本；kind=backup即使文件完整也不获迁移激活资格。正常迁移保留historyEpoch及RecoveryCase/holds/证据引用。检查instance激活/能力、migration phase、备份保护及匹配恢复hold，不把源PID/锁/控制文件原样当目标属主。
2. prepare 在核心事务核对健康恢复点、无匹配RecoveryHold后，原子冻结全部入口新任务、素材导入、平台/付费/新执行阶段/通知派发，覆盖等待槽位的 reserved；真实prepare/activate不接受dryRun/go豁免，离线测试只能注入门禁。允许冻结前合法在途回执/取消确认/核查收尾落账。
3. 停止执行器/外部发布器/发送器并证明已知子进程不再修改文件；无法证明则 export BLOCKED，未知远端效果保留 unknown。完成 journalPending、日记 pendingCommit、Artifact pendingImport 后屏障封存，禁止部分成功包。
4. 导出 manifest＋最新完整账本/事件归档/水位/公共私人日记与索引/全部素材产物与引用式 Bundle/检查点；保留 requests、永久键、额度费用/unknown、审批审计、消息索引/游标/outbox/回执及恢复 evidenceRefs。文件数/字节上限、相对路径、size/hash 完整校验；sealed 后不悄改业务快照，晚回执需封存作废重建或 release 后转目标核查。
5. release 持久 retired 旧端，再给绑定 migrationId/snapshotHash/targetInstanceId 的票据；崩溃和重启仍拒绝业务写/派发，重复相同 release 幂等，冲突拒绝，普通配置不能恢复。
6. 目标只导入新空目录并暂停；验证票据目标、兼容 schema、全量文件/摘要及跨平台路径，拒绝未列出文件、绝对/盘符/UNC/..、重名/保留路径、软硬链接和重解析点。失败不覆盖活跃账本/删除源数据。
7. 秘密、nonce明文、机器执行许可不随包迁移；安全默认配置下重绑身份、目录权限、工具/profile、宿主权限/端点与秘密引用。同MID核验仍保留quota/businessKeys/unknown；workspaceId/timeZone/预算窗口不变。允许仅激活已核验的非平台能力，但须在activation清单中持久禁用未核验平台及其他能力，不能称全量通过。
8. activate核对健康恢复点、无匹配RecoveryHold、源退役证据、摘要/目标/身份/依赖与本地人类确认，先持久激活决定再开允许能力；幂等重启不覆盖最新账本。旧挑战失效、旧任务migrationHold、scheduler关闭；旧Task/outbox/unknown不自动重投，人工续办须重新检查/必要时重新审批。
9. 源端phase固定active/quiescing/sealed/released/aborted，目标固定none/imported/validated/active/disabled；实现migration abort/disable-target/rollback，export原子seal并支持sealed晚回执回到quiescing落账后重新export。release前abort须作废封存/激活资格并审计；release后无论目标是否已激活，均先disable-target，再以目标当前数据目录的最新已提交账本创建反向migrationId。目标未激活时使用其已导入快照及后续核查记录，不得回到源端旧备份；无法取得目标状态/最新账本时保持阻塞。真实数据损失可转T21只读灾备，但不得伪造release/最新账本或直接解除retired。迁移包只携带恢复证据的evidenceRefs，附件由受控权限另行导出。

**先写失败测试与验收**：FR-MIG-001～010、FR-ART-005/006。两个不同根目录/instanceId 模拟全流程：prepare 与派发竞态只有一方获权、收尾可提交、孤儿不退则不能封存；事件/索引/字节逐项守恒。同 MID 换秘密保留占用；无 Cookie 的纯 workspace 可迁移，未核验平台仍禁用。错目标/版本/hash/链接/路径/超限/缺秘密拒绝相应激活；导入暂停，source release 与 target activate 各断电点幂等，旧端重启仍禁写。旧审批/queued/outbox 零自动重放，回滚最新业务键/额度/unknown 连续。双目录/路径模拟与真实跨 OS 结果分开，人工绕流程复制双启不在保证内。

### T20：可信恢复点、分层备份与保护健康【PENDING】

**依赖**：T02、T14、T15。

**目标文件**：`src/backup-recovery.js`、`src/store.js`、`src/artifact-store.js`、`src/contracts.js`；`test/backup.test.js`、`test/backup-retention.test.js`、`test/backup-fence.test.js`、`test/backup-policy.test.js`。`<dataDir>/backup-policy.json`仅为获批后的本地策略对象，当前不创建、不写入普通示例配置。

**工作**

1. 落实SPEC §27.1独立BackupPolicy：scheduleEnabled=false、destinationRoot无默认值、owner确认故障域；不同目录/盘符不自动算异盘，不可用时不回退同盘。初始interval=15分钟、maxPointAge=20分钟，full为24小时，保留8recent/7daily/4weekly取并集，autoPrune=false，checkpointTimeout=5000ms；校验正整数、interval不大于maxAge、容量与安全路径。checkpointTimeout只约束事务屏障和staging捕获，不限制锁外大对象复制。
2. 备份调度只作为显式管理任务，复用Coordinator策略但不依赖完整DSH壳；提供getProtection(scope)给T14注入。无策略或无独立有效恢复点为unprotected，超龄/失效为degraded：平台写、生产付费和IM发送停止新派发，在途回执/归档收尾仍可提交；不把local免费工作误计平台保护条件。
3. BackupService.create先持久backupId/request，再由唯一freezeCoordinator在同一Store事务检查migration.phase/recovery并设置短checkpointFence，阻止新派发和新多文件提交，允许已有提交收尾；migration准备优先，新备份在非active迁移阶段拒绝，崩溃属主不明保持冻结。捕获必须在checkpointTimeout内完成，在同一cut记录v3账本、epoch/seq、configRevision/version+hash、timeZone、永久键/requests/额度/unknown、权限审计/outbox/归档引用及Artifact元数据；pending保留或完整归档，不漏事实。普通recovery.normal可建点；readonly/reconciling仅允许经完整性校验的管理路径建点，blocked且数据可疑时禁止，restricted/released只允许已验证范围建点，任何新点都不清除既有hold。
4. 可变日记需屏障内staging或明确derived/rebuild，大复制超预算时默认derived/rebuild；大媒体/不可变归档固定引用后锁外复制，正在渲染的临时输出不算定稿。元数据80MiB预警、100MiB达到RTO条件化边界并停止新业务，只允许保留永久引用的压缩/归档与恢复收尾。超时/崩溃修复屏障和固定引用，失败不生成新有效点、不覆盖最后好点，也不留下永久冻结。
5. ledger保证完整账本恢复材料并列媒体覆盖，full要求其cut所需全部定稿对象字节。库内可按hash去重，但manifest闭合引用；便携full实体化所有必要对象，禁止旧机绝对路径/越界/软硬链接/额外文件。
6. BackupManifest明确kind=backup、schemaVersion=1、stateVersion=3、sourceHistoryEpoch/cutEventSeq/cutAt、configRevision/version+hash、timeZone、sourceStateHash与去秘密副本snapshotHash、files/journalCoverage/mediaCoverage/excludedData/failureDomain。sourceStateHash按SPEC §27.3对规范化账本与捕获元数据做JCS-SHA256，snapshotHash覆盖实际快照文件清单；去掉秘密、nonce/nonceHash、有效写者与迁移票据，只留不能授权的审计摘要。
7. 全量必需文件flush/hash完成后才发布完成标记并更新索引；即时verify和显式启用策略下的每日复查。cutAt不改为复制完成时间；保存真实错误、年龄/覆盖、验证及演练状态。受控访问/用户管理加密介质是部署前提，不自动建云连接或操作系统权限。
8. prune先给计划，再owner确认并重新校验引用；按tier保底保留最后有效账本点及最后有效full、调查固定点/恢复引用/共享对象。新ledger不能挤掉唯一full，full超龄仍保留；容量不足报错而非删唯一好备份腾空间。

**先写失败测试与验收**：FR-DR-001～004；SPEC §19.5。覆盖cut同时有reserved、渲染、日记提交和Artifact提交，快照/引用同界且大媒体不持锁；备份重复请求幂等、超时/断电屏障可恢复，checkpointFence与迁移prepare并发只有一方获权。无策略/同盘未核验/超龄各入口零受保护派发但在途回执落账。验证partial目录、flush失败、缺字节/摘要错/满盘不替换last good；大日记derived/rebuild、80/100MiB容量边界、configRevision/hash/timeZone和sourceStateHash金标准；ledger缺媒体仅账本可恢复，full缺必需对象失败；8个新ledger不能删除最后full，prune不能删除共享/固定对象。仅verify通过不写restoreTested，15分钟间隔/20分钟最大年龄/24小时媒体目标不是已测SLA。

### T21：只读灾备、证据核查与分范围解冻【PENDING】

**依赖**：T20。

**目标文件**：`src/backup-recovery.js`、`src/store.js`、`src/task-manager.js`、`src/identity.js`、`src/effect-gateway.js`；`test/recovery.test.js`、`test/recovery-evidence.test.js`、`test/recovery-authorize.test.js`、`test/history-epoch.test.js`。

**工作**

1. RecoveryService不依赖损坏的普通Store成功启动；从独立BackupPolicy/manifest、owner指定来源和新空恢复目录建立最小恢复上下文，不要求旧instance.json可用，恢复时生成新instanceId/activationRevision。保全原件，校验可信来源、kind/schema/v3/configRevision/timeZone/摘要/完整ledger，在新空目录恢复只读。无有效点或关键键/归档缺失拒绝完整恢复，不能自动置空索引；媒体缺失标unavailable/ready=false。
2. 保留workspace/稳定账号/业务键，创建目标新instance及新historyEpoch，记录parent恢复点；旧分支只读，事件游标/归档/checkpoint带epoch。旧Task/outbox/审批/权限/路径/票据默认hold或待核验，不因恢复文件成功而开放派发。
3. RecoveryCase记录可信cut至实际旧写者隔离之间的uncertaintyRange，不能确认则右边界open。RecoveryHold固定{id,caseId,kind,scope,scopeKey,revision,status,evidenceRefs,createdAt,releasedAt,releaseDecisionRef}，UnknownExposure固定{id,caseId,scope,currency,maxMinor|null,source,operationRefs,evidenceRefs,status,revision,createdAt,resolvedAt}，maxMinor=null表示无法封顶且相关预算禁止新付费。scope按SPEC §27.5 JCS规范化并做覆盖/组合矩阵；备份中的reserved无dispatchAt、queued或未消费审批可能在cut后执行，不能套用普通重启cancelled/not_sent。未知动作/金额不能靠新请求/换Cookie/新预算窗口消除。
4. RecoveryEvidence记录来源hash、范围、主体、原task/operation/businessKey及结论。普通事件摘要不是完整WAL；原Operation存在则核查更新，缺原ID时只记独立recoveredFact，不伪造历史参数/成功/未发；无法恢复业务键则保留目标或更大scope冻结。冲突和旧epoch迟到记录进入证据区，不能自动当新执行回调。
5. recovery authorize与migration activate分离。先核验旧源、可能迁移目标/执行器及票据/凭据已持久隔离；失联/PID消失/租约超时不够。无release时可审查owner提供的停机/存储隔离/旧会话或凭据撤销等外部证据，插件不自动撤销秘密或关机；证据不足只读。
6. 每scope解冻前核查缺口、保守修复键/预算、重验身份/素材/依赖，并建立修复副本的新独立verified点。管理路径允许仍禁派发的已校验副本先备份，避免先解冻才能备份的循环；新点保留父历史/case/holds，不能用新cut洗白旧缺口。
7. 人类批准scope与证据revision；recovery.json是case决定/revision唯一权威，目标state.recovery和instance.allowedCapabilities只是投影。按SPEC §27.7两阶段顺序写入prepared决定→同revision账本摘要→committed决定，最后才写instance开放能力；任一文件缺失或revision不一致按更严格门禁，重启可续办但未完成最后一步绝不派发。重复请求幂等，不自动resume旧Task/outbox/审批。新冲突证据立即再冻结；普通config/resume/resolve/激活不能覆盖hold。
8. 将事实修复、只读数据可用、外部派发解冻分别报告。与未知历史无关的新免费本地工作可单独授权，不代表全账号可外发；没有证据的scope可长期阻塞，不设绕过核查的force开关。

**先写失败测试与验收**：FR-DR-005～009及§19.5。以10:00cut、10:05已发、10:06丢账验证缺记录不能重发；reserved之后执行、unknown费用、原ID丢失、仅日记摘要、伪确认、冲突回执均保留恰当冻结。覆盖workspace/account.action/provider.budget/bot.conversation的scope包含、交集、通配、父hold与部分解冻矩阵，以及unknownExposure=null封顶拒绝；新epoch、新requestId、换Cookie均不得绕过。新epoch同裸seq不覆盖旧归档，旧权限/nonce/票据不复活。无旧写者隔离不得写；可靠隔离＋完整scope核查后可仅开该scope，其余继续hold。逐一注入recovery.json prepared/committed、state摘要和instance能力各写入断电点，证明revision不一致fail-closed、可幂等续办且最后一步前零派发；新恢复点仍携历史缺口。正常迁移保留epoch的组合验收在T18/T22，不让T21反向依赖迁移。

### T10：Coordinator、惰性 DSH/CLI 与主体权限【PENDING】

**依赖**：基础接线为 T05、T06、T07、T08、T09、T14、T16.1、T17.2 和 T18 正向部分，可先使用隔离的备份/恢复门禁替身；完整门禁接线与 T10 DONE 另需 T20、T21 和 T18 完整验收。T22/T19/T11 使用完整 T10，不得提前把基础接线标为完成。

**目标文件**：`src/coordinator.js`、`src/index.js`、`src/adapters/registry.js`、`cli.mjs`；静态核验对象 `cordis.patch.yml`；`test/coordinator.test.js`、`test/dsh.test.js`、`test/cli.test.js`。

**工作**

1. 唯一调度器、事务领用、执行单飞与待人工锁分离；默认只 Browse/Diary，评论/DM 按配置消费 Candidate。生产/发布独立命令，无默认自动串链；状态仅本插件 Task/Operation，不聚合全 DSH/桌宠会话。
2. start/stop 幂等，停止新派发但保留收尾，取消请求与实际终止分离；人工 resume 原 Task 新 attempt，核验 checkpoint/旧执行已停/unknown/最新权限配置审批。配置下轮生效且派发再查 revision。
3. 惰性挂载 HTTP/工具/CLI 到同一 CommandService；默认声明能力但不导入重 SDK、不 spawn/poll/探测媒体或 whoami。宿主缺服务不拖垮核心；真实 IM 模块仅在 T16.2 已验证后绑定。
4. SPEC §17 全路由/命令逐项注册与注销，主体/会话/scope 权限；HTTP 信任机制先验证，缺失拒绝写，1MB 限制与 400/403/404/409/429/501/503 映射，按 SPEC §18 36个稳定错误码建立“错误码/HTTP”双列表并逐条测试。test/dsh.test.js 静态断言 cordis.patch.yml 的 id=dsh-bili-unified、name=dsh-bili-unified、enabled=true、exports=dsh-bili-unified、HTTP前缀及禁用路径无重依赖/spawn。config PATCH 仅已知业务白名单，不能解 dryRun、强制审批或修改特权配置。
5. 模型工具可创建草稿/查询/取消，不能调用approve/complete/resolve/config/migration/backup/recovery。CLI平台写/生产/任务resume显式--dry或--go；diary支持--force重建，comments支持原任务/回复引用。敏感管理采用SPEC §22.1的宿主签名挑战或受控TTY＋OS会话核验＋一次性挑战，本机来源/--confirm不等于owner；机制不可用则真实go保持BLOCKED。仅受信本地人类入口提供补录、operation/outbox核查、绑定、导入，以及migration abort/disable-target/rollback和灾备命令。
6. 接入T20/T21的BackupPolicy、备份create/verify/status/planPrune/prune及recovery restore/inspect/reconcile/authorize。备份调度独立显式开关，不继承Browse开关；status只显示脱敏年龄/阶段/hold，不返回路径或明文证据。配置、激活、Operation核查及Task恢复全部复用门禁，缺服务默认拒绝受保护派发，不能把测试替身作为运行服务。
7. 验证失效主Store也可运行只读灾备管理；checkpointFence与迁移封存互斥/兼容按SPEC处理，数据可疑时不生成假健康点，已校验受限恢复副本仅管理路径可建立新点。将旧Task/outbox的恢复hold与新任务许可分离。

**先写失败测试与验收**：SPEC §16～18、FR-IM-001/003/004、FR-LITE-001/002。重复启停不重复定时器/路由；cordis.patch.yml静态断言和错误码/HTTP双列映射全覆盖；等待审批、IM 离线/通知 unknown 不阻断 Browse。所有入口三级 dry 真值表、越权/他人任务/秘密/路径访问拒绝；无损 JSON 输出、失败非 0 退出。模型不能借 CLI 非交互身份升级；TTY/宿主证明缺失时敏感go拒绝；取消晚于成功保留事实，进程未停不假取消。状态/配置验证零登录探测，无可选服务仍可只读账本；真实宿主不足按能力报告，不以 Mock 通过声称实际接入。

### T22：灾备集成、故障注入与隔离恢复演练【PENDING】

**依赖**：T20、T21、T18、T10。

**目标文件**：`test/disaster-recovery.integration.test.js`、`test/backup-coverage.test.js`、`test/recovery-gates.test.js`、`test/manual/disaster-recovery.acceptance.mjs`；发现的问题回到对应原模块修正，不新增远程服务。

**工作**

1. 将SPEC §19.5全部故障场景接到真实本地模块组合，外部平台/付费/IM仅用Mock。不同根目录和instanceId模拟损坏源、可信备份和恢复目标，保全源文件，不能破坏真实用户数据。
2. 注入快照cut、日记/Artifact提交、复制/flush、索引发布、prune、恢复导入、事实核查和授权落盘各阶段故障；区分普通重启、正常迁移和灾备新epoch，验证全部派发入口无旁路。逐一覆盖新requestId、换Cookie、新historyEpoch、备份protected/readonly/reconciling/restricted/released/blocked阶段、outbox送达查询失败及恢复授权三记录各写入断电点，均不得绕过冻结。
3. 覆盖只有旧ledger/最后full、媒体缺失、多个新ledger、独立目的地不可用、恢复点超龄、未知费用、原Operation丢失、冲突证据、旧权限/nonce/票据以及旧写者无法隔离。restore成功不等于authorize成功，未决scope不能用新backup cut洗白。
4. 演练只读账本恢复及分scope核查/解冻，验证备份记录、引用字节、永久键/额度、epoch分支和恢复holds；旧Task/outbox零自动重放，迟到冲突再冻结。
5. 记录cut年龄、账本及必需归档字节、只读耗时、媒体覆盖、未解冻scope、最后ledger/full保护以及实际工具/介质条件。15分钟账本间隔/20分钟最大年龄/24小时媒体是设计目标；60分钟只读RTO仅按SPEC §27.1的100MiB条件评估，80/100MiB容量边界分别触发预警/停新，写入RTO由证据决定。

**先写失败测试与验收**：FR-DR-001～010及SPEC §19.5逐条通过，特别是10:00备份、10:05已发、10:06丢账不能重复外发；reserved无dispatchAt不能推定未发，数据缺口不能被事件摘要或裸seq掩盖。实模块在临时目录的恢复演练必需，单纯create/verify或Mock BackupService不能替代；真实物理磁盘损坏、独立故障域及跨OS未测须单列，不用模拟结果冒充。恢复许可故障窗口保持fail-closed，最后有效full不被ledger淘汰。全部以隔离样本运行，不自动撤销真实凭据、关机或发消息。

### T19：轻量、显式依赖预检与跨模块验收【PENDING】

**依赖**：T10、T22。

**目标文件**：`src/adapters/registry.js`、`src/config.js`、`package.json`（获批后同步检查脚本，不在本轮改动）；`test/lite-loading.test.js`、`test/dependency-preflight.test.js`、`test/integration.test.js`、`test/safety-matrix.test.js`。

**工作**：为完整链路建立副作用矩阵与离线回归；隔离无媒体工具/IM SDK/B 站 Cookie/Agent Key 的启动环境，跟踪模块加载、fetch/http、spawn/execFile、timer/poll。显式 profile 预检只检查配置程序/版本/权限，禁用路径零探测；可选组件失败仅影响自身。记录长期归档/永久索引/素材容量及积压，验证80MiB预警、100MiB停新和永久引用保留，不能用“轻量”掩盖磁盘增长；获批后同步 package.json 的版本与全源码语法/自动测试/覆盖率脚本（当前version=0.1.0及旧检查脚本是已知草案待办），不引入服务编排。

**先写失败测试与验收**：FR-LITE-001～004、SPEC §19.2全部19条集成场景，以及T22覆盖的§19.5灾备矩阵。额外断言未配置备份策略时零备份调度/目的地扫描，受保护派发明确拒绝但诊断与无关免费本地工作不被误称平台不可用；独立BackupPolicy不混入普通业务配置。

- 默认核心/`status`/`config validate`：重 SDK import、网络、媒体进程、轮询均为 0；capabilities 为声明/cached/unverified。显式 remote/X/抖音返回不支持，不切本地/B 站。
- Browse→原 Task 审批→DM/评论事实→scope 日记；unknown 核查和 >2000 事件归档一致；所有外发均有禁用/dry/权限/重复/unknown/迁移冻结断言。
- workspace 独立生产（Mock）→Artifact→独立投稿审批，发布失败/通知失败不重跑生产；已有视频直接投稿、付费恢复累计预算、取消/迟到回执不伪造终态。
- IM 接纳与 outbox 同事务、撤权后查/批/发均拒绝，群聊隐私；真实宿主与发送状态另引用 T16.2/T12.1，不通过 Mock 解除阻塞。
- 双根迁移在所有模块有未决状态时保留最新账本/素材/消息索引，禁旧任务/通知重投；禁用组件收尾落账无孤儿继续派发。
- 本项自动回归使用 Mock 媒体；生产完成证据必须另引用 T17.3 真实 MP4/封面，不能替代该门槛。

### T11：全量测试与代码审查【PENDING】

**依赖**：T19、T22、T17.3。

**目标文件**：所有目标源码/测试；`package.json` 的 check/test/test:coverage；审查结论在 T13 交付记录中汇总。

**工作**：按第 5 节检查全部 `.js/.mjs/.cjs`，包含嵌套适配器、Runner、profile、CLI 和测试辅助器；执行所有离线自动测试/覆盖率，复核新增 FR、每种副作用/文件/进程入口、账本恢复、权限和隐私。逐项核对T02～T10及T14～T22（含子项）的证据，新增52条FR映射（含灾备FR-DR-001～010）、v3/epoch、备份保护和分scope恢复均不能遗漏；安排独立只读代码审查，修复高优先级问题后重跑。§9记忆规划尚未并入本基线，不把草案视作已实现能力。

**验收**：自动测试全部通过、无未处理rejection、无真实服务调用或真实用户目录写入，不用skip掩盖未完成。T17.3真实媒体与T22真实本地模块的隔离灾备演练均为必需；工具不足仅单列已完成离线结果，不能关闭完整T11门槛。IM契约必需，T16.2/T12.1可有明确外部BLOCKED，但必须进入交付矩阵。区分备份文件verify、只读数据恢复和外发解冻，不把任一阶段冒充灾备全恢复；真实故障域/介质/跨OS与真实平台另外列明。T11须以T19/T22/T17.3等全部明示验收为前提，任何单项结束都不代表全量完成。

### T12：真实宿主/平台分项人工验收【BLOCKED，外部条件与授权未满足】

**依赖**：T12.1、T12.2、T12.3。

**目标文件**：下列显式人工验收程序；输出仅进入隔离测试目录和交付记录，不自动清理外发内容。

**工作/验收**：分别报告每项证据与条件。真实 B 站写入可不授权、真实跨 OS 可缺环境，但必须如实未实测；真实 IM 是桥接能力的完成门槛。**本地真实视频不是本项可选测试，归 T17.3 必需。**

#### T12.1：真实 IM 入站、人工审批/拒绝与回信【BLOCKED】

**依赖**：T11、T16.2；另需用户对测试会话/主体/消息/回信范围的单独授权。

**目标文件**：`test/manual/im.acceptance.mjs`；必要修正回到 `src/adapters/channels/dsh-im.js` 并重跑 T16.1/T19/T11。

**工作**：先在受控测试环境配置经owner核验的独立备份目的地，建立有效且未超龄恢复点，确认无匹配RecoveryHold；无条件则保持发送阻塞，不能因是测试或dryRun绕过IM保护。随后在已只读验证宿主上绑定测试主体/会话，走授权消息→持久草稿Task→真实人类批准或拒绝→状态回信，优先不产生平台写或付费。验证重投、撤权、生命周期及实际回执，记录脱敏event/Task/notification ID。

**验收**：FR-IM-008。必须有真实入站、人类来源、原 Task 决策和授权状态回信证据；审批 fail-closed 的负例也留证。无授权不发消息，标未实测；无宿主/人类证明标 BLOCKED。契约 Mock、只读探测、HTTP 自造 envelope 都不能替代本项，未通过不得称真实 IM 全功能完成。

#### T12.2：真实 B 站/External 发布验收（可选授权）【BLOCKED】

**依赖**：T11、T03、T09；另需用户明确授权账号、内容、动作、额度和发布器执行范围。

**目标文件**：`test/manual/bilibili.acceptance.mjs`、`test/manual/publisher.acceptance.mjs`。

**工作**：config validate→显式account verify/whoami→只读Browse→评论/审批/白名单DM干跑→Manual Bundle。真实平台写入前还须建立owner核验的独立有效恢复点并确认无匹配RecoveryHold；缺保护条件不得用测试配置或go绕过。真实评论/DM、External投稿逐动作再授权，一次一条最低额度，记录备份cut与操作回执，不批量外发。

**验收**：记录真实回执/verification 与接口差异；Manual 断言和 publisher_receipt 不称平台读回，Bundle 不称已发布，超时不重试。未授权保持未实测，不削弱 T11 自动安全验收；外发内容保留/删除由用户决定，不自动清理。

#### T12.3：真实 Windows/Linux 停机搬迁（环境条件项）【BLOCKED】

**依赖**：T11、T18；另需两系统、受控测试目录和本地人类交接条件。

**目标文件**：`test/manual/migration.acceptance.mjs`。

**工作**：以两系统不同instanceId和v3测试账本执行prepare/release/import/validate/activate，重绑工具/路径/秘密；正常迁移保持historyEpoch、业务键/额度/unknown及RecoveryHold，备份kind不能获取迁移许可。验证产物后以最新账本反向交接，不请求平台写或真实IM发送。需要测试灾备时单独经T21/T22产生新epoch和只读副本，不能混称计划内迁移。

**验收**：记录系统/路径/工具差异及票据，源重启仍禁写，旧Task/outbox不重放，正常迁移不解除既有恢复hold。缺两系统则明确“路径/双目录模拟通过，真实跨OS未实测”；两个本地目录也不证明独立物理故障域或真实磁盘损坏恢复。

### T13：分项交付说明【PENDING】

**依赖**：T11、T12.1、T12.2、T12.3、T22。每个分项必须已有明确 PASS 或带原因/证据的 BLOCKED/未实测记录后才可汇总；外部真实项 BLOCKED 不阻止 T13 完成受限交付说明，但禁止宣称全功能交付，也不是免除 T17.3 的替代条件。

**目标文件**：获批后的 `TASKS.md` 状态/矩阵与现有 `DESIGN.md`、`SPEC.md` 中需要同步的实际限制；不另建未获要求的报告文件。

**工作**：汇总轻核心/B站/审批CLI/Artifact/IM契约与真实桥接/真实生产/停机迁移/可信备份/只读灾备与scope解冻，以及平台remote预留的实现、依赖、配置顺序、测试证据和限制。独立BackupPolicy默认未配置、保护未就绪禁止受保护派发须写入启用说明；列明旧自动化停用要求，不提供旧账本升级器。

**验收**：52条新增FR和原功能全部追踪，包含T14～T22、T17.3、T16.2/T12.1。真实视频与IM闭环各有实际证据，T22隔离恢复演练必需；分别列verified备份、restoreTested、真实故障域/RPO/RTO及未解冻scope，不能把create成功当灾备完成。原生UPOS/商业生成/X/抖音/remote只按实际范围报告。§9记忆规划单独列待审核，不计已实现；任何必需能力BLOCKED/未实测不得宣称完整交付。

## 4. 功能与规范验收矩阵

### 4.1 能力分项

| 能力 | 工作项 | 必需代码/安全验收 | 真实证据与当前口径 | 默认状态 |
|---|---|---|---|---|
| 稳定身份/账本/Task | T02、T14 | 同 MID 轮换、workspace、永久键、partial 未结算、归档恢复 | 未实施 | 仅轻核心查询，不探测登录 |
| 自主浏览 | T03、T05、T10 | 账号/内容去重、失败隔离、只读限流 | T12.2 可选；未实测 | 关闭 |
| 评论/白名单 DM | T06、T07 | 统一审批/策略、额度、目标/正文键、unknown | T12.2 单独授权；未实测 | 关闭，评论审批、空白名单 |
| scope 日记 | T08 | >2000 事实、版本/双阶段恢复、隐私 | 本地临时目录必测；未实施 | 关闭 |
| Artifact | T15 | 不可变 hash/ACL、链接越界/恢复、实际字节 | 本地导入必测；未实施 | 外部导入白名单为空 |
| 本地执行/独立生产 | T17.1～T17.3 | 固定阶段、dry、审批、预算、取消/序号/验证 | 真实 MP4＋封面必需，当前 BLOCKED | production/allowLocalProducer 关闭、dry、付费上限 0 |
| 独立投稿 | T09 | Artifact/原 Task 审批、Manual 断言、External 原 Operation resolve | External T12.2 单独验证；未实测 | 关闭、Manual、dry、禁止 auto |
| IM 契约/outbox | T14、T16.1 | 主体会话 ACL、防重/冲突、挑战、可靠通知 | Mock 仅契约；未实施 | 关闭、空授权、通知关闭 |
| 真实 dsh-im | T16.2、T12.1 | 只读能力/身份核验后薄绑定 | 真实消息/批准或拒绝/回信；BLOCKED | unavailable，不能 Mock 冒充 |
| 停机迁移 | T18 | v3与epoch、完整账本、恢复hold保留、幂等激活和最新账本回滚 | 双根实例必测；跨OS T12.3未实测 | offline，不自动派发旧记录 |
| 可信分层备份 | T20、T22 | 一致cut、ledger/full、故障域与超龄保护、保留/清理引用闭合 | 隔离verify/恢复演练必需；物理介质未测单列 | 调度关闭、目的地无默认值，未保护禁受保护派发 |
| 灾备与证据解冻 | T21、T22 | 新epoch/只读、未知区间、旧写者隔离、分scope授权、断电幂等 | 临时目录故障注入必需，RPO/RTO为待测目标 | 旧任务/权限/通知hold，不自动恢复外发 |
| 记忆连续性规划 | §9、GATE-MEM | 事实来源、偏好确认、经验适用性、版本/纠错、遗忘和灾备过滤 | 仅待审核建议，未写入主规范/未实施 | 不启用自动学习，不长期保存完整对话 |
| 平台/remote 预留 | T14、T17.1、T19 | 无 BV 强依赖、服务隔离、不支持明确拒绝 | 只契约 Mock，非正式能力 | 不可启用，无 SDK/网络 worker |
| 轻量/入口 | T10、T19、T11 | 零重依赖/进程/轮询/探测、按主体查询与取消 | 离线仪表测试必测；未实施 | 仅本插件状态 |

### 4.2 原规范与新增 FR 的逐条映射

原 SPEC 全部章节的归属如下；§3.3 的 Cordis 挂载由 T10 静态核验，§18 错误码由 T02 构造、T10 映射，§22 全章由 T14/T16.1/T16.2/T10/T12.1 分段承接，不能再以“§21～26”笼统跳过：

| SPEC 章节 | 工作项与边界 |
|---|---|
| §1～2 | T01/T14：范围、术语与公共定义；不代表实现完成 |
| §3 | T10/T19：包/运行要求；§3.3 由 T10 核验 cordis.patch.yml |
| §4～7 | T02/T03/T04/T14：配置、凭据、Store、限流/Operation |
| §8～9 | T03/T04：B 站协议与可选 Agent |
| §10 | T02/T14/T10：Task 状态机、结算与恢复 |
| §11～15 | T05/T06/T07/T08/T09：Browse/评论/DM/日记/发布 |
| §16～18 | T10/T02：Coordinator、入口及全部稳定错误码 |
| §19 | T11/T12/T17.3/T19/T22：分层测试与真实/灾备验收 |
| §20 | GATE-0/T01：审核门 |
| §21 | T14/T02/T03/T19：公共、平台与规范化散列契约 |
| §22 | T14/T16.1/T16.2/T10/T12.1：身份、审批、通知及真实桥接 |
| §23 | T15：ArtifactStore |
| §24 | T17.1/T17.2/T17.3/T04/T14：Execution、生产与付费预算 |
| §25 | T18/T12.3：迁移协议与真实跨 OS 验收 |
| §26 | T10/T19：轻量加载及分项交付边界 |
| §27 | T20/T21/T22，以及接入门禁的 T14/T16.1/T17/T18/T19 |

各工作项验收必须追溯这些段落，不因下表只列新增 FR 而删减旧要求。下表覆盖 52 条新增 FR（42 条原新增＋10 条 FR-DR），逐条不得缺项。

| 新增需求 | SPEC § | 工作项 | 可操作验收（除真实项外均先写失败测试） |
|---|---|---|---|
| FR-EXT-001 | §21.1 | T14、T02 | 未知 schema/动作/安全字段拒绝；inputHash 覆盖素材/规格/版本/费用，改参失效审批 |
| FR-EXT-002 | §21.1 | T14 | 同作用域 requestId 并发仅一 Task，同 hash 幂等/异 hash 冲突；accepted 不早于落账，新请求不绕业务键 |
| FR-EXT-003 | §21.2 | T14、T03、T19 | 能力逐项声明，B 站 dm.receive=false；X/抖音未注册，调用不支持，不要求公共 BV |
| FR-EXT-004 | §21.2 | T02、T03、T14 | 凭据/永久键/额度/熔断按服务和稳定账号隔离，Mock 替换平台不得得到 B 站 Cookie |
| FR-IM-001 | §22.1 | T14、T16.1、T10 | 可信 envelope＋本地绑定推导主体；body/Agent/群成员伪造拒绝，撤权/错会话/越 scope 拒绝 |
| FR-IM-002 | §22.2 | T16.1、T18 | 四元消息键同参原 Task、异参冲突；过期/未来时间拒绝，缺 eventId 只读；有效/未决索引迁移保留 |
| FR-IM-003 | §22.2 | T16.1、T10 | 仅草稿/干跑、自有任务查/取消、可信挑战；自然语言不能直接 go，敏感管理/补录/resolve 不可达 |
| FR-IM-004 | §22.2 | T14、T06、T09、T17.2 | 原 Task 审批回流；同决定幂等/冲突拒绝，过期/改参/撤权/迁机拒绝，dry 不消费 go，生产不批准发布 |
| FR-IM-005 | §22.3 | T02、T16.1、T19 | Task/事件/outbox 崩溃同事务；发前重鉴权/限流，未知送达不盲重发、不重跑业务，待办独立保留 |
| FR-IM-006 | §22.3 | T16.1、T19 | 群聊 summary/none，产物只 artifactId；脚本/日记/路径/秘密/未经授权附件不出站 |
| FR-IM-007 | §22.3 | T16.2 | 先只读核验真实宿主来源/生命周期/ID/回执/人类证明，缺失 unavailable/BLOCKED，不安装聊天 SDK |
| FR-IM-008 | §22.3 | T12.1、T13 | 单独授权真实入站→草稿→人类审批/拒绝→状态回信，Mock/只读探测均不能替代；缺条件不全功能完成 |
| FR-ART-001 | §23 | T15 | 七类素材角色、稳定 ArtifactRef，授权源目录普通文件流式 hash/复制，拒绝链接/超限，源不删除 |
| FR-ART-002 | §23 | T15、T10、T16.1 | artifactId 无目录能力；跨 scope/未授权共享拒绝，Runner 仅核心临时目录 |
| FR-ART-003 | §23 | T15、T17.2 | 伪输出清单不能成功；核心独立核文件/媒体/hash 后提交，不可就地改定稿 |
| FR-ART-004 | §23 | T09、T15 | 批准后替换视频/封面被派发前复核拒绝，调用参数不能扩目录授权 |
| FR-ART-005 | §23 | T15、T18 | 相对路径导出实际字节；绝对/越界/跨平台碰撞/链接/额外或缺文件失败 |
| FR-ART-006 | §23 | T15、T18 | pendingImport全字段、realPath/权限复核及rename/索引各崩溃点恢复；封存前清完提交意图 |
| FR-PRO-001 | §24.1 | T17.2、T17.3 | 无 Cookie/Browse/IM/付费服务独立生产真实 MP4/封面；固定阶段合法无配音，Bundle 不通过 |
| FR-PRO-002 | §24.1 | T17.2 | 受信 profile 绑定工具/版本/阶段输入输出；请求 command/args/env、缺脚本/素材及越界规格拒绝 |
| FR-PRO-003 | §24.1 | T17.2、T19 | enabled/allowLocalProducer/人类批准/预检必需；三级 dry 否决，零 spawn/Provider/ready |
| FR-PRO-004 | §24.2 | T17.1 | executionId/attempt/seq、stageRequest 身份/输入绑定；不可变尝试及resume新ID，冲突/乱序/旧 attempt 不推进 |
| FR-PRO-005 | §24.2 | T17.1 | 固定 Runner/无 shell/环境白名单、有界 JSONL/总输出、并发 1；重复 submit 和 spawn 窗口崩溃不盲重开 |
| FR-PRO-006 | §24.3 | T14、T04、T17.2 | 付费先 Operation＋可封顶预算；零预算/无上限拒绝，unknown/resume 累计费用不重置，免费渲染只 Execution |
| FR-PRO-007 | §24.3 | T17.1、T17.2、T10 | cancel≠停止，成功先到保留；未知未结算，旧进程未停禁止 resume，费用不因取消回退 |
| FR-PRO-008 | §24.3 | T17.1、T17.2、T18 | checkpoint 绑定 stage/profile/inputHash/确认 seq/产物；仅持久验证阶段可复用，变更重审，无续帧承诺 |
| FR-PRO-009 | §24.4 | T17.2、T17.3、T09 | 实际媒体/封面/manifest 完整才 ready；partial/干跑均 readyForPublish=false，发布另建另批，失败不重跑生产 |
| FR-PRO-010 | §24.4 | T17.1、T19 | remote 明确 CAPABILITY_UNSUPPORTED，无端口/心跳/任务传输/素材同步服务，不回退 local |
| FR-MIG-001 | §25.1 | T18、T02 | 只兼容本插件 schema/state 版本，拒绝旧插件/未知版本；账本 phase 与 instance activation 双闸门 |
| FR-MIG-002 | §25.2 | T18、T19 | 健康恢复点/hold前置；prepare 冻结新 Task/导入/所有派发含 reserved/outbox，允许在途收尾 |
| FR-MIG-003 | §25.2 | T18 | 归档/日记/素材提交先恢复，export原子seal；一致快照与全部字节/hash，缺失/变动/超限失败 |
| FR-MIG-004 | §25.2 | T18 | 源持久 retired 后才交票据；重启禁写，相同绑定幂等、冲突拒绝 |
| FR-MIG-005 | §25.3 | T18 | 目标新空目录暂停，拒绝额外/越界/链接/碰撞；保留所有账本/素材/消息索引，不带秘密和旧许可 |
| FR-MIG-006 | §25.3 | T18、T19 | 重新绑定身份/秘密/目录/profile/宿主权限，核 MID 保留额度/unknown；未核验能力不开放 |
| FR-MIG-007 | §25.3 | T18 | 健康恢复点/hold、票据/migration/hash/target/人类确认匹配，先记决定后开闸；断电幂等 |
| FR-MIG-008 | §25.4 | T18、T19 | 导入旧挑战失效、Task hold/scheduler 关闭、旧 outbox 不重发，人工 resume 重校验/审批，unknown 先核查 |
| FR-MIG-009 | §25.4 | T18 | abort/disable-target/rollback状态闭环；从目标当前账本反向交接，原快照/config解retired拒绝 |
| FR-MIG-010 | §25.4 | T18、T12.3 | 双 instance/双根目录验证禁写/账本/素材/路径；跨 OS 未测明确标记，不以重启冒充 |
| FR-LITE-001 | §26 | T10、T19 | 默认/状态查询零重依赖 import、spawn、轮询、whoami；cached/unverified 能力只读 |
| FR-LITE-002 | §26 | T17.2、T19 | 缺可选组件仅自身不可用，显式生产预检才查工具；禁用后无新调度，收尾/孤儿不丢账 |
| FR-LITE-003 | §26 | T19、T18 | 无消息中间件/微服务/远程调度，按需本地进程；暴露归档/永久索引容量与积压 |
| FR-LITE-004 | §26 | T11、T13 | 核心/B站/IM契约与真实桥接/生产/迁移分别报告；真实媒体必需，Mock 与 BLOCKED 不计全功能完成 |
| FR-DR-001 | §27.1 | T20、T02 | `kind=backup` 不等于迁移票据、恢复导入不授予派发权；无有效点只残存证据并报 RECOVERY_REQUIRED，拒绝空账本伪装恢复 |
| FR-DR-002 | §27.1 | T14、T20、T22 | 每次真实平台写/External/付费/IM发送均须独立故障域＋未超龄有效点＋无hold；各入口零受保护派发，在途回执仍落账 |
| FR-DR-003 | §27.2 | T20、T15、T08、T17.1 | 短暂 checkpointFence 同界捕获账本/键/额度/outbox/引用清单；大媒体事务外复制，失败不成新点、不遗留永久栅栏 |
| FR-DR-004 | §27.3 | T20 | manifest/configRevision/timeZone齐备，JCS-SHA256金标准；排除秘密/nonce/写者票据，ledger缺媒体标unavailable，full缺对象失败 |
| FR-DR-005 | §27.4 | T21、T02 | 独立只读恢复入新空目录，保workspace/稳定账号并开新historyEpoch；阶段映射一致，旧审批/通知/scheduler关闭 |
| FR-DR-006 | §27.5 | T21、T22 | 记录不确定区间；结构化scope与unknownExposure匹配，改Cookie、新requestId、新epoch不清除风险 |
| FR-DR-007 | §27.5 | T21、T14 | 证据须覆盖范围方可修复；缺原ID只写recoveredFact；not_sent需证明未执行，裸seq或修改时间不采信 |
| FR-DR-008 | §27.6 | T21、T22 | authorize≠migration activate；外部隔离证据＋分scope人类确认，无force开关，迟到冲突立即重冻 |
| FR-DR-009 | §27.7 | T21、T20 | RecoveryCase字段/phase完整；recovery.json两阶段决定→state→committed→instance，任一断电点fail-closed |
| FR-DR-010 | §27.8 | T22、T19 | §19.5逐条通过并报告年龄/只读耗时/缺口；create/verify不等于演练，各派发入口同闸 |

表中 FR-PRO-009 的“partial/dry”均要求 `readyForPublish=false`；任何 Task 的成功显示不替代真实媒体验证或平台发布回执。FR-DR 各行的自动验收只在隔离临时目录与注入样本上运行，不请求真实网络、凭据撤销、远程关机或外发；RPO/RTO 是待测设计目标，未经演练不得称 SLA。

#### T19 场景追溯表

| 场景 | FR / SPEC | 必须通过的可判定证据 |
|---|---|---|
| T19-01 默认加载 | FR-LITE-001 / §26 | 无重依赖、网络、spawn、轮询；能力只读 |
| T19-02 禁用/缺依赖 | FR-LITE-002 / §26 | 仅目标能力unavailable，核心查询可用 |
| T19-03 B站缺密钥 | FR-EXT-001/004、FR-ART-001、FR-LITE-001 | 结构化缺凭据/能力错误，其他本地能力可用 |
| T19-04 越权文件 | FR-ART-002、FR-EXT-004 | 目录穿越/链接/跨scope均拒绝，无字节外泄 |
| T19-05 未注册工具 | FR-PRO-002/005、FR-LITE-002 | 预检BLOCKED，零spawn，核心仍可查 |
| T19-06 三级dry | FR-PRO-003 / §4.6 | 全真值表通过，零工具/付费/ready |
| T19-07 预留未启用 | FR-EXT-003、FR-PRO-010、FR-LITE-002 | 明确CAPABILITY_UNSUPPORTED，不回退/注册 |
| T19-08 缺运行工具 | FR-PRO-002、FR-LITE-002 | 工具缺失只阻塞生产，无隐式安装/探测 |
| T19-09 禁用仍探测 | FR-PRO-002、FR-LITE-002 | 禁用路径无ffmpeg/ffprobe调用 |
| T19-10 参数/输出边界 | FR-PRO-005 / §24.2 | 无shell注入，JSONL/总输出限长且可收尾 |
| T19-11 dry跳过输入 | FR-PRO-003 / §24.1 | 缺输入仍明确阻断，不能借dry伪造ready |
| T19-12 禁用仍可预检 | FR-EXT-003、FR-PRO-001～003 | 只读预检不启用、不执行、不扩大权限 |
| T19-13 无B站生产 | FR-PRO-001/004 | 无Cookie可建生产Task，执行身份/输入绑定 |
| T19-14 无宿主通知 | FR-IM-005/007 | outbox独立未决，不重跑业务、不冒充送达 |
| T19-15 越权go | FR-IM-003/004 | Agent/正文批准/旧挑战均拒绝 |
| T19-16 重复付费 | FR-PRO-006、FR-DR-002/006 | 原Operation/预算占用防重，unknown不重置 |
| T19-17 迁移空目录 | FR-MIG-005/008、FR-LITE-002 | 目标暂停导入，不覆盖，旧任务不自动重放 |
| T19-18 正常迁移 | FR-MIG-001/006/007/008 | epoch/键/额度连续，重绑后才按能力激活 |
| T19-19 灾备重置 | FR-DR-002/006/009、FR-LITE-001 | 新epoch/请求不洗白hold，恢复不自动外发 |

#### T22 场景追溯表

| 场景 | FR / SPEC | 必须通过的可判定证据 |
|---|---|---|
| T22-01 损坏恢复 | FR-DR-001/005 / §27.1/27.4 | 原件保全、只读新目录，不初始化空账本 |
| T22-02 保护派发 | FR-DR-002 / §27.1 | 无点/超龄/hold零新派发，在途回执可落账 |
| T22-03 一致快照 | FR-DR-003 / §27.2 | cut同界、epoch/configRevision/timeZone完整 |
| T22-04 提交/引用故障 | FR-DR-003 / §27.2 | 崩溃可收尾，引用固定，无永久栅栏/半有效点 |
| T22-05 账本恢复材料 | FR-DR-004 / §27.3 | 完整账本/键/归档可恢复，媒体覆盖如实标注 |
| T22-06 恢复源一致 | FR-DR-003 / §27.2 | sourceStateHash/snapshotHash及文件字节一致 |
| T22-07 媒体覆盖/保留 | FR-DR-004 / §27.3 | ledger/full语义正确，最后有效full不被淘汰 |
| T22-08 包外恢复/哈希 | FR-DR-004/010 | 便携full闭合，路径/哈希/缺对象失败可检测 |
| T22-09 主库丢失重建 | FR-DR-001/005 / §27.1/27.4 | 新instance/epoch和父恢复点完整，旧事实不伪造 |
| T22-10 冻结生命周期 | FR-DR-005/006/009 | scope组合、授权两阶段、冲突再冻结均fail-closed |
| T22-11 证据核查 | FR-DR-007 / §27.5 | 原Operation或recoveredFact唯一，冲突/not_sent证据受控 |
| T22-12 旧写者隔离 | FR-DR-008 / §27.6 | 失联/PID/租约不足，外部隔离证据齐全才可解冻 |
| T22-13 分scope解冻 | FR-DR-008/009 | 仅授权scope放行，其余hold及旧任务继续冻结 |
| T22-14 零重放 | FR-DR-002/010 / §27.8 | 新request/Cookie/epoch及所有入口均不能重复外发 |

## 5. 测试命令与证据（获批实施后使用，当前未执行）

以下为 Git Bash/Node 22 命令设计。T19 须实现对应包脚本后才能称可用。所有自动测试默认拒绝真实网络/付费服务和真实用户目录写入；人工程序使用 `.acceptance.mjs`，不混入 `.test.js/.test.mjs` 自动发现，也不能以 skip 充当验收通过。

### 5.1 全源码语法检查与离线自动测试

```bash
set -e
node --check "D:/workbuddy_space/dsh-bili-unified/cli.mjs"
while IFS= read -r -d '' file; do
  node --check "$file"
done < <(find "D:/workbuddy_space/dsh-bili-unified/src" "D:/workbuddy_space/dsh-bili-unified/test" -type f \( -name '*.js' -o -name '*.mjs' -o -name '*.cjs' \) -print0)

mapfile -d '' test_files < <(find "D:/workbuddy_space/dsh-bili-unified/test" -type f \( -name '*.test.js' -o -name '*.test.mjs' \) -print0)
(( ${#test_files[@]} > 0 ))
node --test --test-reporter=spec "${test_files[@]}"
node --test --experimental-test-coverage --test-reporter=spec "${test_files[@]}"
```

目标包脚本等价执行全部递归源码/测试，不能仅入口 `node --check`，不能漏 nested adapters/production/runner/test helpers：

```bash
npm --prefix "D:/workbuddy_space/dsh-bili-unified" run check
npm --prefix "D:/workbuddy_space/dsh-bili-unified" test
npm --prefix "D:/workbuddy_space/dsh-bili-unified" run test:coverage
```

各项先跑指定文件，例如：

```bash
node --test --test-reporter=spec "D:/workbuddy_space/dsh-bili-unified/test/approval.test.js"
node --test --test-reporter=spec "D:/workbuddy_space/dsh-bili-unified/test/migration-crash.test.js"
```

### 5.2 真实本地媒体：独立、必需、非平台写测试

先通过可信本地管理流程配置测试 profile 的 ffmpeg/ffprobe **绝对路径**、版本范围、允许源目录/工作目录及人类审批；不得靠扫描 PATH、安装工具或单个环境标志代替生产授权。验收程序先检查该隔离配置，缺项直接失败并报告 BLOCKED，不产生 skip/pass；网络请求一律拒绝。

```bash
node --test --test-reporter=spec "D:/workbuddy_space/dsh-bili-unified/test/manual/local-production.acceptance.mjs"
```

期望证据：无 Cookie/商业 provider 环境、真实 MP4/封面、ffprobe/解码结果、带音轨字幕及合法无配音样本、manifest/hash、原生产 Task/审批/阶段结果。设置为必需的 T17.3 单独记录，普通 `npm test` 通过不自动代表本项通过。

### 5.3 备份与灾备：离线故障注入与隔离恢复演练

T20/T21/T22 的自动验收全部在隔离临时目录运行，以注入型 BackupService/Storage 触发栅栏超时、flush 失败、缺字节、摘要不符、满盘和断电；不访问真实网络、不撤销凭据、不关机、不发消息。真实物理介质、独立故障域与跨 OS 灾备未测须单列，不用模拟结果冒充演练通过。

```bash
node --test --test-reporter=spec "D:/workbuddy_space/dsh-bili-unified/test/backup-coverage.test.js"
node --test --test-reporter=spec "D:/workbuddy_space/dsh-bili-unified/test/recovery-gates.test.js"
node --test --test-reporter=spec "D:/workbuddy_space/dsh-bili-unified/test/disaster-recovery.integration.test.js"
node --test --test-reporter=spec "D:/workbuddy_space/dsh-bili-unified/test/manual/disaster-recovery.acceptance.mjs"
```

期望证据：实际恢复点年龄、checkpointFence 释放、ledger/full 覆盖差异、最后有效 full 的保留、只读恢复耗时、未解冻 scope 及 RecoveryHold 清单。仅 `backup create/verify` 成功不得称为恢复演练通过（FR-DR-010）。

### 5.4 真实外部项

T12 的三个分项不纳入自动命令；只读宿主探测不发送试探消息。收到具体环境和单独授权后才按目标人工程序执行并记录实际命令/回执。没有授权写“未实测”，没有能力写“BLOCKED”，不运行真实账号批量操作，不借测试安装 SDK、网络 worker 或付费服务。

## 6. 本期、预留与外部阻塞清单

### 本期必须有的实现与验收

- 轻核心、稳定身份/workspace、事务与完整事件归档、统一主体/审批/网关、全部原 B 站读写与日记/Task 安全要求。
- Artifact、独立 Local Runner、local-slideshow-v1 的真实 MP4/封面、可控取消/恢复/费用接口；生产不绑定 B 站登录或商业 provider，不自动发布。
- 独立 Artifact 发布、明确 Manual/External、可信本地人类 complete/resolve、unknown 原 Operation 核查。
- IM 契约/outbox、真实宿主能力探测及条件具备后的薄桥接；真实入站/授权人工审批或拒绝/回信是该接入完成门槛。
- 同插件兼容 schema 停机搬迁、最新完整账本/素材/消息索引、旧端退役/目标暂停/幂等激活/最新账本回滚；双根实例验证。
- 可信分层备份（一致恢复点、ledger/full、manifest 校验、按 tier 保留底线）、只读灾备恢复与证据分 scope 解冻，以及平台写/付费/生产/通知/迁移各入口共用同一恢复门禁。
- 所有新增 FR 的安全/轻量/跨模块测试、全源码语法检查和分项交付说明。

`BackupPolicy` 由 owner 管理并落在 `<dataDir>/backup-policy.json`，`config.example.json` 本轮未改、不含备份策略示例；策略文件与实际调度实现均属未来接线，本文档不声称其已存在。

### 仅契约/Mock 预留，不计真实能力

- remote ExecutionBackend、X/抖音 PlatformAdapter：明确不支持，不安装 SDK、不轮询、不监听端口、不实现跨机任务传输/接管。
- 生产文案 LLM、生图、TTS 商业 provider：可选接口与 Mock；不强制商业接入、默认付费上限 0，真实启用另行授权和成本封顶。

### 本期明确不做

- 原生 UPOS/archive submit、完整视频编辑器、内置 Whisper/通用抽帧理解。
- 旧插件配置/账本导入、0.1 草案账本自动升级、不兼容 schema 转换、在线热迁移、双端接管/多机共享 JSON。
- B 站收件箱/评论或 @ 自动监听、自研 QQ/微信 SDK、人格/桌宠/RVC/唱歌、全 DSH 状态聚合。
- 多账号群控、陌生人群发、刷量/绕风控、默认点赞投币关注、分布式调度和复杂 Web 设置 UI。
- 备份内置云 SDK、跨机实时双写、共识/分布式租约服务、恢复时自动撤销凭据或远程关机；物理故障域独立性只由 owner 核验声明记录。
- 长期记忆的自动学习、默认完整对话留存、跨账号/跨主体自动共享偏好，以及记忆写入授权或记忆绕过审批、额度与恢复门禁。

### 当前外部阻塞（不替代代码进度）

| 条件 | 受影响项 | 解除/报告规则 |
|---|---|---|
| 修订稿尚未批准 | 全部实施项 | 用户明确批准 GATE-0；方向已确认不用重选 |
| DSH 实际服务/消息/人类证明未核验 | T16.2、T12.1；实际 DSH 入口部分 | 先只读证据；缺失 fail-closed，不阻塞离线核心/本地生产 |
| 真实 IM 消息/回信未授权 | T12.1 | 单独批准测试会话/范围；未授权不发送、不称已完成 |
| 受信 ffmpeg/ffprobe、目录及执行授权未提供 | T17.3、生产完成门槛/T11 | 用户显式配置并实际生成验证 MP4/封面；仅该生产能力不可用，非真实 B 站授权事项 |
| B 站账号/动作授权与 External 接口未验证 | T12.2 | 只读先行、逐动作最低额度授权；未实测不能说平台写已验证 |
| 没有 Windows/Linux 两系统环境 | T12.3 | T18 双根/路径模拟仍必做，真实跨 OS 明确未实测 |
| owner 未确认独立故障域目的地与介质 | T20 保护门禁、T12.1/T12.2 前置、T13 | 离线备份与注入演练仍可实施；缺未超龄有效点时受保护派发保持 fail-closed，同盘多份不称独立故障域 |
| 真实介质损坏/异地恢复环境不可得 | T22 真实项、T13 | 隔离临时目录故障注入必做；RPO/RTO 只报实测值，物理损坏与跨 OS 恢复标未实测 |
| GATE-MEM 记忆规划未审核 | §9 全部 | 批准前不写入 DESIGN/SPEC、不实施、不扩 FR 基线、不升级账本 schema |
| 平台/宿主身份或本地人类证明不足 | 对应敏感入口及真实go | 不降格相信 body/--confirm/进程身份，不扩大权限；本地敏感管理/真实go不可用，但离线代码与替身测试可继续；保留不可用原因 |

## 7. D/R 审核映射与回复模板

D-01～D-18、R-01～R-13 沿用上一版；D-19/D-20 与 R-14/R-15 为本次灾备增补。§9 的记忆机制仍是待 GATE-MEM 审核的规划，尚未占用 D/R 编号，也不计入本轮 52 条 FR 基线。

| 决策 | 任务与审核重点 |
|---|---|
| D-01 / R-01 | T02/T14：统一轻核心，不拼接旧运行时 |
| D-02 / R-02 | T03/T14：Node 22、公共引用、可选 B 站协议 |
| D-03 / R-04 | T04/T06/T17：模型可选，无模板默认 auto，无商业依赖生产 |
| D-04 | T14/T19：权限/键/预算同事务，派发二次闸门 |
| D-05 | T02/T14/T09/T16.1/T17：unknown 不重试/不清理，不以取消当未执行 |
| D-06 / R-05 | T02/T08/T18：跨进程锁、归档/提交恢复、完整迁移 |
| D-07 / R-03 | T06/T10/T17/T19：默认关闭/三级 dry、人工审批与 auto policy 分开 |
| D-08 | T07：白名单/互关 DM，非收件箱/IM |
| D-09 | T08：scope、完整事实、双阶段提交与修订 |
| D-10 / R-06 | T09：生产/发布分离、Manual/External、不支持不降级 |
| D-11 / R-07 | T10/T16：惰性宿主/CLI、插件内任务，不做完整 UI |
| D-12 / R-08 | T13：接替前停旧平台自动化，不导入旧账本 |
| D-13 / R-09（含D-17/D-18公共契约） | T14/T19：四类独立契约、禁用零重依赖/进程/轮询/探测 |
| D-14 / R-10 | T15/T17/T11：真实 MP4/封面、独立执行、费用/取消/检查点 |
| D-15 / R-11 | T16/T12.1：先只读探测、可信人类、可靠通知与真实闭环 |
| D-16 / R-12 | T18/T12.3：已选停机迁移、源禁写、目标暂停、最新账本回滚 |
| D-17 / R-13（同时归入R-09） | T14/T17.1/T19：X/抖音/remote 只契约 Mock，不支持明确拒绝 |
| D-18 / R-09 | T02/T14/T19：MID/workspace、不可伪造审批、永久键与未决事实 |
| D-19 / R-14 | T20/T22：一致恢复点、ledger/full 分层、独立故障域与未保护/超龄停发 |
| D-20 / R-15 | T21/T22：只读新 epoch、不确定区间、旧写者隔离、分 scope 证据解冻且不自动重放 |

本次请求的是**修订稿批准**，不是再次选择已确认方向。可以只回复：

```text
GATE-0（0.2.1-draft）：批准 / 不批准 / 有条件批准
R-01～R-15 及 D-01～D-20：按修订基线确认；需要调整的编号与具体约束：
第 8 节跨文档表述对齐结果：
GATE-MEM（§9 记忆范围、更新与遗忘机制）：批准 / 不批准 / 有条件批准；批准前不写入主规范、不实施、不升级账本 schema
如有条件批准，允许执行的任务/子项及仍阻塞项：
真实 IM、真实平台写、本地工具执行授权、备份目的地与故障域核验：另行按各项范围确认，不随 GATE-0 自动授予。
```

## 8. 本轮一致性复核与已统一口径

第 1～6 条为首轮交叉审查后已同步到 DESIGN/SPEC/TASKS 的确定基线，第 7～11 条为灾备与记忆增补口径；以下均是实施和测试应遵守的确定基线，不是待实施者自行选择的分支，用户对修订稿的审核仍未完成。DESIGN 的状态行、引言与 §13/§14 尾注，以及 SPEC 的状态行、引言、§19 验收、§20 审核门尾注与 §27.8 已同步更正：TASKS 现为 0.2.1-draft，已映射账本 v3、FR-DR-001～010 与 T20～T22；示例配置及旧审查摘要未因此修改，代码仍未实施。本次仅消除文档状态与局部术语不一致，不解除 GATE-0 或 GATE-MEM。

1. **Manual账本时点**：待审批/待人工期间保留Publish/Task及pending业务索引，不伪造已派发Operation。仅不存在已派发/unknown操作的Manual任务，在本地人类complete时创建唯一manual_confirmation confirmed Operation；External核查只能更新原Operation。
2. **公共字段与身份**：AccountRef/ContentRef平台无关，aid/cid/tid使用platformData，WBI留在协议层；IM键包含adapterId/botAccountId/conversationId/eventId；scope日记采用SPEC §14的scopeKey路径。
3. **三类派发上下文**：平台写/付费使用OperationContext，免费本地阶段使用ExecutionDispatchContext，通知使用OutboxDispatchContext；共享权限/迁移栅栏但不重复建Operation，生产Runner不承接上传或平台凭据。
4. **按能力激活**：允许仅启用已核验的非平台能力，activation中须持久禁用未核验平台及其他组件；不把部分能力通过称为全量迁移成功，不自动恢复旧任务/通知。
5. **无回滚旁路**：source release后，即使目标尚未激活，也必须先持久禁用目标及旧票据，再以目标所持最新账本反向交接；拿不到状态/最新账本则阻塞，不从原快照便捷恢复源端。
6. **输出与完成证据**：免费本地视频须有实际可解码MP4及可读封面，不能用Bundle、进程退出或Mock替代；任务结算与通知送达分离，未决通知所依赖的最小归属/权限记录保留。
7. **备份与迁移票据分离**：`kind=backup` 只用于恢复，`kind=migration` 只用于交接派发权；备份包不含秘密、审批 nonce 与有效写者/迁移票据，恢复导入绝不直接授予派发权。
8. **保留底线按 tier**：最近/日/周保留集合之外，不得删除最后一个有效账本恢复点、最后一个有效 full 点、调查固定点或其他备份仍引用的对象；ledger 数量增长不能挤掉唯一完整媒体备份，`verify` 通过不等于 `restoreTested`。
9. **historyEpoch 语义**：正常停机迁移保持同一 epoch 与 seq 连续；灾备恢复创建新 epoch 并记录 `parent={backupId,sourceHistoryEpoch,cutEventSeq,snapshotHash}`，旧分支只读。跨 epoch 的裸 `seq` 不比较、不推断缺口。
10. **恢复门禁同闸**：RecoveryHold/未保护状态与迁移栅栏、dryRun、审批一起进入同一预留事务；普通 config、任务 resume、Operation resolve、迁移 activate 均不能覆盖，迟到冲突证据立即重冻该 scope。
11. **记忆仍是规划**：§9 的记忆分层、遗忘与恢复过滤未取得 GATE-MEM 批准，不占用 FR/D/R 编号、不改动账本 schema，也不构成任何实现或真实环境验证证据。

静态验收需确认23个主任务ID（T00～T22）及子项唯一、依赖无环、独立生产无B站/IM/商业服务依赖，新增52条FR（含 FR-DR-001～010）均逐条映射，备份/恢复入口不绕统一派发闸门。文档静态检查不等同代码测试或真实集成通过。

## 9. 记忆更新与连续性规划【待 GATE-MEM 审核，未实施、未回写主规范】

用户已选定记忆范围为“事实＋偏好＋经验”。本节只回答“这些记忆如何更新、如何组织，才能在纠错、换凭据、迁机和灾难恢复后仍连贯且有效”，不是实施许可，也不占用本轮 D/R/FR 编号。批准后须先回写 DESIGN/SPEC 并补齐新 FR 与任务映射，才建立实施项；当前不新增任务 ID（T00～T22 计数不变）、不升级账本 v3、不创建源码或策略文件。

### 9.1 分层与不变式

| 层 | 内容与权威 | 来源要求 | 默认可信度 |
|---|---|---|---|
| 事实 | 已发生的业务结果：读写回执、发布/生产结论、审批与额度事实 | 只能从 Task/Operation/Event/Receipt/Artifact 投影，账本为唯一权威 | 高，但不得成为第二权威；与账本冲突时以账本为准并记录差异 |
| 偏好 | 人类明确表达或确认的取向：语气、主题、时段、目标白名单倾向 | 受信本地人类入口或已核验 IM 主体的明确陈述，绑定主体与会话 | 仅在有效期内、按 scope 生效 |
| 经验 | 由多次事实推导的倾向性结论，含样本引用、反例与置信度 | 派生投影，必须标注推导输入与算法版本 | 低，默认只作提示，不得单独驱动外发、auto 策略或付费调用 |

不变式（任何一条被破坏即视为设计缺陷，不允许实现期自行放宽）：

1. **记忆不授权**：记忆条目永远不产生、替代或延长人工审批挑战，不绕过 dryRun、额度、迁移栅栏、`RecoveryHold` 与备份保护门禁（§8 第 10 条同闸）。
2. **不默认留存对话**：默认只保存最小可追溯条目，不保存完整对话原文；任何原文片段留存需 GATE-MEM 单独批准，并受私有/公开边界与脱敏规则约束。
3. **来源可回溯**：每条携带 `provenance`（来源类型、`eventId/operationId/taskId/artifactId` 引用、证据 hash、`historyEpoch`）；无来源的条目只能是 experience 且 `verification=unverified`，不参与对外输出。
4. **身份绑定稳定**：按 `workspaceId + platform + 核验 accountId` 与 IM `principal` 命名空间隔离，与 Cookie 摘要、机器路径、进程身份无关；同 MID 换凭据或迁机后条目连续，凭据核验失败 fail-closed 不切换命名空间。
5. **私有不外溢**：私人日记、私人偏好与 `private` 条目不进入群聊输出、公共日记或平台写正文，出站仍遵守 FR-IM-006 的 summary/none 规则。

### 9.2 条目结构与版本化

`MemoryEntry` 至少含：`id、kind(fact|preference|experience)、scope、subjectRefs、payload、provenance、confidence、verification(verified|unverified)、applicability、status(active|superseded|revoked|expired|disputed|revoked_unknown)、supersedes、revision、createdAt、validFrom、validUntil、lastConfirmedAt、historyEpoch、privacy、redactionState`。

- 变更只用 add/revise/supersede/revoke/tombstone 五种动作，禁止就地覆盖与“不断追加的摘要文本”；每次变更递增 `revision`、写 `supersedes` 链，保留历史版本供审计与回滚判断。`revise` 用于普通修订，`supersede` 指向替代条目，`revoke` 表示显式撤回，`tombstone` 表示遗忘/删除标记。
- `revoked_unknown` 只能由恢复核查在无法证明撤回集合完整时写入，表示隔离待核验，不是普通变更动作，也不等于已确认撤回；本地人类重新核验后才能通过 `revise/revoke/tombstone` 转为其他状态。
- 写入与相关事件、审计在同一事务内提交；带 `expectedRevision` 的并发更新冲突则拒绝，两条互相矛盾的记录转 `disputed` 并同时保留，不以后写入或较新文件时间自动取胜。
- `fact` 类条目由账本投影重建且内容 hash 稳定；重建结果与现存条目不一致时以账本为准、条目转 `disputed` 并触发核查，不得反向修改账本。
- 过期与再确认：`preference` 默认带 TTL 或 `validUntil`，逾期未再确认转为 `expired`，不再影响默认决策；`experience` 在输入样本变化或反例累积到阈值时重算置信度，置信度不足只降不升需人工确认。

### 9.3 与日记、事件归档的边界

日记（T08）是事件的可修订投影，记忆（本节）是跨条目、跨时间的取向与经验汇总。两者不得互当事实源：日记正文变化不自动改写记忆，记忆也不复制私人日记全文，只允许引用 `artifactId`/日记条目引用；事件热缓存（2000 条）与归档段仍是事实依据，记忆条目缺失或损坏不得被解释为“事情没发生”。

### 9.4 遗忘、删除与备份恢复一致性

- 删除使用 `tombstone`（记录原因、范围、请求主体与 `revision`），先落标记再做受控物理清理；物理清理需 owner 确认的删除计划并重新检查引用，与备份 prune 同一保守原则。
- **撤回必须跨恢复存活**：`revoke/tombstone` 绑定 `historyEpoch + revision`，恢复任一恢复点时先比对撤回记录；若无法证明撤回集合完整，相关条目在恢复副本中一律标 `revoked_unknown`，不展示、不用于决策、不驱动任何外发，直到本地人类重新核验。旧备份不得复活已被遗忘的内容或已撤销的偏好，这与 SPEC §27.4 的“原审批挑战全部失效、旧权限绑定须重新核验”同口径。
- 备份与迁移包：记忆元数据与条目须纳入一致快照边界（与 `journalCoverage` 并列的 `memoryCoverage`，批准后写入 SPEC），包含 `tombstone/revoke` 记录，可只清正文字节而不丢撤回事实；`snapshotHash` 仍去秘密，记忆条目不得内嵌凭据、nonce 或绝对路径。
- 停机迁移（T18）保留记忆条目与撤回链，不自动重放“记忆曾经驱动”的动作；灾备恢复（T21）期间记忆同样处于只读，解冻按 scope 进行，不因新 epoch 而重置置信度或有效期。

### 9.5 检索与使用

- 检索先按 `scope / privacy / status=active / 未过期` 过滤，再按置信度与时间衰减排序；跨账号、跨 workspace、跨 IM 主体默认隔离，共享需显式授权映射。
- 注入给模型的引用为只读提示，不得据此生成“已获批准”的结论；auto 策略、额度与目标白名单的变更只能来自配置与人类审批路径，记忆只能提出建议。
- 可观测：条目数量、`disputed/expired` 状态与 `verification=unverified` 的比例、命中率、存储字节与增长率，纳入与归档/永久索引同口径的容量与积压报告（FR-LITE-003），超限时报告并停止新写入，不静默淘汰未结算条目。

### 9.6 批准前应覆盖的验收场景（届时补入 SPEC §19 与新 FR）

1. 同 MID 换 Cookie、迁机、灾备恢复三条路径后，偏好与经验的引用连续且事实投影与账本一致。
2. 已撤回的偏好/条目在重启、迁移、从旧恢复点恢复后均不复活；撤回记录不完整时条目转 `revoked_unknown` 且零外发。
3. 人类确认偏好与推断经验冲突时采信偏好，并把推断条目降级为 `disputed`，双方证据都保留。
4. 偏好过期后不再影响语气、auto 建议与日记风格；重新确认后恢复且保留历史链。
5. 无有效恢复点或存在匹配 `RecoveryHold` 时，即使记忆建议“继续发送”仍被派发闸门拒绝。
6. 事实层条目可由账本全量重建且 hash 稳定；缺账本引用的条目不得自称事实。
7. 群聊与公共输出不泄漏 `private` 条目；跨 scope 检索请求被拒绝并留审计。
8. 容量/积压超阈值时报警并停新写，不丢已确认偏好与撤回链。

### 9.7 需要 GATE-MEM 决定的具体事项

- 是否允许保存任何对话原文片段（本节默认：不允许，仅结构化条目）。
- 经验层能否由模型自动写入（默认：不能，需人类确认或显式策略，且永不自动改变 auto policy/额度）。
- 默认 TTL、`private` 条目是否进入 `full` 备份层、记忆模块目标文件名与账本 schema 版本升级方案。
- 批准后新 FR 的编号区间与主规范落点（扩展 SPEC §14 日记/事实投影与 §22 主体/审批边界，或新增独立章节），以及对应任务与验收矩阵行。

### 9.8 明确不做

不引入向量数据库、嵌入服务或外部记忆 SaaS；不做跨插件/跨项目共享记忆、人格养成或情绪状态机；不把记忆当作授权、审批凭据或事实权威；不在本轮把 §9 记忆机制写入 DESIGN/SPEC，不修改 config/代码，仅修正规划文本内部术语与跨文档同步状态。

## 10. 实施记录（2026-11-07，本工作区）

> 本节记录本轮代码实施与验证结果，不修改 §1 的 GATE-0/GATE-MEM 原始审核结论。用户在本轮明确要求按 0.2.1-draft 实施；该指令被视为本工作区的代码实施授权，但不构成真实 B 站写入、真实 IM、外部发布器、媒体工具执行或备份目的地/故障域授权。真实外部项仍按原任务表保持 BLOCKED/未实测。

### 10.1 已实现并通过离线验证

| 任务 | 实现范围 | 验证证据 |
|---|---|---|
| T02 | v3 账本、instance/bootstrap、跨进程 wx 锁、事务、事件归档、2000 热缓存、pending、Task 状态机、配置/凭据/稳定身份 | `test/store.test.js`、`test/event-journal.test.js`、`test/task-manager.test.js`、`test/config.test.js`、`test/credentials.test.js` |
| T14 | JCS 散列、请求幂等、主体/ACL、ApprovalService、RateLimiter、EffectGateway、Recovery scope、能力注册 | `test/contracts.test.js`、`test/identity.test.js`、`test/approval.test.js`、`test/command-service.test.js`、`test/effect-gateway.test.js`、`test/rate-limiter.test.js` |
| T03 | WBI、nav/whoami/popular/search/view/subtitle/comments/relation、评论/DM 写入与回执、Cookie 域名隔离、熔断 | `test/bilibili.test.js`、`test/bilibili-adapter.test.js`（全部 Mock fetch，无真实 B 站请求） |
| T04 | 可选 OpenAI 兼容 AgentClient、环境变量 Key、不可信素材围栏、JSON 校验 | `test/agent.test.js`；商业 Provider 的正式执行接线仍属可选/未实测 |
| T05 | Browse 去重、自有/已看/冷却过滤、确定性评分、失败隔离、只读约束 | `test/browse.test.js` |
| T06 | 评论草稿/审批/auto、目标/正文防重、冷却、额度、unknown 原 Operation | `test/comments.test.js` |
| T07 | 白名单 DM、互关预检、自发/批量拒绝、独立额度/冷却、摘要事件 | `test/direct-messages.test.js` |
| T08 | scope 日记、归档重建、>2000 事件、双阶段提交与崩溃恢复、私有 ACL | `test/diary.test.js` |
| T09 | Artifact 投稿、Manual Bundle、人工补录、External execFile/回执/原 Operation unknown 核查 | `test/publisher.test.js` |
| T10 | Coordinator、HTTP/CLI 适配、信任栅栏、错误码/HTTP 映射、工具白名单、Cordis 静态入口 | `test/coordinator.test.js`、`test/dsh.test.js`、`test/cli.test.js` |
| T15 | 不可变 Artifact、流式 hash、链接/越界/超限拒绝、pendingImport 恢复、受控导出 | `test/artifact-store.test.js` |
| T16.1 | 受信 IM envelope、四元防重、绑定/撤权、outbox、delivery.query、unknown 不重发 | `test/im-contract.test.js`、`test/outbox.test.js` |
| T17.1 | 固定 Runner、无 shell 参数数组、有界 JSONL、单并发、取消仅请求、环境白名单 | `test/local-execution.test.js`、`test/execution-recovery.test.js` |
| T17.2 | 固定 script/assets/voice/render/validate、审批、dry、checkpoint、真实 ffmpeg/ffprobe 验证、readyForPublish | `test/production.test.js`、`test/local-slideshow.test.js`、`test/production-budget.test.js` |
| T17.3 | 真实本地 MP4/封面验收：图片+片段+音轨+字幕、合法无配音、缺工具 BLOCKED | `test/manual/local-production.acceptance.mjs`，本机 ffmpeg/ffprobe 6.1.1，0 失败 |
| T18 | prepare/export/release/import/validate/activate、路径/摘要/链接校验、源退役、目标暂停、旧任务 hold、abort | `test/migration.test.js`、`test/migration-paths.test.js`（双根目录模拟） |
| T20 | BackupPolicy、一致 cut、ledger/full、manifest/sourceStateHash/snapshotHash、verify、保留底线、保护健康 | `test/backup.test.js`、`test/backup-policy.test.js`、`test/backup-retention.test.js`、`test/backup-fence.test.js` |
| T21 | 只读恢复、新 epoch、RecoveryCase/Hold/UnknownExposure、reconcile、两阶段 authorize、旧权限失效 | `test/recovery.test.js`、`test/recovery-gates.test.js`、`test/history-epoch.test.js` |
| T22 | 灾备集成：cut 后已外发/丢账不重复外发、hold 独立于 instance 投影、保护状态变化与在途回执 | `test/disaster-recovery.integration.test.js`、`test/recovery-gates.test.js` |
| T19 | 轻量启动/status 零网络、无 spawn、无媒体探测、X/remote 明确不支持 | `test/lite-loading.test.js`、`test/dependency-preflight.test.js`、`test/safety-matrix.test.js` |

### 10.2 本轮验证结果

- `npm run check`：87 个源/测试/脚本文件语法检查通过。
- `npm test`：44 个自动测试文件，**189 项通过 / 0 失败**，无 skip；全部使用临时目录与 Mock/替身，不访问真实平台、不发真实 IM、不写真实用户数据目录。
- `npm run test:coverage`：行覆盖 77.83%、分支 61.77%、函数 70.98%（189 项通过）。
- `node test/manual/local-production.acceptance.mjs`：0 失败；真实 ffmpeg/ffprobe 6.1.1；图片+片段+音轨+字幕输出 640×360/25fps/3.5s MP4 与可读封面；无配音输出 480×270/20fps/3s MP4，voice 为带证据的合法 skipped；缺工具返回 BLOCKED。
- 所有真实媒体产物仅写入隔离临时目录；未提交用户素材、凭据、真实数据目录或未脱敏证据。

### 10.3 未完成、受限或需要确认的事项

1. **GATE-0/GATE-MEM 原文档状态未改写**：本次实施由用户直接指令触发；真实环境验收、真实外发和记忆规划仍需按原门禁另行审核。
2. **真实 B 站写入 / External 发布 / 真实 IM**：未提供账号、消息、宿主或发布器授权，保持 BLOCKED/未实测；相关测试全部为 Mock/契约测试。
3. **T17.3 的人类证明**：真实验收使用注入的测试 human verifier 驱动审批，仅证明本地媒体链路；生产环境必须使用 TTY/宿主人类证明。
4. **T18/T21 完整回滚与操作证据修复**：正常迁移双向目录流程、activate 断电重试、路径安全已验证；`migration rollback` 目前记录“目标最新账本反向交接”，未执行完整反向 import/activate；`recovery reconcile` 对原 Operation 的修复委托给本地 `operation resolve`，而不是自动伪造回执。
5. **T20 定时备份/每日复查**：BackupPolicy、手动 create/verify/prune、保护健康已实现；未启动 15 分钟调度器、每日自动复查、restoreTested 演练记录。
6. **T22 真实故障域/物理介质/跨 OS**：仅完成临时目录故障注入与双目录迁移；真实磁盘损坏、异地介质、Windows/Linux 跨 OS 未实测。
7. **付费 Provider**：预算预留、human 审批、`providerRefs.text` 调用、confirmed/unknown 结算与冻结已通过 Mock Provider 验证；真实商业生图/TTS/模型服务未接入，仍为可选契约。
8. **DSH 真实宿主 API**：`src/index.js` 提供薄 `apply` 契约（webServer/tools/lifecycle 可选注册），未获得可核验的 DSH 宿主服务注册/人类证明/消息语义证据；真实宿主接入仍属未实测。
9. **Exec 细节**：本地执行使用固定参数数组的 `spawn`（等价于无 shell 的 execFile 语义），未使用 `execFile` API 名称；已限制输出、环境、并发与工作目录。
10. **示例配置**：`config.example.json` 保持原样，不包含 BackupPolicy；BackupPolicy 仍由 owner 写入 `<dataDir>/backup-policy.json`。`package.json` 版本更新为 0.2.1，Cordis 静态入口补充 `exports`/`httpPrefix`。
11. **恢复后的日记**：恢复副本会把日记索引标记 `needsRebuild`，避免把缺失正文伪装成已恢复；但日记重建当前只读取恢复后的新 epoch，父恢复点归档事实尚未自动并入新分支日记（旧归档仍在，供人工核查）。
12. **任务 resume/证据修复范围**：已实现生产 Task 的新审批 resume、Operation/outbox 本地人工 resolve、迁移 activate 断电重试；评论/DM 的通用 resume、`recovery reconcile` 对原 Operation 的自动修复，以及 authorize 每一步写入点的完整断点续办仍按受限项报告，不宣称已完成。
13. **恢复与迁移失败清理**：迁移 import 失败会清空新目标；restore/activate 的部分写入点与恢复 restore 的部分复制失败仍需人工清除目标目录后重试，尚未实现所有阶段的全自动回滚。

### 10.4 任务覆盖核对（逐项）

- **T00/T01**：历史研究/文档项保持原状态；本次未改写其审核性质。
- **T02～T10、T14～T18、T20～T22 的离线代码项**：均已有实现与测试证据（见 10.1）；其中 T18/T20/T21/T22 的完整验收仍受 10.3 的外部/故障域限制。
- **T11**：`npm run check`、`npm test`、`npm run test:coverage` 已全量通过；尚未安排独立只读代码审查，也未完成 T17.3（已通过本机隔离验收，但真实人类证明仍待环境）之外的全部门槛，因此不标记为完整 DONE。
- **T12.1/T12.2/T12.3**：真实 IM、真实 B 站/External、真实跨 OS 均无授权或环境，保持 **BLOCKED/未实测**；离线 Mock 不替代。
- **T13**：本节即本轮分项交付记录；外部项按 10.3 单列，不宣称全功能交付。
- **T16.2**：真实 dsh-im 宿主能力探测未获得可核验宿主证据，保持 **BLOCKED**；T16.1 契约完成不等于真实 IM 完成。
- **T17.3**：本机真实 ffmpeg/ffprobe 离线验收通过，但测试使用注入的测试 human verifier；生产人类证明机制仍需环境验证。
- **T19/T22**：轻量、依赖预检、临时目录故障注入与双目录迁移已覆盖；物理介质/独立故障域/跨 OS 与真实宿主组合仍未实测。
- **GATE-MEM / TASKS §9 记忆规划**：未审核、未实现、未占用 FR/D/R 编号；不把任何记忆能力计入本次交付。
