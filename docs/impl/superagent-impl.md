# SuperAgent 层实现方案

本文件描述 SuperAgent 层在 DeepSeek Harness（DSH）上的派发技术方案。
重写后的结构见 `../design/working-unit.md`；本文第二节的派发链路是当前代码，第六节之后的模型按设计文档重写。
行为规格见 `../spec/interaction-spec.md`，Worker 类型与工具见 `../spec/composition-spec.md`，派发操作见 `../guides/dispatch-guide.md`。

---

## 一、定位

SuperAgent 层就是 Partner。Partner、Secretary 和 Worker 都是 DSH 会话，差别在 preset：

| 角色 | preset | 说明 |
|---|---|---|
| Partner | `superagent-wish-partner` | 本插件注册。只做对话和派发，不执行 |
| Secretary | `superagent-wish-secretary` | 本插件注册。判断外部事件要不要开成工作单元 |
| 启发者 | `superagent-wish-discoverer` | 本插件注册。发散探索，产出写成文件 |
| 执行者 | `superagent-wish-implementer` | 本插件注册。按 task spec 产出交付物 |

Partner 在会话启动时选中；Secretary 随 Partner 新会话创建；Worker 会话由 Partner 派发时创建。三个角色都不供手动选择。

Partner 与 Worker 的会话关系由 R28 定：两者都是独立 DSH 会话，Partner 不用子代理派活。

---

## 二、派发链路

每一步用的都是 DSH Host 服务。原型 `dsh-superagent` 的 `Sessions.ensure`（`src/app/sessions.ts:138-155`）已跑通这条链，本插件照它的顺序实现。

| 步骤 | 接口 | 说明 |
|---|---|---|
| 0. 查会话 | `ctx.sessionController.resolveAgent(sessionId)` | 会话已存在就复用，不重复创建 |
| 1. 建工作目录 | `mkdir(cwd, { recursive: true })` → `ctx.workspaceRegistry.create(cwd, title)` | 每个 Worker 一个独立目录。`create` 要求目录已存在，所以先建；基准取 Partner 会话自己的工作目录，取不到时退回 `workingDirectory.defaultDirectory`。不要用 Host 的 profile 目录做基准 |
| 2. 起 Worker 会话 | `ctx.sessionController.create({ sessionId, workspaceId, agentPreset })` | `agentPreset` 指定启发者或执行者 |
| 3. 取到会话 | `ctx.sessionController.resolveAgent(sessionId)` | 返回 live Agent |
| 4. 设权限 | `ctx.permissionPresets.set(session, 'danger-full-access')` | 与原型一致 |
| 5. 命名 | `ctx.sessionController.rename({ sessionId, title })` | 标题取任务标题 |
| 6. 送任务 | `agent.followup(message)`，`message` 形如 `{ id, role: 'user', content, source: { kind: 'user' } }` | 缺 `id` 或 `source` 的消息不会投递，会话建出来是空的 | 原型的 `AgentDelivery.send`（`src/app/delivery.ts:66-85`）是插件自己的类，不是 Host 服务；它用 `requestId` 去重后落到这三个方法 |
| 7. 收回报 | `partner_report` 工具 → 队列 → `agent.steer(report)` | Worker 主动回报，Partner 整合后带回给 wish |

`followup` 送下一轮任务，`steer` 改动当前轮，`inject` 只写入历史不唤醒会话。回报用 `steer`，不用 `inject`：Partner 需要被唤醒才处理回报。

**回报通道**：通道是 Partner preset 加载时创建的单例，放在模块级而不是 `ctx` 上——Cordis 拒绝读取未注入的上下文属性，Worker preset 又不在创建它的作用域里。

**会话身份**：每次派发生成独立 `sessionId`（标题 slug + 随机后缀）。用标题推导会复用该标题已占用的会话，包括一个坏掉的会话。

**调用方会话**：`partner_dispatch` 从工具执行的 `exec.agent.id` 取 Partner 会话 id，不读 `ctx.session`（那要多注入一个 Host 服务，且缺失会让整个 preset 加载失败）。取不到时直接返回错误结果，不创建 Worker 会话——否则 Worker 的回报没有投递目标。

