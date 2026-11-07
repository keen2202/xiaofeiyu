# dsh-bili-unified 设计方案

- 状态：**方向已确认；规范化修订稿待审核；核心实施仍暂停**
- 版本：0.2.1-draft
- 日期：2026-11-06
- 修订记录：2026-11-05 按 `report/REVIEW_REPORT.md` 同步安全闸门、迁移/恢复协议与术语；2026-11-06 补齐prepare素材导入冻结。不改变 GATE-0，不代表代码实施或真实环境验证。
- 项目目录：`D:/workbuddy_space/dsh-bili-unified`
- 对应技术规范：`SPEC.md`（灾备契约见 §27，验收统一见 §19）
- 对应实施拆解：`TASKS.md`（0.2.1-draft；账本 v3、FR-DR-001～010 与 T20～T22 已映射；§9 记忆规划仍待 GATE-MEM）

> 已确认方向为“轻核心＋可选适配器＋独立视频生产＋停机迁移/远程预留”。0.2.1补充可信备份与灾难恢复，相关契约、任务映射和验收已同步到 DESIGN/SPEC/TASKS，不构成编码或真实备份执行授权。示例配置维持上一版；两份历史摘要仅增加失效标识并清理过时哈希。策略接线和代码实现仍需在审核通过后进行。§3/4 保留历史参考源码证据，不代表已实现能力。

## 1. 背景与目标

现有插件分别覆盖了 B 站内容读取、评论、私信、日记、任务状态和视频生产，但它们不能直接叠加：

- 每个插件都有自己的调度器、配置、凭据路径、状态文件和限流逻辑。
- 多个插件同时操作同一账号，会重复浏览、评论或发送私信。
- “任务已投递给 Agent”与“业务已执行完成”在部分实现中被混为一谈。
- 参考项目中没有可直接复用且可验证的完整 B 站视频上传/投稿实现。

本项目是一个项目内的模块化 DSH 插件，不是微服务群。核心作为 Task、Operation、审批、幂等、额度和事件账本的唯一逻辑权威，提供统一、可审计、可独立启停的能力：

1. 通过可选 B 站适配器发现和理解视频，提供评论草稿、人工审批及显式启用的 auto 模式、白名单 DM。
2. 从可重放事实事件生成公共/私人日记，持久化本插件任务及未决结果，不聚合整个 DSH 或桌宠状态。
3. 独立触发固定阶段视频生产，产出真实视频和封面；生产不依赖 Browse/B 站，不自动发布。
4. 将生产、素材存储与发布分离；已有视频先导入 ArtifactStore 后可直接创建投稿任务，无须补跑生产。
5. 通过薄 IM 身份桥接复用宿主通道，所有入口共享权限、审批、账本和可靠回执。
6. 支持同插件兼容 schema 的停机单写者搬迁，保留身份、永久业务键、额度与 unknown；远程执行及 X/抖音仅预留契约。
7. 默认保持轻量：禁用组件不影响核心，不加载重 SDK、不派生进程、不轮询、不探测 ffmpeg；状态查询不触发 B 站登录探测。
8. 在磁盘损坏、误删或最新账本不可得时，能从可验证恢复点恢复只读数据；明确数据缺口、隔离旧写者，经证据核查后按范围恢复能力，不能因恢复了旧备份就自动外发。

## 2. 范围

### 2.1 本期范围

- 单机器、单逻辑插件实例和一个已绑定 B 站账号为主；宿主与 CLI 可以是不同进程，但必须共享同一事务、派发闸门和持久账本，不以一个 PID 绝对独占业务。
- 可选 B 站适配器：热门/关键词搜索、详情、字幕、热评、确定性排序与可选模型增强；评论 draft/approval/auto、白名单发送 DM、独立额度、目标去重与未知结果保护。
- 公共日记与可选私人日记，按账号或 workspace 隔离快照身份；事件归档、原子提交和崩溃修复支撑后续重建。
- DSH HTTP API、可选工具、CLI、持久任务查询与取消；状态只覆盖本插件的任务。
- 独立 ProductionTask：固定 `script/assets/voice/render/validate` 阶段；最低可用 `local-slideshow-v1` 执行 profile 使用已导入图片/片段和用户脚本、音轨、字幕，合成真实视频及封面。无配音须经配置与校验允许，不得用投稿 Bundle 冒充生产。
- 发布为独立 PublishTask，支持明确选择的 Manual Bundle 与 External Provider；已有视频经 ArtifactStore 导入和校验后直接投稿。未验证的原生 B 站上传不在交付范围。
- 一个可选 `dsh-im` 桥接契约，优先复用宿主通道；具体 SDK 尚未验证，实施时先做只读能力探测。宿主不支持则明确 `BLOCKED`，不自研 QQ/微信 SDK；Mock 只验证契约，不能冒充真实桥接交付。
- 已选择同插件、兼容 schema 的停机搬迁：prepare/release/import/activate，含账本、日记、素材与产物；不是旧插件数据导入，也不是远程 worker 或双端接管。
- 新增一致性账本恢复点、媒体分层备份、保留策略和本地人类灾备恢复入口。备份不是迁移票据；恢复数据、核查缺口、准许派发是不同步骤，原实例不能隔离时只读恢复。
- Mock 单元/集成测试；本地生产须有显式启用 profile 的真实产物验收，IM 须有真实宿主能力证据；真实 B 站写入须单独授权，默认干跑/低额度。灾备以临时目录故障注入测试，不能把定期备份设置或文件复制视为已验证可恢复。

### 2.2 非目标与预留边界

- 不实现多账号群控、刷量、绕过验证码或平台风控；不默认点赞、投币、关注、陌生人群发。
- 不移植桌宠、RVC、唱歌、情绪养成；IM 通道不是 B 站收件箱，后者本期不自动加入，也不自动监听评论/@。
- 不自研本地 Whisper、完整剪辑器、QQ/微信 SDK 或原生 UPOS 上传；不要求首期接通商业 LLM/生图/TTS 服务。
- LLM/生图/TTS 付费 provider 为可选契约/测试替身；外部 ffmpeg/ffprobe 由显式启用的 profile 声明，核心不安装也不探测。
- remote ExecutionBackend、X、抖音仅以契约与 Mock 验证，不实装 SDK、网络 worker、轮询或自动平台切换。未支持能力返回 `CAPABILITY_UNSUPPORTED`，不偷偷降级。
- 不承诺全自动发布。External 缺失须明确阻塞或能力不支持；只有用户另行明确选择 Manual 才可生成投稿包，不把失败/unknown 改写成人工成功。
- 不支持旧插件账本/配置导入、跨不兼容 schema 搬迁、在线热迁移或双端同时接管；人工交接无法防止绕流程复制后双启。

## 3. 参考源码基线

分析基于 2026-10-27 下载的只读源码快照：

| 项目 | 快照 | 本地研究路径 |
|---|---|---|
| `c1overzz/dsh-bili-scroll` | `4af9839` | `D:/workbuddy_space/.workbuddy/research/dsh-bili-unified/dsh-bili-scroll` |
| `Alterssss/dsh-bili-whale` | `8b0009f` | `D:/workbuddy_space/.workbuddy/research/dsh-bili-unified/dsh-bili-whale` |
| `QCYTSN/dsh-dafeiyu` | `4458ec2` | `D:/workbuddy_space/.workbuddy/research/dsh-bili-unified/dsh-dafeiyu` |
| `baishuyue/dsh-feiyu` | `c1b6916` | `D:/workbuddy_space/.workbuddy/research/dsh-bili-unified/dsh-feiyu` |

参考代码仅用于静态分析，不执行其安装脚本，不在运行时同时加载这些插件。

## 4. 各插件功能、接口、依赖与可复用部分

### 4.1 `dsh-bili-scroll`

**现有能力**

- 搜索、首页推荐、详情、字幕、弹幕、封面、故事板帧和可选本地转写。
- 自动评论、楼中楼回复、私信读取/发送、扫码登录、定时值班、Markdown 日报。
- 评论风格相似度检查、评论公开可见性复核、最小权限 headless profile。

**接口与依赖**

- Cordis：`webServer`、`tools`、`settings`，可选 `attachments`、`llm`。
- HTTP：`/api/bili-duty`。
- 宿主工具：`bili_search`、`bili_subtitle`、`bili_reply`、`bili_run` 等。
- Node 宿主 + Python MCP + headless DSH；依赖 `bilibili-api-python`、`mcp`、`aiohttp`、Pillow，ASR 另依赖 faster-whisper/yt-dlp。

**可复用设计**

- 内容读取与字幕优先的理解流程。
- 评论回执、公开可见性复核、私信 `msg_key` 成功判断。
- MCP 白名单、最小权限、固定路径窄口 IO、凭据权限收紧。

