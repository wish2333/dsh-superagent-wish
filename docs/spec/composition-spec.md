# 组合层规格

本文件是组合层的规格说明。它描述 Worker 有哪些类型、每类 Worker 可以访问哪些能力、mandate 项的确认机制，以及与运行时的接线方式。

机器可读的配置见 `composition.yaml`（与本文件保持同步）。

---

## 一、位置与职责

组合层在资产层/能力层（稳定）和运行时层（可替换）之间建立显式接缝。

- **不存放知识**，不定义业务逻辑。
- **只声明** Worker 类型和能力授权边界。
- **换运行时时只改运行时接线**（`composition.yaml` 中的 `runtime_binding` 节），不改 Worker 类型和能力矩阵。

---

## 二、Worker 类型

当前定义两种 Worker 类型。

### 启发者（discoverer）

| 字段 | 值 |
|---|---|
| 用途 | 探索选项、发散思路、挑战假设 |
| 输入 | 探索性 prompt（开放式） |
| 输出 | 想法、选项、分析 |
| 副作用约束 | 不允许有持久副作用 |

### 执行者（implementer）

| 字段 | 值 |
|---|---|
| 用途 | 按 task spec 产出交付物 |
| 输入 | task spec（含目标、范围、mandate 授权列表） |
| 输出 | 文件、代码、内容等可交付物 |
| 副作用约束 | 允许有持久副作用；mandate 项须在 task spec 中列明 |

---

## 三、授权等级

| 等级 | 含义 |
|---|---|
| **free** | Worker 在任务范围内可自主使用，无需在 task spec 中列出 |
| **mandate** | 须在 task spec 的授权列表中显式列出；总控在派发确认点一并呈给 wish |
| **off** | 此 Worker 类型不可使用该能力 |

**mandate 的执行机制**：当前运行时（Hermes 单 session 模式）靠 prompt 纪律实现，没有架构保障。总控在派发前的确认点须把 mandate 项列在确认消息里。Worker 收到的 task spec 中须包含已授权的 mandate 列表，否则不得调用对应能力。

---

## 四、能力授权矩阵

能力来源见 `plugin-manifest.md`。

| 能力 | 来源 | 启发者 | 执行者 |
|---|---|---|---|
| skills-local | `skills-local` | free | free |
| skills-third | `skills-third` | free | free |
| memory recall | `memory-hindsight` op: recall | free | free |
| memory retain | `memory-hindsight` op: retain | off | mandate |
| browser-detect | `browser-detect` | free | free |
| browser-runtime | `browser-runtime` | off | mandate |
| office 读 | `office-skills` op: read | free | free |
| office 写 | `office-skills` op: write | off | mandate |
| 文件读取 `~/AI/` | — | free | free |
| 文件写入 `~/AI/docs/` `~/AI/repos/` | — | off | free |
| 文件写入 `~/AI/` 其他路径 | — | off | mandate |
| web 搜索/抓取 | — | free | free |

---

## 五、mandate 项格式

执行者的 task spec 须包含 `authorization` 节，列出本次任务用到的所有 mandate 项。总控在发出派发确认消息时从此节提取并呈给 wish。

示例：

```
authorization:
  - memory-retain: 保存本次研究结论至 wish bank
  - browser-runtime: 限 bilibili.com，下载目标视频字幕
  - office-write: 输出 ~/AI/docs/report.docx
```

未在 `authorization` 节列出的 mandate 能力，Worker 不得使用。

---

## 六、运行时接线（当前：Hermes 单 session 模式）

| 项目 | 当前实现 |
|---|---|
| 派发方式 | `delegate_task` |
| 上下文隔离 | 部分隔离（结果回流主 session，已知限制） |
| mandate 核查时机 | 派发确认点（pre-dispatch） |
| mandate 执行保障 | prompt 纪律（无架构保障） |

换运行时时，只改 `composition.yaml` 的 `runtime_binding` 节，本文件其余内容不变。

---

## 七、设计约束

- Worker 类型和能力矩阵对运行时的变化免疫。
- 只用公开格式（Markdown、YAML）。不依赖特定 harness 或运行时。
- 能力来源的变更（例如 `memory-hindsight` 后端从 Xinference 换为 oMLX）在 `plugin-manifest.md` 中反映，不影响本文件。
