Status: ready-for-agent
Blocked by: none

## Title

建立测试运行方式与插件入口的 Host fake

## What it delivers

仓库第一次能跑自动化测试，并且现有的 Partner preset 注册有第一条测试覆盖。之后每张 ticket 都在这一个 seam 上验证，不再新增 seam。

## Scope

- 用内置的 `node:test`（`node --test`）作为测试运行方式，加一条 `test` 脚本。不装任何依赖。
- 一个假的 Host `ctx`：记录 `agentPresets.register`、`systemPrompt.section`、`tools.register` 等调用的参数与顺序，并能触发 `agent/status` 事件。按需补服务，不预先铺满。
- 一条测试：`apply(ctx, { role: 'manager' })` 调用 `agentPresets.register`，注册出的 preset id 是 `superagent-wish-recruiter`；`apply(ctx, { role: 'instructions' })` 调用 `systemPrompt.section`。

## Verification

`npm test` 通过；删除 `index.js` 里的注册调用后测试失败。

## Notes

- 测试只断言 Host 边界的调用，不断言内部实现。
- 现有 `index.js` 的 `inject` 只有 `agentPresets` 和 `systemPrompt`，这张 ticket 不改它。