**不宜直接复用**

- 近 3000 行有状态宿主入口。
- 以 Markdown/模型主动记账作为部分事实来源。
- 写额度并非全部在执行层硬限制，跨进程锁存在竞争窗口。

**缺口**

- 当前源码不支持视频投稿。
- 私有接口与 Python/MCP/headless 多层组合提高部署与测试成本。

### 4.2 `dsh-bili-whale`

**现有能力**

- 多来源选题、偏好排序、字幕/弹幕/热评/抽帧理解。
- 评论、待审回复、评论/@监听、主人私信、可靠私信游标。
- 生物钟、公共/私人日记、收藏与反馈学习。
- 统一流量保护：读写预算、最小间隔、写请求指纹、未知结果、风控熔断。

**接口与依赖**

- Cordis：`sessionController`、`webServer`、`connection`。
- HTTP：`/dsh-bili/api/*`。
- CLI：`tools/bili.mjs`；写命令要求显式 `--dry` 或 `--go`。
- Node 18+、qrcode、可选 ffmpeg；直接调用 B 站 Web API。

**可复用设计**

- `traffic.mjs` 的全局限流与“未知结果禁止自动重发”语义。
- `night-plan.mjs` 的跨午夜窗口与持久化计划。
- 私信 receipt/ack、稳定设备 ID、互关检查、目标白名单。
- 凭据原子保存和账号切换保护。

**不宜直接复用**

- 宿主、工具链和模板存在不同默认配置。
- 多个全局状态文件位于同一用户目录，多插件并存会互相影响。
- 生物钟和评论游标部分在“会话已投递”后即推进，不代表业务完成。
- 业务 quota 检查与记账不是一个事务。

**缺口**

- 不支持视频投稿。
- 日记正文主要依赖 Agent 按提示词写入，没有统一业务完成 ACK。

### 4.3 `QCYTSN/dsh-dafeiyu`

**现有能力**

- 订阅 DSH `session/event`，聚合多 Session 的运行状态。
- 区分持续状态与短期成功/失败脉冲。
- 状态优先级：等待确认 > 错误 > 工作 > 思考 > 空闲。
- 原生桌宠 Helper、IPC、心跳、恢复和设置热更新。

**接口与依赖**

- Cordis：`sessions`、`settings`。
- HTTP：`/plugins/dsh-dafeiyu/events`。
- 可选 PySide6/原生 Helper。

**可复用设计**

- 纯 Reducer 状态聚合、容量限制、输出签名去重。
- 将“需要人工处理”置于普通运行状态之上。
- 成功脉冲不覆盖其他持续失败或等待任务。

**明确不采用**

- 不包含 B 站能力，也没有三层记忆或情绪状态机。
- 桌宠与动画不是自动化核心的必要依赖。

### 4.4 `baishuyue/dsh-feiyu`

**现有能力**

- B 站浏览、评论、回评、弹幕、动态等社交写入。
- 人格、情绪、三层记忆、公共/私人日记和每日复盘。
- 视频策划、生图、TTS、剪辑、封面、字幕及投稿目录生成。

**接口与依赖**

- Cordis：`sessionController`、`webServer`、`connection`。
- HTTP：`/dsh-feiyu/api/*`。
- Node CLI + LLM/生图/TTS/ffmpeg 等多个外部服务。

**可复用设计**

- 统一事件、日记与记忆消费方式。
- 干跑、文本去重、分享额度、投稿包元数据。
- 视频生产与视频发布分离的边界。

**不宜直接复用**

- 多处个人绝对路径和平台耦合。
- 读、写请求未完全经过同一风控层。
- 配置回显曾存在备用密钥递归脱敏缺口。
- 后台任务缺少统一 ID、取消、结果查询和持久化状态。

**缺口**

- B 站私信未实现。
- 没有实际上传/投稿 API；`produce` 只生成投稿包和人工操作说明。
- `social-auto-upload` 在当前源码中并未形成 B 站视频发布链。

## 5. 重复能力与潜在冲突

| 冲突域 | 直接叠加的后果 | 统一策略 |
|---|---|---|
| 调度 | 重复唤醒，或一个待审任务卡住所有浏览 | 一个 Coordinator 策略；执行活跃锁与待人工记录分离，按任务/资源约束并发 |
| 配置/加载 | 多套默认值、启动即加载 SDK 或探测依赖 | 单一 schema 与默认源；可选模块显式启用、按需导入 |
| 凭据/身份 | Cookie 更新导致换身份、额度和去重丢失 | 稳定 `platform + accountId`；B 站通过 whoami 核验 MID；摘要仅为 credentialRevision |
| 平台/通道 | B 站对象污染核心，IM 被当作 B 站收件箱 | PlatformAdapter 与 ChannelAdapter 分离，公共对象平台无关 |
| 限流/付费 | 多进程超额，付费请求绕过保护 | 核心同事务预留；B 站写额度与 provider 费用分桶；unknown 冻结预留 |
| 去重/事实 | 仅凭文本、会话投递或 Markdown 判断成功 | 永久 businessKeys、Operation 回执、事件归档与任务结算标记 |
| 日记 | 多账号覆盖、热事件截断、文件与索引不一致 | 含 scope 的路径、身份级串行提交、版本检查与崩溃修复 |
| 生产/发布 | 只生成目录却声称生成视频/发布成功 | 固定阶段真实生产、ArtifactStore、独立 PublishTask 与独立审批 |
| IM/审批 | body 自报身份、模型审批、通知重发带动业务重执 | 可信宿主主体/会话 ACL、绑定输入的挑战、事务 outbox |
| 搬迁 | 复制凭据与空额度启动、两端同时写 | 停机单写者交接，源端持久禁写、目标默认暂停、完整账本迁移 |
| 路由/会话 | 与旧插件重复注册/调度 | 新命名空间；禁止旧 B 站自动化并行，不接管整个 DSH 状态 |

## 6. 关键取舍

D-01～D-18 保留原架构方向；D-19～D-20 是本次获准写入的灾备建议。全部仍是待审核设计，不是实施、备份导出或权限变更许可。

### D-01：统一重写轻核心，而非运行时拼装原插件

- **原因**：原插件的调度、配置与状态无法靠外层开关可靠统一。
- **影响**：一个项目内模块化，共用核心事实与业务闸门；不追求全部历史功能，不拆成微服务。

### D-02：Node.js 22 + 可选 B 站协议适配层

- **原因**：核心读写无须 Python MCP、多套虚拟环境。
- **影响**：保留 BilibiliClient 的 WBI/协议实现，但封装在 B 站 PlatformAdapter 后；B 站可禁用，公共对象不得强制携带 aid/cid。

### D-03：模型可选，确定性能力可独立运行

- **原因**：浏览、账本、日记、生产合成不应被商业模型绑定。
- **影响**：无模型可读内容、写事实日记并使用用户素材生产；auto 评论默认拒绝低质量模板，只有显式策略允许才可使用，不伪装为人工批准。付费 provider 仅可选契约/测试替身。

### D-04：业务幂等、权限与预算进入同一事务

- **原因**：分离检查/记账无法覆盖多入口并发与崩溃窗口。
- **影响**：所有派发先校验审批/策略与统一栅栏；平台写和付费调用预留 Operation、业务键及额度，免费本地阶段预留 Execution，通知使用独立 outbox 发送上下文，不为后两者伪造 Operation。同键同参返回已有记录，同键异参拒绝冲突。

### D-05：未知结果不自动重试

- **原因**：超时或断联不代表服务端未接受。
- **影响**：业务键与预留冻结至可验证核查；覆盖平台写入、付费请求、发布与通知，通知未知不重执业务。`partial` 含 unknown 仍未结算。

### D-06：原子 JSON + 跨进程文件锁，不引入 SQLite

- **原因**：适合单机器低频任务且避免原生依赖。
- **影响**：宿主与 CLI 共享事务，并非一个 PID 绝对独占；锁、事件/outbox 提交与崩溃修复必须可验证。未来可替换 Store，但本期不是多机共享文件写入。

### D-07：外发默认关闭，默认干跑

- **原因**：评论、DM、发布、IM 通知与付费调用均有真实副作用。
- **影响**：启用能力与每次动作的授权分开；auto 是显式策略而非伪造人工批准。生产的本地执行 profile 也须显式启用，安装不产生外部进程。

### D-08：B 站 DM 仅向白名单发送，默认要求互关

- **原因**：采用窄通道，避免群发骚扰。
- **影响**：拒绝陌生人群发与自发自收；DM 与评论独立额度。此能力不包含 B 站收件箱，也不替代 IM 桥接。

