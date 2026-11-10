# NapCat / OneBot v11 本机接入记录（2026-11-10）

本报告记录在本机安装并跑通 NapCat（OneBot v11 协议实现）作为 `dsh-im` 宿主通道的过程、踩坑与证据。
结论：**NapCat 已可用**，OneBot HTTP/WS 桥接已与插件 `im probe` 打通；真实 QQ 入站回信与插件侧
`im bind` 仍待完成（需真实终端 TTY 人类挑战 + 一条真实 QQ 私聊）。

## 1. 安装与版本

| 项 | 值 |
|---|---|
| 安装目录 | `D:\Tools\NapCat` |
| NapCat 版本 | 4.18.42（`napcat.mjs` 内嵌版本串确认） |
| 一体化 QQ Shell | `D:\Tools\NapCat\NapCat.52230.Shell`，QQ **9.9.33-52230**（pure shell） |
| 登录账号 | 机器人小号 **275748387**（昵称 🐟，普通 QQ 号；官方机器人号不能用于 NapCat） |
| owner 账号 | **2233843382**（挽歌，已与机器人互为好友） |
| 协议形态 | OneBot v11：HTTP action（`127.0.0.1:3000`）+ 正向 WebSocket（`127.0.0.1:3001`），均启用 token |

## 2. 启动失败的根因与修复（重要）

现象：运行 `D:\Tools\NapCat\launcher.bat` 报 JS 错误；随后即使能拉起 QQ 窗口也没有 NapCat 的
WebUI / OneBot 输出。

根因有两个：

1. **`launcher.bat` 注入错目标**：脚本从注册表读取系统安装的 QQ（`D:\QQNT\QQ.exe`，内核 9.9.32），
   而本目录是“一体化 Shell”形态，自带匹配的 `NapCat.52230.Shell\QQ.exe`（9.9.33-52230）。
   版本/目录不匹配 → JS 错误。
2. **多进程 worker 在本机起不来**：NapCat 4.18.42 默认走多进程（主进程 + worker）。本机环境下
   worker 进程无法正常拉起，表现为：QQ 正常、但无 `config/webui.json`、无 `onebot11_*.json`、
   `6099/3000/3001` 全不监听，只在控制台留下 JS 报错。

修复：

- 新增 `D:\Tools\NapCat\launcher-shell.bat`：用**自带 Shell** 启动，并设置
  `NAPCAT_DISABLE_MULTI_PROCESS=1`（单进程模式）。实测单进程下 WebUI、OneBot、登录全部正常。
- 不再使用 `launcher.bat` / `launcher-user.bat`（它们指向系统 QQ）。
- 删除 QQ 自动更新包（`9.9.33-52230-9.9.37-54395.zip`），避免 QQ 自动升级到 NapCat 未适配的
  9.9.37 再次失效。
- 新增 `D:\Tools\NapCat\napcat-login.ps1`：读取 `config/webui.json` 的 token 计算
  `sha256(token + ".napcat")`，调 WebUI `/api/auth/login` 换 credential，再调
  `/api/QQLogin/SetQuickLogin` 做无界面快速登录（不打印 token）。适用于重启后 QQ 掉登录态。

## 3. OneBot 配置（已写入 NapCat）

`config/onebot11_275748387.json`：

- `network.httpServers[0]`：`name=http`，`host=127.0.0.1`，`port=3000`，`token=<本地随机>`；
- `network.websocketServers[0]`：`name=ws`，`host=127.0.0.1`，`port=3001`，`token=<同一 token>`，
  `heartInterval=30000`；
- 其余保持默认（`messagePostFormat=array`）。

WebUI 仅监听 `127.0.0.1:6099`（`host` 已从 `::` 改为回环）。OneBot token 只保存在本机
`D:\Tools\NapCat\.onebot-token.txt`，不进仓库；安装过程中曾有一次临时 token 出现在会话输出里，
已轮换为新 token。

## 4. 已验证证据（2026-11-10）

| 验证 | 命令/方式 | 结果 |
|---|---|---|
| WebUI 可用 | `POST http://127.0.0.1:6099/api/auth/login` | `code=0`，拿到 credential |
| QQ 快速登录 | `POST /api/QQLogin/SetQuickLogin {uin:275748387}` | `isLogin=true, coreReady=true` |
| HTTP action | `POST /api/QQLogin/…`、`POST /get_status`（带 Bearer token） | `online=true, good=true` |
| 无 token 拒绝 | `POST /get_status` 不带 Authorization | HTTP 403 |
| 登录身份 | `get_login_info` | `user_id=275748387`，`nickname=🐟` |
| WS 正向连接 | 客户端连 `ws://127.0.0.1:3001/?access_token=…` | OPEN，并收到 `meta_event/lifecycle/connect` |
| 插件只读探测 | `node cli.mjs im probe --config .dsh-probe/napcat-onebot.config.json` | `ok=true`，`status=available`，`humanIdentity=unverified`，`delivery.query=false`，bot=275748387 |
| 好友关系 | `get_friend_list` | `2233843382`（挽歌）在列 |
| 出站（平台直发自检） | `send_private_msg {user_id:2233843382}` | `retcode=0`，`message_id=192271706` |

未完成：**真实入站事件**（owner 给机器人发私聊）尚未发生；已多次开启 `im listen` 窗口（累计约
27 分钟）均 `received: 0`，NapCat `get_recent_contact` 里也只有 bot 自己发出的那条自检消息，
说明 owner 尚未实际发送，而不是链路故障（WS 已能收到 NapCat 事件）。

## 5. 插件侧待执行（需真实终端 TTY）

本机草稿（均已生成在 `.dsh-probe/`，不入库）：

- `napcat-onebot.config.json`：只读探测用的完整 `im` 配置（`transport=onebot-v11`，
  `baseUrl=http://127.0.0.1:3000`，`websocketUrl=ws://127.0.0.1:3001`，
  `accessTokenEnv=ONEBOT_ACCESS_TOKEN`）；
- `napcat-onebot-im-patch.json`：`config update` 的 `im` 段补丁（同上 + `enabled=true`）；
- `napcat-binding.json`：`im bind` 的绑定文件（bot 275748387 / sender 2233843382 /
  `private:2233843382` / scopes：production.create、task.read.own、task.cancel.own）。

待用户执行：

```powershell
cd D:\Workespace\xiaofeiyu
$env:ONEBOT_ACCESS_TOKEN = (Get-Content D:\Tools\NapCat\.onebot-token.txt -Raw).Trim()
node cli.mjs config update --file .dsh-probe\napcat-onebot-im-patch.json --confirm
node cli.mjs im bind --file .dsh-probe\napcat-binding.json --confirm
node cli.mjs im status --probe
```

之后按 `QQ_ONEBOT_INTEGRATION_2026-11-09.md` §5 / TASKS T16.2 做真实回信验收（首次真实 IM 发送需
用户单独授权，审批保持 fail-closed）。

## 6. 日常运维

- 启动：右键以管理员运行 `D:\Tools\NapCat\launcher-shell.bat`（保持窗口不关）；或直接双击
  （非管理员也可，单进程模式下实测可行）。WebUI：`http://127.0.0.1:6099`。
- 重启后 QQ 掉登录态：`powershell -NoProfile -ExecutionPolicy Bypass -File D:\Tools\NapCat\napcat-login.ps1`。
- 不要运行 `launcher.bat`；不要让 QQ 自动更新（若更新，需要重新匹配 NapCat 版本）。
- 插件侧 token 通过环境变量 `ONEBOT_ACCESS_TOKEN` 提供，值取自本机 `.onebot-token.txt`，不写进
  配置/仓库/报告。
