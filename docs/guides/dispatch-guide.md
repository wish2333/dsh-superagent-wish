# 派发操作指引

本文件是 Partner 派发 Worker 的操作指引。
行为规格见 `../spec/interaction-spec.md`；Worker 类型和工具边界见 `../spec/composition-spec.md`；技术方案见 `../impl/superagent-impl.md`；工作单元的结构见 `../design/working-unit.md`。

一次派发开出一个**工作单元**。之后对它的追加消息投给这个工作单元当前的 Worker，不新建。

---

## 一、判断派哪种 Worker

| 情形 | Worker 类型 |
|---|---|
| 讨论需要拓展，选项还不清晰 | 启发者 |
| 假设需要挑战，需要不同视角 | 启发者 |
| 方向已确认，交付物清晰 | 执行者 |
| 需要产出文件、代码或内容 | 执行者 |

同一个主题下，启发者先行，执行者跟进。启发者的结果由 Partner 整合后带回给你，不直接透传。

---

## 二、exploratory prompt 格式

结构：背景 → 焦点 → 发散要求。

```
背景：[当前正在讨论什么，面临什么决策]
焦点：[想在哪个维度发散，或哪个假设需要挑战]
要求：
  - [具体的发散维度，例如：给出至少 N 种方案]
  - [指出潜在盲点或被忽略的约束]
  - 只在自己的工作目录写产出文件，不改仓库
```

**示例**：

```
背景：正在设计 Worker 的派发链路，需要决定确认点放在哪一步。
焦点：在"少打扰"和"越界风险"之间怎么取平衡。
要求：
  - 给出至少 3 种确认点位置
  - 指出每种位置对 Partner 操作负担的影响
  - 指出每种位置在 DSH 会话创建流程中的可行性
  - 只在自己的工作目录写产出文件，不改仓库
```

**约束说明**：启发者的 preset 有写入工具，写入范围靠这段要求约束，没有运行时拦截。

---

## 三、task spec 格式

结构：目标 → 范围 → 上下文 → 交付物。

```
goal: [一句话说清楚产出什么]

scope:
  in:
    - [在范围内的内容]
  out:
    - [明确排除的内容]

context:
  - [相关文件路径，附简短说明]

deliverables:
  - path: [输出路径]
    format: [格式]
    note: [可选的额外说明]
```

**示例**：

```
goal: 把本次讨论产出的 Worker 组合规格写成文档

scope:
  in:
    - 两类 Worker 的定义
    - 各自可用的工具
    - 与 DSH 的接线方式
  out:
    - Partner 的行为规格（见 interaction-spec.md）
    - 派发代码实现

context:
  - ../spec/interaction-spec.md（Partner 行为规格）
  - ../impl/superagent-impl.md（派发技术方案）

deliverables:
  - path: ../spec/composition-spec.md
    format: Markdown
  - path: ../spec/composition.yaml
    format: YAML
```

**scope 的作用**：`scope.in` 和 `scope.out` 合起来就是 Worker 的意图范围。Worker 遇到 `scope.out` 内的问题时报 `blocked`，不自行处理。范围没有运行时拦截。

---

## 四、Worker 会话怎么起

Partner 确认后调 `partner_dispatch`，工具内部按下表派发，接口细节见 `../impl/superagent-impl.md` 第二节。

| 步骤 | 动作 |
|---|---|
| 1 | `mkdir` 后 `ctx.workspaceRegistry.create(cwd)` 建这个工作单元的工作目录；追问沿用，不重建 |
| 2 | `ctx.sessionController.create({ sessionId, workspaceId, agentPreset })` 起会话，启发者或执行者 |
| 3 | `ctx.permissionPresets.set(session, 'danger-full-access')` 设权限 |
| 4 | `ctx.sessionController.rename({ sessionId, title })` 用任务标题命名 |
| 5 | `agent.followup(message)` 送 exploratory prompt 或 task spec |

