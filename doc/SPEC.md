# dsh-bili-unified 技术规范（Spec）

- 状态：**架构方向已确认，修订稿待审核，未批准核心实施**
- 规范版本：0.2.1-draft
- 日期：2026-11-06
- 修订记录：2026-11-05 按 `report/REVIEW_REPORT.md` 完成文档一致性与可执行性修订；2026-11-06 按二次复核收尾测试分类、requestKey与交叉引用。不改变 GATE-0，不代表代码实施或真实环境验证。
- 设计依据：`DESIGN.md`
- 实施拆解：`TASKS.md`（0.2.1-draft；新增灾备条款、账本 v3、FR-DR-001～010 与 T20～T22 已同步到任务表）

本文使用“必须/可以/不得”表示约束强度；“必须/不得”为强制要求，“可以”为明确允许的可选行为。§4.3 的普通业务默认配置仍与未修改的 `config.example.json` 一致；新增本地备份策略独立定义于 §27，不是已经接线的运行配置。DESIGN/SPEC/TASKS 已同步 0.2.1-draft 的灾备契约、任务映射与验收口径，真实环境验收统一受 FR-DR-002 和 TASKS T12.1/T12.2 的强制前置约束；本次复核修订不修改示例配置或代码，不表示任何备份执行、环境验证或实施批准。

本版采用“轻核心＋可选适配器＋独立生产执行”。本期跨端能力为同插件兼容格式的停机迁移；远程执行、X 和抖音只保留契约与测试替身，不实现常驻服务或平台 SDK。

## 1. 验收目标

实现一个 Node.js 22 ESM 包，既可作为 DSH 插件加载，也可通过 CLI 调用统一核心。系统必须支持：

- B 站自主浏览、评论、白名单私信发送、公共/私人日记和插件内任务状态；
- 独立触发的视频生产、验证后的产物管理，以及独立审批的 Manual/External 投稿；
- 一个可选 DSH IM 桥接：受信身份、命令防重、人工审批、授权范围内的任务查询与回信；
- 服务器与本地之间的停机迁移，保留账本、素材和未知结果，不自动重放；
- 可信备份恢复点、非计划数据丢失后的只读恢复、不确定区间核查和分范围解冻；备份不具有迁移或写入授权；
- 平台、消息通道和执行端契约隔离；X、抖音和 remote 执行端仅做契约级验证；
- 各能力独立启停，未启用的组件不加载重依赖、不启动后台进程。

任何平台写入、生产付费调用和 IM 通知均不得绕过各自的权限、额度、幂等、派发栅栏及未知结果保护。IM 桥接不是 B 站收件箱；本期不承诺 B 站收件监听/自动回复、全 DSH 会话聚合、原生 UPOS、双端接管或通用视频编辑器。

## 2. 术语

- **Feature**：`browse/comments/directMessages/diary/production/publishing/im` 之一。
- **Task**：核心持久化的一次工作，`accepted` 不等于业务成功。
- **Operation**：一次需要防重复副作用的动作，包括平台写入和生产 Provider 的付费调用；不同服务额度分桶。
- **Candidate**：Browse 输出的标准内容对象；B 站私有字段位于适配器扩展内。
- **Artifact**：受管理、带内容摘要的素材或产物，不以绝对路径作为跨端身份。
- **Bundle**：投稿说明与产物引用；创建成功不等于生产完成或发布成功。
- **Principal**：核心根据受信传输身份绑定的操作主体，不接受正文自报权限。
- **Execution**：某 Task 阶段的执行尝试，与 Task 和 Operation 分离。
- **Dry Run**：校验并返回计划，不发送平台写请求、不真实渲染、不调用生产生成服务；允许记录标明干跑的审计 Task。
- **Unknown**：操作可能已生效但没有可靠结果，必须核查，不能自动重发。
- **单写者交接**：仅一个已激活机器拥有业务派发权；同机宿主/CLI 仍可经统一核心事务协作，不是只允许一个 PID。
- **RecoveryPoint**：经过完整性校验的一致账本快照及其归档/对象覆盖清单；时间是捕获时刻，不是文件复制结束时刻。
- **RecoveryCase**：一次灾备事故的受控恢复记录，持久保存丢失历史、证据、未决操作、决定与 revision。
- **RecoveryHold**：字段名统一为 `recoveryHold`（Task 的 `holds[]` 中 `kind=recovery`）；按规范化 scope 冻结可能受损的派发范围。记录缺失不等于未执行，解冻不是重跑许可；迁移冻结使用 `migrationHold`，二者共用 holds 结构但不可互相代替。
- **eventCursor／事件游标／事件水位**：统一指 `{historyEpoch,seq}`，禁止跨 epoch 比较裸 seq；`sealed` 是迁移封存状态，由 `migration export` 原子进入，`quiescing` 是封存前的收尾状态。
- **historyEpoch**：账本历史分支标识。正常迁移不变，灾备创建新值；eventId全局唯一，seq只在同epoch递增，不能把旧恢复点后的新事件伪装为原连续历史。
- **RPO/RTO**：可接受的恢复点滞后与恢复服务目标；分别记录账本、媒体和写能力，本稿目标未实测，不承诺零丢失或固定写入恢复时限。

## 3. 包与运行要求

### 3.1 包结构

```text
dsh-bili-unified/
  package.json
  cordis.patch.yml
  config.example.json
  cli.mjs
  src/
    index.js
    config.js
    credentials.js
    errors.js
    utils.js
    store.js
    rate-limiter.js
    task-manager.js
    bilibili.js
    agent.js
    coordinator.js
    contracts.js
    identity.js
    approval.js
    command-service.js
    effect-gateway.js
    event-journal.js
    artifact-store.js
    migration.js
    backup-recovery.js
    adapters/
      registry.js
      platforms/bilibili.js
      channels/dsh-im.js
      execution/local.js
    modules/
      browse.js
      comments.js
      direct-messages.js
      diary.js
      production.js
      publisher.js
    production/
      runner.mjs
      profiles/local-slideshow.js
  test/
```

这是实施目标结构，不表示文件已存在。X/抖音测试替身放在 `test/helpers`，不伪装为可用的正式适配器；无需为 remote 安装任何服务。

### 3.2 运行时

- Node.js 必须为 22 或更高版本。
- 核心不得要求 Python、MCP、ffmpeg、原生 SQLite 或桌宠 Helper。
- 可选 Agent 使用 OpenAI 兼容 HTTP 接口。
- 可选 External Publisher 使用本机可执行文件。
- 可选生产配置可以要求用户显式提供 ffmpeg/ffprobe；仅启用生产并预检时检查，不在安装或核心启动时下载、探测或启动。
- IM 优先复用宿主已提供的通道，不内置 QQ/微信 SDK。真实宿主桥接需先验证能力与身份语义；缺失时该适配器为 `unavailable`，不得用 Mock 冒充真实接入。
- 可选适配器动态加载；一个适配器失败不得阻止核心状态查询、日记或其他已满足条件的功能。

### 3.3 DSH 挂载

- 插件名和 Cordis ID 均为 `dsh-bili-unified`。
- 宿主核心服务缺失时不得导致整个 DSH 加载失败。
- HTTP 前缀必须为 `/dsh-bili-unified/api`。
- 插件停止必须注销路由、工具和定时器。
- Cordis 挂载层的 enabled 开关由入口单独消费，不作为业务配置字段，也不意味着 browse/im/production 等自动启用；包导出与挂载参数须在宿主集成任务中验证，当前草案不是已可加载的实现包。

## 4. 配置规范

### 4.1 配置来源与优先级

从低到高：

1. 内置默认值；
2. 用户 JSON 配置；
3. DSH 注入配置中的同名字段；
4. 明确的环境变量；
5. 单次调用的显式参数（不得持久化秘密）。

Cookie 和 Agent API Key 不从普通配置返回。Cookie 仅从凭据文件或对应环境变量读取。

### 4.2 路径

- 默认数据目录：`$DSH_HOME/dsh-bili-unified`；未设置 DSH_HOME 时为 `~/.dsh/dsh-bili-unified`。
- 默认配置：`<dataDir>/config.json`。
- 默认凭据：`<dataDir>/credentials.json`。
- 默认状态：`<dataDir>/state.json`。
- 默认日记：`<dataDir>/diary`。
- 默认投稿：`<dataDir>/posts`。
- 默认素材：`<dataDir>/artifacts`；生产临时目录：`<dataDir>/production-work`。
- 默认生产配置绑定：`<dataDir>/production-profiles.json`，内容由受信本地管理员维护，不含凭据值。
- 默认事件归档：`<dataDir>/journal`；迁移输出：`<dataDir>/migrations`。
- 本机实例/交接记录：`<dataDir>/instance.json`，包含 `schemaVersion/instanceId/workspaceId/processStartedAt/createdAt/bootstrapComplete/activationRevision/allowedCapabilities/configRevision/recoveryRevision`；activation/capabilities 必须由同一个可信实例服务读取。该文件含本机进程信息，不作为业务快照原样恢复到另一实例，恢复导入时生成新的 instanceId 和 activationRevision。
- 备份策略为本地 owner 维护的 `<dataDir>/backup-policy.json`。`recoveryDir` 默认是恢复目标下的 `<dataDir>/recovery`，只能由本地恢复管理入口指定；`recovery.json` 是事故恢复决定与 revision 的权威记录，`<recoveryDir>/evidence/` 保存受控证据引用与附件。普通业务配置、模型工具及 IM 均不能改写这些路径。
- 备份目的地无自动默认值，不能默认写回同一数据盘；必须由owner选择并核验故障域。恢复工作目录必须是新空目录，不能覆盖现有账本或受损原件。
- 首次初始化只允许在新空数据目录中由显式 bootstrap 事务同时创建 state、instance 和初始事件水位。若 `bootstrapComplete=true`、既有账本/归档/凭据绑定存在而 state 缺失，返回 `RECOVERY_REQUIRED`，不得当首启建空账本；state 存在而 instance 缺失或字段不一致时保持严格冻结，只能经本地恢复管理入口修复实例投影。
- 测试必须能使用独立临时目录，不得写真实用户状态。

### 4.3 默认配置

```json
{
  "schemaVersion": 1,
  "dataDir": "",
  "credentialsFile": "",
  "dryRun": true,
  "timeZone": "Asia/Shanghai",
  "platforms": { "enabled": ["bilibili"] },
  "owner": { "mid": 0, "name": "" },
  "scheduler": {
    "enabled": false,
    "tickSeconds": 30,
    "browseIntervalMinutes": 360,
    "diaryTime": "23:00"
  },
  "browse": {
    "enabled": false,
    "sources": ["popular", "search"],
    "keywords": [],
    "perRound": 3,
    "candidatePool": 30,
    "minSubtitleChars": 80,
    "minScore": 20,
    "maxDurationSec": 3600,
    "markWatchHistory": false
  },
  "comments": {
    "enabled": false,
    "mode": "approval",
    "perRound": 1,
    "dailyLimit": 3,
    "sameVideoDays": 7,
    "maxLength": 300,
    "mentionOwner": false,
    "allowTemplate": false
  },
  "directMessages": {
    "enabled": false,
    "allowedRecipientMids": [],
    "requireMutual": true,
    "perRound": 1,
    "dailyLimit": 3,
    "sameVideoDays": 7,
    "maxLength": 300
  },
  "diary": {
    "enabled": false,
    "afterBrowse": true,
    "daily": true,
    "publicBook": true,
    "privateBook": false,
    "directory": ""
  },
  "im": {
    "enabled": false,
    "adapterId": "dsh-im",
    "maxMessageAgeSec": 600,
    "approvalTtlSec": 600,
    "groupReplies": "summary",
    "notifications": {
      "enabled": false,
      "minGapMs": 1500,
      "perMinute": 20
    }
  },
  "artifacts": {
    "directory": "",
    "maxImportBytes": 8589934592
  },
  "production": {
    "enabled": false,
    "dryRun": true,
    "backend": "local",
    "profileId": "local-slideshow-v1",
    "profilesFile": "",
    "requireApproval": true,
    "maxConcurrent": 1,
    "workDir": "",
    "limits": {
      "wallTimeSec": 1800,
      "maxPaidCostMinor": 0,
      "currency": "CNY",
      "maxOutputBytes": 1073741824
    }
  },
  "migration": {
    "mode": "offline",
    "directory": "",
    "maxFiles": 100000,
    "maxTotalBytes": 68719476736
  },
  "publishing": {
    "enabled": false,
    "provider": "manual",
    "dryRun": true,
    "autoPublish": false,
    "requireApproval": true,
    "outputDir": "",
    "external": {
      "command": "",
      "args": [],
      "timeoutMs": 600000,
      "successJson": true
    }
  },
  "agent": {
    "enabled": false,
    "baseUrl": "https://api.deepseek.com/v1",
    "apiKeyEnv": "DEEPSEEK_API_KEY",
    "model": "deepseek-chat",
    "timeoutMs": 60000,
    "persona": ""
  },
  "rateLimit": {
    "minGapMs": 1500,
    "writeGapMs": 120000,
    "readPerHour": 600,
    "readPerDay": 3000,
    "writePerHour": 12,
    "writePerDay": 30,
    "requestTimeoutMs": 30000,
    "circuitBaseMs": 300000,
    "circuitMaxMs": 1800000
  },
  "security": {
    "allowExternalPublisher": false,
    "allowLocalProducer": false,
    "maxUploadBytes": 8589934592,
    "allowedVideoExtensions": [".mp4", ".flv", ".mov"],
    "allowedSourceDirs": []
  }
}
```

### 4.4 校验规则

- 所有 `enabled` 以及 `dryRun`、`requireApproval`、`autoPublish`、`requireMutual`、`markWatchHistory`、`allowTemplate`、`afterBrowse`、`daily`、`publicBook`、`privateBook`、`successJson`、`allowExternalPublisher`、`allowLocalProducer` 必须为布尔值，不得用数字或字符串代替；布尔字段不得参与数值转换。
- `scheduler.tickSeconds >= 15`；`scheduler.diaryTime` 必须是 24 小时制 `HH:mm`（`00:00`～`23:59`），由 `timeZone` 解释。
- `browse.perRound` 为 1–20；`candidatePool` 为 1–100；`comments/directMessages` 的 `perRound/dailyLimit` 为 0–20，0 表示不自动执行。
- `comments.mode` 仅允许 `approval|auto`。
- `sameVideoDays` 为 0–365；0 表示不再按时间放开同一业务键，永久幂等键仍有效。
- `owner.mid` 必须为非负安全整数；`mentionOwner=true` 时 `owner.name` 必须是去除首尾空白后非空的字符串。
- `browse.markWatchHistory=true` 本期直接返回 `CONFIG_INVALID`，不得忽略该开关后继续运行。
- `publishing.external.successJson=true` 时，stdout 必须包含且仅包含一个 JSON object：`ok` 为 boolean，`ok=true` 时还须有字符串 `bvid/url`，不得接受裸 `"true"`；`successJson=false` 本期没有已验证回执协议，真实 External 派发返回 `CAPABILITY_UNSUPPORTED`，dryRun 可报告该阻断项。
- `agent.baseUrl` 必须是明确的 HTTPS 绝对 URL；External command、profile 可执行文件及全部目录字段必须是本地 owner 绑定的绝对路径，普通配置更新不得改变其信任边界。
- `directMessages.allowedRecipientMids` 必须为非空正整数数组后才允许实际发送。
- `diary.publicBook` 与 `privateBook` 不得同时关闭后仍请求写日记。
- `publishing.provider` 仅允许 `manual|external`。
- `publishing.provider=external` 且非干跑时，`security.allowExternalPublisher` 必须为 true，且 command 非空。
- `rateLimit.minGapMs >= 500`，`writeGapMs >= 30000`。
- 数值不得使用 `Number(value) || default` 处理合法的 0。
- `schemaVersion=1`；`timeZone` 必须为有效 IANA 时区，日额度与日记统一使用该时区。迁移不重置时间窗口；跨日规则变更不得清空已占额度。
- 本期 `platforms.enabled` 只允许 `bilibili`；将 X/抖音列为启用平台必须拒绝，契约测试不代表可启用。
- `im.adapterId` 本期仅 `dsh-im`，`maxMessageAgeSec/approvalTtlSec` 为 60–3600；`groupReplies` 为 `summary|none`。通知 `minGapMs>=1000`、`perMinute` 为 0–60，0 表示禁发。
- `production.backend=remote` 返回 `CAPABILITY_UNSUPPORTED`，不得回退 local；本期实际运行仅 local。`maxConcurrent=1`，生产阶段串行。
- 本期 `production.requireApproval` 必须为 true；`publishing.autoPublish` 必须为 false，`publishing.requireApproval` 必须为 true。保留字段用于未来明确修订，不能作为本期绕过人工审批的开关。
- `production.limits.wallTimeSec` 为 1–86400；`maxPaidCostMinor` 为非负安全整数，0 禁止付费；`currency` 本期为 CNY，不能做隐式汇率换算。调用限制只能收紧配置上限。
- 字节数及 `migration.maxFiles` 必须为正安全整数；迁移超过上限必须预检拒绝，不能跳过文件后宣称完整。
- `migration.mode` 只允许 `offline`。Profile 未绑定工具、目录未授权或 `allowLocalProducer=false` 时不能真实生产，干跑返回阻断项。

