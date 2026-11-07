# 派发入口与回报回传

R28 定了 Worker 是独立 DSH 会话。本 ADR 记两条随之而来的选型：Partner 怎么触发派发，Worker 的结论怎么回到 Partner。

**派发入口**：Partner preset 带 `partner_dispatch` 工具，工具实现在宿主侧跑 `resolveAgent → workspaceRegistry.create → sessionController.create → permissionPresets.set → rename → followup`。两个 Worker preset 不带这个工具，只带 `partner_report`。

**回报回传**：Worker 调 `partner_report` 提交状态和摘要，经队列以 `agent.steer` 送进 Partner。监听 `agent/status`，Worker 转 `idle` 且上一轮没回报时补一条 `waiting`。

## Considered Options

- **`inject` + `followup` 回传**：`inject` 只写历史不唤醒会话，需要再多一步唤醒，且顺序不好保证。改用 `steer` 一次完成投递和唤醒。
- **照搬原型的 `orchestrator_*` 工具面**：原型有 17 个工具，主 Session 要读候选卡、评估结果和分类规则，引入后违背“Partner 是薄主 Agent”。工具收窄为由 Partner 决定的几个（派、追、停、查）。领域模型本身仍纳入，见 `../design/working-unit.md`。
- **按目录收紧 Worker 写权限**：与 `danger-full-access` 的既定链路冲突，且 DSH 没有可用的目录级授权。边界落在 preset 工具白名单上。

## Consequences

- `scope` 是行为约束，不是安全边界。两类 Worker 越界都靠自身判断和 Partner 核查，不靠运行时拦截。
- 回报质量依赖模型能力（R19）。`waiting` 兜底只保证“不静默”，不保证回报内容准确。
- `partner_report` 是提示词要求的必用工具，不是运行时强制；漏报由兜底补一条 `waiting`，不会丢 Worker 会话。