### D-09：日记是可靠事件的可修订投影

- **原因**：事件热缓存不能当全部事实源，模型文字不能代替回执。
- **影响**：持久归档支撑超过 2000 条热事件后重建；按 scope/date/book 重建、哈希不变跳过、变化递增 revision。按身份串行提交与版本检查避免覆盖，unknown 核查写入下一修订。

### D-10：视频发布采用显式 Provider，独立于生产

- **原因**：参考源码没有完整可验证的原生上传链。
- **影响**：Manual Bundle/External 都不能冒充生产；生产不自动创建或批准发布。External 不支持不得偷偷切 Manual，已派发 unknown 核查回写原 Operation。

### D-11：DSH 集成与核心解耦

- **原因**：缺少宿主可选服务不应拖垮核心或 CLI。
- **影响**：JSON + 受信任 API/CLI 为主，不制作复杂桌宠/设置 UI；IM 只通过宿主能力桥接，状态仅覆盖本插件任务。

### D-12：不与旧 B 站自动化插件并行启用

- **原因**：核心不能约束旧插件的独立外发。
- **影响**：接替运行前停用 scroll/whale/feiyu 自动化；可保留不操作 B 站的 dafeiyu 桌宠。不提供旧插件配置/账本导入，勿与同插件停机搬迁混淆。

### D-13：轻核心，可选模块显式加载

- **原因**：不因预留未来能力引入启动负担或隐含副作用。
- **影响**：PlatformAdapter、ChannelAdapter、ExecutionBackend、ArtifactStore 分离；禁用路径不导入重 SDK、不 spawn、不 poll、不探测 ffmpeg。状态查询只读持久状态，不调用登录探测。

### D-14：独立固定阶段生产

- **原因**：生产应能脱离 B 站/Browse 完成真实可验产物。
- **影响**：`script/assets/voice/render/validate` 固定流水线，首期 `local-slideshow-v1` 消费已导入素材与用户输入。经校验可无配音；仅全部必需阶段完成才 `readyForPublish`，无自动发布。商业 provider 不作为首期硬依赖。

### D-15：薄 IM 身份桥接

- **原因**：复用可信宿主身份/通道，避免自研聊天 SDK 与重复权限体系。
- **影响**：只读能力探测后启用一个可选 `dsh-im` 桥接；不支持标记 `BLOCKED`，不可验证人类身份则审批 fail-closed。模型没有人工批准资格，通知只消费 outbox。

### D-16：停机单写者迁移

- **原因**：本期只解决同插件搬家，不引入分布式一致性或双端接管。
- **影响**：prepare 冻结派发、执行器退出后封存，release 永久记录交接禁写；目标暂停导入、核验后 activate。保留全部可靠账本，不自动重放旧任务，回滚迁回最新账本；不能阻止绕流程拷贝双启。

### D-17：跨平台公共契约与明确不支持

- **原因**：未来平台/后端不应要求重写核心对象与权限。
- **影响**：公共引用使用 `platform + 稳定 accountId/contentId`，B 站字段留在适配器扩展；X/抖音、remote backend 仅契约/Mock，未支持返回 `CAPABILITY_UNSUPPORTED`，不静默替代。

### D-18：稳定身份、可靠事实与人工审批

- **原因**：凭据变化、模型声明、进程退出或迁机都不能改变既有事实。
- **影响**：MID 核验身份，Cookie 摘要仅 credentialRevision；同账号换 Cookie/搬迁保留 quota/businessKeys/unknown。人工批准绑定 task/action/inputHash/principal/nonce/expires，所有入口的 `approved:true` 均无效；归档、回执与结算标记是事实依据。

### D-19：可信恢复点与分层备份

- **原因**：同盘原子写、事件归档和正常迁移不能覆盖磁盘损坏或最新账本丢失；备份文件存在也不代表其内容一致、完整或位于独立故障域。
- **影响**：复用Store一致性屏障、不可变Artifact及manifest校验，分别记录账本恢复点与媒体覆盖。备份调度默认关闭；本地owner配置目的地后才可启用，元数据建议15分钟恢复点目标，媒体建议24小时完整覆盖目标，均是待测目标而非已兑现SLA。

### D-20：灾备只读起步，不确定区间与分范围解冻

- **原因**：备份之后的外发可能已经发生，记录缺失不等于not_sent；直接续用旧游标、审批、额度或写者票据可能重复外发或恢复已撤销的权限。
- **影响**：先验证备份并只读恢复，隔离旧写者，保留所有已知防重键和unknown；为可能遗漏的动作建立scope级恢复冻结，普通事件摘要不能冒充完整派发日志。恢复创建新的historyEpoch，不伪造丢失历史的连续序号；核查事实与解冻授权分开，不能重放旧任务或越过原迁移禁写规则。

## 7. 总体架构

### 7.1 单核心、四类独立契约

```text
DSH Host / HTTP / CLI                  可选 dsh-im（可信宿主事件）
         │                                      │
         └────────── 身份、ACL、命令校验 ──────────┘
                              │
        Core：Coordinator / Task / Approval / Operation
               Idempotency / Quota / Event / Outbox
                              │
             共享 JsonStore 事务与副作用派发闸门
                              │
      Browse / Comments / DM / Diary / Production / Publish
          │               │            │             │
 PlatformAdapter    ChannelAdapter  ExecutionBackend  ArtifactStore
   └ BilibiliClient   └ 宿主通道      └ 显式本地 profile  └ 素材/产物
```

图中四类契约并列而非互相替代：业务按需使用多个契约（Production 使用 ExecutionBackend 和 ArtifactStore；Publish 使用 PlatformAdapter 的发布能力及受控 External 命令调用）。本期生产阶段协议不直接充当上传协议。所有适配器只执行核心授权的请求并返回回执，不拥有独立 Task/审批/额度账本，不绕过核心外发。

单机器内宿主和 CLI 可以并存。Coordinator 的调度领用通过共享事务防重，事务锁与执行活跃锁分离；网络/子进程等待不持有全局 Store 锁，待人工记录不占用全局浏览锁。唯一权威是同一账本及其规则，不是“所有操作必须来自唯一 PID”。

### 7.2 模块职责

| 模块 | 职责 | 明确不负责 |
|---|---|---|
| `config / registry` | 默认源、schema 校验、脱敏、轻量能力清单与按需加载 | 导入全部 SDK、启动即探测服务 |
| `credentials / identity` | 秘密引用、credentialRevision、显式 whoami 绑定稳定身份 | 以 Cookie 哈希重建账号额度 |
| `store` | 跨进程事务、Task/Operation/审批/幂等/额度/事件/outbox、归档与恢复 | 平台协议、远程共享盘多机写入 |
| `coordinator / task-manager` | 调度领用、活跃锁、任务聚合、结算与取消请求 | 等待人工时锁住全部调度，将投递当完成 |
| `approval / policy` | 主体/会话 ACL、人工挑战、auto 策略、输入绑定 | 信任请求体自报身份或 approved 布尔值 |
| `operation / quota` | 前置预留、派发闸门、业务键、费用分桶、unknown 核查 | 根据进程退出码猜测外部成功 |
| `platform-adapters` | 公共能力/回执转换；B 站包装 BilibiliClient | 暴露 aid/cid 为核心强制字段、自建额度 |
| `channel-adapters` | 宿主事件身份映射、消息回执、通知投递 | 自研 QQ/微信 SDK、赋予模型人类身份 |
| `execution-backends` | 执行、检查点、executionId/attempt/seq 回执、取消确认 | 自行创建业务任务或批准发布 |
| `artifact-store` | 导入、哈希、相对引用、来源/派生产物清单与受控导出 | 自动下载任意地址、自动投稿 |
| `browse / comments / direct-messages` | 浏览事实、评论草稿/审批/auto、白名单 DM | 收件箱监听、独立绕过闸门 |
| `diary` | 按 scope 从归档事实重建快照、版本化提交 | 模型改写历史结果 |
| `production / publisher` | 独立生产流水线；独立发布任务及 Provider | Bundle 冒充视频、生产成功自动批准发布 |
| `migration` | 停机封存、交接票据、暂停导入、核验激活 | 旧插件导入、在线接管、防止人为双启 |
| `backup-recovery` | 一致恢复点、备份校验/保留、只读恢复、不确定区间与证据解冻 | 自动恢复写权、凭空重建丢失事实、替代源端隔离 |
| `dsh-entry / cli` | 生命周期、信任栅栏、命令适配与本地人类入口 | 复制业务逻辑、聚合全 DSH/桌宠状态 |

### 7.3 公共与平台契约

