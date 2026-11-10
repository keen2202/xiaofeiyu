# dsh-bili-unified 挂载到真实 DSH desktop profile（T10/T16.2）— 2026-11-10

结论：插件已**真实挂载进本机 DSH 0.2.2-rc.1 的 desktop profile 并可用**（bundle 安装、工具注册、
HTTP 路由、数据目录复用均验证通过）。DSH 内 IM bridge 的“热”接入受**外部 QQ 风控**阻塞：
一次腾讯风控提示后机器人 QQ `275748387` 被下线、NapCat 进程退出，DSH 启动时 OneBot 不在线，
因此 `components.im.started=false`（fail-closed，不是代码缺陷）。

## 1. 安装方式（已执行）

用 DSH 官方的 profile 插件管理命令安装本地链接包（自动维护 dependencies 与 bundles）：

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
& 'D:\DSHdesktop\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add link:D:/Workespace/xiaofeiyu
```

变化（仅这些）：
- `C:\Users\22338\.dsh\profiles\desktop\package.json`
  - `dependencies`：`"dsh-bili-unified": "link:D:/Workespace/xiaofeiyu"`
  - `dsh.profile.bundles` 末尾追加 `"dsh-bili-unified"`
- 新增 `node_modules\`（`dsh-bili-unified` → `D:\Workespace\xiaofeiyu`）、`pnpm-lock.yaml`、`.plugin-manager\`；
- `cordis.patch.yml` / `cordis.yml` 未改动（插件自带的 `cordis.patch.yml` 作为 bundle 补丁插入条目）。

## 2. 挂载与功能验证（重启后）

| 验证项 | 证据 |
|---|---|
| bundle 状态 | `plugin_manager list_bundles`：`dsh-bili-unified`，`availability="profile"`、`installed=true`、`enabled=true`、`removable=true`、`source="link:D:\\Workespace\\xiaofeiyu"`、row=`include:dsh-bili-unified` |
| 工具注册 | 会话工具表出现 `bili_unified_status/browse/comment_draft/diary/dm/production/publish/task_cancel/task_get` 共 9 个；实际调用 `bili_unified_status` 返回完整状态 |
| 数据目录复用 | 仍为 `C:\Users\22338\.dsh\dsh-bili-unified`；workspaceId `workspace_35be7f30…`、historyEpoch `epoch_96c960…`、账号 3546827282450731（白阑王）与凭据 revision 均与挂载前一致；state.json 在 DSH 启动时更新 |
| 运行时组件 | `coordinator.started=true`、`backup.started/configured=true`、`migration.phase=active`、`recovery.phase=normal`、`counts.unknownOperations=0` |
| HTTP 路由 | `GET http://127.0.0.1:<DSH端口>/dsh-bili-unified/api/status` → `401 TRUST_UNAVAILABLE / host_admission_rejected`（路由已挂载；必须经 DSH connection 准入，裸 curl 不可绕过） |

## 3. DSH 内 IM 状态：外部条件阻塞

- `components.im`：`enabled=true / configured=true / transport=onebot-v11 / hostSource=onebot-v11`，
  但 `started=false`，`error="dsh-im host is unavailable"`（`reason: host_lacks_required_capability`）。
- 原因链：
  1. 插件在 `apply()` 时调用 `runtime.start()`，IM bridge 只在启动时尝试连接一次；
  2. 该次 DSH 启动时 NapCat/OneBot 未在线（机器人 QQ 已被腾讯风控下线，NapCat 进程退出）；
  3. 于是 channel probe 失败，bridge 按 fail-closed 不启动（不会伪造可用、不会反复重试）。
- 外部事件：2026-11-10 23:3x，机器人 QQ `275748387` 收到**腾讯风险提示并被下线**。这是账号侧风控，
  与插件代码无关；频繁重启 QQ Shell/第三方客户端注入、自动化收发都可能触发。

## 4. 恢复建议（不绕过风控）

1. **暂停** NapCat/自动化登录尝试，避免风控升级（不要连续重试扫码/快速登录）；
2. 等风险提示解除后，先用**官方 QQ 客户端**登录一次 `275748387` 完成验证（短信/人脸等，由腾讯决定），
   确认账号可用后再启动 NapCat（扫码登录一次，之后保持在线）；
3. 启动顺序：**先 NapCat（OneBot 3000/3001 就绪）→ 再启动 DSH**；否则插件启动时 IM 仍会因 host
   不可用而 fail-closed；
4. 若希望 DSH 内 IM 常驻，可后续用计划任务在登录时拉起 NapCat（需在风控解除后进行）；
5. 在 QQ 恢复前，DSH 内插件保持只读/工具可用，IM 显示 unavailable，受保护写入仍 fail-closed。

## 5. 未改变的安全语义

- 挂载不产生平台写：无调度器、无自动任务；所有写操作仍需 TTY 人类挑战/审批与保护点；
- IM 人类证明为 `unverified`，IM 审批继续 fail-closed；
- 账本/凭据/配置原样复用，无迁移、无 schema 变更。

## 6. 回滚

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
& 'D:\DSHdesktop\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop remove dsh-bili-unified
# 然后重启 DSH
```
沙盒已验证：remove 会同时移除 dependency 和 `dsh.profile.bundles` 条目。兜底：从
`C:\Users\22338\.dsh\profiles\desktop.backup-20261110-2310\` 恢复 `package.json`（其余文件未改动），
删除新增的 `node_modules` / `pnpm-lock.yaml` 后重启。