**派发入口**：Partner preset 带 `partner_dispatch` 工具（参数：Worker 类型、目标、task spec 或 exploratory prompt），工具实现内部跑上表 0–6 步。两个 Worker preset 只带 `partner_report`，不带 `partner_dispatch`。

**回报兜底**：监听 `agent/status`，Worker 转 `idle` 且上一轮没有 `partner_report`（或只有 `progress`）时，补一条 `waiting` 回报给 Partner，与原型 `src/executor/dsh.ts:657-669` 同法。

监听必须带 `{ global: true }`：Worker 跑在自己的 preset 作用域里，作用域内监听收不到它的状态事件，兜底就永远不触发。

**实现落点**：Partner preset 加载时绑定回报通道并监听 `agent/status`；派发时把 Worker 会话登记进通道；Worker 的 `partner_report` 调通道的 `record`，通道按 `worker|turn|state|summary` 去重后以 `steer` 投递给 Partner 会话。

插件声明的依赖：

```js
// manager
export const inject = ['agentPresets']
// partner submodule
export const inject = ['systemPrompt', 'tools']
// worker submodules
export const inject = ['systemPrompt', 'tools', 'agents']
```

派发路径要读的 Host 服务在 `ctx.inject([...])` 的子作用域里声明：`sessionController`、`workspaceRegistry`、`permissionPresets`、`agents`、`workingDirectory`。Cordis 拒绝读取未声明的服务；声明在子作用域，缺服务时只是工具不注册，不会让整个 preset 加载失败。

**模型**：派发时不指定，Worker 会话用默认模型。

---

## 三、两个 Worker preset 的差别

两类 Worker 的差别全部落在 preset 上，不靠提示词约束。

| 项 | 启发者 | 执行者 |
|---|---|---|
| 写入工具（`write` / `edit`） | 给（产出写成文件） | 给 |
| `bash` | 不给 | 给 |
| 只读工具（`read` / `glob` / `grep` / `web_search` / `web_fetch`） | 给 | 给 |
| 挂载的工具插件 | `dsh-tool-fs`、`dsh-tool-fs-search`、`dsh-tool-web`、`dsh-tool-todo` | 同上，加 `dsh-tool-bash` |
| `partner_report` | 有 | 有 |
| `partner_followup` | 无（由 Partner 调用） | 无（由 Partner 调用） |
| 回报方式 | 会话结束时把结论带回 Partner | 会话结束时把交付物和偏差带回 Partner |

启发者的写权限只落在自己的工作目录内，靠 task 说明约束，无运行时拦截。工具白名单靠 preset 挂载哪些 `plugins` 行保证，不靠 `ctx.tools.restrict()`——后者只对已注册的全局工具做减法，preset 加载时那些工具还没注册（ADR-0003）。

---

## 三之二、工作单元的生命周期

一个工作单元是一件事，不是一次会话。它有自己的身份、状态和输入队列；Worker 会话只是它在一个时段的执行者。结构见 `../design/working-unit.md` 第二、三节。

```
开一个工作单元（Partner 决定，或 Secretary 按规则判断）
  → 建工作目录、起 Worker 会话、投第一条输入
  → Worker 执行、回报
  → 追加输入（可选），投给当前 Worker 会话
  → 回报
  → 结束
```

**工具**：

| 工具 | 挂在哪个 preset | 作用 | 状态 |
|---|---|---|---|
| `partner_dispatch` | 只有 Partner | 起一个工作单元，返回工作单元 id | 已实现，返回的是 `sessionId`，重写后改为工作单元 id |
| `partner_followup` | 只有 Partner | 向一个工作单元追加输入，投给当前的 Worker 会话 | 未实现 |
| `partner_stop` | 只有 Partner | 中止当前这一轮；工作单元仍在，之后可以追问 | 未实现 |
| `partner_list` | 只有 Partner | 查工作单元的状态和被判掉的外部事件 | 未实现 |

附录入按工作单元的队列投递：Worker 空闲时开新一轮，运行中排到下一轮。Partner 按工作单元 id 引用，不记 Worker 会话 id。

**现状**：只有 `partner_dispatch` 已实现。Worker 目前只收到一条消息，追加、中止、查询都没有。

