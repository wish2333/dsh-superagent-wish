Status: ready-for-agent
Blocked by: 01

## Title

注册三个 preset 与 Worker 工具白名单

## What it delivers

会话选择器里出现 Partner、启发者、执行者三个 preset；启发者拿不到 `write`、`edit`、`bash`，执行者拿得到；两者都有 `partner_report`。白名单以规格文件和 `composition.yaml` 为准。

## Scope

- 同一个插件包，用 `role` 配置区分三种 preset：`superagent-wish-recruiter`、`superagent-wish-discoverer`、`superagent-wish-implementer`。
- `partner_dispatch` 只注册在 Partner preset 上，`partner_report` 只注册在两个 Worker preset 上。
- Worker 白名单用 `ctx.tools.restrict` 的允许列表形式实现。
- `inject` 增加 worker 所需的 Host 服务；Partner role 在没有这些服务时不得加载失败。
- 测试：三个 preset 的 id 与名称；两类 Worker 白名单的差异；Partner preset 是唯一带 `partner_dispatch` 的。

## Verification

会话选择器显示三个 preset；测试覆盖上述三类断言，且把 `partner_report` 从 `composition.yaml` 删掉后对应测试失败。

## Notes

白名单的改动必须同时改 `docs/spec/composition-spec.md`、`docs/spec/composition.yaml` 和测试。
