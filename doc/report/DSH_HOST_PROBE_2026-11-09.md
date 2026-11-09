# 本地真实 DSH 宿主挂载探测报告（2026-11-09）

> 结论先行：本工作区插件在**本机真实 DeepSeek Harness 0.2.2-rc.1** 上完成了一次可复现的宿主挂载与 HTTP/工具接线探测，
> 入口激活 0 警告，真实 HTTP 前缀路由经宿主 `webServer` 注册并经 `connection` 信任门禁返回 200/401/404。
> 该结果证明"薄宿主适配"可用，但**不**表示 T10/T16/T12.1 等任务已完成：完整门禁（T20/T21/T18）、真实 IM 宿主、
> 真实 B 站写入仍未交付（真实写入当前另被备份保护点门禁阻塞，见 §6）。

## 1. 环境与对象

| 项 | 取值 |
|---|---|
| DSH 版本 | `0.2.2-rc.1`（`D:\DSHdesktop\resources\app.asar\dsh\package.json`） |
| DSH 运行方式 | `ELECTRON_RUN_AS_NODE=1` + `D:\DSHdesktop\resources\runtime\cli\bin\dsh.cmd` |
| 探测 profile | 临时 `DSH_HOME=D:\Workespace\xiaofeiyu\.dsh-probe-home`，profile 名 `probe` |
| 插件包 | `dsh plugin --profile probe add link:D:/Workespace/xiaofeiyu`（junction 指向本仓库，改动实时生效） |
| 组合方式 | profile `package.json` 的 `dsh.profile.bundles` 含 `dsh-bili-unified`，其 `dsh.bundle.patch`（包内 `cordis.patch.yml`）自动插入唯一入口 |
| 端口 | 127.0.0.1:39779（不复用桌面 GUI 端口） |
| 桌面 profile | **未改动**（`~/.dsh/profiles/desktop` 属应用管理） |

探测脚本：`.dsh-probe/probe-host.ps1`；能力/源码只读抽取：`.dsh-probe/probe.mjs`、`.dsh-probe/extract.mjs`、`.dsh-probe/extract-one.mjs`。
原始结果（含完整响应体，本地不入库）：`.dsh-probe/host-probe-result.json`。

## 2. 启动与激活结果

`dsh web --profile probe --no-open --port 39779` 启动日志（`.dsh-probe/host-run.log` 与 stderr）：

```text
dsh web: http://127.0.0.1:39779/?token=<一次性 token，此处省略>
```

- 入口激活：**0 警告**（无 `did not activate` / `Invalid effect` / `without inject`）。
- 页面索引请求：`GET /` → **200**，宿主下发 1 个签名 cookie（浏览器会话）。
- 插件路由：`GET /dsh-bili-unified/api/status`（携带 cookie）→ **200**；未认证 → **401**；未知子路由 → **404**。
- 另一条只读路由：`GET /dsh-bili-unified/api/config` → **200**（返回 redacted 配置）。

## 3. 宿主契约探测结果

| 宿主能力 | 观测结果 |
|---|---|
| `ctx.webServer.register({kind:'prefix',path,handler})` | 可用；返回 disposer；前缀匹配 `/dsh-bili-unified/api/...` 生效 |
| `ctx.connection.admit(req)` | 可用；`GET /` 后携带 cookie 的请求被确认为 owner peer，无 cookie 返回 401 |
| `ctx.connection.browserPeer` | 可用；浏览器 peer 被映射为带 `trustedHumanContext` 的宿主人类上下文 |
| `ctx.tools.register(definition)` | 可用；9 个模型工具以"全局工具"层注册，输出 `{schema, render}` 契约通过宿主校验 |
| `ctx.effect(fn)` / 插件返回 effect | 插件返回 disposer 函数即被 Cordis 收集；卸载时 runtime 关闭、路由/工具释放 |
| 服务注入语义 | `inject: ['webServer','tools']` 使入口延迟到服务就绪后激活；`ctx.get(name)` 可无 inject 安全读取 |
| `ctx.approval.request` | 可用（本探测未触发审批；审批策略仍由宿主/本地人类证明决定） |

`/status` 关键结果（完整 JSON 见本地结果文件）：

