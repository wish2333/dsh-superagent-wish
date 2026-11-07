# 工作单元重写的实施记录

本文件记录六票实现过程中踩到的坑、可复用的解决方案，以及最终验证结果。
spec 见 `spec.md`，各票结论见 `issues/`；运行环境事实见 `../implement-spec/dsh-runtime-recon.md`；
真实运行记录见 `../implement-spec/real-run-validation.md`。

基线是 `a7bb576`（旧实现已删、四个 preset 已改名），终点是 `main` 的 `20a36d2`，中间 47 个提交。

---

## 一、测试替身骗过测试的六类形状

单元测试 173 个全绿之后，真实 DSH 运行仍然连续失败九次。九次全部属于同一类：
**假 Host 接受了真实 Host 不接受的形状**。以下每条都附可复用的正确写法。

### 1. 未声明就读取 Host 服务

**症状**：Secretary preset 整个挂载失败，日志里只有一句 `pending` 或 `broken`，Secretary 会话建不出来。

**原因**：`secretary.js` 读了 `ctx.tools` 却没有写进 `export const inject`。Cordis 对未声明的读取直接抛错，
而 preset 挂载失败是静默的——`agentPresets.resolve(id)` 会返回 `{ id, broken: "..." }`，不检查就看不见。

**正确做法**：

- 每个读 Host 服务的模块，把服务名写进 `inject`；子作用域用 `ctx.inject([...], callback)` 声明。
- 排查时先调 `agentPresets.resolve(id)` 并检查返回值里的 `broken` 字段，它会给出确切的报错文本。

### 2. 存储 schema 与写入值不一致

**症状**：插件重启后读不到任何工作单元，`domain 'working_units': stored record ... does not match its schema`。

**原因**：`inputs.readAt` 的 schema 只接受字符串或省略，而“已送达未读”写的是 `null`。
`storage-domain` 在 `open()` 时校验全部已存记录，遇到 `null` 直接抛错，整个域打不开。

**正确做法**：

- 写出 `null` 表示“尚不知道”的字段，schema 要显式接受 `null`（本仓库用 `nullableString`）。
- 补一条**重载测试**：写入 → `medium.snapshot()` → `createStorageDomain(snapshot)` 重开 → 断言字段，
  这是唯一能发现 schema/写入不一致的测试形状。

### 3. 依赖预设挂载才运行的常驻逻辑

**症状**：放进监听目录的文件永远读不到；Secretary 的 `agent/created` 监听从不触发。

**原因**：预设的 `plugins` 行**只在那个预设被挂载时**才加载。`superagent-wish-sources` 预设没有会话会选中，
写在其 `apply` 里的文件轮询从未启动；`secretary.js` 的监听也只在 Secretary 会话出现后才存在，
形成“先有鸡才能有蛋”的死锁。

**正确做法**：

- 常驻逻辑（轮询、监听、队列泵）放在 **manager（`index.js`）**，它随插件一起加载。
- 预设子模块只放该预设自己会用到的东西：提示词、工具注册。
- 判断是否踩坑的信号：某个预设从未被任何会话选中。

### 4. 事件时序与推断不一致

**症状**：Secretary 会话始终不出现。

**原因**：桌面版**先建会话，约 5 秒后才把 preset 写进会话**。`agent/created` 触发时
`presetForSession` 返回 `null`，Agent 自己的组合里也还没有 preset。

**正确做法**：

- 用 `agentPresets.presetForSession(session)` 读**已落定**的 preset，适合事后查询。
- 要判断“这个会话现在跑的是什么预设”，用 `agentPresets.composedPreset(agent.ctx)`，它在创建那一刻就有值。
- 要捕捉“用户选了某个预设”这件事，监听 **`agent-preset/selected`（携带 `(sessionId, preset)`）**，
  它与组合时序无关，是桌面版唯一可靠的信号。
- 两种创建方式都要覆盖：API 建会话带着 preset 走 `agent/created`，桌面版走 `agent-preset/selected`。
  监听两者，创建逻辑保持幂等。

### 5. prompt section 返回 Promise

**症状**：Secretary 会话的每一轮都以 `text.indexOf is not a function` 失败。

**原因**：`ctx.systemPrompt.section` 的 `text` 可以是函数，但 DSH **同步**调用它，再对结果扫描提示词变量。
写成 `async` 函数时，扫描到的是 Promise 对象。

**正确做法**：

- `text` 必须是同步函数，返回字符串。
- 需要异步读取的数据（例如策略里的规则文本），在挂载时读一次存进闭包，在数据变化时刷新；
  让 `text()` 只做字符串拼接。