### 4.5 配置更新

- 更新只允许已知键，按结构深合并；角色权限来自可信上下文，不来自请求正文。
- HTTP PATCH 仅允许管理员修改业务开关及限额；不能修改 `dataDir/credentialsFile/timeZone`、任何目录/命令/参数/模型地址/Key 环境变量名、`platforms/im/migration/security`、生产 profile/backend 或主体绑定。这些字段只能由受信本地 owner CLI 修改，模型工具与 IM 不开放配置管理。
- HTTP 业务开关调整不得关闭本期强制审批或把 dryRun 从 true 改为 false；提权及生产执行器注册必须回到本地确认。
- 更新前必须完整校验，失败不得写文件；本机处于迁移封存/退役时不得通过改配置绕过禁写。
- 配置写入必须采用同目录临时文件 + rename；每次校验成功的写入在同一 Store 事务中把 `configRevision.version` 单调加一，并以 `SHA256(JCS(规范化非秘密配置))` 更新 `configRevision.sha256`。各进程在派发时同时核对 version/hash 与当前配置，不能使用旧缓存绕过新禁用项；备份/迁移 manifest 同时保存这两个值和 timeZone。
- 配置读取和错误响应必须递归脱敏。

### 4.6 Dry Run 与真实执行优先级

全局 `dryRun`、`production.dryRun`、`publishing.dryRun` 是安全否决项，调用参数只能进一步强制干跑：

```text
effectiveDryRun(feature, invocation) =
  config.dryRun
  OR (feature === production AND config.production.dryRun)
  OR (feature === publishing AND config.publishing.dryRun)
  OR invocation.mode === "dry"
```

| 全局 dryRun | 对应功能 dryRun | 调用模式 | 最终结果 |
|---|---|---|---|
| true | 任意 | dry / go / 自动 | 干跑，不能生产或外发 |
| false | true | dry / go / 自动 | 对应生产或发布功能干跑 |
| false | false | dry | 干跑 |
| false | false | go | 通过启用、权限、审批、额度及派发栅栏后才可执行 |
| false | false | 自动任务 | 不提升权限；本期不自动创建生产或投稿任务 |

- 结果必须包含 `executionMode`；go 被否决时附 `blockedBy`：`global_dry_run/production_dry_run/publishing_dry_run`。
- 平台写、生产执行和发布的 HTTP/CLI/IM 请求必须显式 `mode:dry|go` 或 `--dry|--go`。草稿和查询不需要；审批干跑不会消费真实执行授权，之后 go 仍需有效人工审批。
- 干跑 Task 可以成功完成预检，但 `result.readyForPublish=false`，不得产生已发送/已生产业务键、付费预留或启动生产进程。
- 浏览/日记需要的模型增强另受 `agent.enabled` 控制；生产干跑不调用任何模型/生图/TTS。预算只覆盖本插件发起的生产调用，不声称包含宿主聊天费用。
- IM 对原会话的受限控制回信是明确配置的控制通道，不被业务 dryRun 禁止；它必须遵守 `im.notifications`、受众权限、独立限流、outbox 与迁移派发栅栏，不能借控制回信向任意收件人发内容。
- 素材导入、审批审计、人工补录和迁移不冒充平台外发；使用专用本地确认/权限机制，不通过 `--go` 自动取得管理员权限。

## 5. 凭据规范

### 5.1 字段

```json
{
  "sessdata": "",
  "bili_jct": "",
  "buvid3": "",
  "dedeuserid": ""
}
```

环境变量：

- `BILI_SESSDATA`
- `BILI_JCT`
- `BILI_BUVID3`
- `BILI_DEDEUSERID`

Agent Key 的环境变量名由 `agent.apiKeyEnv` 指定，默认 `DEEPSEEK_API_KEY`。

### 5.2 要求

- 写操作必须具备 `sessdata` 和 `bili_jct`。
- Cookie 只发往明确允许的 B 站域名，不得发往字幕 CDN 或外部模型地址。
- 凭据保存必须原子化，并尝试设置最小文件权限。
- 账号身份必须为 `platform + whoami() 核验后的稳定 accountId`；B 站使用 MID 的十进制字符串。SESSDATA 摘要只作为 `credentialRevision`，不进入账号防重命名空间。
- 同一 MID 更新 Cookie、重启或迁机必须沿用原额度、businessKeys 与未决 Operation。凭据变化后重新 whoami，无法核验时平台写入 fail-closed；不得通过清空账本恢复。
- 配置中的 owner.mid、Cookie 声称的 dedeuserid 均不能替代 whoami 结果；不一致必须提示并暂停写入。
- 切换为不同 MID 后使用独立命名空间，旧记录保留；进行中的操作固定其原 accountRef 与凭据版本，不能转用新账号完成。
- 生产端不接收 B 站 Cookie、宿主环境全集或账本写权限。模型、IM 机器人秘密分别由对应受信网关读取，迁移包不携带秘密值。

## 6. Store 规范

### 6.1 状态结构

```json
{
  "version": 3,
  "workspaceId": "",
  "historyEpoch": "",
  "configRevision": { "version": 1, "sha256": "" },
  "recovery": { "id": null, "phase": "normal", "revision": 0, "holds": [] },
  "activeAccountRef": null,
  "accounts": {},
  "operations": {},
  "businessKeys": {},
  "requests": {},
  "tasks": {},
  "videos": {},
  "events": [],
  "eventSeq": 0,
  "journalPending": {},
  "journalSegments": {},
  "cursors": {},
  "diaries": {},
  "rate": {},
  "publishes": {},
  "principals": {},
  "bindings": {},
  "approvals": {},
  "inboxKeys": {},
  "outbox": {},
  "artifacts": {},
  "productions": {},
  "executions": {},
  "budgets": {},
  "migration": { "phase": "active", "id": null }
}
```

### 6.2 事务要求

- 所有读—判断—修改—写必须在一个排他事务内完成。
- 文件锁必须通过原子创建获得，记录 `instanceId/ownerPid/processStartedAt/leaseToken`，支持存活检查及超时；仅租约过期不足以删除活属主的锁，PID 复用或无法判断时 fail-closed。
- 锁不得在网络请求或渲染期间持有；允许短暂的本地原子提交。
- 写状态前重新读取最新文件，不能使用过期内存快照覆盖其他进程更新。
- 状态JSON损坏时先fail-closed，不把坏文件改名后初始化为空账本。仅可由§27的独立恢复管理入口从可信备份建立只读副本；现有实例不得自动选旧快照并继续运行。
- 临时文件必须包含进程/PID或随机后缀；持久提交须flush文件并在平台支持时同步目录元数据，再报告成功。原子rename不等于异盘备份或断电零丢失，介质耐久性限制必须记录。
- 最近 2000 个 `events` 只是热缓存；500 个 Task、5000 个 Operation 的普通清理仅适用于已结算记录。任何 `isSettled=false` Task、其 Operation/审批/执行/请求引用及 unknown 均不得按数量淘汰。
- 已确认业务键必须写入独立 `businessKeys`，至少含 key、namespace、类型、目标、首次/最近确认时间和回执摘要。它不参与 Operation 数量清理；停机迁移必须完整保留。
- `reserved/dispatching/unknown` 的动作也占用其业务键；不能只查询 confirmed 索引就放行。`failed/cancelled/not_sent` 不写成功效果，但保留审计及受控重试链。
- 创建 Task、登记请求幂等键、生成事件和相应通知 outbox 必须在同一事务完成；不能先回 IM accepted 再异步落账。
- 核心是唯一账本规则实施者；同机宿主和 CLI 可调用它的排他事务，生产子进程、适配器和 Agent 不自行修改账本。

### 6.3 事件归档与版本

- 每个事件含 `eventId/historyEpoch/seq/workspaceId/accountRef/type/taskId/occurredAt/payload`。eventId全局唯一，seq在同historyEpoch内递增；正常迁移保留epoch，灾备开启新epoch并记录父恢复点，不能声称恢复点与丢失尾部之间连续。所有事件游标、归档段、日记及checkpoint水位必须同时携带epoch与seq，不能比较不同epoch的裸seq。
- 无平台账号的生产事件使用accountRef=null。payload以摘要/回执/ArtifactRef为主，单条上限64KiB，不嵌入媒体字节、完整字幕或完整私信。超限改用受管引用，不能静默截断关键回执或幂等字段。
- 业务事务同时写热缓存及journalPending。归档按historyEpoch分目录/索引命名，例如 `journal/<historyEpoch>/<startSeq>-<endSeq>-<hash>.json`；同目录临时文件flush后rename，再事务登记段摘要并移除对应pending。崩溃凭eventId及(epoch,seq)去重，不丢未确认pending；不同epoch相同seq不得覆盖同一路径/索引。
- 段写入失败时保留 pending；达到安全积压阈值时暂停新任务，不能清空旧事件换取可用性。日记读取归档＋pending 的一致性截止序号快照，而非仅热缓存。
- journalPending达到10000条时阻止新业务接纳和新阶段派发，仍允许在途回执落账及归档收尾；超过阈值不是丢事件理由。阈值与文件字节占用应在状态中可观察。
- 归档段缺失、损坏或 seq 冲突时停止相关重建和迁移激活，不以不完整事件覆盖既有日记。
- 本版因新增historyEpoch和灾备门禁将账本提升为version=3；普通接口/业务配置schemaVersion仍为1，迁移与备份manifest必须显式声明stateVersion=3。旧草案v1/v2没有自动升级器，不因JSON可解析而当作v3恢复；未知版本拒绝，不清空重建。
- 事件归档与永久防重索引有长期磁盘增长成本；首版保留并报告容量，不实现自动删除历史事实或多机共享JSON。账本与恢复所需元数据达到80MiB时进入容量预警并停止非必要后台生成，达到100MiB时停止接纳新业务和受保护派发，只允许归档、核查、备份与恢复收尾；owner 可通过保留全部 businessKeys/未知引用的压缩快照和分段归档释放热文件空间，但不得删除永久防重事实。归档用于业务事实投影，不是已证明可重放全部状态的WAL；不得仅凭摘要事件或连续seq推断所有派发均已记录。

### 6.4 Store 公共接口

```js
const store = new JsonStore({ file, lockTimeoutMs, staleLockMs, now })
await store.init()
await store.getSnapshot()
await store.transaction(async draft => result)
await store.appendEvent({ type, actor, payload })
await store.close()
```

`transaction` 回调不得执行网络请求或长时间等待。`appendEvent` 只能在 `transaction` 回调内调用，并与其业务状态、journalPending、请求幂等记录和通知 outbox 在同一 draft 中一次提交；独立调用必须拒绝，不得先落事件后补业务或先回 IM accepted 再异步落账。

## 7. RateLimiter 与 Operation 规范

### 7.1 读取

- 每次读取前预留读额度与时间槽。
- 只读请求可以针对明确可重试错误重试，默认最多 1 次。
- 相同 GET 可以合并进程内并发，但不得跨账号共享。

### 7.2 写入

写请求预留必须在同一 Store 事务中完成：

1. 检查本机激活状态、迁移栅栏、§27的备份保护/恢复scope冻结、最新配置、权限和审批；
2. 检查对应平台/服务的熔断及人工暂停；
3. 检查已确认和未决业务键；
4. 检查对应额度桶、目标冷却和模块限额，预留额度；
5. 创建 `status=reserved` 的 Operation；
6. 更新下一个允许调度槽位。

等待槽位后、实际发送前，必须再次在事务内核对派发栅栏和授权、写入 `dispatchAt/status=dispatching`，随后才执行一次。禁止在 prepare 后派发此前已 reserved 的请求。明确尚未派发的取消可释放预留；unknown 保留占用，confirmed 转为已使用，不可用重启或切凭据重置。

B 站额度按稳定账号与时间窗口分桶；生产付费调用按工作区/Provider/预算授权分桶；IM 通知另用 §22 的发送预算。它们共享状态与安全原则，但不能互相消耗或绕过对方额度。

### 7.3 结果、恢复与人工核查

| 当前状态/事件 | 合法后续 | 额度、业务键与重复派发处置 |
|---|---|---|
| reserved；二次复核失败 | reserved，或人工/系统明确取消为 cancelled；证明启动前失败可为 failed | 复核失败不释放；仅证明未派发并结算时释放未用预留，保留原业务键和审计 |
| dispatching；发送前检测到失败 | 能证明从未越过派发边界才可 failed/cancelled，否则 unknown | 边界不明一律冻结，不按未发送释放 |
| 已派发后超时/退出/终止/回执损坏 | unknown | 冻结额度与业务键，禁止自动重试 |
| confirmed | 终态 | 按可核验实际费用/次数结算，写永久业务键 |
| not_sent | 终态 | 仅凭可靠未执行证据释放未用预留，保留审计及受控重试链 |
| partial/部分费用或部分副作用 | 按子项 confirmed/failed/unknown 分别记录 | 逐项结算；任一 unknown 保持对应占用，不按整体失败释放 |