Worker 是独立 DSH 会话，不是子代理。模型不指定，用会话默认。`partner_dispatch` 只挂在 Partner preset，Worker 会话里没有这个工具。

---

## 四之二、追问和中止

一个工作单元可以来回多轮，不必重新派。

| 目的 | 用什么 |
|---|---|
| 新的一件事 | `partner_dispatch`，开新的工作单元 |
| 同一件事继续，补要求或回问 | `partner_followup`，向这个工作单元追加输入 |
| 先别干了 | `partner_stop`，中止当前这一轮；工作单元还在 |
| 看有哪些活、各自什么状态 | `partner_list` |

Partner 按工作单元引用，不记 Worker 会话 id。追加输入投给这个工作单元当前的 Worker：空闲时开新一轮，运行中排到下一轮。

**追加消息的格式**：一句说明意图，再写要求。不需要重写 task spec 的 `goal` 和 `scope`，除非范围真的变了。

```
接着上次的 [工作单元标题]：[新要求或问题]
```

**三种交互都未实现**：`partner_followup`、`partner_stop`、`partner_list` 在代码里都不存在，现在只能重新派发。

---

## 五、派发确认消息格式

Partner 在派出 Worker 前发给你的确认消息。

```
我准备做 [X]，因为 [Y]。

Worker 类型：[启发者 / 执行者]

同意吗？
```

你确认后，Partner 才调 `partner_dispatch` 开工作单元。追问不需要重新确认，除非它改变了 task spec 的 `scope`。

---

## 六、整合回报

| Worker 类型 | Partner 处理方式 |
|---|---|
| 启发者 | 读它写下的产出文件，提炼关键选项和盲点，整合进当前主题的需求模型，带回给你；原始输出不直接转贴 |
| 执行者 | 核查交付物是否符合 task spec；符合则汇报结果；有偏差则用偏差汇报格式（见 `../spec/interaction-spec.md`） |

回报由 Worker 调 `partner_report` 提交，经队列以 `steer` 送进 Partner。目标是让回报的 source 为 `agent-message`，Partner 按“某个 Worker 报了什么”来读；代码现在仍用 `user`，回报会和 wish 的话混在一起。

推不推由代码按状态决定：`ready`、`blocked`、`failed`、`dropped` 和提问推给 Partner，`progress` 不推。送进 Partner 的正文形如：

```
Worker (discoverer session superagent-wish-discoverer-mac-3f2a1b7c) "Explore macOS" reported ready:

[Worker 写的摘要]

Read session superagent-wish-discoverer-mac-3f2a1b7c for the full trace; do not relay it verbatim.
```

摘要的内容按状态不同，要求见 Worker 提示词“摘要写什么”一节。

| 状态 | 含义 | Partner 是否带回给你 |
|---|---|---|
| `progress` | 任务在做 | 不推；你问时 Partner 查 `partner_list` |
| `ready` | 交付物已按 task spec 完成 | 是 |
| `blocked` | 需要产品决策或范围不清 | 是，按原因＋影响＋选项 |
| `failed` | 无替代路径的工具失败或任务失败 | 是 |
| `dropped` | 没有需要 wish 处理的事 | 直接结束，不发消息 |
| `waiting` | 一轮结束但没有回报，兜底补发 | 是 |

**状态由代码改，Partner 只读。** 它不记状态机；`partner_list` 的工具描述里写明每个状态的含义。

启发者的结果整合后，Partner 应更新需求模型，标明哪些结论来自此次探索（标注"推断"或"启发者建议"，等你确认）。

---

## 附：task spec 字段说明

| 字段 | 必填 | 说明 |
|---|---|---|
| `goal` | 是 | 单句，说清楚产出什么，不描述过程 |
| `scope.in` | 是 | 至少一项；定义 Worker 的工作边界 |
| `scope.out` | 推荐 | 明确排除，防止越界；有歧义时必填 |
| `context` | 推荐 | 相关文件路径和简短说明；避免让 Worker 自行猜测 |
| `deliverables` | 是 | 列出每个预期输出，含路径和格式 |
