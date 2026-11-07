# Worker 组合规格

本文件描述两类 Worker 的定义、各自的工具边界，以及与 DSH 的接线方式。
机器可读的配置见 `composition.yaml`（与本文件保持同步）。
技术方案见 `../impl/superagent-impl.md`。

---

## 一、位置与职责

Worker 是独立 DSH 会话，与 Partner 不属于同一会话树。

- 每个 Worker 会话有一个 preset。
- preset 决定 Worker 能用哪些工具。
- 两类 Worker 的差别全部落在 preset 上，不靠提示词约束。

---

## 二、Worker 类型

### 启发者（discoverer）

| 字段 | 值 |
|---|---|
| preset id | `superagent-wish-discoverer` |
| 用途 | 探索选项、发散思路、挑战假设 |
| 输入 | exploratory prompt（开放式） |
| 输出 | 想法、选项、分析 |
| 副作用约束 | 不给写入工具，不能产生持久副作用 |

### 执行者（implementer）

| 字段 | 值 |
|---|---|
| preset id | `superagent-wish-implementer` |
| 用途 | 按 task spec 产出交付物 |
| 输入 | task spec（目标、范围、上下文、交付物） |
| 输出 | 文件、代码、内容等可交付物 |
| 副作用约束 | 有写入工具；写入范围由 task spec 的 `scope` 限定 |

---

## 三、工具边界

| 工具 | 启发者 | 执行者 |
|---|---|---|
| `read` | 有 | 有 |
| `glob` | 有 | 有 |
| `grep` | 有 | 有 |
| `web_search` | 有 | 有 |
| `web_fetch` | 有 | 有 |
| `write` | 无 | 有 |
| `edit` | 无 | 有 |
| `bash` | 无 | 有 |
| `todo_write` | 有 | 有 |

启发者不写文件，靠 preset 的工具白名单保证，不靠提示词。

---

## 四、与 DSH 的接线

| 项目 | 方式 |
|---|---|
| preset 注册 | `ctx.agentPresets.register({ id, name, description, order, plugins })` |
| Worker 会话创建 | `ctx.sessionController.create({ sessionId, workspaceId, agentPreset })` |
| 工作目录 | `ctx.workspaceRegistry.create(cwd)` |
| 权限 | `ctx.permissionPresets.set(session, 'danger-full-access')` |
| 送任务 | `agentDelivery.send(agent, requestId, text, 'queue')` |
| 模型 | 不指定，用会话默认 |

---

## 五、设计约束

- Worker 只用 DSH 公开的 Host 服务，不依赖 dsh-superagent 的领域模型。
- 工具边界的变更只改 `composition.yaml` 和 preset 的 `plugins` 列表，不改行为规格。
- 换 DSH 版本时，先验证派发链路，再改 Worker 定义。
