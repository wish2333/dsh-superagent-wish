# 插件依赖的 DSH 能力

本文件列出本插件用到的 DeepSeek Harness Host 服务。换 DSH 版本时，按本表验证一遍。

| 服务 | 用途 | 状态 |
|---|---|---|
| `agentPresets` | 注册 Partner、启发者、执行者三个 preset | 已验证（`register(definition)`） |
| `systemPrompt` | 向 Partner 注入协作模式行为规则 | 已验证（`section({ name, order, text })`） |
| `workspaceRegistry` | 给每个 Worker 建独立工作目录 | 已验证（`create(cwd)`） |
| `sessionController` | 起 Worker 会话、取名、取回会话 | 已验证（`create` / `rename` / `resolveAgent`） |
| `permissionPresets` | 设 Worker 会话权限 | 已验证（`set(session, 'danger-full-access')`） |

验证依据：`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` 的类型声明。

当前实现只用到前两项。后三项在派发链路实现时才接入，技术方案见 `../impl/superagent-impl.md`。

---

## 版本

| 包 | 原型钉的版本 |
|---|---|
| `@deepseek-ai/dsh-api-session-controller` | `0.2.1-alpha.2` |
| `@deepseek-ai/dsh-agent` | `0.2.1-alpha.2` |
| `@deepseek-ai/cordis` | `4.0.5-alpha.1` |

DSH 是开发者预览，升级前先跑一次派发验证。
