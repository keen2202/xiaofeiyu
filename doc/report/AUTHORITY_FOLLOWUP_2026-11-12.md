# 2026-11-12 授权入口与迁移重验整改

基线为 `3457f28`，本轮源码改动未提交。延续 F09/F05 整改，在此前派发边界检查之外补齐命令接收、结果重放、IM 入站和通知受众检查；不变更账本版本，不增加记忆功能。

## 已修复问题及依据

| 问题 | 设计要求 | 修复后的行为 | 代码与回归证据 |
|---|---|---|---|
| 命令信任缓存主体；等待请求锁后、返回旧结果前未重新授权；直接读取任务亦未复核当前 scopes | SPEC §22.1–22.2，FR-IM-002/004：撤权生效，重复请求先验证当前访问权 | 依据当前账本解析主体，在接收、锁后、预留事务与业务调用前核验；保留调用方缩小的 scopes 上限；列表/详情直接调用也复核。IM 白名单先于 owner 管理捷径执行 | [command-service.js](../../src/command-service.js)；[命令测试](../../test/command-service.test.js)：缓存 owner 撤销后不能读详情/列表或重放；scope 缩减零读取；等待锁期间撤权零预留；IM scope/会话变化拒绝 |
| 导入后的旧 IM 绑定与主体虽标记 requiresReverification，入站解析却仍可能选中；旧绑定可遮蔽新绑定 | SPEC §22.1、§25.3/25.4、§27.5：旧权限不可自动恢复 | 共用绑定检查同时验证主体、绑定、workspace、会话和待重验标记；解析时跳过无效旧绑定，命令继续核对受信桥接解析的身份上下文 | [identity.js](../../src/identity.js)、[桥接](../../src/adapters/channels/dsh-im.js)；[IM 测试](../../test/im-contract.test.js)：旧绑定零入站接收，新绑定可正常使用，主体再冻结后旧回执也不泄露 |
| 待发送通知只看 binding.revokedAt，未检查主体撤销/待重验；新绑定替换机器人身份后旧通知缺少比较 | SPEC §22.3，FR-IM-005：派发前复核受众；通知独立结算 | 入队拒绝无效授权；派发时发现主体/绑定/会话/机器人身份失效，持久记 suppressed 及原因，attempts 不增、零发送。观察器跳过无效受众，业务提交继续成功；sending/unknown 原语义保持 | [effect-gateway.js](../../src/effect-gateway.js)、[桥接](../../src/adapters/channels/dsh-im.js)；[通知测试](../../test/outbox.test.js) 覆盖 5 种失效原因；IM 测试覆盖撤权后业务状态仍提交 |
| IM 能力重验没有检查绑定主体待重验；收紧检查后又需保证仅申请 IM 的 owner 有可行重绑路径 | SPEC §25.3，FR-MIG-006：按当前证明恢复能力，旧权限不可继承 | 能力检查要求有效主体；本地 owner 已通过本次挑战时，只在检查副本中将该 owner 视作已核验，全部检查及授予成功后才提交标记。旧绑定和其他主体不随之恢复；只申请 im 不必先申请平台权限 | [migration-capabilities.js](../../src/migration-capabilities.js)、[migration.js](../../src/migration.js)；[审计回归](../../test/audit-fixes.test.js)、[迁移回归](../../test/migration.test.js)：无效主体拒绝；旧绑定导致失败且 owner 标记不变；创建新绑定后仅 IM 授权成功，旧绑定仍失效 |

## 验证

- Windows Node v24.18.0：`node scripts/check.mjs`，112 个文件通过。[日志](authority-followup-check-2026-11-12.txt)
- Windows 全量：`node scripts/run-tests.mjs`，417 项、414 通过、0 失败、3 跳过；较基线新增 9 项回归。[日志](authority-followup-tests-2026-11-12.txt)
- 3 项跳过分别为 2 项符号链接权限限制及 1 项沙箱硬链接限制。早前 Linux 406 项零跳过是历史版本证据，不包含本轮源码改动。
- 定向阶段 51 项通过；随后加入仅 IM 能力重验用例，已包含在最终全量中。初次直接 `node --test` 因沙箱 TEMP 重命名权限失败；改为工作区隔离 TEMP 后定向通过，全量使用仓库自带的隔离临时目录测试入口。
- 本轮无真实平台/IM 发送、生产迁移或远端环境变更；测试中的通道和人类证明为测试夹具，不能替代真实验收。

## 规范与兼容性

[SPEC §22/§25](../SPEC.md) 已同步检查时点、失败结果、通知抑制与 owner 重验提交语义；[TASKS §0](../TASKS.md) 为当前状态。历史日志及原有真实验收记录保留，不修改其发生时点和证明范围。

调用 CommandService 的受信宿主必须传入已在当前工作区登记的主体；缓存身份不再保留已撤销的权限。IM 入口必须来自有效绑定，调用方主动缩小的权限不会被扩大。迁移后需要新绑定和本次人类证明；无需升级 schema 或重写旧账本。

代码与规范整改已完成本轮发现的问题。剩余持续 RPO/RTO、生产账本迁移、Manual/External 投稿、生产 TTY 媒体及正式签署仍按 [前轮报告](PRIORITY_FIXES_2026-11-11.md) 的分项口径记录，不以此次离线通过抵扣。
