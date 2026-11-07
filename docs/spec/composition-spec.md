# Worker 组合规格

本文件描述两类 Worker 的定义、各自的工具边界，以及与 DSH 的接线方式。
机器可读的配置见 `composition.yaml`（与本文件保持同步）。
技术方案见 `../impl/superagent-impl.md`。

---

## 一、位置与职责

Worker 是独立 DSH 会话，与 Partner 不属于同一会话树。Partner 不用子代理派活（R28）。

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
| 输出 | 写入自己工作目录的产出文件，含想法、选项、分析 |
| 副作用约束 | 写入只落在自己的工作目录，不改仓库 |

### 执行者（implementer）

| 字段 | 值 |
|---|---|
| preset id | `superagent-wish-implementer` |
| 用途 | 按 task spec 产出交付物 |
| 输入 | task spec（目标、范围、上下文、交付物） |
| 输出 | 文件、代码、内容等可交付物 |
| 副作用约束 | 有写入工具；运行时权限为 `danger-full-access`，`scope` 只是行为约束，无运行时强制 |

---

## 三、工具边界

| 工具 | 启发者 | 执行者 |
|---|---|---|
| 来源插件 | 见 ADR-0003 | 见 ADR-0003 |
| `read` | 有 | 有 |
| `glob` | 有 | 有 |
| `grep` | 有 | 有 |
| `web_search` | 有 | 有 |
| `web_fetch` | 有 | 有 |
| `write` | 有 | 有 |
| `edit` | 有 | 有 |
| `bash` | 无 | 有 |
| `todo_write` | 有 | 有 |
| `partner_report` | 有 | 有 |

启发者不跑命令：preset 不列 `@deepseek-ai/dsh-tool-bash` 就没有 shell。写权限靠这组 `plugins` 行给，范围的约束靠 task 说明，无运行时拦截（ADR-0001）。不用 `ctx.tools.restrict()`——它只对已注册的全局工具做减法，preset 加载时那些工具还没注册（ADR-0003）。

两类 Worker 的结束条件不同：启发者报 `ready` 即结束，追问开新的工作单元；执行者报 `ready` 后等 wish 判断，追问投给同一个工作单元。见 `../design/working-unit.md` 第二节。

---

## 四、与 DSH 的接线

| 项目 | 方式 |
|---|---|
| preset 注册 | 用 `ctx.agentPresets.register({ id, name, description, order, plugins })` |
| Worker 会话创建 | `ctx.sessionController.create({ sessionId, workspaceId, agentPreset })` |
| 工作目录 | `ctx.workspaceRegistry.create(cwd)` |
| 权限 | `ctx.permissionPresets.set(session, 'danger-full-access')` |
| 送任务 | `agent.followup(message)`；改当前轮用 `agent.steer(message)` |
| 回报回传 | 队列 → `agent.steer(report)` 送进 Partner；一轮结束无回报时补一条 `waiting` |
| 派发入口 | Partner preset 的 `partner_dispatch` 工具；Worker preset 无此工具 |
| 追加与中止 | `partner_followup` 投给工作单元当前的 Worker 会话；`partner_stop` 中止当前一轮 |
| 模型 | 可在 `partner_dispatch` 里指定（`provider`、`model`，可带 `reasoningEffort`）；不指定用会话默认 |

---

## 五、设计约束

- Worker 只用 DSH 公开的 Host 服务，不依赖 dsh-superagent 的领域模型。
- 工具边界的变更只改 `composition.yaml` 和 preset 的 `plugins` 列表，不改行为规格。
- 换 DSH 版本时，先验证派发链路，再改 Worker 定义。