- 明确业务成功：`confirmed`。
- 平台明确拒绝且可确定未执行：`failed`。
- 请求已派发后发生网络错误、超时或无法解析回执：`unknown`。
- `unknown` 不得自动重试；只允许受信本地人类 `resolve({operationId, decision, receipt, note}, principal)`，decision 为 `confirmed|not_sent`。平台/Provider 回执结构由动作类型校验，不能只填一个成功布尔值。
- `confirmed` 的发布核查必须带平台、postId（B 站为 BV）、来源及确认信息；更新原 Publish 和原 Operation。`not_sent` 必须有核查说明或可靠未执行回执，超时、非零退出码、杀进程本身均不是未执行证明。
- 失败或 not_sent 后是否允许新 attempt 由业务规范决定，必须人工明确恢复、保留原 request/operation 链；不得随机换业务键、删除历史或由自动流程重发。
- Operation 至少保存 `namespace/accountRef/status/instanceId/ownerPid/processStartedAt/createdAt/dispatchAt/finishedAt/businessKey/taskIds/resultSummary`。
- 普通同机重启仅在账本历史完整且可证明属主已消失时，无dispatchAt的reserved才可转cancelled；dispatching有派发边界则unknown。跨机旧PID仅审计。
- 从备份恢复时必须优先执行§27，不能套用上述普通重启推断：快照中的reserved/queued/未消费审批可能在恢复点后已执行。已知未决记录保留待核查，无法枚举的遗漏动作由scope级RecoveryHold覆盖；备份里没有记录不等于not_sent。
- 属主仍存活、PID 无法可靠判断或派发边界不明确时，恢复必须保守处理，不得自动放行重发。
- 恢复只改变状态，不得自动重放平台写、付费生成或结果未知的通知。
- `resolve(confirmed)` 必须在一个事务内更新 Operation、写入 `businessKeys`、应用对应业务结果、重算关联 Task，并追加 `operation.confirmed` 事件。
- `resolve(not_sent)` 必须更新 Operation、重算关联 Task 并追加 `operation.not_sent` 事件，不得写成功业务效果。
- 同一 Operation 重复 resolve 为相同结果应幂等返回；已从 confirmed 改为 not_sent 或反向修改必须拒绝，避免破坏审计。
- Diary 通过事件感知 resolve 后的最终状态，同日下一修订版必须反映该变化。

### 7.4 风控

- HTTP 412/429 或业务码 `-412,-352,-799,-509,-10403` 触发指数熔断。
- 初始 5 分钟，最大 30 分钟；尊重合法 `Retry-After`。
- 登录失效/验证码要求转为人工暂停，不得持续请求。

## 8. BilibiliClient 规范

### 8.1 构造与通用行为

```js
const client = new BilibiliClient({
  config, credentials, store, rateLimiter, fetchImpl, now, logger
})
```

- 每个响应必须检查 HTTP 状态、JSON 结构和 B 站 `code`。
- 成功必须依赖业务回执，而非仅 `response.ok`。
- 日志不得包含 Cookie、完整表单或完整私信。
- 所有写方法只接受核心已持久预留并准许派发的 OperationContext，校验 operationId、accountRef、inputHash 与当前派发许可；不得从 HTTP/IM 透传伪造上下文。预留由核心完成一次，协议客户端不再重复预留或使用另一套 businessCheck 账本。

### 8.2 WBI

- 从 `/x/web-interface/nav` 获取 `wbi_img`。
- 使用固定 mixin 顺序、`wts` 和 MD5 计算 `w_rid`。
- WBI key 可缓存 10 分钟；失败不得使用空 key 发请求。
- `signWbi(params, images, now)` 必须作为可单测纯函数导出。

### 8.3 读取方法

| 方法 | 接口/来源 | 返回重点 |
|---|---|---|
| `whoami()` | `/x/web-interface/nav` | mid、uname、isLogin |
| `popular(limit)` | `/x/web-interface/popular` | 标准 Candidate 摘要 |
| `search(keyword, limit)` | `/x/web-interface/wbi/search/type` | 标准 Candidate 摘要 |
| `videoDetails(bvid)` | `/x/web-interface/wbi/view` | aid、bvid、cid、标题、简介、UP、时长 |
| `subtitles({bvid,cid})` | `/x/player/v2` + 字幕 URL | 纯文本、语言、来源 |
| `comments(aid, limit)` | `/x/v2/reply` | 热评文本与 rpid |
| `relation(mid)` | `/x/relation` | attribute/be_relation |

字幕下载仅允许 HTTPS 且属于允许的 B 站/HDSlb 域名；不得携带 Cookie。

### 8.4 评论

```js
await client.sendComment({
  aid, bvid, text, root = 0, parent = 0,
  operationContext
})
```

- 接口：`POST /x/v2/reply/add`。
- 正文长度与 CSRF 必须预先校验。
- 成功应返回 `rpid/root/parent` 等回执。
- 平台 code 非 0 不得标记成功。

### 8.5 私信

```js
await client.sendDirectMessage({
  recipientMid, text, operationContext, requireMutual
})
```

- 接口：`POST https://api.vc.bilibili.com/web_im/v1/web_im/send_msg`。
- 使用稳定 `msg[dev_id]`，并持久化，不得每条消息更换设备。
- `msg[content]` 为 `{"content":"..."}` 的 JSON 字符串。
- 默认要求互关；自己给自己发送必须拒绝。
- 成功应有明确成功 code 和可记录回执；无法判断时按 unknown。

## 9. AgentClient 规范

```js
await agent.generateText({ task, input, maxChars })
await agent.generateJson({ task, input, schemaName })
```

- 仅使用 `POST <baseUrl>/chat/completions`。
- API Key 从 `process.env[agent.apiKeyEnv]` 读取。
- 外部素材必须封装为“不可信内容”，不得赋予工具或权限指令。
- JSON 输出可去除 Markdown 代码围栏，但解析失败必须报错。
- Agent 失败不得绕过审批或直接外发。
- Agent 不掌握凭据，不得接收 Cookie。

## 10. TaskManager 规范

### 10.1 Task 状态

仅允许下列白名单迁移；初始状态为 `queued`，未列出的迁移必须拒绝：

| 来源 | 合法目标 | 条件 |
|---|---|---|
| queued | running / waiting_approval / awaiting_manual / cancelled | 接纳、需要审批/人工或尚未开始即取消 |
| running | succeeded / partial / failed / waiting_approval / awaiting_manual / unknown / interrupted / cancelled | cancelled 仅限已证明全部剩余工作未派发且无副作用；否则转 unknown/partial |
| waiting_approval | running / cancelled / failed | 批准后重新预检；拒绝/撤销；批准时校验失败 |
| awaiting_manual | succeeded / failed / cancelled / unknown | 依据人工事实登记；仍有未知副作用时不得 cancelled |
| unknown | running / succeeded / partial / failed | 仅由 Operation 核查或人工恢复重算，不自动派发 |
| interrupted | running / unknown / failed / cancelled | 人工 resume；无法确定派发边界须 unknown |
| partial / failed | running / succeeded / partial / failed | 仅人工恢复或核查重算；保留原 Task/Operation 链 |

`waiting_approval`、`awaiting_manual`、`unknown` 不是终态；含未决操作的 `partial/failed` 也不能视为已结算。任何回流保留原 Task ID、输入修订、状态历史和 Operation 链，禁止自动重新派发。合法字段组合为：`queued/waiting_approval/awaiting_manual/interrupted` 固定 `isSettled=false, executionActive=false`；`running` 固定未结算，executionActive 按实际执行槽位；`unknown` 固定未结算且不活跃；`succeeded/cancelled` 必须 settled 且不活跃；`partial/failed` 由未决 Operation/审批/人工事项计算，任何 unknown 都使 `isSettled=false, finishedAt=null`。

`isSettled` 表示业务及人工事项是否结算，`executionActive` 表示是否仍占执行槽位，不能用一个 status 推导二者。字段至少包括：

```json
{
  "id": "task_uuid",
  "workspaceId": "workspace_uuid",
  "principalId": "principal_uuid",
  "accountRef": null,
  "parentTaskId": null,
  "childTaskIds": [],
  "kind": "browse",
  "status": "running",
  "isSettled": false,
  "executionActive": true,
  "trigger": "scheduler",
  "input": {},
  "inputHash": "",
  "revision": 1,
  "attempts": 1,
  "createdAt": "",
  "startedAt": "",
  "finishedAt": null,
  "cancelRequestedAt": null,
  "result": null,
  "error": null,
  "operationIds": [],
  "pendingOperationIds": [],
  "holds": [],
  "executionIds": []
}
```

### 10.2 要求

- DSH prompt/HTTP 请求被接受不等于 Task 成功。
- 完成状态必须由业务模块回写。
- 全部必需步骤成功或合理跳过且无未决项才 succeeded；部分成功且存在失败/unknown 为 partial；没有成功但含unknown时优先为unknown，即使同时有明确失败；仅无未决项的明确失败可结算为failed。父任务还需汇总关联子任务，不能把“已创建待审批子任务”当作步骤成功。
- `waiting_approval` 批准后必须回到原 Task 的 `running` 并重新检查额度；`awaiting_manual` 登记有效人工回执后才可转为 `succeeded`。
- Operation resolve 后重算关联 Task 和 `pendingOperationIds`；存在 unknown 或未完成审批/人工处理时 `isSettled=false`、finishedAt=null，不得清理或标为已安全取消。
- 同类自动执行默认单飞；等待人工的记录释放执行槽位但保留业务键/审批/额度保护，不能阻塞所有后续浏览。生产首版并发上限为1，仍运行的孤儿进程不得被当作已释放槽位。
- `cancelRequestedAt` 只表明请求取消。尚未派发可取消；已派发须等待实际停止和副作用核查，成功回执先到则保留成功，不伪装撤销。已发生的费用不因 Task 取消而退回额度。
- 重启后可读历史；完整账本下属主确实消失的运行任务标interrupted或unknown，不自动重放。人工resume须核验checkpoint、配置/权限、未决副作用及有效审批。
- 灾备恢复的旧Task统一附recoveryHold并保留快照状态作为历史证据，未完成§27核查/解冻前不得resume、重新投递或以新requestId绕过scope冻结；缺原任务的外部事实单独登记RecoveryCase，不伪造旧taskId。
- 生产 Task 的成功还需 §24 的必需阶段/产物验证；仅脚本成功或干跑通过不代表已有可发布视频。
- `status/tasks` 是插件任务视图，不承诺聚合 DSH 全部会话、桌宠脉冲或 IM 通知送达状态。

## 11. Browse 模块规范

### 11.1 Candidate

```json
{
  "contentRef": { "platform": "bilibili", "contentId": "BV_EXAMPLE" },
  "title": "",
  "description": "",
  "author": { "accountId": "0", "name": "" },
  "durationSec": 0,
  "subtitle": { "text": "", "lang": "", "source": "" },
  "topComments": [],
  "score": 0,
  "source": "popular",
  "platformData": { "aid": 0, "cid": 0 }
}
```

示例 ID 仅用于说明，不是有效平台回执。B 站适配器将 contentId 映射为 bvid，将 platformData.aid/cid 传给 §8；通用调度、事件和产物模块不得读取 BV 格式或 B 站私有字段。

### 11.2 功能要求

- `FR-BRO-001`：自动模式仅在 `browse.enabled=true` 且 scheduler 启用时运行。
- `FR-BRO-002`：候选按账号和 BV 去重，多来源同一 BV 只处理一次。
- `FR-BRO-003`：已成功处理或核验为稳定账号自有内容的视频不得在每轮重复处理；自有内容直接过滤且不产生待互动候选，失败记录采用可配置冷却，不得立即死循环。
- `FR-BRO-004`：详情读取失败不计为“已看懂”；无字幕且未配置替代内容时必须按配置跳过。
- `FR-BRO-005`：单视频失败不得终止整轮；结果必须列出失败项。
- `FR-BRO-006`：确定性评分至少考虑关键词、时长、字幕充分度和来源；不得仅以播放量判断质量。
- `FR-BRO-007`：Browse 不得直接评论或私信，只输出 Candidate 和事件；评论/DM 在生成任何待审批草稿前还必须按已核验 accountRef 排除作者为自身的 Candidate，禁止自我评论或向自己分享。
- `FR-BRO-008`：默认不伪报播放进度；`markWatchHistory` 未实现真实播放前保持关闭。

### 11.3 输出

这里的 `status` 是 Browse 轮次结果，不是 Task.status 枚举。全部候选均合理跳过且无失败时，Task 以 `succeeded` 结算并在 result 中记录 `status=skipped` 及跳过数量；存在失败时为 partial，存在 unknown 时按 §10 保留未结算，不新增 Task 的 skipped 状态。

```json
{
  "status": "succeeded|partial|skipped",
  "selected": [],
  "failed": [],
  "skipped": [],
  "roundId": "task_uuid"
}
```

## 12. Comments 模块规范

- `FR-COM-001`：`comments.enabled=false` 时不得自动评论。
- `FR-COM-002`：`approval` 模式只生成草稿，状态 `waiting_approval`；批准必须记录操作者/来源。
- `FR-COM-003`：`auto` 模式才可由 Coordinator 自动发送。
- `FR-COM-004`：无 Agent 且 `allowTemplate=false` 时，不得自动生成模板评论。
- `FR-COM-005`：每条评论独立检查 `dailyLimit/perRound/sameVideoDays/maxLength`。
- `FR-COM-006`：同 BV 同渠道在冷却期内不得重复，即使正文不同。
- `FR-COM-007`：相同规范化正文不得用于不同视频进行批量灌水。
- `FR-COM-008`：`mentionOwner=true` 时必须配置 owner.name，且最多 @ 一次。
- `FR-COM-009`：干跑只预检和返回草稿，不创建已发送记录。
- `FR-COM-010`：网络结果未知必须保留 Operation，不得自动重发。

草稿必须包含 `taskId/contentRef/platformData/text/inputHash/createdAt/expiresAt/status`；B 站 aid 位于 platformData。批准调用 §22 ApprovalService，绑定可信人类主体和原任务，不接受 `approved:true`。同一目标等待审批时也保留待处理索引，避免每轮生成重复草稿；批准后重新检查额度与去重。

## 13. DirectMessages 模块规范

- `FR-DM-001`：实际发送时收件人必须在白名单中。
- `FR-DM-002`：默认检查互关；显式关闭互关检查也必须保留白名单。
- `FR-DM-003`：不得向 Cookie 对应账号自身发送。
- `FR-DM-004`：每轮/每日额度和同目标分享冷却必须在预留事务中检查。
- `FR-DM-005`：可复用 Browse Candidate 形成分享，但不得由 DM 模块重新浏览。
- `FR-DM-006`：评论和私信拥有不同渠道操作键；同一 Candidate 可分别配置，但不能在同渠道重复。
- `FR-DM-007`：日志和日记默认只记录收件人 mid 与摘要，不记录完整私信正文。
- `FR-DM-008`：不支持陌生人批量发送，不接受收件人数组遍历发送。

## 14. Diary 模块规范