- `PlatformAdapter` 声明平台及能力集合，处理 whoami、内容读取、评论/DM/发布等已支持动作；能力查询读声明，不等于登录探测。只在显式账号绑定、凭据更新、激活核验或需认证操作前进行必要核验。
- 账号引用为 `{ platform, accountId }`，内容引用为 `{ platform, contentId }`；接收者与发布结果同样使用平台命名空间。B 站 accountId 取 whoami 核验的 MID，contentId 可为 BV；aid/cid/tid 位于公共对象的 `platformData`，WBI 等签名细节仅留在协议层。核心通用流程不得依赖这些字段。
- `ChannelAdapter` 接收可信宿主 envelope（channel、主体、会话、消息 ID、人类身份保证等级）并提供发送/回执能力；消息正文不能覆盖 envelope。发送契约包含 `queryDelivery(outboxId, receipt, channelContext)`，能力声明包含 `capabilities.delivery.query/idempotent`；查询结果仅允许 sent/not_sent/unknown，query 不可用或超时保持 unknown。IM 账号身份与 B 站账号身份是两个命名空间，必须显式授权映射。
- `ExecutionBackend` 承接核心创建的 executionId 与固定阶段输入/产物引用，返回独立 attempt、单调 seq、状态与输出摘要；本期仅显式本地 profile 可执行。remote 只定义契约并用 Mock 验证。
- `ArtifactStore` 使用不可变 artifactId、内容 hash、媒体类型/大小、来源、相对存储键和访问 scope；跨模块传引用，不传秘密或本机绝对路径。本机路径仅在可信导入/执行边界解析。
- 不可用组件不影响其他模块；能力未实现返回 `CAPABILITY_UNSUPPORTED`。能力已支持但依赖/宿主权限不满足时明确 `BLOCKED` 并给出原因，不自动换平台、后端或 Provider。

契约细节分别对齐 `SPEC.md` §21 公共与平台契约、§22 身份审批 IM、§23 Artifact、§24 Production/Execution。

### 7.4 轻量加载与生命周期

1. 默认启动只加载轻量核心、持久状态与声明式能力清单；B 站、IM、生产执行、商业 provider 均按显式启用与调用按需加载。
2. 未启用的可选模块不得导入重 SDK、spawn/execFile、启动 poll、探测网络或 ffmpeg/ffprobe；无这些依赖也能启动、查询状态、读账本。
3. 安装/状态查询不执行登录核验或环境探测。显式启用的 profile 才可在其执行边界检查声明的程序、版本与权限；核心不安装程序，不扫描 PATH 自动选工具。
4. 启用 IM 后实施只读宿主能力探测，不以发消息试探权限。宿主能力不足时仅该桥接 `BLOCKED`；真实桥接须真实证据，Mock 不计交付。
5. 禁用/停用先阻止该组件新派发，收尾回执仍落账；不能因卸载组件丢掉已派发 Operation。迁移的冻结覆盖所有组件（含通知）。

轻量验收约束对齐 `SPEC.md` §26，remote/X/抖音预留不得产生常驻 worker 或轮询。

## 8. 核心协作流程

### 8.1 自主浏览与分享

1. Coordinator 在事务中领用浏览轮次并取得相应执行活跃锁；未启用 B 站时拒绝该能力，不影响生产或状态查询。
2. Browse 从热门/搜索获取候选，按平台、稳定账号/内容引用排除已看、失败冷却和自有内容。
3. 读取详情、字幕、热评；单条失败保留结果不终止整轮。确定性评分可选模型增强，只对实际读取成功的内容写事实事件。
4. 评论和 DM 分别创建关联任务，各自检查开关、ACL、额度、审批/auto 策略与去重。评论支持只出草稿；DM 仅白名单并默认互关。
5. 轮次的活跃读取结束即释放浏览执行锁；关联任务待审批/待人工不阻塞后续轮次，同目标预留仍有效。轮次结果明确引用这些未决任务，不宣称外发完成。
6. Diary 在轮次结束或计划时间消费归档事件，不重读视频。显示状态与 `isSettled` 分离，所有未知/待人工项均可查询。

### 8.2 统一副作用派发

下图描述平台写与付费调用的 Operation 流程。免费本地阶段和通知分别使用 Execution/outbox 状态，不创建多余 Operation；它们同样遵守可信授权、持久预留、派发前迁移栅栏和未知结果保护。

```text
可信主体/会话与业务输入校验、能力检查
  → 人工审批挑战或显式 auto 策略校验
  → 规范化 inputHash / businessKey
  → 核心事务：迁移闸门 + 健康备份恢复点 + 无匹配 RecoveryHold + ACL/审批 + 幂等冲突 + 预算/额度 + Operation 预留
  → 等待调度槽位（不持全局事务锁）
  → 派发边界在同一预留事务的后续复核中重新检查备份保护/恢复冻结/迁移冻结/取消/审批有效性，持久化 dispatching
  → 适配器/后端发送一次
  ├─ 可验证成功：confirmed，落账业务键/额度/事件/outbox
  ├─ 明确未生效：failed/not_sent，按证据结算预留
  └─ 超时/断联/含糊回执：unknown，冻结预留，不自动重试
```

prepare 与派发授权必须通过同一事务闸门线性化；冻结前已获派发权的操作列入在途清单，停止新阶段并等待收尾，不能误认为尚未派发而重放。任务事件和通知 outbox 的产生与业务结果同事务，通知发送失败不回滚或重执已完成业务。

### 8.3 独立视频生产与 Artifact

1. 用户通过受信任入口独立创建 ProductionTask，输入为 workspace scope 的脚本/素材/音轨/字幕引用及显式执行 profile；无须登录 B 站、创建 BrowseTask 或绑定投稿账号。
2. 图片、片段、音轨、字幕及已有视频须经 ArtifactStore 导入：受控路径、类型/大小/hash、scope ACL 校验，拒绝路径越界/链接逃逸，生成不可变引用和来源记录。核心不会因 URL/提示词自动下载或执行内容。
3. 固定阶段及最低本地行为如下；检查点绑定输入 hash、profile 版本、executionId/attempt 与产物引用，不能以旧输入检查点冒充新任务结果。

| 阶段 | `local-slideshow-v1` 最低行为 | 完成条件 |
|---|---|---|
| `script` | 使用用户脚本和确定性时序规划 | 脚本、时长/段落和引用可校验，不强制 LLM |
| `assets` | 校验已导入图片/片段并生成素材序列 | 素材可读、格式/范围符合 profile，无须生图服务 |
| `voice` | 使用已导入音轨，或显式选择允许无配音的配置 | 音轨验证通过；无配音记为带证据的合法 skipped，不以 TTS 故障自动静音 |
| `render` | profile 声明的 ffmpeg 合成素材、用户字幕/音轨，生成视频及封面 | 返回真实输出文件引用及 hash；目录/脚本/Bundle 不算成片 |
| `validate` | profile 声明的 ffprobe 检查媒体信息，ffmpeg 验证解码并检查产物 | 视频可解码、轨道/时长/尺寸符合计划，封面可读，清单完整 |

4. 外部 ffmpeg/ffprobe 只由显式启用的 profile 声明并使用固定受信程序、参数数组、环境白名单和受控工作目录；以 `execFile` 无 shell 调用。缺依赖明确 `BLOCKED`，核心不安装、不自行探测。该机制不是沙箱，假设可执行文件可信。
5. 核心创建独立 executionId；每次尝试递增 attempt，回执携带单调 seq。接收/启动 ACK 不是阶段完成；重复/乱序/旧 attempt 回执不得推进新状态，冲突 hash 必须拒绝并保留审计。
6. cancel 仅是请求；直到后端确认停止及输出/副作用状态才可结算。阶段部分失败、缺封面、输出未验证或执行仍未决均不得 `readyForPublish=true`。仅全部必需阶段成功或经规则验证可跳过时才 ready；ready 只说明可供投稿使用，不是发布许可。
7. LLM/生图/TTS 是可选 provider 契约与测试替身，不强制首期商业接入。若启用任何付费调用，核心须先创建 Operation、预留可封顶费用；禁止后端私自重试/加量，无法确定成本上限则拒绝自动调用，unknown 冻结费用（见 §9.6）。
8. 生产成功不自动发布；用户另建 PublishTask 并单独批准。已存在视频无需生产，先导入 ArtifactStore，经媒体/元数据校验后直接进入发布流程。

### 8.4 视频发布与本地人工核查