```json
{
  "accepted": true,
  "result": {
    "instance": { "status": "active", "activationRevision": 1,
      "capabilities": ["core:read","core:write","platform:bilibili","production:local","publish:manual","publish:external","im"] },
    "migration": { "phase": "active", "id": null },
    "recovery": { "phase": "normal", "revision": 0, "holds": 0 },
    "capabilities": "declared/cached/unverified",
    "loginProbe": false,
    "components": {
      "coordinator": { "started": true, "scheduler": false },
      "im": { "enabled": false, "configured": false, "moduleAvailable": false, "reason": "disabled" },
      "execution": { "local": { "supported": true, "active": 0 }, "remote": { "supported": false } },
      "migration": { "available": true, "phase": "active" },
      "backup": { "started": true, "scheduler": { "configured": false } }
    },
    "backup": { "status": "unprotected", "reason": "policy_not_configured" }
  }
}
```

## 4. 本次探测发现并修复的真实宿主契约问题

截至 `e818ada`，入口只能通过简化 Mock 宿主；真实 DSH 依次暴露了三个契约问题，均已在 `src/index.js` 修复并有回归测试：

1. **Cordis ctx 是代理，未 `inject` 的服务属性读取会抛错**。旧实现 `if (ctx.webServer) …` 全部落空 → 误判为非真实宿主 → 返回普通对象，
   被 Cordis 判为 `TypeError: Invalid effect`（`1 entry did not activate`）。
   修复：入口声明 `inject: ['webServer','tools']` 延迟到服务就绪激活；服务读取走 `ctx.get(name)` 再回退普通属性，缺服务仍 fail-closed。
2. **插件 apply 的返回值被 Cordis 当作 effect 收集，必须是 disposer 函数（或可迭代项），不能是普通对象**。
   修复：真实宿主分支返回函数（携带 `runtime/dispose/mounted/httpPrefix` 属性）；不再额外 `ctx.effect` 重复注册。
3. **重复入口会造成双重挂载**。若包同时被 profile 的 `cordis.patch.yml` 插入、又作为 bundle 自带 patch，组装结果会出现两个 `dsh-bili-unified` 入口。
   修复：探测 profile 不再重复插入；代码对重复挂载返回幂等空 disposer（真宿主下仍为函数，满足 Cordis effect 契约）。

其他对齐：`ctx.connection` 由每请求惰性解析（服务可能在插件激活后才就绪）；`/status` 中 `im.moduleAvailable=false` 是"未启用"而非加载失败；
匿名/未知路由分别严格返回 401/404，未泄露内部错误。

## 5. 回归测试

- 新增 `test/host-probe.test.js`（5 项）：前缀路由注册、owner peer 准入、401/403 fail-closed、工具 agent principal、禁用配置、超大/畸形 body、缺失信任服务 503。
- 全量：`node scripts/run-tests.mjs` → **374 tests / 372 pass / 0 fail / 2 skipped**；`node scripts/check.mjs` → 99 files OK。
- 真实探测可复现：`.dsh-probe/probe-host.ps1` 启动临时 profile → 校验激活/路由/信任链 → 关闭进程，不写入真实业务数据。

## 6. 结论、边界与下一步

**已验证**：本仓库插件可作为 DSH 组合入口在真实本地 DSH 中激活；HTTP 前缀路由、信任门禁、工具注册、生命周期释放均按契约工作。
这补上了 T10 "惰性挂载 HTTP/工具到同一 CommandService" 的宿主侧证据。

**未验证 / 仍阻塞**：

- **真实 B 站写入**：`/status` 显示 `backup.status=unprotected`。SPEC §27 要求每次受保护真实派发前必须有有效恢复点，缺失即 BLOCKED；
  用户当前也选择"先不做真实写入"。需先建立独立故障域的有效备份策略与恢复点，再以最低额度、白名单 DM 做单次验收。
- **真实 IM**：本机无 dsh-im 宿主通道，QQ 也没有 OneBot/NapCat 类桥接在监听；`src/adapters/channels/dsh-im.js` 的宿主契约尚未接真实实现，
  按 FR-IM-007 保持 unavailable/BLOCKED，不用 Mock 冒充。
- **完整门禁**：T20/T21/T18 仍未完成，T10 不能因本探测标为 DONE；真实媒体、跨 OS、物理故障域同样未测。