- 输入来自统一事件归档＋pending 和可选 Agent 叙述，不重新请求 B 站、不调用生产或发布。
- 身份为 `workspaceId + scope + date + book`。scope 是稳定平台账号，或无平台生产使用的 workspace；`scopeKey=SHA256(workspaceId + "\n" + scope)`，默认文件 `<diaryDir>/<scopeKey>/<public|private>/YYYY-MM-DD.md`。切换账号或 workspace 都不能覆盖其他身份同日日记。
- 包含日期、浏览数、评论/私信结果、生产阶段与产物就绪状态、失败/unknown、投稿状态及 Task ID；不能把生产完成写为已发布。
- 自动日记是截止 eventCursor 的事实重建，不持续追加。每次 Browse 后、每日定时和 resolve 后可重建；核查发生在次日时，将原操作日期与核查日期标为待更新。
- `diaries` 保存 `contentHash/revision/lastGeneratedAt/eventCursor/pendingCommit`，其中 eventCursor 始终为 `{historyEpoch,seq}`。事实输入未变化时复用原叙述，不再次调用模型制造无意义修订；变化才递增 revision。
- 大文本生成在锁外完成。提交时按日记身份串行，在短事务内核对基准 revision 与目标 eventCursor；旧快照不得覆盖已提交的新快照，冲突后重读重建。
- 使用可恢复双阶段提交：pendingCommit 至少包含 `{diaryId,expectedRevision,targetRevision,baseEventCursor,targetEventCursor,tempFile,targetFile,contentHash,phase,createdAt}`；先登记该意图，再原子替换正文，最后确认状态。启动时核对正文/临时文件摘要完成或撤销未完成提交；未恢复前不发布新修订。临时文件路径由核心生成。
- 任一归档缺失或损坏时 fail-closed，不能用不完整输入覆盖已有日记；超过2000热事件仍应完整重建。
- `force=true` 可重建，但不修改原事件。同内容保持事实一致；公共日记不得含秘密、完整私信、敏感路径，私人日记仍不得包含凭据。
- 日记默认只写本地文件，不自动作为IM附件或公开网页发送。
- 灾备后的日记仅使用可信父恢复点范围和经核查的新epoch事实，明确标注缺口/恢复来源，不把旧正文声称为最新完整记录。恢复核查事件按原Operation/业务键关联，不能按事件条数把同一外部效果重复计数；跨epoch裸seq不得作为覆盖依据。

## 15. Publishing 模块规范

### 15.1 投稿输入与原任务审批

```json
{
  "schemaVersion": 1,
  "requestId": "publish-request-001",
  "productionTaskId": null,
  "videoArtifactId": "artifact-video-001",
  "coverArtifactId": null,
  "accountRef": { "platform": "bilibili", "accountId": "123456" },
  "metadata": {
    "title": "标题",
    "description": "简介",
    "tags": ["标签"],
    "platformData": { "tid": 1 }
  },
  "mode": "dry"
}
```

ID 为结构示例，不是实际文件或账号。已有视频先通过本地素材导入生成 ArtifactRef，不要求先跑生产。来自生产的投稿必须确认其原 Task 已真实成功且 readyForPublish=true。

- 不接受输入 `approved:true`。go 且未批准时原 Task 为 waiting_approval，通过 §22 ApprovalService 对该 taskId/inputHash 批准后回流，不新建 Task。
- 审批绑定视频及封面摘要、元数据、目标平台与账号、Provider 配置版本。任一变化都必须重新批准；生产审批不能继承为发布审批。
- 本期未批准的发布请求只形成草稿；发布不由 Browse、生产完成事件或 IM 自然语言自动触发。

### 15.2 通用要求

- Artifact 必须存在、为核心管理的普通文件、类型及大小合规；派发前重新验证摘要。外部任意路径只能由本地受信导入入口转换，IM/HTTP 不能借 videoPath 读取服务器文件。
- 标题、简介、标签和分区由 PlatformAdapter 按实际能力验证；未确认的平台限制在适配器验收中列明，不假装已对真实接口验证。
- 业务键为 `publish:<platform>:<accountId>:<videoSha256>:<metadataHash>`；metadataHash 包含封面摘要和目标相关元数据。
- 待审批和 awaiting_manual 的 Publish 保留 pending 业务索引，重复创建返回原 Task，不因尚无 Operation 而生成多个待投稿任务。
- 不删除源视频、封面或用户目录。生产产物留在受管理 ArtifactStore；其目录由本地配置明确授权，不受 IM 请求扩大。

### 15.3 Bundle

每个 Bundle 含 metadata.json 与 PUBLISH.txt。元数据保存 schemaVersion、taskId、accountRef、ArtifactRef、metadata、状态和 operationId（未派发时为 null）。权威元数据不保存另一机器必须存在的绝对路径。

Bundle 可以引用本机管理的 ArtifactStore 而不重复复制大视频；停机迁移时必须把所有引用的实际字节纳入清单。外部命令的绝对路径由执行前临时解析，迁机后重新生成，不作为持久身份。

### 15.4 Manual Provider

- 人工审批后生成可执行投稿包并进入 awaiting_manual，不是 succeeded；干跑包明确标记不可视为已发布。
- `publish complete` 是受信本地人类事实登记入口，提交 taskId、平台 postId（B 站 BV）及确认来源/note；必须显式 --confirm，不能由 Agent/IM 冒充。它不主动访问平台，保存 verification=manual_assertion，不宣称平台回读验证。
- 仅对 Manual 且没有已派发/unknown 发布 Operation 的 Task 创建 manual_confirmation confirmed Operation；同一事务写 businessKeys、更新原 Publish/Task 和事件。
- 相同回执重复登记幂等；不同回执冲突拒绝。允许人类确认未发布/作废，但保留 Bundle、状态历史，不抹掉未决 Operation。

### 15.5 External Provider

- 仅 provider=external、allowExternalPublisher=true、非干跑、产物及账号核验通过且有有效人工审批时执行。
- 固定可信可执行文件＋execFile 参数数组，不走 shell；环境采用必要项白名单，平台凭据仅给显式获授权的发布适配器，不给生产 Runner。
- 占位符保留 `{video}/{cover}/{title}/{description}/{tags}/{tid}/{bundleDir}/{metadata}`；它们来自经过验证的元数据与核心路径解析。临时生成的包含本地路径的调用清单不进入迁移权威数据。
- 默认超时600秒；必须限制 stdout/stderr 总量并脱敏，退出0不是业务成功证明。
- B 站桥接最低成功回执为 `{"ok":true,"bvid":"有效BV","url":"平台地址"}`；适配器转换为 §21 Receipt，记录 verification=publisher_receipt。格式及账号/任务关联验证不能冒充平台回读。
- 启动前确定失败可 failed；启动后超时、输出损坏、无有效回执或不能证明未执行的非零退出均为 unknown。已启动 External 不得降级 awaiting_manual 来绕过 unknown。
- 人工查到 BV 后调用 §7 resolve 附回执，核销原 Operation、更新原 Publish/Task；不能走 Manual complete 再造成功操作。未知键未核销前不得再发布。

### 15.6 限制声明

本期不包含原生 UPOS/archive submit，不默认接入某个第三方上传工具。外部发布器必须单独验证接口与输出；未配置时只提供 Manual。Bundle 创建、进程退出、生产完成均不能冒充平台发布成功。

## 16. Coordinator 规范

- 唯一的自动调度入口。
- 默认可调度 Browse 和 Diary；评论/DM 可消费 Browse 结果。生产仅由明确生产命令触发，投稿仅由独立投稿命令触发，不将浏览、生产、发布串成默认自动链。
- 每类自动执行必须有活跃锁；正在执行的同类轮次不能重入，等待人工的记录按 §10 释放执行槽位而不释放业务防重。
- Browse 成功后，Candidate 按配置传给评论和 DM；各渠道最多消费自己的 perRound。生产失败不阻塞普通浏览。
- Diary 从统一事件生成，含平台无关生产事件，不持有各模块私藏事实副本。
- 一个后置步骤失败不撤销已成功步骤，Task 为 partial 并记录未决集合。
- start/stop 必须幂等；stop 停止新任务，等待或保守标记现有执行，不把可能已发生的副作用伪装为取消。
- 配置下一轮生效；实际派发还须核对最新权限、配置 revision 与迁移栅栏，禁止旧内存配置继续外发。
- IM 适配器只投递 CommandService，不自建另一套调度器；生产执行器只上报执行事件，不能直接创建投稿或改业务账本。

## 17. DSH API、工具与 CLI

### 17.1 HTTP API

以下是本插件拟定义的入口，不是已验证宿主 SDK。统一前缀 `/dsh-bili-unified/api`，所有动作调用同一 CommandService/ApprovalService。

| 方法 | 相对路径 | 功能与约束 |
|---|---|---|
| GET | `/status` | 本地缓存的能力、Task/Operation/熔断状态，不自动请求平台登录接口 |
| GET | `/config` | 管理员脱敏配置 |
| PATCH | `/config` | §4.5 的管理员业务字段白名单 |
| POST | `/run/browse` | 手动一轮，参数 mode 不提升任何后置步骤权限 |
| POST | `/run/diary` | 授权 scope 的日记生成；显式 `{date,scope,force}`，force=true 只触发重建、不修改事件 |
| POST | `/comments/draft` | 创建草稿及审批请求；接受 contentRef 或显式 parent/root 回复引用，由适配器校验目标，不接受裸 platformData 越权 |
| POST | `/comments/approve` | 评论动作兼容入口；仅把 comment 的 approvalId/decision/nonce/mode 转换为统一 `/approvals/decide` 调用，共用同一ApprovalService/原Task回流，不另建审批状态，不接受裸 approved 布尔值 |
| POST | `/dm/send` | 有权限主体的白名单私信，mode 必填 |
| POST | `/production` | 创建生产任务或干跑，返回持久 taskId |
| POST | `/publish` | 创建独立投稿任务，不能继承生产审批 |
| POST | `/approvals/decide` | 受信人类上下文的批准/拒绝，按原 taskId 回流 |
| GET | `/tasks` | 按主体过滤的有界列表 |
| GET | `/tasks/:id` | 授权任务详情及执行阶段，不回显秘密/敏感路径 |
| POST | `/tasks/:id/cancel` | 提交取消请求，不保证同步取消成功 |
| POST | `/tasks/:id/resume` | 人类显式恢复安全阶段，仍需权限、审批、unknown 检查 |

- 所有非公开读取和写入需经宿主信任栅栏及主体权限检查；本机来源不等于管理员。写 API 必须通过 `connection.requestRejection` 或实施前验证过的等价机制；无法建立可信主体则 fail-closed。
- 不提供公开IM webhook、远程Worker、迁移、备份导出/灾备恢复/解冻、凭据管理、任意文件导入路由。Manual complete、Operation resolve和§27灾备管理仅受信本地人类CLI可用；模型工具与IM不得调用。status只显示脱敏的备份年龄、恢复阶段及冻结原因，不回显备份路径或事故证据内容。
- 请求体1MB；错误含稳定 code，不含秘密。HTTP 映射如下，未列路径参数错误为400，未知路由404/`CAPABILITY_UNSUPPORTED`：

| HTTP | 稳定错误码 |
|---|---|
| 400 | CONFIG_INVALID、PUBLISH_INPUT_INVALID、INPUT_REQUIRED、ARTIFACT_INVALID、AGENT_OUTPUT_INVALID |
| 403 | FORBIDDEN、CREDENTIAL_MISSING、RECIPIENT_NOT_ALLOWED、MUTUAL_FOLLOW_REQUIRED、EXTERNAL_PUBLISH_DISABLED、IDENTITY_UNVERIFIED |
| 404 | CAPABILITY_UNSUPPORTED（reason=route_not_found/task_not_found） |
| 409 | FEATURE_DISABLED、APPROVAL_REQUIRED、APPROVAL_STALE、DUPLICATE_OPERATION、DUPLICATE_TARGET、IDEMPOTENCY_CONFLICT、OPERATION_UNKNOWN、MIGRATION_BLOCKED、BUDGET_EXCEEDED、QUOTA_EXCEEDED |
| 429 | RATE_LIMITED |
| 501 | CAPABILITY_UNSUPPORTED（未实现的预留能力） |
| 503 | TRUST_UNAVAILABLE、DEPENDENCY_UNAVAILABLE、BILI_API_ERROR、AGENT_DISABLED、STORE_CORRUPTED、JOURNAL_CORRUPTED、BACKUP_UNPROTECTED、BACKUP_STALE、BACKUP_INVALID、RECOVERY_REQUIRED、RECOVERY_GAP、RECOVERY_FENCING_REQUIRED |

同一码的 reason 不得改变其主语义；T10 必须对每个 §18 错误码建立双列映射并做序列化测试。

### 17.2 DSH 工具

在工具服务可用且主体可验证时按需注册 status、browse、comment_draft、dm、diary、production、publish、task_get、task_cancel 的 `bili_unified_` 前缀工具。输出为无损 JSON，服务缺失不影响核心/CLI。

工具调用者身份是 Agent，不因为提示词或用户授权文本自动变为 human。生产/发布可创建草稿，真实执行必须等待独立人类审批；不注册 approve/resolve/publish_complete/config/migration 工具。DM 等没有交互审批的动作仍要求显式授予该主体动作权限、开关、白名单和 mode。

### 17.3 CLI

```text
node cli.mjs status
node cli.mjs config validate
node cli.mjs config update --file <json-file> --confirm
node cli.mjs account verify --platform bilibili
node cli.mjs browse --dry
node cli.mjs diary --date YYYY-MM-DD --scope <scope> [--force]
node cli.mjs comment --draft <json-file>
node cli.mjs approval decide <approval-id> approve|reject --confirm --dry|--go
node cli.mjs dm --to <mid> --text <text> --dry|--go
node cli.mjs artifact import --file <path> --role <role> --confirm
node cli.mjs production --job <json-file> --dry|--go
node cli.mjs task get <task-id>
node cli.mjs task cancel <task-id> --confirm
node cli.mjs task resume <task-id> --confirm --dry|--go
node cli.mjs publish --job <json-file> --dry|--go
node cli.mjs publish complete <task-id> --bvid <bvid> --confirm --note <note>
node cli.mjs operation resolve <id> confirmed|not_sent --receipt <json-file> --note <note> --confirm
node cli.mjs outbox resolve <outbox-id> confirmed|not_sent --receipt <json-file> --note <note> --confirm
node cli.mjs im bind --file <binding-json> --confirm
node cli.mjs im revoke <binding-id> --confirm
node cli.mjs migration prepare --target <instance-id> --confirm
node cli.mjs migration export <migration-id> --out <directory>
node cli.mjs migration release <migration-id> --confirm
node cli.mjs migration import --from <directory> --data-dir <new-empty-directory>
node cli.mjs migration validate <migration-id>
node cli.mjs migration activate <migration-id> --receipt <file> --confirm
node cli.mjs migration status
node cli.mjs migration abort <migration-id> --confirm
node cli.mjs migration disable-target <migration-id> --confirm
node cli.mjs migration rollback <migration-id> --confirm
node cli.mjs backup policy --file <policy-json> --confirm
node cli.mjs backup create --kind ledger|full --confirm
node cli.mjs backup verify <backup-id>
node cli.mjs backup status
node cli.mjs backup prune --dry
node cli.mjs backup prune --plan <plan-id> --confirm
node cli.mjs recovery restore --from <backup-directory> --to <new-empty-directory> --confirm
node cli.mjs recovery inspect <recovery-id>
node cli.mjs recovery reconcile <recovery-id> --evidence <json-file> --confirm
node cli.mjs recovery authorize <recovery-id> --scope <scope-id> --evidence <evidence-id> --confirm
```

- CLI 是接口设计，不表示命令已存在。平台写、生产/恢复 go 必须显式选择 mode；本地管理动作使用专用确认而非滥用 dry/go。
- 人类敏感命令须验证受信交互终端及展示绑定内容的确认挑战，或宿主提供的经验证人类证明；单有 `--confirm` 或普通进程身份不足以证明 Agent 代表人类。无法建立证明则拒绝敏感动作，不靠 body.actorKind 自报。
- 无人值守进程只得到显式配置的服务主体权限，不继承本地 owner 的审批、补录、秘密和迁移权限。
- account verify 是显式只读平台调用；status/config validate 不进行该探测。所有命令结构化输出，失败退出码非0。

## 18. 错误码