### 6. 用假会话代替真实 Agent

**症状**：外部事件开出的工作单元，目录路径少一截（`/private/tmp/superagent-wish/unit-1` 而非
`/private/tmp/wish-run/superagent-wish/unit-1`）。

**原因**：判定后开活时构造了 `{ agent: { id, session: { id } } }` 当调用方，
`workingDirectory.get(session)` 读不到真实工作目录，回退到默认基准。

**正确做法**：

- 需要调用方会话的工作目录时，用 `sessionController.resolveAgent(id)` 取真实 Agent，不要拼一个只有 id 的假对象。
- 单元目录、会话 id、模型选择都应从真实 Agent 上读。

---

## 二、并发与状态的四个缺陷

### 7. 槽位在回合结束时没有释放

**症状**：两个 Worker 都用“结束但不回报”的方式收尾后，派发队列永久卡住。

**原因**：执行者槽位从 `store.start` 计到下一次报告或停止，Worker 静默结束不触发任何一条。

**正确做法**：回合结束的 `agent/status` → `idle` 监听要用 `{ global: true }`（Worker 在别的预设作用域里），
并在确认回合确实结束时把结局返回给调用方（本仓库是 `turnEnded` 返回 `{ outcome: 'closed' | 'open' | 'none' }`），
`closed` 时与“收到报告”一样调用 `advance()` 释放槽位。

### 8. 停止后单元卡在 running

**症状**：`partner_stop` 之后 `partner_list` 仍显示 `running`。

**原因**：回合已被 `waiting` / `ready` / `blocked` 报告结束，`stop` 看到“派工已结束”就直接返回，单元状态没动。

**正确做法**：派工已结束时，停止仍应把单元置为 `waiting-for-input`——停止的语义是“这一轮结束”，不是“什么都不做”。

### 9. 追问后工作目录被删就不会重建

**症状**：Worker 报 `working-directory: directory does not exist`。

**原因**：目录只在会话**首次创建**时 `mkdir`；会话已存在而目录被删时不再建。

**正确做法**：每次投递前都确保目录存在（`mkdir(..., { recursive: true })` 是幂等的），不要只在开会话时建。

### 10. 回报根本送不到 Partner

**症状**：Partner 收不到任何回报。

**原因**：存储层把 `partnerSessionId` 覆盖成 `mandate: unit.id`，且 `nextId()` 解析出 NaN，
会话 id 变成 `superagent-wish-NaN`。两条都由单元测试掩盖——测试只断言“报告写进了表”。

**正确做法**：回报链路的测试要断言**消息真的到了一个可解析的 Partner 会话**，
而不只是“表里多了一行”。

---

## 三、可复用的验证方法

### 真实运行怎么跑

`../implement-spec/dsh-runtime-recon.md` 有完整命令。要点：

- 用 **App 自带的运行时**（`0.2.2-rc.1`），不要用 PATH 里的 `dsh`（`0.2.1-rc.3`，没有 desktop-host）。
- `DSH_HOME` 必须指向 `/tmp` 下的一次性目录，且要在启动进程的环境里设置（`.env` 里的 `DSH_*` 会被拒绝）。
- `--profile desktop` 被拒绝；把 desktop profile 复制成别的名字（如 `wish-web`），再 `pnpm install` 装上插件。
- 判断插件是否真的挂上：`--dump-config | grep superagent-wish`，应看到 `superagent-wish-manager`。

### 驱动插件

真实 Host 上没有现成的“建 Partner 会话并调工具”的入口。做法是挂一个一次性驱动插件：

```js
export const inject = ['loader', 'tools', 'agentPresets', 'agents', 'agentDefaultModel', 'sessionController']
export function apply(ctx) {
  const timer = setTimeout(() => run(ctx), 800)
  ctx.effect(() => () => clearTimeout(timer))
}
```

- 调工具用 `ctx.tools.definitions(agent).find(t => t.name === name).execute(args, { agent, callId, signal })`；
  工具是按 agent 作用域隔离的，全局 `definitions()` 看不到 Partner 的工具。
- 建带 preset 的会话最稳的是 `ctx.sessionController.create({ agentPreset, cwd })`（web profile 有它）。
- 要复刻桌面版顺序：先 `agents.create`（不带 preset），再 `agentPresets.select(agent, preset)`。

### 读会话日志

会话落盘在 `$DSH_HOME/sessions/<cwd 横线化>/<sessionId>/session.v4.jsonl.zstd`，zstd 压缩：

