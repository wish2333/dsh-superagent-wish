# 工具 parameters 是 provider 收到的 JSON Schema

`ctx.tools.register` 注册的工具，`parameters` 必须是 DSH 直接发给模型 provider 的 JSON Schema：对象根、`properties`、`required` 数组，每个属性带 `type`。

DSH 自己的工具经 `defineTool` 编写，作者写的是参数 DSL（属性表加 `required: true`），由 `defineTool` 编译成 JSON Schema。直接调 `ctx.tools.register` 时没有这一步，写 DSL 就等于把没有 `type`/`properties` 的非法 schema 发给 provider。

后果不是工具调用失败，而是**整个会话的每次请求都 400**：工具清单随每条消息一起发出。

## Consequences

- 手写工具定义必须写成 JSON Schema，不能照抄 `defineTool` 的 DSL 写法。
- 测试要断言 `parameters.type === 'object'`、`properties` 每项带 `type`、`required` 是数组，且不出现 DSL 的 `required: true` 键。
- 想写 DSL，就得改用 `defineTool` 并注入它所在的包；本插件目前不引入该依赖。

## Evidence

2026-11-07 真实请求体：`partner_dispatch` 的 `parameters` 是 `{"kind":{...},"title":{...},"body":{...}}`，同请求里 DSH 自己的 `working_directory` 是 `{"type":"object","properties":{...}}`。修正后两者形状一致。