| 错误码 | 含义 |
|---|---|
| `CONFIG_INVALID` | 配置校验失败 |
| `CREDENTIAL_MISSING` | 凭据缺失或失效 |
| `FEATURE_DISABLED` | 功能未启用 |
| `APPROVAL_REQUIRED` | 需要人工批准 |
| `DUPLICATE_OPERATION` | 相同 Operation 已存在 |
| `DUPLICATE_TARGET` | 业务目标在冷却期内重复 |
| `QUOTA_EXCEEDED` | 日/小时/轮次额度超限 |
| `RATE_LIMITED` | 本地冷却或平台熔断 |
| `RECIPIENT_NOT_ALLOWED` | 私信收件人不在白名单 |
| `MUTUAL_FOLLOW_REQUIRED` | 未满足互关 |
| `AGENT_DISABLED` | 需要模型但未配置 |
| `AGENT_OUTPUT_INVALID` | 模型输出无法解析 |
| `BILI_API_ERROR` | 平台明确业务错误 |
| `OPERATION_UNKNOWN` | 外发结果未知 |
| `PUBLISH_INPUT_INVALID` | 投稿输入或路径不合法 |
| `EXTERNAL_PUBLISH_DISABLED` | 外部发布未获允许 |
| `TRUST_UNAVAILABLE` | DSH 信任栅栏不可用 |
| `STORE_CORRUPTED` | 状态损坏，写操作停止 |
| `SCHEMA_UNSUPPORTED` | 接口、配置、账本或迁移格式版本不支持 |
| `IDENTITY_UNVERIFIED` | 账号或主体身份无法可信核验 |
| `FORBIDDEN` | 主体/会话/素材权限不足 |
| `IDEMPOTENCY_CONFLICT` | 同请求键或事件序号出现不同内容 |
| `APPROVAL_STALE` | 审批过期、输入变更、撤权或迁机挑战失效 |
| `CAPABILITY_UNSUPPORTED` | 契约存在但能力未实现，如remote/X/抖音 |
| `DEPENDENCY_UNAVAILABLE` | 已支持的可选能力缺宿主服务或媒体工具 |
| `INPUT_REQUIRED` | 生产所需脚本、素材或其他必需输入缺失 |
| `ARTIFACT_INVALID` | 文件缺失、越界、摘要/媒体规格或产物清单不合规 |
| `BUDGET_EXCEEDED` | 生产费用、耗时或产物容量超过授权上限 |
| `JOURNAL_CORRUPTED` | 事件归档缺失、损坏或序号冲突 |
| `MIGRATION_BLOCKED` | 未完成收尾、封存、源端交接或目标核验 |
| `BACKUP_UNPROTECTED` | 无经过核验的独立恢复点，受保护动作禁止派发 |
| `BACKUP_STALE` | 最近可信账本恢复点超龄，停止新的受保护派发 |
| `BACKUP_INVALID` | 恢复点、来源、版本、摘要或所需对象不满足校验 |
| `RECOVERY_REQUIRED` | 主账本损坏/缺失，仅允许受控只读恢复，不初始化空账本 |
| `RECOVERY_GAP` | 存在不能证明已覆盖的历史缺口，相关scope保持冻结 |
| `RECOVERY_FENCING_REQUIRED` | 旧写者/旧票据/相关凭据未被可靠隔离，不能开放写权 |

unknown及recovery错误不能被通用重试器解释为重派许可。副作用未知retryable=false；备份文件复制可在原backupId下幂等续办，但不能因此重执业务任务。

## 19. 测试与验收

### 19.1 单元测试

- 配置：0 值、非法布尔、路径、递归脱敏、外部发布条件。
- WBI：固定时间/key 的签名结果、参数过滤。
- Store：锁竞争、崩溃 stale lock、损坏 fail-closed、事务不回滚覆盖。
- RateLimiter：读额度、写间隔、熔断、重复键、unknown。
- Browse：多来源去重、失败隔离、无字幕、评分、已看过滤。
- Comments：审批、自动、模板禁用、同 BV、同文、日额度、干跑。
- DM：白名单、互关、自发、渠道去重、回执。
- Diary：归档＋热缓存、跨2000事件重建、账号/workspace路径、版本冲突、双阶段提交崩溃、公共脱敏。
- Publisher：Artifact解析、输入hash审批、Manual人工断言、External JSON和原Operation核查。
- Task/Coordinator：执行单飞与人工等待分离、partial/failed含unknown不清理、取消竞态、重复start。
- 身份/IM：可信上下文、权限撤销、消息去重、过期回调、模型伪造审批、outbox送达未知。
- Production：固定阶段、能力不足、真实执行许可、序号/attempt、预算预留、取消/中断、输出校验。
- Migration：派发栅栏、收尾事务、源retired、目标暂停、路径与摘要、回执绑定、激活崩溃、最新账本回滚。
- Backup：策略校验、manifest/configRevision/timeZone、JCS-SHA256金标准、ledger/full覆盖、分层保留、checkpointFence与迁移竞态、复制/flush/索引断电恢复。
- Recovery：损坏Store下独立只读恢复、新epoch/父恢复点、不确定区间、结构化scope/unknownExposure、证据修复、两阶段authorize与分scope解冻。
- 轻量性：禁用组件时无重依赖import、无spawn、无探测/网络/定时器；显式remote不静默降级。

### 19.2 集成测试

使用 Mock BilibiliClient、Mock Agent、临时目录：

1. 浏览 → 评论审批 → 原 Task 回到 running → 批准 → 日记。
2. 浏览 → 私信 → 同轮重复私信被拒绝。
3. 写请求超时 → unknown → 自动流程不重发 → 人工 resolve → businessKeys/Task/事件/日记同步更新。
4. 分别模拟崩溃于 Operation 预留后、派发后，验证 cancelled/unknown 恢复且都不自动重放。
5. Operation 清理后永久 businessKeys 仍能阻止重复外发。
6. 全局/功能/调用三级 dryRun 真值表覆盖自动、HTTP、CLI；任何 dryRun=true 时 `go` 均不得真实外发。
7. 投稿输入 → Bundle → `publish complete` 登记 BV → Publish/Task/Operation/事件同步成功。
8. 同日两轮 Browse + 一次 unknown resolve：日记只在内容变化时递增 revision，最终包含最新事件。
9. 外部发布器使用测试辅助可执行文件，验证无 shell 注入与回执解析。
10. DSH Mock host 加载/卸载，信任服务缺失时写 API 拒绝。
11. 同MID换Cookie后保留业务键、额度与unknown；不同MID隔离，不能核号则暂停平台写。
12. 一条IM命令重复/重放只得到一个Task；未绑定群成员及Agent伪造approved不能执行；撤权后旧审批/通知拒绝。
13. 通知超时不重跑生产，不支持发送幂等的通道unknown不盲重发。
14. 生产dry/go各级否决、阶段重复submit/乱序事件、损坏媒体、费用unknown、取消晚于成功；所有不可用产物均readyForPublish=false。
15. 同一Task付费阶段resume仍计入既有花费与unknown占用；不能用新attempt重置预算。
16. 两根目录/两个instance迁移：reserved未派发被冻结、收尾回执可入账、孤儿进程不退出则禁止export、全部素材及永久键保留、旧端继续禁写。
17. 迁移票据错目标/摘要不符/秘密未重绑/账号错误/路径越界或软硬链接均拒绝相应激活能力；导入不覆盖现有活跃目录。
18. 源release与目标activate各断电窗口幂等恢复；旧审批、queued和unknown均不自动重放，回滚不得用旧账本。
19. Mock X/抖音不要求BV，凭据不串用；remote返回不支持；核心默认启动与status不访问网络/媒体工具。

灾备真实本地模块组合、完整故障注入和隔离恢复演练统一归 §19.5 与 TASKS T22；§19.2 不以普通Mock通过替代该矩阵，T19/T22场景须分别按TASKS §4.2追溯表核对FR与判定证据。

### 19.3 真实环境验收

- 默认不运行真实写测试。
- 用户明确授权后，先验证 `whoami` 和只读浏览。
- 评论/私信使用专门测试账号、白名单和最低额度，一次一个动作。
- 视频发布仅对已配置External Provider单独小规模验证；Manual Bundle及人工断言不冒充平台读回。
- IM先只读检查宿主接口及真实事件结构，再经授权执行一条测试消息/回信；无宿主或授权时报告不可用/未实测，Mock不构成真实桥接完成。
- B站写、External 和真实 IM 的每次受保护真实派发前，必须由 T20/T21 实际服务核验 owner 确认的独立故障域、未超龄有效恢复点及无匹配 RecoveryHold；测试配置、dryRun/go、Mock 或宿主授权均不能豁免，缺失即 BLOCKED，不得生成真实发送请求。
- 本地生产须在显式提供媒体工具后，以项目测试素材实际生成可探测MP4和封面，不访问平台、不使用付费Provider。工具缺失则该生产配置验收BLOCKED，不能以脚本/Bundle替代视频；这不要求授权真实平台写。
- 跨Windows/Linux迁移未能在两系统实测时区分“路径语义/双目录模拟通过”与“真实跨OS未测”。
- 真实测试产生的外发内容由用户决定是否保留或删除，不自动批量清理。

### 19.4 完成门槛

- `node --check` 覆盖全部源码，而非只检查入口；`npm test` 全部通过，无未处理Promise rejection。
- 自动测试不访问真实平台/付费服务、不写真实用户目录；媒体测试仅运行经显式提供的本地工具。
- 每条副作用路径有干跑/禁用、权限、重复防护、unknown、迁移冻结及备份/恢复门禁测试；纯本地执行另外覆盖崩溃与取消。无有效恢复点或存在匹配 RecoveryHold 时，平台写、付费生成、External 和 IM 新派发均为0；对应计数器不变，冻结前合法在途回执、归档和必要核查仍可落账。
- 普通配置示例与§4.3结构一致。全部52条新增FR已映射到TASKS的任务与验收，FR-DR-001～010及账本v3的接线计划已覆盖；该映射不代替实施证据或GATE-0审核，仍须获批后按任务依赖实施。
- 基础核心、真实本地生产、IM契约/真实桥接、停机迁移、备份恢复点/灾备演练、平台扩展契约分别报告；存在BLOCKED不得宣称全功能完成。
- 远程执行、商业生图/TTS、X/抖音、原生UPOS的Mock测试不计为正式能力交付。

### 19.5 灾备故障注入与恢复验收

以下为新增设计验收，不表示已经运行；全部使用临时根目录、测试主体和Mock外部回执，不访问真实平台、不破坏真实数据。

| 场景 | 必须观察到的结果 | 需求 |
|---|---|---|
| 主state损坏/丢失，仅有可信旧点 | 不初始化空账本；独立入口恢复只读，保全原件与全部已知永久键/unknown | FR-DR-001、005 |
| 未配置目的地、同盘未核验、恢复点过期 | 报unprotected/degraded，平台写/付费/IM发送零新派发；在途回执仍可落账 | FR-DR-002 |
| 捕获时有reserved请求、渲染、日记/Artifact提交 | 同一cut的账本和引用一致；未确认输出不算完成，大文件复制不持全局锁 | FR-DR-003 |
| 复制中断、manifest缺字节、摘要错、磁盘满 | 不更新最后有效恢复点；full不能部分成功，不先删除唯一好备份腾空间 | FR-DR-003、004 |
| ledger有效但视频对象缺失 | 只读账本可恢复，媒体标unavailable/ready=false，不能冒充完整生产恢复 | FR-DR-004、005 |
| 多个新ledger挤出唯一full，或删除计划命中共享对象/调查固定点 | 按tier保护最后有效账本点与full点；删除后媒体覆盖不得消失，仅清理不再被保留点引用的对象 | FR-DR-004 |
| 10:00恢复点、10:05外发成功、10:06丢账 | 无记录不能not_sent，建立10:00之后的缺口和scope冻结，不重复外发 | FR-DR-006 |
| 备份中reserved无dispatchAt，之后已派发 | 不套用普通重启cancelled规则；即使原operationId缺失，也冻结受影响账号/预算/发送范围 | FR-DR-006、007 |
| 仅事件摘要、伪造人工确认或冲突回执 | 不自动重建完整账本或解冻；原操作核查与recoveredFact区分，争议保留 | FR-DR-007 |
| 新epoch收到旧epoch迟到回执或相同裸seq | 不覆盖历史、不作为新任务执行，进入证据核查；跨epoch事件游标不混淆 | FR-DR-005、007 |
| 源/迁移目标失联且无法证明隔离 | migration仍阻塞，灾备仅只读；有可信隔离证据且该scope完整核查后才允许授权 | FR-DR-008 |
| reconcile/authorize各持久化步骤断电、重复调用 | 数据和许可不一致时保持冻结，同case/request幂等，零自动任务/通知重放 | FR-DR-009 |
| 恢复旧权限、旧nonce、旧migration票据或改dryRun | 不能取得管理员/审批/外发权，备份kind不能用于migration activate | FR-DR-005、008、009 |
| 隔离恢复演练与性能记录 | 记录实际cut年龄、元数据量、只读耗时、媒体覆盖及未解冻scope；verify通过不能替代restoreTested | FR-DR-010 |

只读RTO目标的演练条件见§27.1；写入恢复无固定时限，证据不足的scope持续冻结。真实介质/跨OS的耐久性或故障域未验证时，报告模拟结果与未验证条件，不冒充实际灾难演练通过。

## 20. 修订决策与审核门

用户已确认采用轻核心、可选适配器、独立视频生产，以及停机迁移＋远程接口预留方向。本版将其规范化，仍需审核修订稿后才能实施；不重复要求选择已确认的跨端范围。

| 决策 | 本版基线 |
|---|---|
| R-01 | 重写统一核心，不运行时拼装旧插件 |
| R-02 | Node 22 ESM，B站协议隔离于适配器 |
| R-03 | 评论默认人工审批，auto 为显式业务授权 |
| R-04 | 无模型默认不自动套模板评论 |
| R-05 | 单机事务 JSON Store＋持久事件归档，不引入分布式数据库 |
| R-06 | 发布 Manual＋External，原生UPOS不在本期 |
| R-07 | HTTP/CLI/宿主入口，不自研完整设置或剪辑UI |
| R-08 | 不与旧平台自动化插件同时调度 |
| R-09 | 可选组件惰性加载，核心没有重媒体依赖 |
| R-10 | 独立固定阶段生产，首个真实配置 local-slideshow-v1；商业生成仅可选扩展 |
| R-11 | 一个可选dsh-im桥接；真实宿主身份/通道验证是该适配器交付门槛 |
| R-12 | 本插件兼容格式的停机搬迁；remote执行、双端接管不实现 |
| R-13 | X/抖音只做平台契约与Mock一致性测试，不安装SDK或轮询 |
| R-14 | 一致账本恢复点与媒体分层备份，独立故障域、保留策略、过期保护及可测RPO/RTO |
| R-15 | 灾备只读恢复、新historyEpoch、缺口冻结、旧写者隔离与证据驱动的分范围解冻 |

0.2.1新增R-14/R-15及FR-DR-001～010；TASKS已同步T20～T22、52条新增FR映射及账本v3接线计划，示例配置未修改。独立备份策略实现、代码接线及相应测试仍须在审核通过后完成，不能仅凭任务映射宣布本增补已实施。

需实施前验证的外部前提：DSH实际服务注册/人类证明/消息语义、B站接口回执、选定本地媒体工具与外部发布器。无法验证时明确 BLOCKED/未实测；不能自行放宽授权、冒充成功或扩大到新平台。旧插件配置/账本导入与本插件停机迁移不同，本期不提供前者。

## 21. 公共接口与平台适配契约

### 21.1 版本、身份和请求