1. 创建独立 PublishTask，绑定 `platform/accountId`、不可变视频/封面引用、标题、分区、标签及规范化元数据；计算输入 hash 和业务幂等键。选择的发布能力不支持即拒绝，不切换平台/Provider。
2. 默认等待人工批准，批准必须绑定该发布任务和当前输入；ProductionTask 的批准、ready 标记或任何入口 `approved:true` 都不能代替。输入/素材变更需重新挑战。
3. 明确选择 `manual` 并批准后才生成可用 Bundle 和操作说明，状态为 `awaiting_manual`；Bundle 不是生产产物，也不代表已发布。此时保留 Publish/Task 与 pending 业务索引，不伪造已派发 Operation；只有人类明确确认未发布/作废才可取消，进程退出不是未发布证明。
4. `external` 只有在人工批准、额度预留、受信发布器绑定、健康备份恢复点及无匹配 RecoveryHold 均满足时才通过 `execFile` 派发；这些条件与 §8.2 使用同一预留事务和发送前复核，不得以测试配置、dryRun 或 go 豁免。退出码为 0 或接收任务 ACK 不代表成功，须核验发布结果、平台/账号/内容引用及输入关联；发布器回执与平台实际读回须区分。
5. 外部器明确未发送才可失败结算；超时、输出不完整或成功无法确认记 `unknown`，保留原发布 Operation 与额度，不转成 `awaiting_manual` 以绕过冻结。
6. `publish complete`（Manual 人工补录）与 `resolve`（unknown 核查）仅限本地受信人类入口，模型/普通工具/IM 无权使用。仅无已派发/unknown Operation 的 Manual 任务可在补录时创建唯一 manual_confirmation confirmed Operation，记录 `verification=manual_assertion`；External 必须核销原 Operation，不走 Manual 新建。
7. 人工回执须绑定任务、输入、平台稳定账号/发布内容及证据，重复同结果幂等、冲突拒绝；在一个事务中更新 Operation、businessKeys、额度、Task、事件与 outbox。`not_sent` 仅来自可验证核查，不能由超时推断。

### 8.5 薄 IM 命令与可靠通知

1. 显式启用 `dsh-im` 后，先只读探测宿主收消息/发送/身份保证/回执能力；不自研 QQ/微信 SDK。宿主不支持则桥接 `BLOCKED`，不能用 Mock 宣称已交付。
2. 身份取可信宿主事件而非 body；每条命令检查主体、会话和操作 ACL。最小命令集合为创建草稿、查询自有任务、请求取消自有任务、针对明确挑战做交互审批；不得读取他人私人日记或任务结果。
3. 消息防重键使用 adapterId + botAccountId + conversationId + eventId，保存规范化命令 inputHash；同键同参返回原结果，同键异参报冲突。命令接纳、任务创建/变更、消息游标和相关事件在核心事务中提交；重放仍需验证当前访问权。
4. 人工审批必须验证宿主人类身份保证、主体/会话 ACL 及绑定挑战；无法验证人类身份则 fail-closed，不接受模型生成的“同意”、请求体身份或 `approved:true`。
5. IM 不得改秘密、可执行文件/profile 或迁移状态，也不开放发布人工补录/unknown 核查；这些保留在本地受信人类入口。
6. Task 事件与通知 outbox 同事务，通知只引用既有事实。outbox 带消息键、接收主体/会话、payloadHash、发送状态与回执；每条通知在真实发送前仍检查通道 ACL、通知预算和匹配 RecoveryHold。
7. 通知 unknown 不重执业务；无发送幂等保证的渠道不得盲目重发，转人工核查/查询状态。ChannelAdapter 提供 `queryDelivery(outboxId, receipt, channelContext)` 与 `capabilities.delivery.query/idempotent`；query 不可用、超时或响应不可信时保持 unknown，不得推断未发送。本地人类通过 `outbox resolve` 登记 confirmed/not_sent；pending/unknown 永不按留存期清理，已结算通知须保留 Task/事件引用后才可清理正文。支持幂等的渠道也必须验证其保证，方可按同发送键核查或安全续传；不得换新键重发。通知未决单独记录，不把已完成业务改成失败。

### 8.6 停机迁移：prepare → release → import → activate

迁移范围已选定：同插件、兼容 schema、单写者停机搬迁。它不是旧插件导入、远程 worker、共享盘双写或双端接管。以下步骤均由本地受信人类入口触发，IM/模型不可执行；契约对齐 `SPEC.md` §25。真实 `prepare` 和 `activate` 均须在同一预留事务中取得 owner 核验的健康恢复点、确认无匹配 RecoveryHold，dryRun/go 不能豁免；离线契约测试只能使用明确隔离的注入替身。外部素材先经 `artifact import --confirm` 完成 SPEC §23 的普通文件校验、摘要登记和 ACL 绑定，再进入 §8.3 或迁移引用，不能通过 HTTP/IM 任意路径导入。

1. **prepare**：创建 migrationId，持久冻结新任务、素材/Artifact导入及所有副作用派发（平台写、付费 provider、本地执行新阶段、通知/outbox 均包含）；允许冻结前在途操作的收尾回执和核查结果落账。源端保持可读；等待全部本地执行器及其已知子进程稳定退出，无法确认退出则 `BLOCKED`，不得封存。外部服务结果仍未知可带 unknown 迁移，不能伪造取消。
2. **seal/export**：执行器退出、回执落账及核心在途写事务/日记提交收尾后，在事务屏障下建立一致快照、事件水位和 manifest，计算 snapshotHash。封存后业务账本不再变化，release 仅追加交接控制记录；晚到回执不得悄悄改动已封存包，release 前须作废封存并纳入最新账本后重新封存，release 后转交目标以核查回写。
3. **release**：源端持久记录禁写交接票据，绑定 `migrationId/snapshotHash/targetInstance`；写入并持久化成功后才可交付票据。源端重启仍拒绝任务、派发与业务账本写入，只允许只读查询/导出票据。重复 release 同绑定幂等，冲突拒绝；普通开关不能解除已交接禁写。
4. **import**：目标默认暂停且隔离导入，不覆盖一个正在运行的账本。先验证票据目标、manifest、schema 兼容性和文件 hash，再受控解包；只允许相对路径，拒绝绝对路径、盘符/UNC、`..` 越界、重复冲突条目、软链接和硬链接。所有最终路径须受目标根目录约束。
5. **核验**：目标重新绑定秘密与本机目录/权限/profile程序；B站启用时whoami核验原MID，不能重建quota/businessKeys/unknown。仅对需启用组件做必要只读核验；不满足的能力保持暂停。可只激活已核验的非平台能力，但必须在activation清单中持久禁用未核验平台/其他组件，不借激活自动启用，也不声称全量通过。
6. **activate**：核验源端已 release、目标匹配、快照/hash/schema/身份/依赖/权限后，由本地人类显式激活新任务能力。导入的旧任务不自动重放，旧通知不自动重发，unknown 永不自动重试；旧审批挑战一律失效但保留审计。明确允许续办的已知未派发工作也须重新校验、必要时重新审批，不能因激活就执行。
7. **rollback**：release前通过 `migration abort` 在审计下解除prepare并进入 `aborted`，同时作废封存包/激活资格。release后先以 `migration disable-target` 将该目标及旧票据持久禁用，再由 `migration rollback` 创建反向 migrationId，以目标当前数据目录中的最新已提交账本做反向交接；即使目标未激活，也只能使用其已导入快照及后续核查记录，不能从源端旧备份直接恢复。源端状态固定为 `active/quiescing/sealed/released/aborted`，目标状态固定为 `none/imported/validated/active/disabled`；sealed 晚到回执须先回到 quiescing、落账并重新 export。CLI 对应 `migration prepare/export/release/import/validate/activate/status/abort/disable-target/rollback`，任何状态下都禁止覆盖式 `import`。无法取得目标状态/最新账本时保持阻塞，保留全部额度与未知事实。

| 迁移包必须包含 | 不随包迁移，目标必须重新绑定 |
|---|---|
| Task/Operation、永久 businessKeys、额度与预算预留、unknown/未决索引、审批审计 | Cookie/API Key/token 等凭据与会话认证秘密；旧审批不能复用 |
| 稳定 workspaceId/accountRef、主体绑定审计、configRevision、迁移包内所需 RecoveryCase/RecoveryHold 的 evidenceRefs | 宿主事件处理器、会话内存；证据附件仅按受控权限另行导出 |
| 消息去重/游标、通知 outbox 与回执、完整事件归档及水位 | 本机绝对路径、可执行文件路径授权、宿主通道权限与身份保证 |
| 公共/私人日记及提交索引、已导入素材、产物、manifest/hash、检查点 | 本机 ACL/文件权限授权、外部依赖安装；不因搬迁自动继承执行许可 |

迁移包可能含私人日记/消息元数据，须由用户安全保管。交接票据和源端持久禁写只约束遵循流程的实例，无法阻止人为绕流程拷贝账本后双启；本期无中央租约或硬件隔离保证，不宣称解决恶意/失误双写。

