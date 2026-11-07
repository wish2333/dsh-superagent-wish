Status: ready-for-agent
Blocked by: 02

## Title

Worker 提示词段落与 Partner 工具说明

## What it delivers

两类 Worker 的会话提示词里写明五状态回报的含义、`blocked` 时不自行决定、一轮不得无回报结束；Partner 的提示词里写明只通过 `partner_dispatch` 派发，只转达回报的结论。

## Scope

- 新增启发者与执行者的提示词段落，各自独立注册。
- 两个 Worker role 的提示词都包含：`progress`、`ready`、`blocked`、`failed` 的触发条件；「遇到产品决策或范围不清时报 `blocked`，不要自行决定」；「一轮结束前必须报一次」。
- Partner 段落补两句：派发只经 `partner_dispatch`；Worker 的回报是执行的唯一信息来源，只带回结论。
- 测试：两个 Worker preset 的系统提示词段落包含五状态关键字；Partner 段落包含两个工具名。

## Verification

新建启发者会话时，系统提示词里能找到五状态说明；测试覆盖两处关键字断言。

## Notes

本 ticket 只改提示词文本，不改工具与派发逻辑。提示词措辞与 `docs/spec/interaction-spec.md` 保持一致。