- `FR-EXT-001`：所有跨模块逻辑消息含 schemaVersion=1；兼容扩展放在明确的 extensions 对象，未知安全字段/动作和不支持版本拒绝，不能静默忽略授权参数。
- RequestEnvelope 至少含 requestId、action、input、mode；workspaceId、principal、sourceKind 由可信上下文绑定。taskId由核心生成，迁移不变；instanceId由本机安装生成，迁机改变。`requestKey` 统一为 `"jcs-sha256-v1:"+lowercaseHex(SHA256(JCS({workspaceId,principalId,action,requestId})))`；requestId是同一逻辑请求在重试中复用的原值，requestKey是其规范化作用域散列，DESIGN生产键与TASKS requestKey均使用此定义，不得另行拼接或省略principal/action。
- 所有规范化散列使用带版本的 `jcs-sha256-v1:<hex>`：按 RFC 8785 JCS 对动作专用对象排序键、规范化数字和 Unicode；数组默认保序，只有动作 schema 明确定义为无序集合时才排序。`inputHash` 覆盖 action、规范化输入、全部输入Artifact摘要、输出规格、profile/Provider版本、目标及费用上限，不覆盖 requestId、随机时间或显示名；`metadataHash` 覆盖 action=publish、视频/封面摘要、目标平台/账号、元数据及Provider配置版本；normalized-text-hash 对文本先做 NFC、CRLF/CR→LF、去首尾空白，再计算 `SHA256(JCS(text))`，不折叠大小写或内部空白。改输入递增revision并失效审批。

金标准向量（输入均为下列 UTF-8 JSON 文本本身）：

```text
JCS {"a":1,"b":"你好"}
  → jcs-sha256-v1:f904ecdbf542d8dba6a81d16e73ba685adcd7da823f1b38ff41d78e2341ca088
JCS {"action":"comment","contentRef":{"contentId":"BV_EXAMPLE","platform":"bilibili"},"text":"你好"}
  → jcs-sha256-v1:c770c268e85c7456a62aab59eed0c07547317d3b78e1bca1a444382e994fe9f3
JCS "你好"（normalized-text-hash）
  → jcs-sha256-v1:0922515335495b677fa44d53bcf0f33d9fbfc8fda4aba447afa805f0f206a8b9
```
- `FR-EXT-002`：请求键作用域为 workspace＋principal＋action＋requestId；同键同hash返回原taskId/result，同键异hash返回 IDEMPOTENCY_CONFLICT。请求去重与永久业务去重是两层；新requestId不能绕过业务键。
- 响应含 accepted、taskId、status、deduplicated、executionMode；accepted只在持久提交后返回。错误为 code/message/retryable/details，unknown 的 retryable=false，不允许调用者据网络超时盲重试副作用。

### 21.2 三类适配器

| 契约 | 最小方法 | 不能负责 |
|---|---|---|
| PlatformAdapter | capabilities、verifyAccount、discover、readContent、readComments、writeComment、sendDirectMessage、preparePublish、normalizeReceipt | 自建调度/额度、越过核心直接外发 |
| ChannelAdapter | capabilities（含delivery.query/idempotent）、start(onEvent)、send(notification)、queryDelivery(notificationId,receipt)、stop | 授予管理员、批准模型请求、读取任意文件 |
| ExecutionBackend | capabilities、submit(stageRequest)、getStatus、cancel、close | 写账本、持有平台Cookie、自动投稿 |

这些是内部协议，并非对DSH或第三方SDK方法名的断言。平台写入和付费调用只接受核心已预留的 OperationContext（operationId、业务键、授权摘要、派发许可）；通知发送接受绑定notificationId的OutboxDispatchContext；免费本地执行接受绑定executionId的ExecutionDispatchContext。三类上下文均由核心校验并在派发前检查统一栅栏，但不为免费执行或通知额外伪造Operation，也不能凭适配器收到的字符串绕过网关。

- `FR-EXT-003`：平台能力逐项声明 supported/reason/limits：read.content、read.comments、write.comment、dm.send、dm.receive、publish.manual、publish.external。未支持必须返回 CAPABILITY_UNSUPPORTED。B站本期dm.receive=false；X/抖音测试替身不得注册为正式启用适配器。
- ContentRef={platform,contentId}；AccountRef={platform,accountId}；平台特有aid/cid/tid放platformData。生产输入/产物不包含必填BV、MID或tid。
- Receipt={platform,accountId,action,externalId,url,verification,receivedAt}；verification为manual_assertion/publisher_receipt/platform_readback之一。B站格式检查由适配器执行，不等同读回验证。
- `FR-EXT-004`：凭据、业务键、额度和熔断按服务及稳定账号隔离；平台替换不能收到B站Cookie，公共错误不暴露平台原始秘密。

## 22. 身份、人工审批与 IM 契约

### 22.1 主体与授权

- `FR-IM-001`：桥接来源与终端用户授权分开验证。宿主受信消息形成 adapterId、botAccountId、conversationId、senderRef、eventId、occurredAt、command、mode；principal从受信桥接上下文和本地bindings推导，不能来自正文role/approved/actorKind。
- 首版绑定包含 bindingId、adapterId、botAccountId、senderRef、允许conversationIds、principalId、scopes、revokedAt；只能本地人类绑定/撤销。群成员身份变化、未绑定或撤权后拒绝，不能因机器人进程受信而自动放行群成员。
- 默认scopes为空。可显式授予 production.create、task.read.own、task.cancel.own、approval.decide.own；读取/取消/审批还需 task.principalId 或明确委派匹配。配置、秘密、执行器注册、迁移、人工补录、unknown核查不开放IM。
- 模型自然语言解析只形成候选草稿；system/scheduler/agent主体均无人工审批资格。评论auto及白名单DM可使用独立配置的服务主体动作授权，不能扩展为审批权。
- 本地人类证明必须满足以下一种可验证机制：宿主签名的 human-interaction challenge；或受控交互 TTY 中展示绑定摘要后，由 owner 输入一次性挑战短语并完成当前 OS 会话的独立身份核验。挑战绑定 task/action/inputHash/principal/nonce/expires，一次性消费且禁止无人值守进程代答。普通body字段、nonce、同OS进程或--confirm本身都不是身份来源；TTY和宿主证明均不可用时，本地敏感管理及真实go保持BLOCKED，离线实现/测试不因此取消。
- 本期威胁边界是不可信消息/模型/素材及进程崩溃，不声称抵抗拥有同一OS账户任意代码执行权限的恶意程序；需要该隔离时另行部署OS权限边界，不能把独立进程当沙箱。

### 22.2 命令入口与审批

```text
ChannelGateway.ingest(event, trustedContext) -> CommandReceipt
CommandService.execute(envelope, principal) -> TaskReceipt
ApprovalService.decide({approvalId, decision, nonce, mode}, trustedHumanContext)
```

- `FR-IM-002`：幂等键为 adapterId＋botAccountId＋conversationId＋eventId，另保存命令hash和原taskId。无可靠eventId的通道只能受限只读；消息编辑不修改已接收任务，同键异内容拒绝。
- 已登记重复消息核验当前访问权后返回原结果，不重新执行；新消息须校验可信发生时间，超过maxMessageAgeSec或异常未来时间拒绝。索引保留至少覆盖通道重投窗口和允许时间窗，未决任务索引不清理；迁移完整携带有效索引。
- `FR-IM-003`：可执行动作白名单为生产草稿/干跑、本人任务查询、取消请求及受信人类审批。未经明确结构化确认的自然语言不得直接go；本期IM不能任意发送B站私信或创建已批准发布。
- Approval={id,taskId,action,inputHash,taskRevision,principalId,nonceHash,expiresAt,decision,decidedAt,source}。只绑定一次批准对象；配置、权限、费用及输入变化均重新预检，修改输入必失效旧审批。
- `FR-IM-004`：对同一审批同决定幂等，冲突决定拒绝；干跑不消费真实执行批准。批准过期、输入变更、主体撤权、迁机后的旧挑战一律拒绝；保留审计，不让Agent补写approved:true。
- 所有等待审批状态都有原taskId的回流入口；生产批准仅允许生产，发布另有批准对象。ApprovalService 在事务中核验并消费挑战、更新Task/事件，实际派发仍执行§7二次栅栏检查。

### 22.3 通知与宿主适配

- `FR-IM-005`：任务事件与 outbox 在同一事务提交。Notification至少含 notificationId、taskId、taskRevision、bindingId、conversationId、summary、status；status为pending/sending/sent/failed/unknown/suppressed。
- 发送前重新验证binding、受众权限、独立通知预算及匹配RecoveryHold，限流后在事务中写sending。明确未发送可有限重试；超时未知只有通道保证同notificationId幂等或可查询确定结果时才可恢复，否则unknown不自动重发。ChannelAdapter 的 `queryDelivery(notificationId,receipt)` 只能返回 sent/not_sent/unknown，能力不支持、超时或响应不可信均保持unknown；本地人类可用 `outbox resolve` 根据受控证据登记confirmed/not_sent，通知失败绝不触发任务重跑。
- 进度通知可合并尚未发送的较旧revision，终态和人工待办保留；通道关闭时保留待办，撤权则suppressed。入站accepted响应是桥接处理回执，用户可见IM回信仍走outbox。
- outbox独立结算，不使已成功业务Task重新失败；pending/sending/unknown及仅有失败但未经核查的通知不得按留存期删除，其必需的Task归属/权限引用不得被普通Task清理删去。已sent/not_sent且超过通道重投窗口的记录可清理正文，但必须保留notificationId、Task/事件/回执摘要引用；迁移完整携带所有未决项与审计引用。
- `FR-IM-006`：群聊只发summary或不发，不带完整脚本、私人日记、绝对路径、凭据或未经授权附件。首版产物回信仅含artifactId和摘要；不自行搭建公开下载链接服务。
- `FR-IM-007`：dsh-im只有在已验证宿主消息来源、发送方式、事件ID、生命周期及人类证明后启用相应能力。未验证时报告unavailable/BLOCKED，不另接未经授权的QQ微信SDK。
- `FR-IM-008`：MockChannel只能证明契约行为；真实IM交付至少验证一次授权消息→草稿Task→人类审批/拒绝→状态回信。真实消息发送需单独用户授权；无条件时交付报告必须列未实测/阻塞，不静默标完成。

## 23. ArtifactStore 契约

- `FR-ART-001`：ArtifactRef={artifactId,sha256,sizeBytes,mediaType,role}。角色至少支持script/image/clip/audio/subtitle/video/cover；引用稳定且归workspace管理，物理路径映射不是业务身份。
- `ArtifactStore.importFile({sourcePath,role}, trustedLocalPrincipal)` 只从security.allowedSourceDirs允许的真实路径导入，空列表禁止外部文件导入；检查普通文件、重解析点/软硬链接、文件大小及类型，流式hash并复制到受管理目录，不删除源文件。
- `FR-ART-002`：素材ID不提供目录读取能力。API/IM只传已授权artifactId；对共享素材必须显式ACL。生产临时目录由核心分配，Runner输出只允许该目录内的普通文件。
- `FR-ART-003`：Runner输出清单不是成功证据。核心核验文件、类型、大小、hash和配置要求后提交受管理产物；内容定稿后不可就地修改，变更创建新Artifact。
- `FR-ART-004`：发布前复核视频/封面摘要和授权，不能用审核后的旧hash发布被替换文件。受管理artifact目录可由本地管理员授权给生产/发布，不通过调用参数扩大sourceDirs。
- `FR-ART-005`：迁移包使用核心生成的相对路径，拒绝绝对路径、..、跨平台保留路径、软硬链接、未列出或重名碰撞的文件。引用式Bundle导出时必须包含实际字节，缺文件就失败，不能保持旧机路径假装可移植。
- `FR-ART-006`：临时产物提交采用pendingImport记录＋原子rename＋摘要恢复。pendingImport 至少包含 `{artifactId,sourceRealPath,tempFile,expectedSha256,expectedBytes,expectedMode,requestedRole,requestedVisibility,principalId,phase,createdAt}`，提交前复核授权、realPath、摘要/大小/权限。崩溃后只回收核心可证明拥有的临时文件；不自动删除已定稿产物、源素材或用户目录。迁移封存前完成所有pendingImport/日记pendingCommit。

## 24. 独立视频生产与 ExecutionBackend

### 24.1 最低交付与请求

- `FR-PRO-001`：生产可独立于Browse/B站账号触发，不默认联网或发布。生产Task归workspace，发布另建关联Task。
- 首个真实本地profile为 local-slideshow-v1：将已导入图片/片段、用户提供脚本及可选音轨/字幕，通过独立ffmpeg进程合成MP4、封面并用ffprobe等可信验证器检查。它不是仅返回metadata或投稿包的占位实现。
- script/assets/voice/render/validate固定阶段。用户输入可满足前序阶段；无配音须在profile中显式选择并通过校验后skip voice，不能把依赖缺失当合理跳过。
- 文案模型、生图和TTS Provider仅保留可选契约与Mock覆盖；无商业服务仍可由本地素材完成真实视频。不承诺默认从一句话自动生成所有素材，也不自研编辑器/ASR。

```json
{
  "schemaVersion": 1,
  "requestId": "production-request-001",
  "profileId": "local-slideshow-v1",
  "brief": "使用已导入素材制作一分钟介绍视频",
  "inputs": [{ "artifactId": "asset-001" }],
  "output": { "container": "mp4", "width": 1920, "height": 1080, "fps": 30, "maxDurationSec": 60 },
  "mode": "dry",
  "limits": { "wallTimeSec": 1800, "maxPaidCostMinor": 0, "currency": "CNY" }
}
```

- `FR-PRO-002`：profileId指向本地可信配方与工具绑定，不能由请求提交command、args或环境变量。Profile含id/version/backend、固定阶段、requiredInputs/Outputs、stage restartSafe/checkpoint能力、工具路径及版本范围、outputLimits、voiceMode、可选providerRefs。
- local-slideshow-v1必须提供脚本文本Artifact及至少一项图片/片段；选配音轨/字幕须格式与时长匹配，缺输入返回INPUT_REQUIRED，不自动转成付费生成。
- 输出规格必须在profile声明范围内；本期容器mp4，宽高为2–3840的偶数，fps为1–60的整数，maxDurationSec为1–600。配置/调用均有上限，超出拒绝而非静默改尺寸。
- `FR-PRO-003`：go必须production.enabled、allowLocalProducer、有效人类审批、工具/素材/输出预检全部通过。global或production dryRun为true时只返回计划和blockedBy，不启动工具或Provider、不产生readyForPublish。

### 24.2 执行协议

| 方法 | 返回与约束 |
|---|---|
| capabilities() | backendId、schemaVersion、supportedStages/profiles、supportsCancel/checkpoint、限制及unavailable原因 |
| submit(stageRequest) | executionId、accepted；核心须在调用前持久化执行记录和request映射 |
| getStatus(executionId) | 指定执行的最新已知状态/seq，不借查询启动新任务 |
| cancel(executionId) | accepted或当前终态，只是取消请求 |
| close() | 拒绝新执行、收尾/停止子进程并保守上报未决结果 |