### 8.7 可信备份与非计划灾难恢复

此流程解决“最新数据已丢失”，不替代 §8.6 的计划内迁移，也不以旧备份获取新的迁移激活资格。具体协议及验收见 SPEC §27、§19.5。

1. **建立恢复点**：短暂冻结新派发/多文件提交，允许在途回执收尾，取得同一stateHash、historyEpoch、eventSeq和配置修订下的账本、归档清单、永久键、额度、审批/消息审计与Artifact引用。大媒体仍在不可变存储中，渲染可继续写尚未提交的工作文件；恢复点不假装这些在途阶段已完成。
2. **分层落备份**：账本快照、其引用的归档和必要提交恢复材料构成完整ledger备份；full备份再包含其清单要求的所有不可变媒体字节。只完成ledger时必须列缺失媒体，不能宣称视频全部可恢复。大文件复制在核心事务外，使用引用固定和hash验证；失败不覆盖最后一个有效点。
3. **独立故障域与保留**：不同目录不等于不同磁盘；目的地须记录故障域并由owner复核。使用受控访问及用户管理的加密介质/容器，不打包Cookie、Key、旧审批挑战或有效写者票据。建议保留最近8个点、7个日点、4个周点，并按tier保底：不得删除最后有效账本点、最后有效full点、调查固定点或其他备份仍引用的对象；大量新ledger不能挤掉唯一完整媒体备份。
4. **只读恢复**：保留受损原件，导入新的空目录，验证manifest、版本、摘要及引用。新instance/新的historyEpoch与原workspace保持关联；恢复副本默认无任何派发权。所有旧任务/审批/通知置恢复hold，旧主体授权只作为待重新核验的历史。
5. **划定不确定区间**：以最后可信恢复点至旧写者实际隔离的区间记录missing-history。备份中reserved无dispatchAt、queued任务或未消费审批，也可能在备份之后已执行，不能套用普通进程重启规则直接cancel/not_sent。已知unknown继续保留；动作ID或费用无法枚举时冻结整个相关账号、Provider预算或IM发送范围。
6. **基于证据核查**：普通日记/事件摘要不是完整派发日志。只有具备必要业务参数、原键与可靠回执的事实才能重建索引或更新原Operation；不明事实进入RecoveryCase，不能伪造原ID/成功/未发送。外部回读只读且显式授权，不确定性不能因人工点击确认而消失。
7. **单独解冻**：必须先证明旧实例/旧迁移目标及凭据已被持久隔离。无法取得普通release回执时，只能走灾备事故证据流程，不能伪造票据或解除retired。身份/权限重绑、完整性检查及该scope缺口核查通过后，本地人类批准限定范围的新能力；旧任务仍须逐个resume和重新审批。
8. **衡量恢复结果**：分别报告账本恢复时间、媒体可用范围和恢复写入时间。初始建议在有效备份可访问、环境就绪且账本及必需归档/恢复元数据合计不超过100MiB时，60分钟内恢复只读账本；写入恢复取决于证据，不承诺固定时限。无备份、备份过期、媒体缺失或无法隔离旧写者时明确降级/阻塞，绝不声称零数据丢失或自动接管。

保持轻量：复用现有存储与文件校验，只增加本地备份策略、恢复清单和核心派发门禁；不引入云备份SDK、同步双写或共识服务。定时备份未经本地owner配置不启动；平台写、生产付费和IM发送在保护未就绪/恢复点超龄时停止新派发，已派发回执仍可落账，纯只读与明确的新本地免费工作可独立评估。

## 9. 状态与防重复模型

### 9.1 稳定身份与凭据修订

- 公共状态键绑定平台和稳定 accountId，而非 Cookie、路径或机器 ID；B 站由 whoami 核验 MID。Cookie 摘要仅是 `credentialRevision`，用于变更检测与审计，不作账号、quota 或 businessKey 的命名空间。
- 同 MID 换 Cookie/迁机必须复用 quota/businessKeys/unknown 及目标冷却。凭据变化后先核验再允许认证操作，核验失败或 MID 不符时 fail-closed，不自动切号、不删旧账本或从空额度启动。
- Workspace 是不依赖 B 站的稳定 scope，用于生产、素材与日记；迁机保留 workspaceId。宿主主体 principal 与平台 accountId 明确分离，授权映射不随消息 body 改变。

### 9.2 Task、Operation 与结算必须分离

- **Task**：一次插件业务工作；Browse、Comment、DM、Production、Publish、Diary 各有独立任务，可用 parentTaskId 关联。
- **Operation**：一次需可靠记账的副作用，包括平台写、付费调用和发布；通知使用 outbox 自身的发送状态账本，不再创建与业务 Task 绑定的发送 Operation。执行尝试使用独立 Execution 记录，不能用 Task ID 或 PID 代替可靠回执。
- **状态展示不等于结算**：Task 显式保留 `pendingOperationIds`、`holds[]`、待人工/待执行原因及 `isSettled`。合法组合仅为：`queued/waiting_approval/awaiting_manual/interrupted` 时 `isSettled=false, executionActive=false`；`running` 时 `isSettled=false`，executionActive 可为 true/false；`unknown` 时 `isSettled=false, executionActive=false`；`succeeded/cancelled` 时必须 settled 且不活跃；`partial/failed` 是否 settled 按未决 Operation/审批/人工事项计算，任何 unknown 都强制未结算且 finishedAt=null。`partial` 可能仍含 unknown，不得被终态清理规则删除；必要关联任务/执行未结算时也不能宣称全局完成。通知发送不属于原业务任务的必需步骤，其未决发送在 outbox 独立跟踪和保留，不把已完成业务重新置为未完成。
- 必需步骤全部成功/经验证合理跳过且无未决项才 `succeeded`；部分成功伴明确失败/未知为 `partial`；无成功但含 unknown 优先保留 `unknown`，不能因另有失败改成可清理的 failed；只有明确失败且无未决项才 `failed` 且可结算。
- Task 的 `waiting_approval/awaiting_manual` 均未结算；`cancel_requested` 是 Execution 状态，Task 只记 `cancelRequestedAt`，不因此取消成功。等待审批/人工时释放执行活跃锁，仍运行的执行器不得释放槽位；保留任务、业务键与待办，批准后重新竞争资源并检查输入/策略。
- 取消已派发工作不能删除 Operation。执行器退出也不等于外部服务未生效；只有可验证的停止/未派发或已完成事实才能结算。

### 9.3 Operation 状态机与恢复

```text
reserved → dispatching → confirmed
    │          ├───────→ failed（明确未生效）
    │          └───────→ unknown → confirmed
    │                       └────→ not_sent
    └───────────────→ cancelled（可证明尚未派发）
```

- `unknown` 禁止自动重试，冻结业务键与预留；`not_sent` 必须有可靠核查/明确回执，不由超时、cancel 请求或退出码推断。处置统一为：reserved 的二次复核失败仍保留原预留，只有证明未派发并显式取消才转 cancelled/failed 且仅释放未用部分；dispatching 或已派发后终止/超时一律 unknown；confirmed 按真实费用结算；not_sent 核销未用预留但不删除审计。存在部分收费/部分副作用时逐项保留事实与费用，不能按完全未生效释放全部预留。
- 启动恢复只处理能确认执行属主已失效的记录：确认无 dispatchAt、未授权派发且未交接人工的 reserved 才可 cancelled；已进入派发边界又无最终回执必须 unknown。属主活着、PID 复用不明或边界不清时保守冻结。
- 人工交接记录和待审批记录不靠 PID 存活判断取消；本地执行的迟到回执按 executionId/attempt/seq 校验。恢复不自动重放任何旧副作用。
- 本地人工 resolve 同事务更新原 Operation、businessKeys、额度、关联 Task、事件与 outbox；同结论幂等，冲突拒绝。External 发布不得新建 Manual Operation 绕过原 unknown。
- Operation 历史可压缩但保留可审计引用；**永久 businessKeys、unknown、待人工/未结算记录不得随热缓存或终态清理删除**。日额度可按窗口滚动，未决预算预留与业务冻结不得因此丢失。

### 9.4 幂等键示例

以下散列统一采用 SPEC §21.1 的 `jcs-sha256-v1`：字段按 RFC 8785 JCS 规范化，数组保序，除非动作 schema 明确定义为集合；文本先 NFC、CRLF/CR 转 LF、去首尾空白，不折叠大小写或内部空白。散列带算法版本，不接受实现自定义对象 `toString()`。

