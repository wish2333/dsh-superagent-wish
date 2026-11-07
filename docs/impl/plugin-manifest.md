# 插件依赖的 DSH 能力

本文件列出本插件用到的 DeepSeek Harness Host 服务。换 DSH 版本时，按本表验证一遍。

| 服务 | 用途 | 状态 |
|---|---|---|
| `agentPresets` | 注册五个 preset | 已验证（`register(definition)`、`resolve(id)`、`composedPreset(agent.ctx)`） |
| `systemPrompt` | 向 Partner 注入协作模式行为规则 | 已验证（`section({ name, order, text })`） |
| `storageDomain` | 工作单元、输入、派工、授权四张表；策略记录 | 已接入（`open(spec)`；域 `working_units` 表 `working_units` / `inputs` / `assignments` / `mandates`；域 `superagent_wish_policy` 表 `policy`） |
| `workspaceRegistry` | 给每个工作单元建独立工作目录 | 已接入（`create(cwd)`，目录先 `mkdir`） |
| `sessionController` | 起 Worker 与 Secretary 会话、取名、取回会话、指定模型 | 已接入（`create` / `rename` / `resolveAgent` / `selectModel`） |
| `permissionPresets` | 设 Worker 会话权限 | 已接入（`set(session, 'danger-full-access')`） |
| `agents` | 取 live Agent，叫停当前派工 | 已接入（`get(id)`，再调 `agent.cancel({ kind: 'user' }, { keepInbox: true })`） |
| `workingDirectory` | 取 Partner 会话自己的工作目录，作为工作单元目录的基准 | 已接入（`get(session)`，缺少时退回 `defaultDirectory`） |
| `schedule` | 定时巡查：到点把一个 Secretary 会话叫起来记录一次巡查 | 已接入（`create` / `edit` / `pause`） |

验证依据：`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` 的类型声明。

`sessionController.create` 收的是 `workspaceId`（工作区 id），`workspaceRegistry.create(path)` 返回它。

## 插件配置

`apply(ctx, config)` 读 `implementerSlots`：同时跑几个执行者，默认 2，取值 1–16，越界回落默认值。
启发者不占槽位；wish 的追问不等槽位。同一个目录同一时刻只跑一个执行者。
在 bundle patch 里设置：

```yaml
- name: @wish2333/dsh-superagent-wish
  config:
    implementerSlots: 3
```
Secretary 的创建依赖两个预设事件：`agent-preset/selected`（会话建好之后才选预设，桌面版走这条）
与 `agent/created`（建会话时就带着预设）。见 `../design/working-unit.md` §九。

`ctx.systemPrompt.section` 的 `text` 会被同步调用；函数返回 Promise 会让整轮请求失败。

---

## 版本

| 包 | 原型钉的版本 |
|---|---|
| `@deepseek-ai/dsh-api-session-controller` | `0.2.1-alpha.2` |
| `@deepseek-ai/dsh-agent` | `0.2.1-alpha.2` |
| `@deepseek-ai/cordis` | `4.0.5-alpha.1` |

DSH 是开发者预览，升级前先跑一次派发验证。
