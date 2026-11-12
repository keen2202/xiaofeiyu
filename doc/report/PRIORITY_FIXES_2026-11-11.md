# 2026-11-11 优先级 1–6 整改与验证

2026-11-12 后续代码整改：命令入口当前权限、IM 旧绑定、通知受众及仅 IM 迁移重验已补齐，当前全量 417 项 / 414 通过 / 0 失败 / 3 环境跳过，见 [后续整改报告](AUTHORITY_FOLLOWUP_2026-11-12.md)。下文 408/406 项日志保留其原有代码范围。

整改基线：`0cfb4ae`，证据与修复已分别提交为 `d1a6e1c`、`6ae973a`。2026-11-12 收尾复核基线为 `3457f28`，包含后续真实验收记录及 `3bef4cd` 的 Windows 原子写重试修复。环境：Windows x64/Node v24.18.0；Linux 6.8/Node v24.14.0、v22.23.4；ffmpeg/ffprobe 6.1.1。对应 [修复前审计](IMPLEMENTATION_AUDIT_2026-11-11.md) §8 的六项处理顺序；原审计探针与结果保留为历史反例。

**结果：优先级 1–4 的代码与文档整改完成；第 5 项已完成 Linux 双版本回归、真实媒体、合成数据双向跨 OS 迁移及一次跨机 full 只读恢复，后续提交还记录了 owner 核验的独立备份域、真实评论和 IM 审批闭环；持续 RPO/RTO、生产账本迁移及真实投稿等验收仍有缺口；第 6 项按原建议后置，不实施记忆功能。** 这不是全项目已完成真实验收的声明。

后续真实验收证据分别见 [独立备份域与首条评论](P3_REAL_ACCEPTANCE_2026-11-11.md)、[DSH 内 IM 入站/回信](DSH_IM_LIVE_2026-11-11.md)、[IM 批准到真实评论及状态回信](T12_1_IM_APPROVE_2026-11-11.md)。它们补齐下文隔离测试未覆盖的部分，不改变原测试使用合成数据和测试人类证明的事实。历史 `protected` 只表示当时恢复点有效，不表示今天仍然新鲜。

## 1. 逐项结果与依据

