Status: ready-for-agent
Blocked by: 02

## Title

回报回传与 `waiting` 兜底

## What it delivers

Worker 用 `partner_report` 提交 `progress`、`ready`、`blocked`、`failed` 之一；`ready`、`blocked`、`failed` 以 `steer` 送进 Partner 并唤醒它，`progress` 不唤醒。Worker 一轮结束却没有回报时，插件补一条 `waiting` 送进 Partner。同一条回报重复投递只到达一次。

## Scope

- 工具入参：状态与摘要；不接受会话 id，会话由工具上下文提供。
- 回传走队列，以 `steer` 投递；投递失败不使 Worker 的工具调用失败。
- 回报身份由 Worker 会话与回报内容推导；投递前检查 Partner 历史与收件箱，已存在则跳过。
- 监听 `agent/status`：Worker 转 `idle` 且该轮没有回报时补 `waiting`；已有回报则不补。
- 会话持久化服务缺失时退回内存集合，并在加载时记一条警告。
- 测试：`blocked` 到达 Partner 为一条 `steer`；`progress` 不唤醒；`idle` 无回报产生 `waiting`；已回报的 `idle` 不再补；同一条回报投递两次只到达一次。

## Verification

Worker 会话里报 `blocked` 后，Partner 收到一条带摘要的唤醒消息；测试覆盖上述五个用例。

## Notes

兜底只保证不静默，不保证回报内容准确；它不监视 Worker 的输出。