**多任务体系**：Ticket / Input / Assignment / Mandate 这一档已经确定要做，方案见 `../design/working-unit.md`。这些模型不属于团队场景：个人用户同样需要知道一个活做到哪一步、把几条追问排队、限制 Worker 只碰指定文件。

---

## 四、确认点

Partner 在调用 `partner_dispatch` 之前自行暂停，等你确认。DSH 没有强制机制，这是主 Agent 的行为约定。

确认消息格式见 `../guides/dispatch-guide.md` 第四节。

---

## 五、回报回传

Worker 的回报经 `steer` 送进 Partner，由 Partner 整合后交给你，不直接透传。

**回报不是用户说的话。** 它带着 Worker 会话 id、任务标题和状态，Partner 应当把它读成“某个 Worker 报了什么”，而不是“wish 说了什么”。实现上回报是一条 source 为 `agent-message` 的消息，不伪装成用户输入；正文格式见 `../guides/dispatch-guide.md` 第六节。

| Worker 类型 | Partner 的处理 |
|---|---|
| 启发者 | 提炼选项和盲点，读它写下的产出文件，并入当前需求模型，标“推断”或“启发者建议” |
| 执行者 | 核查交付物是否符合 task spec；有偏差按原因＋影响＋选项汇报 |

回报用 `partner_report` 提交，状态取 `progress` / `ready` / `blocked` / `failed` / `waiting` 之一，附摘要。`progress` 只在你要求时带回；其余四种一律带回。

---

## 六、与 dsh-superagent 原型的关系

本插件复用原型的派发方式、四张表的领域模型和事件源那一层；判断位置按本插件的需要重新安排。

| 原型有 | 本插件 |
|---|---|
| Source / Thread / Eval / Decision | 做。外部事件由 Secretary 判断，进入方式见 `../design/working-unit.md` 第五节 |
| Ticket / Mandate / Assignment / Subscription | 做，对应工作单元、输入、派工、授权四张表。订阅简化为“工作单元挂在哪条对话上” |
| `orchestrator_*` 领域工具 | 换成 `partner_*` 工具，名字和参数按个人对话重定 |
| 会话创建、工具白名单、消息投递 | 复用同一组 DSH Host 服务 |
| 两个 preset（router / worker） | 四个 preset（`superagent-wish-partner` / `superagent-wish-secretary` / `superagent-wish-discoverer` / `superagent-wish-implementer`） |
| 回报以 `steer` 送进主 Session，无报告时补 `waiting` | 同法复用 |

原型的 Ticket / Input / Assignment / Mandate 不是团队专用。个人用户同样需要知道一个活做到哪一步、把几条追问排队、限制 Worker 只碰指定文件。

与原型的分工差异：原型里主 Session 只做路由，判断分散在策略规则和 Worker 上；本插件的 Partner 承担对话里的判断（值不值得开活、派给谁、此刻要不要对你说），机制部分仍在代码里。差异的理由见 `../design/working-unit.md` 第三节。

### 现在缺什么

| 缺的东西 | 现在的结果 |
|---|---|
| 工作单元 | 没有这个对象，派发结果里只有一个 `sessionId` |
| 输入队列 | Worker 只收一条消息；追加消息要重派一个 Worker |
| 派工记录 | 叫停、重试、恢复都没有落点 |
| 授权 | 越界判断只靠 Worker 自报和 Partner 核查，无运行时拦截 |
| `partner_followup`、`partner_stop`、`partner_list` | 文档描述了前两个，代码里一个都没有 |

---

## 七、风险

| 风险 | 影响 | 应对 |
|---|---|---|
| DSH 是开发者预览，Host 服务会变 | 派发链路可能失效 | 锁版本；升级前先跑 `node` 加载和一次派发验证 |
| 原型钉的是 `@deepseek-ai/dsh-api-session-controller@0.2.1-alpha.2` | 与本机 DSH 版本可能不一致 | 装好后核对版本 |
| 确认点靠行为约定 | 可能漏掉确认直接派发 | 规格里写死，后续可加运行时检查 |
| 无 Watchdog | Worker 卡住时无自动告警 | Worker 自报卡点 |
| `@deepseek-ai/dsh-agent-preset` 能否从本机 profile 解析，未验证 | 按原型用 YAML 声明 Worker preset 可能加载失败 | 加载失败时退回 `ctx.agentPresets.register()` 注册 |
