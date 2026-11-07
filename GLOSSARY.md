# dsh-superagent-wish

本仓库为 DeepSeek Harness 提供一个个人超级 Agent 的运行时：Partner 与人对话和派活，Secretary 过滤外部事件，Worker 承担执行与探索。

## Language

**Partner**:
wish 唯一直接对话的 Agent，承担项目经理和良师益友两种角色。它是独立 DSH 会话，preset id 为 `superagent-wish-partner`。
_Avoid_: 主 Agent、Router、总控、orchestrator

**Secretary**:
Partner 新会话创建时随之创建的独立会话，判断外部进来的文件和定时事件要不要开成工作单元。不需要 wish 决定时不说话。
_Avoid_: 秘书、助理、assistant

**事件源**（`source`）:
外部事件的入口，现在有文件入口 `files` 和定时入口 `schedule` 两个，各有一个配置块存在策略的 `sources` 里。配置和判断规则只经 `partner_setup` 修改。
_Avoid_: 监听器、watcher、触发器

**判掉**（`drop`）:
Secretary 判断一个事件不必开成工作单元。判掉的结果写进 `source_events` 的那一行，含时间、事件和理由，`partner_list` 里查得到。
_Avoid_: 忽略、丢弃、skip

**工作单元**（`working unit`）:
一件由 Worker 承担的事，有自己的身份、状态、输入队列和授权。Worker 会话只是它在一个时段的执行者。
_Avoid_: 任务、job、ticket、工单

**Worker**:
Partner 派出执行任务的 Agent 的集合名，分启发者和执行者两类。每个 Worker 是独立 DSH 会话，不是子代理。
_Avoid_: 子 Agent、subagent、助理

**启发者**（`discoverer`）:
用于发散探索的 Worker，产出写成文件交给 Partner，不产生仓库内的改动。
_Avoid_: 研究员、探索者、explorer

**执行者**（`implementer`）:
按 task spec 产出交付物的 Worker，有写入工具。
_Avoid_: 执行 Agent、worker（小写）、开发

**task spec**:
Partner 派给执行者的任务说明，由 goal、scope、context、deliverables 四段组成。
_Avoid_: 任务单、assignment

**exploratory prompt**:
Partner 派给启发者的开放式提示，由背景、焦点、要求三段组成。
_Avoid_: 探索提示词、发散 prompt

**回报**（`report`）:
Worker 在任务过程中向 Partner 提交的状态说明，含状态和摘要。
_Avoid_: 汇报、通知、结果、result
