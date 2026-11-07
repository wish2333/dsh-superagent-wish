Status: ready-for-agent
Blocked by: 02

## Title

派发链路：`partner_dispatch` 起 Worker 会话

## What it delivers

Partner 调用 `partner_dispatch` 后，按七步链路建出一个独立工作目录和 Worker 会话，按任务标题命名，权限为 `danger-full-access`，任务正文作为 Worker 的第一轮消息。同一派发请求重试不产生第二个会话。

## Scope

- 工具入参：Worker 类型、任务标题、任务正文（已格式化的 task spec 或 exploratory prompt）。
- 链路顺序：解析会话 → 建工作目录 → 建会话（带 worker preset）→ 再次解析取回 live Agent → 设权限 → 改名 → `followup` 送正文。
- 会话 id 由派发请求推导；解析命中就复用。
- 未知 Worker 类型直接返回错误结果，不调用任何 Host 服务。
- Host 错误翻译成一行原因的错误结果，不向模型抛出原始异常。
- `partner_dispatch` 不挂在任何 Worker preset 上（由 02 保证）。
- 测试：六步调用的顺序与参数；重试复用不重复建会话；未知类型无 Host 调用。

## Verification

在 Partner 会话里调 `partner_dispatch` 后，会话列表出现按任务标题命名的 Worker 会话；测试覆盖三类断言。

## Notes

派发前的确认仍是 Partner 的行为约定，本 ticket 不做运行时拦截。
