# `.dsh-probe` — 本地真实 DSH 能力探测工具（仅开发/验收用）

本目录是本机对 `D:\DSHdesktop` 中真实 DeepSeek Harness 做**只读能力探测**和**宿主挂载验证**的脚本。
探测结果与抽取源码属于机器本地证据，已被 `.gitignore` 排除；仓库只保留脚本，便于复现。

| 文件 | 用途 |
|---|---|
| `probe.mjs` | 只读扫描 app.asar 中 `@deepseek-ai` 包清单与关键字命中（QQ/IM/审批/生命周期等），输出 `.dsh-probe/probe-out.json` |
| `extract.mjs` | 按包清单把 README/package.json/lib 源码抽取到 `.dsh-probe/dsh-src/`，并检索插件市场中的 QQ/IM 线索 |
| `extract-one.mjs` | 抽取单个包（`extract-one.mjs dsh-tools .`），用于核对具体契约实现 |
| `probe-host.ps1` | 用临时 `DSH_HOME=.dsh-probe-home` + `probe` profile 启动真实 DSH，校验入口激活、HTTP 路由、信任门禁与生命周期，结果写入 `.dsh-probe/host-probe-result.json` |
| `onebot-stub.mjs` | 最小 OneBot v11 HTTP stub（`get_status`/`get_login_info`/`send_private_msg`），只用于 `im probe` 协议通路验证，不是 QQ 桥接，也不发送真实消息 |

运行前置：

1. 本机安装 `D:\DSHdesktop`（DeepSeek Harness 桌面版，Electron 运行时）。
2. 探测 profile：`DSH_HOME=D:\Workespace\xiaofeiyu\.dsh-probe-home`，
   `dsh plugin --profile probe add link:D:/Workespace/xiaofeiyu`（junction 指向本仓库）。
3. 抽取/扫描脚本用 `ELECTRON_RUN_AS_NODE=1 'D:\DSHdesktop\DeepSeek Harness.exe' ...` 运行（asar 需在 Electron 运行时下读取）。
4. 宿主挂载探测：`powershell.exe -NoProfile -ExecutionPolicy Bypass -File .dsh-probe\probe-host.ps1`。

边界：探测不写入真实业务数据、不使用 B 站凭据、不向 IM 发消息；结果见
`doc/report/DSH_HOST_PROBE_2026-11-09.md`。`.dsh-probe-home/` 与桌面 profile 相互独立，不修改 `~/.dsh/profiles/desktop`。
