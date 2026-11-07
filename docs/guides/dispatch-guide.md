# 派发操作指引

本文件是总控派发 Worker 的操作指引。
行为规格见 `interaction-spec.md`；Worker 类型和能力授权见 `composition-spec.md`。

---

## 一、判断派哪种 Worker

| 情形 | Worker 类型 |
|---|---|
| 讨论需要拓展，选项还不清晰 | 启发者 |
| 假设需要挑战，需要不同视角 | 启发者 |
| 方向已确认，交付物清晰 | 执行者 |
| 需要产出文件、代码或内容 | 执行者 |

同一个主题下，启发者先行，执行者跟进。启发者的结果总控整合后带回给 wish，不直接透传。

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
背景：正在设计 AI 工作区的组合层，需要决定执行者的文件写入授权粒度。
焦点：如何在"默认权限范围"和"每次 mandate 审批成本"之间取得平衡。
要求：
  - 给出至少 3 种粒度方案
  - 指出各方案对总控操作负担的影响
  - 指出各方案在运行时约束（Hermes 单 session）下的实际可行性
  - 不写文件
```

**约束说明**：exploratory prompt 须显式写入"不写文件，不调用任何写入工具"，在 Hermes 单 session 模式下这是唯一的副作用约束机制（prompt 纪律）。

---

## 三、task spec 格式

结构：目标 → 范围 → 上下文 → 交付物 → 授权。

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

authorization:          # 只列 mandate 项；无 mandate 项时此节省略
  - [能力 id]: [具体用途和约束]
```

**示例**：

```
goal: 把本次讨论产出的组合层设计写成规格文档

scope:
  in:
    - Worker 类型定义
    - 能力授权矩阵
    - mandate 项格式
    - 运行时接线
  out:
    - 运行时层的行为规格（见 interaction-spec.md）
    - 能力实现细节（见 plugin-manifest.md）

context:
  - ../spec/framework.md（四层结构定义）
  - ../spec/interaction-spec.md（总控行为规格）
  - ../impl/plugin-manifest.md（能力来源清单）

deliverables:
  - path: ../spec/composition-spec.md
    format: Markdown
  - path: ../spec/composition.yaml
    format: YAML

authorization:
  - file-write-standard: 写入 ../spec/composition-spec.md 和 ../spec/composition.yaml
```

**scope.out 的作用**：明确排除防止 Worker 越界，也是卡点的判断依据——Worker 遇到 scope.out 内的问题时应停下来汇报，而不是自行处理。

---

## 四、派发确认消息格式

总控在派出 Worker 前发给 wish 的确认消息。

**有 mandate 项时**：

```
我准备做 [X]，因为 [Y]。

Worker 类型：执行者
需要以下额外授权：
  - [mandate 能力 id]：[用途和约束]

同意吗？
```

**无 mandate 项时**：

```
我准备做 [X]，因为 [Y]。

Worker 类型：[启发者 / 执行者]，无需额外授权。

同意吗？
```

确认消息中的 mandate 列表直接从 task spec 的 `authorization` 节提取。wish 确认后，总控才派出 Worker。

---

## 五、整合结果

| Worker 类型 | 总控处理方式 |
|---|---|
| 启发者 | 提炼关键选项和盲点，整合进当前主题的需求模型，带回给 wish；原始输出不直接透传 |
| 执行者 | 核查交付物是否符合 task spec；符合则汇报结果；有偏差则用偏差汇报格式（见 `interaction-spec.md`） |

启发者的结果整合后，总控应更新需求模型，标明哪些结论来自此次探索（标注"推断"或"启发者建议"，等 wish 确认）。

---

## 附：task spec 字段说明

| 字段 | 必填 | 说明 |
|---|---|---|
| `goal` | 是 | 单句，说清楚产出什么，不描述过程 |
| `scope.in` | 是 | 至少一项；定义 Worker 的工作边界 |
| `scope.out` | 推荐 | 明确排除，防止越界；有歧义时必填 |
| `context` | 推荐 | 相关文件路径和简短说明；避免让 Worker 自行猜测 |
| `deliverables` | 是 | 列出每个预期输出，含路径和格式 |
| `authorization` | 有 mandate 项时必填 | 只列 mandate 项；无 mandate 项时省略 |