- 评论：`comment:<platform>:<accountId>:<contentId>:<normalized-text-hash>`。
- 评论目标：`comment-target:<platform>:<accountId>:<contentId>`，冷却另受 sameVideoDays 约束；冷却到期不删除永久动作键。
- DM：`dm:<platform>:<accountId>:<recipientId>:<target-or-content-hash>`。
- 发布：`publish:<platform>:<accountId>:<video-sha256>:<metadata-hash>`。
- 生产：`production:<workspaceId>:<requestKey>`，inputHash 覆盖脚本、素材 hash、profile 版本及阶段参数；同键异参拒绝，不强制所有同输入请求合并。
- IM：`im:<adapterId>:<botAccountId>:<conversationId>:<eventId>`，另存主体绑定及命令 inputHash；通知有独立发送键，不能用新键规避 unknown。
- 日记：`diary:<workspaceId>:<scope>:<yyyy-mm-dd>:<book>`。scope 为 `account/<platform>/<accountId>` 或 `workspace/<workspaceId>`；这是快照身份，不代表仅写一次。

### 9.5 事件归档与日记一致性

1. Task/Operation事实变更、historyEpoch/事件序号与通知outbox须同一逻辑事务提交。新账本v3的seq仅在同epoch递增，eventId全局唯一；正常迁移保留epoch，灾备另建分支并链接可信父恢复点，不伪造丢失尾部的连续历史。原子JSON提交需可恢复记录，网络不放入事务锁；归档摘要不等于完整WAL。
2. 最多 2000 条仅是热事件缓存，不是事实留存上限。业务事务先持久写 journalPending，再由归档器生成不可变段并确认归档；热缓存移除不影响 pending/归档中的事实。归档含连续水位与摘要，可追加核查修订，不覆盖旧证据。
3. 日记读取 scope 对应的归档及 pending，按 eventId/水位去重重建。物理路径统一为 `<diaryDir>/<scopeKey>/<public|private>/YYYY-MM-DD.md`，scopeKey 为 `SHA256(workspaceId + "\n" + scope)`，账号或 workspace 相互隔离，不复用本机绝对路径。
4. 日记身份为 workspaceId/scope/date/book；先记录读取的事件水位和期望 revision，再生成内容。提交时跨进程按该身份串行，核验事件版本/期望 revision；冲突则重新读取重建，不能覆盖较新快照。
5. pendingCommit 至少保存 `{diaryId,expectedRevision,targetRevision,baseEventCursor,targetEventCursor,tempFile,targetFile,contentHash,phase,createdAt}`；先持久记录意图，再原子替换正文并提交索引。崩溃恢复核对文件 hash 和意图，完成或从归档重建；不能把旧索引配新文件当一致状态。提交/修复不追加重复事实事件。
6. 内容哈希不变则跳过，有新事实（包括 unknown 核查）递增 revision。模型只能生成叙述，事实、scope 权限与私人信息边界不由模型决定；迁移携带归档与日记索引，不只复制正文。

### 9.6 额度与费用预算分桶

- B站写额度按稳定平台账号与窗口设置总预算，再按评论/DM/发布分别记账，读限流也归核心策略。生产Provider费用按workspace/provider/Task预算授权分桶，resume累计原Task支出与unknown占用；有附加窗口限额时同时检查，不能花B站quota替代生产费用预留或反之。
- 付费启用前须有可封顶请求参数、最大费用和可核验结算方式；每次调用在核心事务中先预留 Operation 与费用，适配器不能先调用后补账。成本无法封顶则拒绝自动调用，不以 dry-run 名义发送付费请求。
- confirmed 按可核验费用结算；明确未生效按证据释放未用预留；unknown 冻结对应预算且禁止同动作自动重试。预算窗口变化、凭据轮换和迁机都不释放未决预留。重试必须满足已确认未发送、重新授权/额度检查及可审计的显式动作。

### 9.7 Execution 与审批回执

- Execution 记录包含 taskId、executionId、attempt、lastSeq、stage、inputHash、检查点、产物 hash 与取消状态；一次 executionId 是一次不可变尝试。interrupted/FAILED/CANCELLED 的 resume 必须创建新 executionId、递增 attempt 并引用前一执行和已验证检查点，只能显式 rebind 相同 taskId/stage/inputHash 的后继执行；相同 executionId 重复 submit 仅返回原进行态，不把终态改为运行态。接受 ACK、进度、最终输出分开；重复回执幂等，旧尝试/逆序回执不得使阶段回退或恢复已取消任务。
- cancel 请求后仍可收到合法完成事实，核心按实际回执结算，不假定取消必胜；未收到最终停止/完成确认则保留未决。产物存在不代表所有阶段成功，须通过 validate 才能 ready。
- 人工挑战绑定 `task/action/inputHash/principal/nonce/expires`，在可信入口原子校验并消费；nonce 一次性、防重放，过期/改参/错误主体拒绝。会话 ACL 同时生效；模型会话不能消费人类挑战，`approved:true` 一律不是证据。
- 自动模式记录命中的显式 policy 和输入 hash，不制造人工审批记录。生产与发布的 task/action 不同，审批不得复用；迁移后保留历史审批审计但作废旧挑战，待续办动作重新授权。

## 10. 异常与恢复原则

- 只读请求允许有限重试，412/429 和风控码由 B 站适配器归一并触发对应平台/账号熔断；不能因此关闭独立生产/日记等无关能力。已派发副作用不自动重试。
- 状态/归档/迁移manifest损坏先fail-closed，不能退回空账本；之后只可进入§8.7/Spec §27受控灾备只读恢复。缺失的防重证据由RecoveryHold保守隔离，不能为尽快可用而清空索引；状态查询只显示脱敏阻断原因。
- 事务锁采用原子 `wx`、属主启动标识/随机 token、PID 存活与租约协同校验；租约过期或 PID 相同本身不足以抢锁。无法确认安全释放时拒绝写入，锁不覆盖网络/进程等待。
- 共享事务负责调度领用和派发门禁；等待人工、IM 离线、通知 unknown 不占全局浏览执行锁。仍须保留相关未决业务键，防止新轮次同目标重复外发。
- 错误结构保留 `code/message/retryable/details`，能力未实现为 `CAPABILITY_UNSUPPORTED`，依赖/身份/迁移条件未满足为明确 `BLOCKED`；禁止静默降级。
- 停止插件时先阻止新派发，取消定时器并请求执行器停止；允许合法收尾回执落账，已派发不伪装 cancelled。仅当本地执行器稳定退出才满足迁移封存条件。
- 文件与事件归档提交恢复、日记提交意图修复、导入临时状态均遵守提交标记；部分写入不能被当成成功。恢复只修复事实一致性，不自动重新执行旧任务/通知。

## 11. 安全与隐私

- 凭据与普通配置分离，环境变量/秘密引用按明示优先级解析；凭据文件按 POSIX `0600` 或 Windows 当前用户 ACL 收紧。迁移不携带秘密或本机权限；核验不通过保持暂停，不为绕过问题扩大权限。
- 配置 API 递归脱敏 `api_key/apiKey/token/secret/password/cookie/sessdata/bili_jct`；日志不包含 Cookie、API Key、完整私信/字幕或宿主认证秘密。
- HTTP 经 DSH 信任栅栏且执行主体/会话 ACL；“来自本机”不等于“人类批准”。本地人工入口也须可验证的人类上下文，模型与普通工具不能调用人工补录/resolve/迁移接口。
- IM 身份由可信宿主事件提供，不信任 body 中 principal、角色或批准标记；宿主身份不足则审批 fail-closed。任务、artifact、私人日记查询按 scope 和所有者授权，通知不得泄露他人内容。
- 字幕、评论、消息、脚本及素材均是不可信输入，不能修改工具权限、可执行程序、profile 或迁移目标，也不能提升自身为审批者。
- 外部发布器和媒体程序采用固定受信 executable、`execFile` 参数数组、无 shell、环境白名单、受控工作目录及最小所需秘密；不继承整个宿主环境。输入不能注入程序路径/任意参数模板；产物路径和媒体协议须受 profile 限制。
- 上述进程约束不构成沙箱：受信程序可能拥有当前用户权限，本期不承诺隔离恶意程序/媒体漏洞。用户须显式授权执行 profile；核心不自动安装/探测工具。
- Artifact 导入/导出与迁移解包校验 hash、大小及最终受控路径，拒绝链接/路径逃逸；包内私人数据须安全保管。视频、原始素材与未决操作证据不得自动删除。

## 12. 限制与替代方案

