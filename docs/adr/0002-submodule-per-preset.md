# 按 preset 拆子模块

每个 preset 的工具必须各归各的会话：Worker 看不到 `partner_dispatch`，Partner 看不到 `partner_report`。DSH 的 preset 用 `plugins` 行引入插件，而一行只能指向一个模块。所以工具不能都放在同一个 `index.js` 里，否则它们会落到共享的作用域，对所有会话可见。

决定：`index.js` 只做 manager，负责注册 preset；每个 preset 的 `plugins` 行写本包的子路径——事件源子模块、Partner 子模块、Secretary 子模块、启发者子模块、执行者子模块。Secretary 与事件源子模块随重写加入。`package.json` 的 `exports` 与 `files` 列出这些子路径。

## Considered Options

- **单文件 + 运行时检查调用方 preset**：改动最小，但 Worker 的工具列表里仍会出现 `partner_dispatch`，白名单不再是唯一边界，还要额外加 deny 规则。
- **相对路径 `./partner.js`**：原型实验确认不可行。DSH 解析 preset 行时走包作用域，相对路径取不到；子路径必须写进 `exports`。

## Consequences

- `package.json` 的 `exports` 成为接口的一部分：改名或移动子模块等于破坏 preset 定义。
- 测试必须按包子路径加载子模块，才能保证 `exports` 写错时测试会失败。
- 这些 preset 仍由同一个 bundle patch 的 manager 行注册，安装方式不变。

## Evidence

2026-11-07 原型实验：在临时目录建最小 bundle，`exports` 声明 `./sub/entry.js` 后，从包作用域解析 `dsh-preset-probe/sub/entry.js` 成功，子模块的 `apply(ctx)` 能正常调用 Host 服务。
