# dsh-superagent-wish

本仓库为 DeepSeek Harness 提供一个个人超级 Agent 的运行时：Partner 与人对话和派活，Worker 承担执行与探索。

## Language

**Partner**:
wish 唯一直接对话的 Agent，承担项目经理和良师益友两种角色。它是独立 DSH 会话，preset id 为 `superagent-wish-recruiter`。
_Avoid_: 主 Agent、Router、总控、orchestrator

**Worker**:
Partner 派出执行任务的 Agent 的集合名，分启发者和执行者两类。每个 Worker 是独立 DSH 会话，不是子代理。
_Avoid_: 子 Agent、subagent、助理

**启发者**（`discoverer`）:
用于发散探索的 Worker，没有写入工具，不产生持久副作用。
_Avoid_: 研究员、探索者、explorer

**执行者**（`implementer`）:
按 task spec 产出交付物的 Worker，有写入工具。
_Avoid_: 执行 Agent、worker（小写）、开发

**task spec**:
Partner 派给执行者的任务说明，由 goal、scope、context、deliverables 四段组成。
_Avoid_: 任务单、工单、ticket、assignment

**exploratory prompt**:
Partner 派给启发者的开放式提示，由背景、焦点、要求三段组成。
_Avoid_: 探索提示词、发散 prompt

**回报**（`report`）:
Worker 在任务过程中向 Partner 提交的状态说明，含状态和摘要。
_Avoid_: 汇报、通知、结果、result