- `FR-PRO-004`：stageRequest含workspaceId/taskId/executionId/stageId/attempt/requestId/inputHash/instanceId/profileId/inputArtifactRefs/limits；executionId由核心在持久预留时生成，后端返回相同ID。核心绑定可信临时目录和环境，网络/IM正文不能提供这些特权上下文。
- 执行状态为accepted/running/cancel_requested/succeeded/failed/cancelled/interrupted/unknown。事件含executionId/taskId/stageId/attempt/seq/status/progress/outputs/error；seq单执行递增，同序号同内容幂等，异内容拒绝；旧attempt回执不能覆盖新状态。
- `FR-PRO-005`：本机协议使用固定runner入口、execFile参数数组和有界JSONL。单消息≤1MiB，stdout/stderr总量上限10MiB；超过限制收尾并按副作用状态判定，不阻塞宿主内存。环境白名单不传平台Cookie、秘密全集和账本路径。
- local-slideshow-v1只接受已验证的本地媒体格式；ffmpeg输入协议限file/pipe，合成清单由核心依据受控路径生成，不执行用户脚本、不接受任意滤镜/参数/外部播放列表或网络URL，避免媒体工具绕过素材授权联网。
- 本期maxConcurrent=1，每个Task固定阶段顺序，不建立通用DAG/分布式队列。独立进程提供故障隔离，不保证减少同机CPU/GPU负载，也不是恶意代码沙箱。
- 每个 executionId 表示一次不可变执行尝试；只有仍处于 accepted/running/cancel_requested 的相同 requestId/inputHash/executionId 重复submit才返回原记录。不得把 failed/cancelled/interrupted 的原 executionId 改回运行态。崩溃于持久化和spawn之间时，不能因没有accepted回执就盲目spawn；需核实本机属主/子进程及派发记录，不明确则冻结待核查。

### 24.3 费用、副作用与恢复

- `FR-PRO-006`：可选付费Provider调用只经核心EffectGateway，调用前在事务中预留Operation及预算，实际发送前写dispatchAt。Runner不能自行持钥直调付费服务，第三方执行器仅在可信代码假设内支持。
- 成本按同一currency的最小货币单位整数记账。请求/尝试成本不得超过授权上限；人工resume仍累计原Task支出及unknown占用，不以新attempt重置预算。零预算禁付费，不能估算并约束最坏上限的Provider拒绝自动调用。
- 免费本地渲染仅记Execution，不伪造平台Operation；付费unknown不能自动重试/释放预算，收到明确结算或未发送证据后再resolve。
- `FR-PRO-007`：cancelRequestedAt与真实停止分离；执行停止但有unknown时Task仍未结算，不可标已安全取消。成功回执先到则保留成功，已发生费用不回滚。
- 纯本地阶段中断可标interrupted。人工resume先核验未决操作、权限、旧执行已停止、profile版本和输入hash，再创建新的 executionId、递增attempt并记录 previousExecutionId/checkpointRef；只允许重绑定相同 taskId/stageId/inputHash 的后继执行，旧回执不得覆盖新尝试。只复用已确认Artifact，restartSafe阶段才可显式重跑。迁机不恢复GPU/ffmpeg进程内存，不承诺精确中途续帧。
- `FR-PRO-008`：checkpoint含stageId/profileVersion/inputHash/outputRefs/lastConfirmedSeq及可恢复类型。只有持久化验证完成的阶段可跨端复用；profile或输入变更要新revision与审批。

### 24.4 成功与发布边界

- `FR-PRO-009`：最终manifest包含所有必需Artifact、媒体探测/解码验证结果、profile版本及阶段摘要；核心通过可信验证器检查实际文件、视频流、时长/尺寸/fps/字节上限、视频可解码及必需封面可读后才置succeeded/readyForPublish=true。仅ffprobe读到头部或Runner自报成功不足以通过；部分失败或干跑必须false。
- 发布通过§15显式创建并独立批准，生产成功仅说明可用视频已生成；发布失败不自动重做生产，通知失败不重跑任务。
- `FR-PRO-010`：remote仅预留同一逻辑协议。请求该backend明确CAPABILITY_UNSUPPORTED，不监听端口、不建心跳/任务传输/素材同步服务。未来需另行设计认证、租约/执行归属及断连核查，不能把本期本机协议称为远程实现。

## 25. 停机迁移协议

### 25.1 范围与状态

- `FR-MIG-001`：只支持同插件、迁移manifest的schemaVersion=1、kind=migration、stateVersion=3及对应账本v3。未知版本/旧插件数据不自动导入；kind=backup即使文件齐全也不能走migration activate，不提供双端接管或网络共享JSON。
- MigrationRecord含migrationId、workspaceId、sourceInstanceId、targetInstanceId、snapshotHash、phase、createdAt、validation、receipt；源端阶段为active/quiescing/sealed/released/aborted，目标阶段为none/imported/validated/active/disabled。prepare原子进入quiescing，`migration export`在提交屏障内原子进入sealed；release前晚到回执使sealed回到quiescing，落账后重新export并更换snapshotHash，release后回执只交目标核查。`migration abort`只允许release前取消并作废旧包；release后先`migration disable-target`，再以`migration rollback`创建反向migrationId，任何状态都不允许覆盖式import。正常迁移保留historyEpoch、既有RecoveryCase/holds及证据引用，不以新实例替换消除历史缺口。
- 本机instance.json单独记录instanceId、activation状态及交接回执。业务派发必须同时满足账本phase=active、本机有效激活与能力许可、§27备份保护且无匹配recovery冻结；任一缺失/不一致均禁派发，普通config不能解除。

### 25.2 Prepare、导出与源端交接

- `FR-MIG-002`：prepare为人类本地管理动作，先在核心事务核验owner确认的健康恢复点及无匹配RecoveryHold，再原子冻结所有入口的新任务、平台/付费/通知派发及素材导入；包括尚在等槽位的reserved操作。真实prepare/activate不得以dryRun/go豁免，离线测试仅可使用隔离替身。允许已派发操作的回执、取消确认及事实落账，不能冻结收尾所必需的写入。
- 等待或请求停止全部本地执行器、外部发布器和发送器，确认无继续修改产物的子进程；不能确认进程退出则export阻塞。远端副作用无法确认的Operation标unknown且保留占用，不能假定杀进程即未执行。
- `FR-MIG-003`：导出前完成事件归档、日记pendingCommit和Artifact pendingImport恢复；sealed后业务快照不可再变。导出失败保留源端禁派发状态及错误，不删除源数据。
- 导出为本地可搬运目录，含manifest.json、业务快照、事件归档、日记、全部被引用的素材/产物/投稿说明；流式复制并记录相对路径、size、sha256。不能只带Bundle路径或漏掉未决任务输入。
- manifest含schemaVersion、kind=migration、stateVersion=3、historyEpoch、configRevision/version+hash、workspace/migration/source/target IDs、timeZone、stable accountRefs、profile依赖、文件清单和快照摘要；有RecoveryCase时须携带hold与evidenceRefs，证据附件只按受控权限另行导出，不强制把明文证据放进迁移包。超过maxFiles/maxTotalBytes或文件变动/缺失则失败，不生成部分成功包。
- `FR-MIG-004`：release核对封存快照后将源instance持久标retired，再生成绑定migrationId/snapshotHash/targetInstanceId的交接回执。崩溃后仍保持禁写；回执生成可幂等重试，不因导出完成就自动恢复源端。

### 25.3 导入、验证与激活

- `FR-MIG-005`：只导入新的空目录，目标默认暂停；不覆盖活跃数据。验证版本、清单、全部摘要、跨平台路径冲突/越界/链接及容量，拒绝额外未列出文件；目标使用自己的instanceId，不复用旧PID/锁文件。
- 包内保留永久键、requests、额度及unknown占用、Task/Execution/审批审计、IM inboxKeys/outbox、事件与产物；不带Cookie/API Key/机器人密钥/批准nonce明文/旧机器执行权限。旧人类挑战全部失效，历史决定仅作审计。
- `FR-MIG-006`：本机命令路径、目录授权、Profile工具绑定、模型/IM端点及环境秘密引用只能作为待确认提示，不自动启用。目标从安全默认配置开始，本地重新绑定并验证；业务额度与timeZone沿用，不能借安全配置重建清空历史用量。
- 激活前检查所需Profile/工具/输入、IM绑定/回信目标；已绑定平台账号重新whoami核验稳定ID，无法核验则不能激活其平台写能力。允许只激活已验证的非平台能力，但必须在activation能力清单中持久禁用未核验平台，不默认为全量通过。
- `FR-MIG-007`：activate须核对健康恢复点、无匹配RecoveryHold、本地导入摘要、源交接回执、目标ID及操作者对源端已停写的确认。先持久记录激活决定，再开放本机允许的派发能力；断电后按同migrationId幂等恢复，不重新覆盖最新账本。相同票据不同目标拒绝。
- 交接回执及sha256用于本地受信流程的一致性检查，不宣称能认证任意网络来源或抵抗恶意owner伪造；无中心协调无法阻止绕流程复制后双启。

### 25.4 恢复、回滚与不自动重放

- `FR-MIG-008`：激活不自动重投旧queued/running任务、旧审批或旧outbox。旧任务置migrationHold，只有受信人类明确resume/重新批准后恢复安全阶段；unknown必须先核查。scheduler仍关闭，需另行本地启用。
- 旧通知恢复前重新验证受众及通道送达语义；unknown送达不能盲重发。旧执行instance/PID仅审计，不按目标机器PID解释；断电/中途渲染只恢复持久阶段产物。
- `FR-MIG-009`：release前只能通过 `migration abort` 进入aborted并作废封存包及激活资格。source release后不提供普通config开关解除retired；无论目标是否已激活，均先以`migration disable-target`持久禁用目标及原票据，再以`migration rollback`创建反向migrationId。最新账本位置是目标当前数据目录：已激活时包含激活后的新提交；未激活时为已导入快照及其后续核查记录，绝不能直接重启源端旧备份。无法取得目标状态/最新账本时普通迁移流程保持阻塞。
- 发生真实数据损失时，可转§27的独立灾备流程建立只读副本和缺口记录；这不是解除retired的例外或伪造最新账本。开放外部写入仍须证明旧写者隔离、核查不确定区间并逐scope重新授权。
- `FR-MIG-010`：测试须模拟两个不同instanceId及不同根目录，验证旧端禁写、账本连续、素材可用和跨平台路径；不能用同目录进程重启代替停机迁移验收。

## 26. 轻量加载与可交付边界

- `FR-LITE-001`：默认核心加载只注册能力描述，不import媒体/IM/平台重依赖，不spawn，不轮询、不请求whoami。status返回cached/unverified，不为显示状态发网络请求。
- `FR-LITE-002`：可选模块未启用或依赖不可用时其他核心能力仍可使用；启用失败返回明确能力原因。只有显式生产预检会检查媒体工具，禁用后不保留新调度或孤儿任务。
- `FR-LITE-003`：一个仓库、一个统一业务核心、按需本地进程；不引入消息中间件、微服务编排或实时远程调度来满足停机迁移。长期索引/归档容量需可观测，不将逻辑分文件误称资源零成本。
- `FR-LITE-004`：基础核心、B站适配、IM桥接、生产profile、迁移、备份与灾备恢复分别报告已实现/未实现/不可用/未实测。至少一个真实本地视频产物是生产验收门槛；Mock平台/IM/remote测试不能冒充真实集成。

## 27. 可信备份与灾难恢复契约

### 27.1 范围、目标与策略

- `FR-DR-001`：本章用于主账本损坏、误删、介质丢失、最新迁移目标不可恢复等非计划故障。复用Store、ArtifactStore及manifest校验，但备份kind=backup不是迁移票据；恢复导入不需要伪造source release，也绝不直接授予派发权。没有有效备份时只能保全残存证据并报告RECOVERY_REQUIRED，不能初始化空账本伪装恢复。
- 本期采用本地文件备份库，可放在owner指定的独立挂载介质；不内置云SDK、同步双写、远程接管或共识服务。目的地不可用时不偷偷回退同盘目录。
- 账本恢复点目标RPO为15分钟；完整媒体覆盖目标为24小时。只读账本RTO目标为60分钟，条件为可信备份可访问、恢复机器就绪、账本及必需归档/恢复元数据合计不超过100MiB；大媒体复制、人工对账和重新开放外发分别计时。目标不是已经实测的SLA，不承诺零丢失、固定写入RTO或任意数据量的恢复时限。
- 恢复点年龄以cutAt而非completedAt计算。发现备份失败/超龄必须报告实际年龄及保护状态；即使停止新派发，在途请求仍可能晚到，因此不得据15分钟策略声称实际丢失窗口一定不超过15分钟。

本地 `BackupPolicy` 由owner管理，schemaVersion=1，不属于本轮未修改的普通业务config示例：

| 字段 | 初始设计值与语义 |
|---|---|
| scheduleEnabled | false；未显式配置不启动备份任务 |
| destinationRoot | 无默认值；不得位于活动数据目录内或形成递归备份 |
| failureDomain / verifiedBy | 记录存储介质/故障域及人工核验来源；不同目录或盘符不自动证明物理独立 |
| intervalMinutes / maxPointAgeMinutes | 15 / 20；启用后按恢复点年龄保护，owner变更需审计 |
| fullIntervalHours | 24；full与ledger成功状态分开 |
| keepRecent / keepDaily / keepWeekly | 8 / 7 / 4；保留集合取并集，不代表可以删除最后有效点 |
| autoPrune | false；先给出删除计划，owner确认才清理 |
| checkpointTimeoutMs | 5000；只约束事务屏障、staging与逻辑捕获，不限制锁外大对象复制；超时不发布新有效点并按属主证据安全收尾 |

- 频率和保留数量必须为正整数；intervalMinutes不得大于maxPointAgeMinutes，不能用0跳过保留。周期与容量限制在实施前补入策略校验及任务表，本轮不创建策略文件。
- `FR-DR-002`：每次真实平台写（含External）、生产付费调用和IM发送的预留及实际派发前，必须核验owner确认的独立故障域、验证通过且未超龄的ledger或full恢复点，并确认无匹配RecoveryHold。无策略/无有效点为unprotected，过期或校验失败为degraded，禁止上述新派发；go、普通config、任务审批和测试配置不能覆盖。只读、配置诊断和不触及受影响历史的新免费本地工作可单独授权，不假称已受灾备保护。
- 备份调度复用Coordinator的管理通道但有独立显式开关，不随Browse调度启用。`freezeCoordinator`在同一Store事务中线性化checkpointFence与migration.phase：仅migration.phase=active且无活跃case阻断时可开始常规备份；迁移prepare等待时新备份让位，已持栅栏者只能在截止边界收尾，崩溃且属主不明保持冻结。recovery.normal允许常规备份；readonly/reconciling只允许已校验副本经管理路径建点；blocked且数据可疑时禁止；restricted/released只允许已验证范围建点。任何新点都保留既有hold，不能洗白缺口；在途业务回执及必要归档收尾不受备份超龄阻断。

### 27.2 一致恢复点与媒体分层

