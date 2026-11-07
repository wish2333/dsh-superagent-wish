# 工具白名单靠 preset 的 plugins 行

Worker 能用的工具，由该 preset 的 `plugins` 行列出哪些工具插件决定：不列 `@deepseek-ai/dsh-tool-bash` 就没有 shell，不列 `dsh-tool-fs` 就没有写入。启发者挂 `fs`、`fs-search`、`web`、`todo`，执行者再加 `bash`。

早先的设计用 `ctx.tools.restrict({ allow: [...] })` 表达白名单。真实 DSH 下这条路走不通：`restrict` 只对**已注册的全局工具**做减法，而 Worker preset 加载时那些工具还没注册，`restrict` 直接报 unknown global tools，preset 被标成 broken。

## Considered Options

- **`restrict` 白名单**：见上，加载时机不成立。
- **`tools.guard()` 运行期拦截**：工具仍出现在列表里，模型会尝试调用，体验差。
- **依赖加载顺序，等宿主工具注册完再 restrict**：preset 加载顺序不由本插件控制。

## Consequences

- 白名单是声明式的：增删工具改 `PRESETS` 里的 `tools` 数组，不改运行期代码。
- 有两个工具插件有必填配置，必须随行给出：`dsh-tool-fs-search` 要 `sampleOverCapGlobResults`，`dsh-tool-todo` 要 `allowParallelInProgress`，缺了 preset 同样会 broken。
- 工具包的包名是 DSH 内部契约；升级时要核对 `preset-standard` 的工具行。
