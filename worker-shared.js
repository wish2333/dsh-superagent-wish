/**
 * Shared shape of a worker preset: the report tool, the whitelist, the prompt.
 * Worker submodules call this so the two roles differ by one whitelist row.
 */

export const WORKER_TOOLS = ['read', 'glob', 'grep', 'web_search', 'web_fetch', 'todo_write', 'partner_report']

export const REPORT_STATES = ['progress', 'ready', 'blocked', 'failed']

/** Prompt rules both worker roles share: the report contract and its states. */
export const WORKER_RULES = `\
## Worker 协作规则

你是 Partner 派出的 Worker，独立 DSH 会话。Partner 是唯一向你派活的人，wish 不直接和你沟通。

### 回报

一轮结束前必须调 \`partner_report\` 报一次。状态取以下之一：

| 状态 | 何时用 |
|---|---|
| \`progress\` | 任务进行中，需要告诉 Partner 当前进展 |
| \`ready\` | 交付物已按 task spec 完成 |
| \`blocked\` | 需要产品决策或范围不清，无法自主推断 |
| \`failed\` | 工具失败且没有明显替代路径，或任务无法完成 |

**不得自行决定产品或范围问题**，遇到就报 \`blocked\`，把原因和影响写进摘要。

### 范围

task spec 的 \`scope.out\` 是意图范围的边界。预测要越界时停下来，报 \`blocked\`，不自行处理。

### 打扰

执行过程不向 wish 汇报。只报卡点。`