- `FR-DR-003`：备份必须是同一捕获边界的逻辑快照，不对正在变化的整个dataDir直接递归复制。创建backupId并短暂设置checkpointFence，禁止新派发、新Artifact/日记多文件提交和归档清理；允许已有提交/回执收尾。等待已有pendingImport/pendingCommit到达可恢复边界，再在排他事务中捕获账本及其引用清单。
- 捕获内容包括原stateHash、historyEpoch/eventSeq、configRevision/version+hash、timeZone、cutAt、Task/Operation、永久businessKeys、requests、额度/费用/unknown、主体与审批审计、IM索引/outbox、Artifact元数据、journalPending及归档段摘要。journalPending可以随同快照保留，不能丢弃；引用集合必须覆盖该cut的全部已确认事实。
- 可变日记正文若纳入备份，必须在屏障内复制到只读staging；不能直接在锁外读取不断更新的正文。若预计突破checkpointTimeout或100MiB捕获预算，默认显式标为derived/rebuild并保留事实及索引；恢复时先标记待重建，不能把缺正文解释为已恢复的文学叙述。元数据达到80MiB预警，达到100MiB停止新业务，只允许归档、保留永久引用的压缩及恢复收尾，并单独报告条件化RTO不再适用。
- 本地渲染可继续写尚未提交的临时输出，捕获后解除checkpointFence；不等待整个视频生产结束，也不把这些工作文件列为已确认产物。大媒体与不可变归档复制在事务外，固定引用集合并按hash校验，禁止复制过程中回收相关对象。
- 捕获/flush/复制任一环节失败或屏障超时，该backupId不可成为新的有效恢复点，清理只限本次受控临时数据；不覆盖最后有效备份，不让异常遗留永久checkpointFence。崩溃后先完成屏障/提交记录的安全恢复，绝不借恢复自动重派业务。
- ledger包含完整账本恢复材料及媒体引用清单；full额外包含该cut要求的全部已定稿素材/产物字节。ledger可用于业务事实只读恢复，但缺媒体时相应Artifact=unavailable、readyForPublish=false，不声称能完整恢复成片；full漏掉任一必需对象即失败。
- 对象可按内容hash在同一受控备份库去重，manifest需列全引用与位置；不能引用任意外部绝对路径。导出便携full包时须实体化全部必要对象；增量/去重不改变“所需对象都能取回并校验”的完成条件。

### 27.3 清单、持久性与保留

- `FR-DR-004`：BackupManifest至少含schemaVersion=1、kind=backup、tier=ledger/full、stateVersion=3、backupId、workspaceId、sourceInstanceId、sourceHistoryEpoch、cutEventSeq、cutAt、configRevision={version,sha256}、timeZone、sourceStateHash、snapshotHash、files、journalCoverage、mediaCoverage、excludedData、failureDomain、createdAt、completedAt。
- `sourceStateHash = "jcs-sha256-v1:" + lowercaseHex(SHA256(JCS({stateVersion,workspaceId,historyEpoch,eventSeq,configRevision,timeZone,cutAt,state})))`，state为去除本机锁/进程临时字段的完整规范化账本；`snapshotHash = "jcs-sha256-v1:" + lowercaseHex(SHA256(JCS({manifestWithoutSnapshotHash,files})))`，对应实际导出的去秘密/去有效授权副本，两者不得混用。每个files条目含受控相对路径、角色、大小、sha256和是否恢复必需；mediaCoverage明确已包含/缺失/可重建对象，不能以最后复制时间冒充更新了cut。
- 不打包Cookie/API Key/机器人密钥、nonce或nonceHash等可用审批挑战、旧机器有效写者许可/迁移激活票据。保留审批决定与控制记录的审计摘要，但一律标为不能用于授权；旧权限绑定在恢复时必须重新核验。
- 恢复库包含私人日记/消息元数据等敏感资料，必须采用owner限定访问；离线搬运或共享介质须使用用户管理的加密介质/容器，密钥不随包存放。SHA-256只证明内容一致，不认证任意网络来源；只接受owner指定的可信备份来源。
- 所有必需文件复制、flush、hash核验完成后，才原子发布完成标记并更新备份目录索引。部分目录、临时文件、仅有manifest、无法保证持久性的复制确认都不能标为verified。按能力记录目录同步及介质耐久性限制，不宣称rename等于跨故障域保证。
- 每个完成点即时verify；启用策略期间至少每日复查最近有效ledger/full的必需文件摘要，完成一次隔离恢复演练后才标记restoreTested。保存lastVerifiedCutAt、lastBackupError、metadata/full覆盖、演练时间及RPO/RTO实测。
- 清理使用明确计划并重新检查引用，按tier分别保底：不得删除最后一个有效账本恢复点（可由full承担）或最后一个有效full点，哪怕它们超出最近/日/周保留集合；也不能删除故障调查固定点、未完成恢复引用或尚需的共享对象。若从未有有效full，必须报告媒体未受完整保护，不能用ledger数量代替。
- prune必须验证删除后的账本与媒体覆盖，不只检查是否还有ledger；即使full已超24小时目标，也保留最后可用full并报告过期，直至新的full验证通过。容量不足拒绝新备份/报告degraded，不先删唯一好备份腾空间，不自动删除业务源素材或原始证据。

### 27.4 只读恢复与历史分支

- `FR-DR-005`：RecoveryService独立于损坏的普通Store启动，限受信本地人类入口。先保全受损文件，校验可信恢复点、kind/schema/state版本、完整账本/归档及路径安全；只导入新空目录，不合并到活跃数据目录，不执行来源包内脚本或命令。
- ledger缺媒体允许只读账本恢复并列出不可用产物；账本/永久键/关键归档缺失或损坏不可伪装为完整恢复，必须保留错误和缺失范围。禁止从日记摘要反推全部businessKeys，或把坏索引置空后开放写入。
- 创建RecoveryCase和目标新instanceId，保留workspaceId与稳定账号命名空间；创建新historyEpoch并记录parent={backupId,sourceHistoryEpoch,cutEventSeq,snapshotHash}。旧分支只读保存，seq从新分支开始递增；业务键/requestId/taskId不因epoch变化而重置。
- 账本recovery.phase为readonly，holds初始覆盖所有可能受损的派发scope，本机activation为recovery-readonly。恢复服务可写自己的证据/审计与受控重建副本，但业务派发、旧审批、旧queued/running Task、旧通知、scheduler均关闭。恢复阶段的统一语义为：无活动case时state.recovery={id:null,phase:normal,holds:[]}；readonly/reconciling/blocked均不开放派发；restricted只开放已授权scope；released只表示case内既定scope核查完成，仍须逐hold和instance能力复核。state.recovery.phase必须与RecoveryCase同名阶段及revision一致，instance.capabilities只是最后投影，不得自定义另一套阶段名。
- 原审批挑战全部失效；旧主体/会话权限、迁移许可、工具路径、秘密与目录授权不得自动恢复，防止恢复已撤销的授权。正常§25迁移保留historyEpoch；灾备不得冒充同一历史无缺口延续。

### 27.5 不确定区间与事实重建

- `FR-DR-006`：RecoveryCase记录从最后可信cut到旧写者被实际隔离之间的uncertaintyRange；隔离时刻不能确认则右边界open。记录证据覆盖的epoch/seq区间和时间范围，但时钟相近或seq连续不是完整派发证明。
- 已知unknown/dispatching及预算占用原样保留；快照中的reserved、queued、未消费审批也可能在cut之后产生效果，不能依据快照缺dispatchAt或旧PID消失推断未发送。§7普通重启恢复规则在这里不适用。
- 无法枚举丢失动作时必须建立 RecoveryHold，而不是只冻结可见operationId。RecoveryHold 固定字段为 `{id,caseId,kind:"recovery",scope,scopeKey,revision,status:"active|released",evidenceRefs,createdAt,releasedAt,releaseDecisionRef}`；迁移hold使用相同结构但 `kind=migration`、`caseId=null`，不得伪造恢复case。scope 是下列对象之一：`{kind:"workspace",workspaceId}`、`{kind:"account_action",workspaceId,platform,accountId,action}`、`{kind:"provider_budget",workspaceId,provider,budgetId}`、`{kind:"im_conversation",workspaceId,adapterId,botAccountId,conversationId}`；action/provider/budgetId/botAccountId/conversationId 仅可在schema允许处使用 `*`。`scopeKey="jcs-sha256-v1:"+lowercaseHex(SHA256(JCS(scope)))`，禁止直接拼接未转义前缀键。
- scope匹配采用结构化覆盖而非字符串前缀：workspace覆盖同workspace全部候选；account_action覆盖同账号且action相同或为*；provider_budget覆盖同Provider/budget；im_conversation覆盖同adapter/bot/conversation。多个hold中任一active匹配即拒绝，released只解除该hold，不覆盖其他active hold。部分解冻必须在同一case revision中把父scope拆成不相交子scope、先激活其余子hold再释放父hold，不能用子scope release覆盖仍active的父hold；候选scope缺失/非法时按workspace级保守处理。
- 无法确定费用总额时建立 `UnknownExposure={id,caseId,scope,currency,maxMinor:null,source,operationRefs,evidenceRefs,status,revision,createdAt,resolvedAt}`，并以hold.exposureId关联；maxMinor=null表示不可封顶，停止该预算范围新付费，不以备份中的旧余额放行。
- 等待配额窗口过期、修改账号Cookie、生成新requestId、重建workspace或新historyEpoch都不能清除同一稳定账号/服务的恢复风险。能力切换不得绕过原scope冻结。
- `FR-DR-007`：RecoveryEvidence含id、caseId、scope、source、sourceHash、coveredRange、capturedAt、reviewedBy、原operation/task/businessKey引用及结论。支持残存可信完整记录、平台只读回执、Provider计费/任务回执或明确来源的人工核查；证据读取须另行授权，默认不联网探测。证据正文位于 `<recoveryDir>/evidence/`，使用owner限定权限，对外只返回evidenceRef/hash/脱敏摘要；迁移包携带refs，附件需独立受控导出，不得通过HTTP/IM/Agent读取或夹带秘密。
- 普通事件归档不是完整WAL。只有必要输入/原键/回执及覆盖范围足够时才应用事实修复：有原Operation则按§7核查更新它；缺原ID时写独立recoveredFact并保留证据，不编造历史operationId、参数或成功状态。无法恢复业务键就保留目标或更大scope的冻结。
- not_sent必须有证明未执行的证据；仅“列表里暂时没有”“备份没有记录”“用户点击确认”或超时不够。冲突证据建立争议，不能以较新的文件修改时间覆盖已确认事实。旧epoch迟到记录只进入证据区，经审查生成新epoch reconciliation事件，不自动当新回调执行。

### 27.6 隔离旧写者与分范围解冻

- `FR-DR-008`：recovery authorize不是migration activate。开放任何外部副作用前必须核验旧源、可能的迁移目标和关联执行器已经持久停止/隔离，旧票据或凭据无法继续外发；网络不通、PID不存在、租约超时或声明机器丢失都不是充分证明。
- 普通release回执确实不可取得时，可使用owner提供并审查的停机/存储隔离、旧会话与机器人/Provider凭据撤销等外部控制证据，绑定caseId、旧实例/账号、隔离时刻及目标instanceId。插件不自动执行凭据撤销或远端关机；证明不足时维持只读及写scope冻结，不能伪造release回执或直接解除原retired。
- 解冻前须完成该scope的不确定区间核查、永久键与额度保守修复、主体/账号重新验证、必要素材及依赖检查，并为修复后的目标建立新的独立verified恢复点。本地人类批准具体scope和证据版本，不提供“全部恢复/忽略缺口”的force开关。
- 已完成相应事实校验但仍禁派发的恢复副本，允许在管理路径创建上述恢复点，避免先解冻才能备份的循环。新备份必须携带父恢复点、未决RecoveryCase/holds和证据引用；新的cutAt或fresh状态不能消除旧历史缺口，held scope仍禁止派发。
- 无足够证据覆盖潜在重复动作/未知费用时，该scope持续冻结；可以单独允许不访问缺失历史或外部服务的新免费本地任务，不能宣称整套系统已恢复写入。外部写能力解冻也不自动resume旧任务、重发旧outbox或恢复旧审批。
- 最终准许派发必须同时满足：有效实例激活/能力清单、正常迁移门禁、健康备份恢复点、无匹配RecoveryHold、当前权限/审批/dryRun及额度检查。任何一项拒绝即停止。

### 27.7 恢复接口与幂等控制

| 逻辑接口 | 必要输入 | 返回与保证 |
|---|---|---|
| BackupService.create | kind、policyRevision、requestId | backupId、捕获cut、验证状态；接受不等于备份完成 |
| BackupService.verify | backupId | 完整性、故障域声明、媒体覆盖、恢复点年龄及阻断项 |
| BackupService.planPrune / prune | 保留策略；执行时planId＋owner确认 | 受保护引用清单与实际删除审计，不删除唯一有效点 |
| RecoveryService.restore | backupId/source、newEmptyDir、requestId、人类上下文 | recoveryId、readonly状态、缺失对象、初始holds |
| RecoveryService.inspect | recoveryId | 证据覆盖、未知区间、冻结scope及当前可用能力 |
| RecoveryService.reconcile | recoveryId、evidence、expectedRevision | 仅修复可证明事实，递增case revision，不授予写权 |
| RecoveryService.authorize | recoveryId、scope、evidenceRevision、隔离证据、人类确认 | 限定能力许可或明确拒绝，旧任务保持hold |

- `FR-DR-009`：RecoveryCase至少含id、workspaceId、targetInstanceId、backupRef、parentHistory、newHistoryEpoch、revision、phase、holds、evidenceRefs、fencingEvidence、decisions、createdAt；phase为readonly/reconciling/restricted/released/blocked。released仅表示既定scope核查与许可完成，不等于所有旧任务已执行。
- `<recoveryDir>/recovery.json` 是case状态、证据revision和授权决定的唯一权威，目标state.recovery与instance.activation/capabilities只是其投影。authorize使用两阶段持久化：①在recovery.json写入`decision.state=prepared`、nextRevision、证据/隔离引用和拟开放scope并flush；②在同一目标账本事务写入相同revision的恢复摘要和holds；③把recovery.json决定推进为committed；④最后才写instance.activationRevision/allowedCapabilities。前三步均不得开放派发；任一步崩溃可凭caseId/requestId幂等续办，但只有第④步完成且三者revision/决定完全一致才可能放行。
- 任一文件缺失、revision不匹配、state/instance被单独修改或中途崩溃均按更严格门禁处理；不能从state反推已授权，也不能因recovery.json committed而跳过instance最后的明确激活。恢复时无需旧instance可用，新instance/recoveryDir由restore建立。
- 所有管理入口只限本地人类；不向HTTP/Agent/IM开放backup/recovery/authorize或明文事故证据。普通config、task resume、Operation resolve和migration activate均不能覆盖RecoveryHold。
- 已解冻的scope若收到新的冲突/迟到证据，立即重新冻结该scope并记录原因，不能悄悄改账继续发。checkpoint/restore/authorize崩溃恢复只修复数据与许可一致性，不重放业务动作。

### 27.8 验收与实施接线边界

- `FR-DR-010`：必须完成§19.5的故障注入矩阵，分别证明数据能恢复和副作用不会被误重放；记录实际恢复点年龄、只读恢复耗时、缺媒体范围和未解冻scope。仅backup create/verify成功不等于恢复演练通过。
- 新增本地模块目标为backup-recovery.js，复用Store/Artifact/事件归档与主体权限，不新建分布式服务。以下每个入口都必须在预留和实际派发边界接入健康恢复点及RecoveryHold检查：§7.2平台写、§15.4 Manual人工补录、§15.5 External发布、§22.3通知/outbox、§24付费Provider；§24本地免费阶段与§25迁移prepare/activate还须检查迁移/恢复冻结。§6/§10只负责状态与hold约束，不能替代派发网关；同机HTTP/CLI/IM/scheduler入口不能保留绕过路径。
- 契约与验收已写入DESIGN/SPEC，TASKS已同步T20～T22、新增10条FR-DR及账本v3的任务映射；config.example仍无独立备份策略，代码与运行接线尚未实现。必须先完成审核再实施，不以文档同步或旧版42条覆盖率证明本增补完成。