| 能力 | 本期限制 | 明确处理方式 |
|---|---|---|
| 无字幕/画面理解 | 不内置 Whisper 或通用视觉剪辑链 | 跳过或用户提供文本；后续可选 ASR/抽帧契约，不在核心启动探测 |
| 独立生产 | 仅固定阶段与最低 local-slideshow-v1，不是完整编辑器 | 用户素材/脚本/音轨/字幕合成真实视频和封面；显式无配音配置可合法跳过 voice |
| 商业模型/生图/TTS | 首期不强制接入 | 契约/测试替身；启用真实调用必须成本封顶和前置 Operation 预留 |
| 原生视频上传 | 不实现未验证 UPOS，也不保证某第三方发布器已适配 | 明确选择 Manual Bundle 或经契约验证的 External；不支持返回能力错误 |
| External 结果不明 | 退出码不等于发布成功 | 原 Operation 记 unknown，本地人类核查；不得切 Manual 新建 |
| IM 宿主支持 | dsh-im 具体 SDK 尚未验证 | 实施先只读能力探测；不支持为 BLOCKED，Mock 不等于真实交付，不自研 QQ/微信 SDK |
| B 站收件箱 | 与 IM 无关，本期不自动加入 | 仅白名单发送 DM；收件箱需另行审核范围 |
| remote / X / 抖音 | 仅契约与 Mock，无 SDK/轮询/远程接管 | CAPABILITY_UNSUPPORTED，不偷偷降级或启动 worker |
| 多账号/高并发 | 首期单机 JSON Store 与一个绑定 B 站账号 | 以后可替换 Store/扩展分区，不提前做微服务 |
| 停机搬迁 | 仅同插件兼容schema；不能防绕流程双启 | 完整账本、票据与人类交接；正常回滚不使用旧快照 |
| 备份/灾备 | 不承诺零丢失、自动接管或固定写入RTO | 独立恢复点、只读导入、历史缺口冻结和证据解冻；隔离/事实不足则持续阻塞相应写入 |
| DSH 设置/桌宠 | 无复杂设置 UI、无全 DSH 状态聚合 | JSON + 受信任 API/CLI，仅展示本插件 Task |
| 文学性日记 | 无模型时结构化事实 | 可选叙述增强，不改变事实归档或私人 scope |

## 13. 测试策略摘要

所有条目是待实施的验收要求，不表示已测试通过；验收统一映射到 `SPEC.md` §19。

- 核心/身份：同 MID 换 Cookie 或迁机保留 quota/businessKeys/unknown；MID 不符 fail-closed；同键异参冲突、稳定平台引用、禁用 B 站时状态查询零登录探测。
- Store/并发：宿主与 CLI 并发预留只能成功一次；锁属主/租约不明拒绝写；Operation/事件/outbox 同事务崩溃恢复；partial 含 unknown 不得清理；等待审批不阻断新浏览。
- B 站：Mock fetch 验证 WBI、热门/搜索/详情/字幕/热评、评论三模式、白名单/互关 DM、额度/风控/回执；真实写入单独人工授权、默认干跑，不批量外发。
- 审批：body 伪造身份、模型审批、approved:true、错误主体/会话、改参/过期/nonce 重放全部拒绝；生产批准不能批准发布，IM 无权执行 complete/resolve/迁移。
- Production/Artifact：无 B 站/Browse/商业 provider 也能独立运行；显式本地 profile 真实合成视频及封面，验证字幕/音轨与无配音配置、缺依赖 BLOCKED、链接越界拒绝、导入已有视频可直接建发布任务；Bundle 不能通过成片验收。
- Execution/费用：executionId/attempt/seq 重复/乱序/冲突、部分阶段失败不 ready、取消不等于确认；付费请求无预留禁止派发、成本无上限拒绝自动调用、unknown 预算冻结且不与 B 站额度混桶。
- 发布：独立人工审批、Manual 补录、本地受信入口、External 成功/明确失败/超时/含糊回执；unknown 核查只回写原 Operation，不新建 Manual，不静默降级。
- IM/outbox：只读能力探测、不支持 BLOCKED、真实桥接能力证据独立于 Mock；主体/会话 ACL、自有任务查询/取消、消息防重/冲突、事件与 outbox 同事务，通知未知不重执业务，无发送幂等不得盲重发。
- 日记：超过 2000 热事件仍可按 scope 重建历史日期；unknown 核查更新 revision，不同账号/workspace 不覆盖，跨进程版本冲突和正文/索引崩溃可修复，私人内容不泄露。
- 迁移：prepare 冻结所有派发含通知并允许在途回执；执行器未退出拒绝封存，快照/票据目标校验，越界/软硬链接拒绝、秘密/权限重绑、whoami 核号；导入暂停，旧审批失效，activate 不重放旧任务/通知，源重启仍禁写，回滚必须迁回最新账本。
- 轻量/预留：禁用组件缺 SDK 仍启动；默认零重 SDK 导入、零 spawn/poll/ffmpeg 探测，状态查询只读；X/抖音/remote 仅契约 Mock 与 CAPABILITY_UNSUPPORTED，禁止隐含降级。
- DSH：宿主注册/注销、信任栅栏缺失拒绝写、可选组件失败不拖垮核心；任务状态不夹带全 DSH/桌宠会话。

- 灾备新增验收见SPEC §19.5：损坏/丢失账本、备份过期/同盘、捕获并发、缺媒体、保留/共享对象、恢复点后外发、未知费用、epoch分支、旧权限失效、旧写者不能隔离、证据冲突与授权断电。记录实际恢复时间及未解冻scope，不能把备份文件存在当恢复成功。

规范沿用SPEC §1～26，新增§27灾备契约。上一版42条需求与新增FR-DR-001～010共52条，均已映射到TASKS的T00～T22及相应验收；D-19/20、R-14/15和账本v3的任务接线计划已同步。示例配置未修改，两份历史摘要已标为非现行基线；代码和策略实现仍未开始，必须完成审核后再实施，不把任务映射或文档完成当作代码实现。

## 14. 待审核的规范化修订

原架构方向和停机迁移范围不变；R-01～R-13沿用上一版，本次增补R-14/R-15的灾备约束和验收。写入建议不等同用户已批准策略数值、账本升级或核心实施；任务表已同步，仍须完成修订稿审核。

| 编号 | 规范化基线 | 本轮审核重点 |
|---|---|---|
| R-01 | 一个项目统一重写核心，不运行时拼装旧插件，不导入旧配置/账本 | 核心唯一权威及模块职责边界 |
| R-02 | Node 22，BilibiliClient 包装在可选 B 站适配器后 | 协议维护、稳定引用；不保留 Python MCP 硬依赖 |
| R-03 | 评论提供草稿/审批/auto，默认审批，auto 须显式策略 | 人类挑战与自动策略分开记账 |
| R-04 | 无模型默认禁止低质模板 auto 评论，显式允许才可降级 | 不因模型缺失阻断读取/日记/本地生产 |
| R-05 | 原子 JSON 与跨进程事务/锁，保留未来 Store 替换能力 | unknown/partial 结算、归档及崩溃恢复证据 |
| R-06 | 发布 Manual + External；原生上传不在本期 | 独立发布审批、可靠回执及 External 原 Operation 核查 |
| R-07 | 首版 JSON + 受信任 API/CLI，无复杂设置 UI | 入口 ACL 与仅本插件任务状态 |
| R-08 | 旧 B 站自动化不能并行，不提供旧插件导入工具 | 停用边界；与 R-12 同插件搬迁明确区分 |
| R-09 | 轻核心＋四类独立契约，可选模块显式加载（D-13/17/18） | 默认零重 SDK/进程/轮询/探测，稳定身份与可靠账本 |
| R-10 | 独立固定阶段生产，local-slideshow-v1 真实视频/封面（D-14） | 无商业依赖最低路径、预算/取消回执、生产不自动发布 |
| R-11 | 一个可选 dsh-im 薄桥接（D-15） | 只读探测、可信人类/会话 ACL、BLOCKED、outbox；Mock 不冒充交付 |
| R-12 | 同插件兼容 schema 停机单写者搬迁（D-16） | prepare/release/import/activate、完整账本、禁写及最新账本回滚；远程仅预留 |
| R-13 | X/抖音及 remote backend 仅契约与 Mock（D-17） | 不实装 SDK/轮询/双端接管，不支持明确拒绝 |
| R-14 | 一致恢复点与分层备份（D-19） | 独立故障域、初始15分钟账本/24小时媒体目标、保留/校验、未保护或超龄停止新的受保护派发 |
| R-15 | 灾备只读恢复与证据解冻（D-20） | historyEpoch、恢复点后未知区间、旧写者隔离、权限重绑及不自动重放 |

**审核基线：0.2.1-draft、D-01～D-20、R-01～R-15。灾备契约及任务映射已同步到三份文档，策略实现与代码接线尚未完成；核心实施及GATE-0继续暂停，本次修订不是编码或备份执行批准。**
