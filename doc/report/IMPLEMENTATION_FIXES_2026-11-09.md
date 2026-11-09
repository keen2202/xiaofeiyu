# 第一批实现缺口修复记录

日期：2026-11-09。对应用户指定的审查结论第 1～4 项，以及 Windows 测试失败。本次只实施代码与离线验证，没有真实 B站、IM 或 External 外发。

## 已完成

| 范围 | 修复结果 | 主要文件 |
|---|---|---|
| 干跑传递（F03） | 生产统一以 envelope.mode 为准；内层 mode 冲突在创建任务前拒绝；requestId 由统一入口传入。干跑审批不消费挑战。 | src/command-service.js |
| 审批回流（F01） | CLI、HTTP、IM 统一调用 decideAndContinue，按原任务执行评论、生产或投稿准备。持久 continuation 认领避免并发/重复批准重复执行；拒绝不执行。进程中断不自动重放，原任务保留用于显式恢复。Manual 仍进入 awaiting_manual。 | src/command-service.js、cli.mjs、src/index.js |
| 请求可靠性（F06） | 预留是持久 intent；Task 提交时在同一 Store 事务绑定 request/taskId、接纳事件、IM inbox 与通知目标。任务落账后崩溃，重复请求返回同一 taskId；无可靠结果的失联 owner 请求标记 OPERATION_UNKNOWN，不盲目重做。 | src/store.js、src/command-service.js |
| 通知可靠性（F02） | Task 状态提交同步生成 outbox；常驻 IM pump 只处理 pending，发送前重检保护点、冻结、权限与独立通知额度。sending/unknown 不自动重发，通知失败不重跑业务。群聊 none 不入队；关停等待正在派发的通知。 | src/adapters/channels/dsh-im.js、src/effect-gateway.js、src/index.js |
| 调度与聚合（F04） | 按任务类别同步占位，禁止重入；独立异步 Store 调用排队，真正嵌套仍拒绝。手动浏览接回 Coordinator 并传递 dry；后置未决/失败以 partial 呈现，子任务全部完成后更新父任务结算；stop 后不再接纳新轮次。 | src/coordinator.js、src/modules/browse.js、src/task-manager.js、src/store.js |
| 常规归档及容量（F08） | 启用功能的常驻 runtime 分批归档，默认禁用启动不新增轮询；关停归档收尾。统计账本、索引、归档与恢复目录字节及 pending 数，status 暴露指标。80MiB 停非必要后台生成，100MiB 阻止新业务/派发；10000 pending 保护保留；在途回执、归档、核查、备份与恢复收尾不因容量门禁被一并冻结。 | src/store.js、src/event-journal.js、src/effect-gateway.js、src/coordinator.js、src/index.js |

通知使用延迟派发队列：先随业务事实原子落账，再在真正派发边界检查当前备份保护与额度。这样备份暂时不可用或通知限流不会阻止已经发生的业务结果落账，也不会导致通知绕过派发保护。

## Windows 测试处理

- 路径预期改用 path.resolve/path.join，不再把 POSIX /tmp 写死为 Windows 结果。
- POSIX 0600 权限断言只在支持其语义的平台执行。Windows 保留文件保存/读取/环境覆盖验证并输出说明；不以 Node mode 位声称已验证 NTFS ACL。
- 文件 symlink/hardlink fixture 拆为独立子场景，仅在 Windows 明确返回权限或文件系统不支持错误时 skip；其他错误仍失败，越界、错误类型、超限等断言照常执行。修正原大小测试依赖硬链接残留的偶然拒绝，使用真正超限字节。
- 测试 runner 为每次运行创建独立工作区临时目录，传给 TEMP/TMP/TMPDIR，并在进程退出时清理，避免受限沙箱系统 TEMP 的 rename EPERM。

## 验证结果

- npm run check：92 个源/测试/脚本文件通过。
- npm test：229 项，226 通过、0 失败、0 cancelled、3 skip。
- 3 个 skip 均为本机不允许构造的真实链接 fixture：Artifact 文件 symlink、Artifact hardlink、Migration 文件 symlink。没有将这些场景记录为通过；有权限的 Windows 或 Linux 环境仍会实际执行。
- git diff --check：通过。
- 新增 test/entrypoint-reliability.test.js 覆盖真实 HTTP 路由到模块的审批执行、重复/并发批准、干跑/拒绝、任务提交后断点、失联 owner、IM 同事务落账与自动泵、群聊抑制、轮次互斥、容量门禁与回执收尾、常规归档生命周期。另更新父子任务结算回归。

完整日志位于工作区 .audit-tmp/fix-check.log、.audit-tmp/fix-tests.log。自动测试使用临时账本、Mock 平台/宿主及 FakeExecutionBackend，不代表真实外部服务验收或真实媒体重验。

## 边界

原审查第 5～6 项及未指定的缺口未在本次整体关闭，包括按账号浏览历史隔离、afterBrowse 日记接线、完整配置更新协议、真实 DSH 适配、多进程备份库索引锁和真实环境验收。旧审查报告保留为修复前快照，应结合本记录阅读。
