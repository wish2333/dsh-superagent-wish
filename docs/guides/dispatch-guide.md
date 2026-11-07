# 派发操作指引

本文件是 Partner 派发 Worker 的操作指引。
行为规格见 `../spec/interaction-spec.md`；Worker 类型和工具边界见 `../spec/composition-spec.md`；技术方案见 `../impl/superagent-impl.md`。

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
  - 不写文件，不调用任何写入工具
```

**示例**：

```
背景：正在设计 Worker 的派发链路，需要决定确认点放在哪一步。
焦点：在"少打扰"和"越界风险"之间怎么取平衡。
要求：
  - 给出至少 3 种确认点位置
  - 指出每种位置对 Partner 操作负担的影响
  - 指出每种位置在 DSH 会话创建流程中的可行性
  - 不写文件
```

**约束说明**：启发者的 preset 没有写入工具，副作用由工具白名单保证。prompt 里仍写"不写文件"，作为第二道约束。

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

**scope 的作用**：`scope.in` 和 `scope.out` 合起来就是 Worker 的意图范围。Worker 遇到 `scope.out` 内的问题时停下来汇报，不自行处理。

---

## 四、Worker 会话怎么起

Partner 确认后按下表派发，接口细节见 `../impl/superagent-impl.md` 第二节。

| 步骤 | 动作 |
|---|---|
| 1 | `ctx.workspaceRegistry.create(cwd)` 建独立工作目录 |
| 2 | `ctx.sessionController.create({ sessionId, workspaceId, agentPreset })` 起会话，启发者或执行者 |
| 3 | `ctx.permissionPresets.set(session, 'danger-full-access')` 设权限 |
| 4 | `ctx.sessionController.rename({ sessionId, title })` 用任务标题命名 |
| 5 | `agentDelivery.send(agent, requestId, text, 'queue')` 送 exploratory prompt 或 task spec |

Worker 是独立 DSH 会话，不是子代理。模型不指定，用会话默认。

---

## 五、派发确认消息格式

Partner 在派出 Worker 前发给你的确认消息。

```
我准备做 [X]，因为 [Y]。

Worker 类型：[启发者 / 执行者]

同意吗？
```

你确认后，Partner 才调 `sessionController.create` 起 Worker 会话。

---

## 六、整合结果

| Worker 类型 | Partner 处理方式 |
|---|---|
| 启发者 | 提炼关键选项和盲点，整合进当前主题的需求模型，带回给你；原始输出不直接透传 |
| 执行者 | 核查交付物是否符合 task spec；符合则汇报结果；有偏差则用偏差汇报格式（见 `../spec/interaction-spec.md`） |

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