| 优先级 / 审计编号 | 设计要求 | 改动和当前行为 | 代码与证据 |
|---|---|---|---|
| 1 / F01 | SPEC §27.1、FR-DR-002：独立故障域、有效且新鲜恢复点 | 新增结构化 failureDomainVerification，绑定源目录、目的地、核验人、时间和独立性；manifest/index 绑定 policyRevision。缺核验、同域、旧策略或策略变更后无新点一律 unprotected。描述文字不作为授予依据 | [backup-recovery.js](../../src/backup-recovery.js)、[验收核验读取](../../scripts/acceptance/_failure-domain.mjs)。真实 BackupService → Gateway 回归断言未核验时 reserve 拒绝、策略变化后 dispatch 拒绝且零网络写入 |
| 1 / F09 | SPEC §22.2、FR-IM-004：撤权后未派发动作拒绝 | reserve/dispatch/本地执行和批准使用当前账本主体；Task 持久记录创建绑定；审批单独记录决定绑定。撤销主体、撤销绑定、移除 scope 或要求重新核验均阻断。新任务的状态回信绑定不替代执行授权；旧任务缺创建授权字段时按已有绑定保守检查 | [identity.js](../../src/identity.js)、[approval.js](../../src/approval.js)、[effect-gateway.js](../../src/effect-gateway.js)、[task-manager.js](../../src/task-manager.js)、[command-service.js](../../src/command-service.js)。覆盖批准后撤销、预留后撤权、IM 创建绑定/批准绑定撤销 |
| 1 / F10 | SPEC §22.1：scheduler 不得冒充人类 owner | 稳定 service/scheduler 主体，scopes 仅随已开启功能配置生成，不授予 `*` 或审批/管理权限；撤销后拒绝自动重建。服务草稿由已有本地人类审批；私有日记可按配置生成，私有读取仍仅 owner | [coordinator.js](../../src/coordinator.js)、[identity.js](../../src/identity.js)、[diary.js](../../src/modules/diary.js)。身份、证明拒绝、稳定 ID/撤销测试及既有调度/日记回归 |
| 1 / F03 | SPEC §4.1：默认 < JSON < 注入 < 环境 < 显式调用 | 修正加载、更新和 intent 恢复；文件只保存文件层，文件 hash 与生效配置 hash 分开。宿主 dryRun 和限额不因文件更新或重启被覆盖 | [config.js](../../src/config.js)。冲突字段、更新/重启、staged intent 恢复测试；测试 fixture 迁回文件层以验证可更新配置 |
| 1 / F04；2 / F02 | SPEC §7.1/§7.4/§8：所有读取遵守额度、时间槽、暂停和熔断 | 连续读和只读重试在 Store 锁外等待槽位，等待总量有界，醒来重验；冷 WBI nav 同样预留读额度。字幕失败记录失败冷却，避免误归为“无字幕” | [bilibili.js](../../src/bilibili.js)、[browse.js](../../src/modules/browse.js)。真实 client+adapter+Browse、Mock 网络覆盖热门→WBI→搜索→详情→字幕元数据→字幕内容→热评，7 次读取/6 次等待；等待时可另开事务，暂停/熔断的冷 WBI 零请求 |
| 3 / F05 | SPEC §25.3、FR-MIG-006：目标重绑并按验证结果恢复业务能力 | 新增本地人类 `migration reauthorize`，逐项检查账号、profile/工具、发布器或 IM 通道/受众及目标恢复点；请求任一项失败不授权。两阶段决定覆盖 state/instance，prepared 阻止派发；崩溃重试不能继承未提交授予。hold/旧挑战不自动解除，待审批评论/生产 resume 可签发新挑战 | [migration.js](../../src/migration.js)、[能力检查](../../src/migration-capabilities.js)、[入口](../../src/index.js)、[CLI](../../cli.mjs)、[comments.js](../../src/modules/comments.js)、[production.js](../../src/modules/production.js)。[迁移测试](../../test/migration.test.js) 从双目录交接到真实 runtime/CLI、账号重绑、能力授权、hold 释放和原 Task 新审批；另覆盖断电后禁派发及不同请求重试不继承权限 |
| 4 / F06 | SPEC §27.3、FR-DR-004：保留旧 full，同时报告过期 | 分别报告 ledger 与媒体年龄、阈值和健康状态；full 超龄为 mediaStatus=degraded、reason=full_recovery_point_stale，新 ledger 不掩盖旧媒体覆盖 | [backup-recovery.js](../../src/backup-recovery.js)。25 小时旧 full + 新 ledger 回归，账本 protected、媒体 degraded |
| 4 / F07/F08 | SPEC/实现范围、默认配置和验收口径一致 | SPEC 默认 JSON 与 config.example.json/DEFAULT_CONFIG 完全一致；IM 白名单补 comment.draft；新增授权/备份/调度契约说明。TASKS §0 成为唯一现行状态，下方任务标题作为验收要求，§10 标为历史记录 | [SPEC](../SPEC.md)、[TASKS](../TASKS.md)、[DESIGN](../DESIGN.md)。默认配置三方深度比对通过；历史 DM/IM 证据与当前缺口分列 |
| 5 | T17.3/T22/T12.3：真实媒体、链接防护、独立介质、跨 OS 验收 | Windows/Linux 回归通过；Linux 链接用例零跳过；真实视频/封面和合成数据双向跨 OS 迁移通过。跨机 full 只读恢复 38ms，单点故障时年龄 17分24.370秒。后续独立备份域与评论/IM 已有单次真实证据；持续 RPO/RTO、生产账本迁移和投稿尚未证明 | 见下表及后续验收记录，不用 Mock 或 skip 代替真实验收 |
| 6 | 审计建议后置记忆能力；TASKS §9/GATE-MEM | 保留事实/偏好/经验规划，等待单独确定具体机制并补主规范。未新增记忆数据、源码或 schema | [TASKS §0/§9](../TASKS.md)；这是按第 6 项建议延期，不计作记忆功能已实现 |

## 2. 验证结果