```sh
node -e 'const z=require("zlib"),f=require("fs");console.log(z.zstdDecompressSync(f.readFileSync(process.argv[1])).toString())' <file>
```

关键事件：`agent-preset/selected`（预设何时落定）、`agent/inbox/spliced`（投递了什么）、
`tool/call`（Worker 与 Secretary 调了哪些工具）、`turn/end`（`completed` / `aborted` / `error` + 原因）。

---

## 四、测试怎么写的

spec 的 Testing Decisions 只留两道接缝，实现按此执行：

| 接缝 | 覆盖 | 文件 |
|---|---|---|
| 插件入口 + `test/host-fake.js` | preset 注册、工具注册与参数形状、派发链路、回报投递、事件源、Secretary | `test/*.test.js`（`host-fake.js` 除外） |
| 纯状态机 | 状态顺序、幂等、未读输入退回、同一轮不重复投递 | `test/state.test.js` |

- 事件按真实签名发射：`agent/status` 传 `{ agent, status }`，`agent-preset/selected` 传 `(sessionId, preset)`。
  `host-fake.js` 的 `emit(name, ...args)` 转发全部参数——早期只传一个参数，掩盖了监听缺陷。
- 存储重载：`medium.snapshot()` + `createStorageDomain(snapshot)` 模拟重启。
- **每条修复都要做红绿验证**：先把生产代码退回修复前，确认新测试变红，再恢复并确认变绿。
  本次有两处测试在撤回修复后仍绿（断言太宽，匹配到了空列表文案），收紧断言后才真正生效。

---

## 五、最终结果

### 六票

| 票 | 结论 | 落点 |
|---|---|---|
| 01 工作单元与四张表 | 已关闭 | `state.js` / `schema.js` / `working-units.js` |
| 02 派发、追问、中止、查询 | 已关闭 | `partner.js` / `sessions.js` / `worker.js` |
| 03 回报通道 | 已关闭 | `relay.js` |
| 04 Secretary 会话 | 已关闭 | `secretary.js` |
| 05 文件与定时事件源 | 已关闭 | `sources.js` / `judge.js` |
| 06 策略版本与并发上限 | 已关闭 | `policy.js` / `queue.js` / `pump.js` / `advance.js` |

### 测试

173 个测试全部通过（`pnpm test`）。生产代码 4169 行，测试 3835 行。

### 真实运行验证过的路径

在桌面版 GUI 里由 wish 完整走通：

1. 往监听目录放 `.md` 文件。
2. Secretary 会话出现，调 `partner_read_conversation` 读对话、调 `partner_decide` 作出判定。
3. 判定开出工作单元，Worker 会话与目录建立，Worker 读取文件并执行。
4. Worker 调 `partner_report` 报 `ready`，回报以 `agent-message` 来源、带 `senderSessionId` 送进 Partner。
5. 追问投给同一个 Worker 会话（同一目录、同一会话，记录显示 3 轮），不新建会话。
6. `partner_stop` 中止当前一轮，`turn/end` 记为 `{"kind":"aborted","reason":{"kind":"user"}}`，单位保留。

### code review

两轴审查共 20 项（Standards 10、Spec 10），全部处理，提交 `345aea3`–`e44990c`。
最重的三项：Secretary 的“读对话”原为提示词声明，补成只读工具；`partner_list` 默认不再累积已结束单元；
`partner_setup` 不再要求传 Session id。

### 有意保留的取舍

| 项 | 现状 | 理由 |
|---|---|---|
| `partner_followup` 的加宽范围 | 任何未被授权覆盖的追问都并入 `scope`，旧值留在 `previousScopes` | 符合用户故事 10，旧范围仍可读 |
| 定时巡查 | 到点唤醒一个 Secretary 会话 | `ctx.schedule` 的任务必须绑定会话，唤醒的是 Secretary 而非 Partner 对话 |
| `dropped` 推送 | 不推送 | 用户故事 13 |
| 策略重新校验 | 整份规则与事件源配置的哈希等值比较 | 任何规则改动都会让旧授权复核不通过；按规则归属需要授权记录“开在哪些规则下”，未做 |
| `partner.js` 规模 | 约 650 行 | 审查指出职责发散，本轮只记录不拆分 |
| Secretary 可见性 | 空白会话，不进会话列表 | 它不主动与人对话；有判定时才有内容 |

### 常驻逻辑的位置

插件里任何需要在“没有 Partner 会话时也运行”的逻辑，都必须放在 manager（`index.js`），
不能放在可能永远不被挂载的预设子模块里。这是本次踩坑最集中的一条，也是后续扩展（新的常驻循环、新的监听）必须遵守的规则。