| 验证 | 结果 | 日志 |
|---|---|---|
| 2026-11-12 当前树 `3457f28` 语法检查 | 112 文件通过，含后续原子写修复 | [final-syntax](priority-final-check-2026-11-12.txt) |
| 2026-11-12 当前树 `3457f28` Windows 全量回归 | 408 项，405 通过、0 失败、3 skip（2 项符号链接权限、1 项沙箱硬链接限制）；含原子写重试 2 项新增回归 | [final-suite](priority-final-tests-2026-11-12.txt) |
| Windows `npm run check` | 原 109 文件语法检查通过；后增 2 个手工验收脚本另检查并实跑 | [syntax-check](priority-check-2026-11-11.txt) |
| `npm test` | 406 项，403 通过、0 失败、3 skip；新增 13 项审计/迁移回归 | [full-suite](priority-tests-2026-11-11.txt) |
| `node --test test/audit-fixes.test.js` | 全量运行后补强 BackupService→Gateway 的 reserve/dispatch 断言；11 项全通过 | [safety-regressions](priority-safety-tests-2026-11-11.txt) |
| 最终授权兼容性回归 | Windows 37 项通过，含旧任务绑定撤销、新任务 IM 审批和 HTTP/CLI 入口 | [authority-regressions](priority-final-authority-tests-2026-11-11.txt) |
| Windows 沙箱外隔离链接复验 | 10 项，8 通过、0 失败、2 skip；硬链接拒绝用例通过，符号链接仍缺 Windows Developer Mode/SeCreateSymbolicLinkPrivilege | [link-checks](priority-link-tests-2026-11-11.txt) |
| Windows 媒体初次预检 | 当时 BLOCKED；后续已在用户提供的 Linux 完成真实媒体验收，此日志保留为初次环境记录 | [media-preflight](priority-media-2026-11-11.txt) |
| Linux `node scripts/check.mjs` | 最终 111 文件语法检查通过 | [linux-syntax](priority-linux-check-2026-11-11.txt) |
| Linux Node v24.14.0 整改最终回归 | 406 项全通过、0 失败、0 skip，含最后的旧任务授权绑定加固 | [linux-final-tests](priority-linux-node24-final-2026-11-11.txt) |
| Linux Node v22.23.4 整改最终回归 | 406 项全通过、0 失败、0 skip，含相同授权加固，覆盖声明的 Node 22 主版本 | [node22-final-tests](priority-linux-node22-final-2026-11-11.txt) |
| Linux 真实媒体验收 | 两组成片均 succeeded/readyForPublish；h264、尺寸、音轨/字幕、解码、cover/hash 校验通过；缺工具负例阻断 | [media-evidence](priority-linux-media-2026-11-11.json) |
| Windows→Linux→Windows | 实际跨机复制/导入/激活/重启/反向交接；账号/epoch/永久键/Artifact hash 保留，原源 retired，旧审批无效，未核验平台禁派发 | [structured-evidence](priority-linux-acceptance-2026-11-11.json) |
| Windows full→Linux 只读恢复 | 远端核验副本后模拟仅测试源账本丢失；38ms 恢复并核对摘要、新 epoch、readonly/holds、禁派发；保留 post-cut 缺口，不补造事实 | [structured-evidence](priority-linux-acceptance-2026-11-11.json) |
| SPEC §4.3 JSON 深度比较 | 与 config.example.json、DEFAULT_CONFIG 一致 | 本轮本地校验，无网络 |
| 两个真实验收脚本 `--help` | 新参数已暴露，语法通过；该次检查未执行真实 DM/IM，后续真实 IM 见独立记录 | [脚本说明](../../scripts/acceptance/README.md) |
| `git diff --check` | 通过 | 仅有仓库换行符提示 |

Linux 406 项日志对应 F01–F10 整改源码：初次源码包之后同步了 `src/identity.js` 与 `test/audit-fixes.test.js`，摘要在结构化证据中。这轮覆盖最终授权加固，但不包含后续 `3bef4cd` 的原子写重试及新增 2 项测试；不能当作当前 408 项代码树的 Linux 全量结果。初次 Linux 日志保留，最终日志另行归档。

Windows 的 3 项跳过已在 Linux 整改回归中执行通过；Windows 本机的符号链接系统权限仍未改变。用户提供 Linux/密钥并明确使用 sudo -i 后，采用 root 已有 Node/ffmpeg，子进程使用隔离 HOME/TEMP 和无业务秘密的环境。另用仅解压到验收目录且核对 Node 官方 SHA256 的 Node 22 验证兼容性，未改系统安装。

本轮隔离跨机验收使用合成数据和测试 human verifier，不代表生产 TTY/宿主人类证明验证。迁移验收注入备份保护，故数据/OS 交接通过不等于完整生产启用前置已满足。该次 full 测试时用户仅准许验收目录作为目的地，尚未明确确认物理故障域；本地 staging 始终 unprotected，未伪造 independent=true。后续 owner 核验及真实 TTY 建立的独立保护点见 P3 记录，与此隔离样本分开计证。

单次 full 演练仅包含一个 68 字节 PNG fixture 和小型合成账本：故障时点到 cut 的实际年龄为 1,044,370ms（17分24.370秒）；38ms 仅计远端本地包已到达后，从 restore 到只读状态/摘要核对完成，不含网络传输、人工诊断或大媒体。它不是长期 15 分钟调度、20 分钟上限、24 小时媒体目标或60分钟生产 RTO 的达标证明。SSH 只用于传输验收包，本轮未新增自动 SSH 备份目的地适配器。

可复查材料保留在本机 `.audit-tmp/linux-acceptance-20261111/` 和 Linux `/home/ubuntu/xiaofeiyu-acceptance-sx58lukl/`；只含本轮运行时、源码、合成数据与日志。全量原始日志及结构化摘要已归档到本报告目录。

## 3. 升级与操作说明

旧任务缺少 authorizationBindingId 时，已有通知绑定按保守权限上限处理；来源不明的旧草稿需本地重新审查/创建，不能自动认作无限制本地任务。

旧 `backup-policy.json` 不含结构化核验时仍可创建备份，但真实平台写、付费调用和 IM 派发会被拒绝。owner 必须实际核验独立介质，在策略里记录 sourceRoot/destinationRoot/verifiedBy/verifiedAt/independent，再按当前策略创建并验证新恢复点。不能把历史点改个标记继续当作受保护点；也不能仅把 C:/D: 换为两个盘符就认定独立。验收脚本现在要求 `--verification <owner-reviewed.json>`，默认模板不替 owner 声明独立性。

迁移后先完成原 prepare/export/release/import/validate/activate 流程，在目标绑定路径、配置、凭据（平台能力需 `account verify`）、IM 受众并建立目标保护点，再由本地人类执行，例如：

```text
node cli.mjs migration reauthorize <migrationId> --capabilities platform:bilibili,publish:manual --data-dir <target> --confirm
node cli.mjs migration release-hold <holdId> --task <taskId> --data-dir <target> --confirm
node cli.mjs task resume <taskId> --go --confirm --data-dir <target>
```

能力列表另支持 `production:local`、`publish:external`、`im`，只请求本机已重新绑定的项。生产能力检查会运行所选受信工具的版本预检；平台核验只读 whoami；External 检查不执行发布，IM probe 不发送消息。启用新 IM 通道后需重建 runtime，以装配对应通道。任务恢复仍需当前权限、hold 和新的人工审批；源实例保持 retired，旧通知不重发。灾难恢复必须走 recovery authorize，不能借此迁移命令解除 recovery hold。

## 4. 剩余优先事项

1. 在已建立的远程备份域上，按真实数据规模和自动备份周期持续测量 RPO/RTO，补媒体 full 与介质故障演练；检查容量和挂载重建。P3 记录远端当时已用 92%，单次小样本恢复不能替代该验收。
2. 按 [生产账本跨 OS 方案](T12_3_CROSS_OS_PLAN_2026-11-11.md) 完成停机窗口和两端真实 TTY 安排后，再执行生产迁移及所需业务能力重验。当前通过的是合成数据交接和受限重授权代码流程。
3. 补 Manual/External 投稿、生产 TTY 媒体及 DSH+IM 持续组合验收，逐项限定账号/内容/额度/会话。已记录的真实评论和 IM 审批闭环是单次证据，不替代持续运行或投稿验收。
4. 核心必需验收收敛后再审 GATE-MEM；不将记忆能力加入本轮代码整改。
