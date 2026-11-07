Status: ready-for-agent

# 工作单元重写

## Problem Statement

### 这件事要做的是什么

这个插件要在 DSH 上建一套人机协作模式：wish 只和 Partner 对话，Partner 负责谈和派活，Secretary 过滤外部事件，Worker 负责分析和执行。

目标不是把活干得多快，而是让对话保持在可以深入的状态，同时不失去动手能力。wish 自己的说法是“上下文薄，和人的交流才更深”：执行框架占满上下文时，模型会偏向代码和执行；上下文薄，注意力才回到对话上。

### wish 的核心需求

| 需求 | 内容 |
|---|---|
| R1–R4 | Partner 是协作者，同时承担项目经理和良师益友。能对话讨论、追问意图、指出盲点、摆出利弊；会反思、敢直言并给理由；先帮 wish 想清楚，再安排任务 |
| R6、R17 | 打扰按轻重分。执行过程只报卡点，需要判断的事展开深聊；深度讨论时抑制执行倾向 |
| R7 | 判断权归 wish。Partner 备齐权威来源、现状和需求，wish 问到时才给有依据的意见 |
| R8、R9 | 薄主 Agent。Partner 的上下文围绕对话组织，工作路径保持在接收信息、思考、回复 |
| R10–R12 | 主题锚定；结果导向和发散之间保持平衡；每次补充并进同一需求模型，标明原话还是推断 |
| R13、R14 | Worker 分两类，按思维方式分派，两类结果由 Partner 整合后带回 |
| R15 | 可调度资源包括其它 Session 和可自定义的模型 |
| R16 | 讨论和安排任务之间有确认点；派出后持续汇报，wish 随时可以介入 |
| R19 | wish 尽可能只负责输出，收到的是方案汇报：有解释、可以选择、可以执行 |
| R25–R27 | 文件放进指定文件夹，定期巡查；名单、周期、每类默认处理可配置 |

### 现在做不到的地方

**一、派出去只能等。** Worker 只收一条消息。想说“再细一点”或者“换个方向”，只能重派一个新 Worker，把背景重新交代一遍。wish 本来只打算输出意图和判断，这一步把 wish 拉回重建上下文，正是 R19 要避免的。

**二、活和会话被合并成一件。** 插件把“派出过一次 Worker”当成“一个活”的全部。启发者的活每次都从零开始；执行者的活等于一个会话，已有交付物没有人认领，磁盘上的东西散在多个目录里。合并之后状态没有落点：叫停、重试、恢复、排队都无处可放。

**三、文档和代码对不上。** `partner_followup`、`partner_stop`、`partner_list` 三处都写着要做，代码里一个都没有。

**四、外部事件进不来。** 文件放进去不会有人看，定时巡查没有入口。R25–R27 没有落点。

### 与原型的关系，以及为什么不能照搬

参照的原型是 `dsh-superagent`（commit `8c32a9d`）。它同样是 DSH 插件，领域模型（Ticket / Input / Assignment / Mandate）和事件源接入方式本插件直接用，本轮的大部分机制照搬它，不另行设计。领域规则、字段、状态转换、投递顺序、推送规则，都以原型为准。

但这不表示可以照着抄完。原型和本插件在最关键的一点上目的相反：

| 方面 | 原型 | 本插件 |
|---|---|---|
| 主 Agent 的定位 | 只做路由，不做技术判断。原文：“The main Session only routes: it forwards the original Trigger and the routing facts, and makes no technical decisions” | 承担对话里的判断：值不值得开活、派给谁、此刻要不要对 wish 说、回报怎么整合 |
| 判断的依据 | 策略规则（代码可执行）和 Worker 自己 | Partner 和 wish 之间的对话 |
| 服务对象 | 团队事件流，人和工作都可以来自多个来源 | 一个人，只有 wish 一个对话方 |
| 人看到的东西 | 面板：哪些活等人、系统健康、历史 | 只有对话 |

原型刻意让主 Agent 不做判断，团队场景里判断由规则和 Worker 分担。wish 要的正好相反：判断不在规则里，在 Partner 和 wish 之间。照搬原型会得到一个更快把活推出去、但不理解 wish 此刻在想什么的调度器，这是本轮最需要避免的结果。

所以分工是：领域机制照搬原型，判断的位置按本插件重新安排。判断位置见下面的 Solution 和 Implementation Decisions 中的“Partner 的双重角色”。

## Solution

把“活”从“会话”里拆出来，成为**工作单元**：有自己的 id、状态、输入队列、派工记录和授权。Worker 会话只是它在一个时段的执行者。

wish 的体验变化：

- 派出之后还能对同一个工作单元说“再细一点”，这句话投给当前 Worker，不新建会话、不重建目录。
- 说“先别干了”就中止当前这一轮，工作单元还在，之后还能接着问。
- 问“它现在在干什么”，Partner 能说出状态，而不是只能等。
- 外部放进来的文件和定时事件，由 Secretary 先判断要不要开成工作单元；不需要 wish 决定的，不打扰 wish。

### Partner 的双重角色

Partner 同时是**项目经理**和**良师益友**，两个角色由它自己承担，不是两个会话。这一节是判断位置的依据，实现时按它检查，不按它打折扣。

**良师益友**（R2–R6）：

- 追问意图。wish 说“我想做个 X”时，先问清 X 要解决什么，而不是直接开活。
- 指出盲点。wish 没想到的约束、代价、替代方案，要说出来。
- 敢直言并给理由。wish 判断偏了，说出来，同时始终记得主题（R3、R10）。
- 摆出并列选项，每个带解释和代价。不默认选一个，不给推荐，除非 wish 问（R4、R7）。
- 先理清再安排。把问题讲透，wish 想明白之后才开活。

**项目经理**（R14、R16、R18）：

- 把对话收敛成 task spec 或 exploratory prompt，确认后派出。
- 决定派启发者还是执行者。
- 跟踪进展。只在三种情形打断：Worker 将超出 `scope`、遇到产品决策或范围不清、工具失败且没有替代路径。
- 把两类结果整合后带回。读结论、读启发者的产出文件，不转贴 Worker 原文。
- 偏差时给原因、影响和选项，不给推荐。

**两者的分界**：良师益友先工作，项目经理后工作。同一轮对话里两者交替，但不可省略前者。wish 刚提出一个想法时，Partner 先谈；只有 wish 确认方向之后，Partner 才开活。

**为什么这条会写错，以及检查标志**：把 Partner 做成执行者，表现是它开始替 wish 想方案、替 wish 判断该选哪个、或者在看 Worker 的实现细节。出现这三种之一，就是越界了。它的上下文里不应该有执行细节；它不写文件、不跑命令、不读代码。

**Partner 不做的事**：不写文件、不跑命令、不读 Worker 的完整会话（除非 wish 要求核验某一处）、不修改工作单元状态、不替 wish 做产品判断。

### 机制在代码里

状态转换、输入队列、投递顺序、并发、重试、策略版本这些不需要理解语境的事，全部在插件代码里，有测试。Partner 和 Secretary 只读，不写。

## User Stories

1. As wish, I want 派出之后还能对同一个活追加要求，so that 我不用把背景重新交代一遍。
2. As wish, I want 追加的要求投给同一个 Worker 会话，so that 它接着上次的上下文做，不会从零开始。
3. As wish, I want 能中止当前这一轮而不作废整个活，so that 我中途想改方向时不丢已有工作。
4. As wish, I want 能查一个活现在在做什么、卡在哪，so that 长时间没有回报时我知道它没死。
5. As wish, I want Partner 按工作单元引用活，不按会话 id，so that 我看不到也不需要记会话 id。
6. As wish, I want 启发者的追问接着同一批思路，so that 它是叠加而不是重新发散。
7. As wish, I want 启发者能把产出写成文件，so that 我能读到完整选项而不只是摘要。
8. As wish, I want 执行者的工作单元一个固定目录，追问沿用，so that 已有交付物不会散在多处。
9. As wish, I want 派发时能指定模型，so that 简单活和难活用不同的模型。
10. As wish, I want 一个工作单元有自己的授权范围，so that 越界时 Worker 知道要停下来。
11. As wish, I want Worker 越界时报 `blocked` 而不是自作主张，so that 判断权留在我这里。
12. As wish, I want Worker 报 `ready` 后我能判断接不接受，so that 交付物不是它说了算。
13. As wish, I want 报 `dropped` 时不打扰我，so that 无事发生不占我的注意力。
14. As wish, I want `progress` 不推给我，so that 执行过程不打散我的思考。
15. As wish, I want 回报带着 Worker 自己的身份，so that Partner 分得清哪句是 Worker 说的、哪句是我说的。
16. As wish, I want 回报的摘要按状态有具体内容要求，so that 我拿到的是能判断的信息，不是“已完成”。
17. As wish, I want 同一个回报重复到达时只算一次，so that 重试不会让我看到两条一样的消息。
18. As wish, I want 一个活能同时排几条追问，so that 我不必等它回完才能说下一句。
19. As wish, I want 追问按顺序投递，so that 后说的不会先到。
20. As wish, I want 工作单元的状态跨重启保留，so that 插件重启后我问它，它还记得。
21. As wish, I want Worker 会话被外部删掉后能重建，so that 工作单元不会因为会话没了而丢失。
22. As wish, I want 文件放进指定目录后由 Secretary 判断要不要处理，so that 我不必每次手动说“看看那个文件”。
23. As wish, I want 定时事件也走同一套判断，so that 巡查不用我记着去做。
24. As wish, I want 每类文件的默认处理可配置，so that 常见类型不用每次说明。
25. As wish, I want Secretary 判掉的东西留下记录，so that 它判错时我能发现。
26. As wish, I want Secretary 只在需要我决定时说话，so that 它不成为新的打扰源。
27. As wish, I want Secretary 读得到当前对话，so that 它知道我这会儿在做什么，判断不至于离谱。
28. As wish, I want Secretary 随新的 Partner 会话创建，so that 它和这次对话一起生、一起结束。
29. As wish, I want 普通会话不创建 Secretary，so that 它不在无关的会话里冒出来。
30. As wish, I want 打扰阈值可配置，so that 哪些情形必须打断我能改。
31. As wish, I want 策略版本被记录，so that 规则变了时我知道哪些活是按旧规则开的。
32. As wish, I want 规则变化只通知受影响的活、不撤销授权，so that 正在做的事不会因为改规则就停。
33. As wish, I want 已结束的活在恢复前重新校验，so that 过期的授权不会无声复活。
34. As wish, I want 并发上限可配置，so that 同时跑几个执行者我控制得住。
35. As wish, I want 我的追问不占执行者的槽位，so that 两个执行者满槽时我还能插话。
36. As wish, I want Partner 的上下文只有它需要的，so that 活一多它也不会变笨。
37. As wish, I want Partner 的工具少而明确，so that 它不会选错工具。
38. As wish, I want 状态的含义写在工具描述里，so that Partner 不用背状态机。
39. As wish, I want 一次派发不产生多余的会话和目录，so that 会话列表不会被垃圾填满。
40. As wish, I want 派发失败时 Partner 拿到可读的错误，so that 它能告诉我卡在哪。
41. As wish, I want 未知的 Worker 类型被拒绝，so that 打错字不会建出错误的会话。
42. As wish, I want 取不到调用方会话时直接拒绝，so that 不会建出一个没人能回报的 Worker。
43. As wish, I want 工作单元有自己的类型（启发者/执行者），so that 两类活的结束条件不同。
44. As wish, I want 启发者的活报 `ready` 即结束，so that 它的产出是一次性的。
45. As wish, I want 我能在一个活上连续说几句话，so that 协作是来回的，不是一问一答。
46. As wish, I want 插件不再声称有而不存在的工具，so that 我读文档时不会误判能力。

## Implementation Decisions

### 工作单元与四张表

一个工作单元是一件事，不是一次会话。四张表按原型 `dsh-superagent` 的领域模型（Ticket / Input / Assignment / Mandate），字段按个人使用收窄：

| 表 | 关键字段 | 谁读 |
|---|---|---|
| 工作单元 | id、类型、状态、标题、来源、输入队列、未送达输入、派工记录引用、授权 | Partner 查活；Secretary 读判断结果 |
| 输入 | 内容、来源、送达时间、Worker 读入时间 | 追问投递、失败重投、恢复 |
| 派工 | 状态（待启动 / 执行中 / 已结束）、Worker 会话 id、最近一次回报 | 中止、重试、恢复 |
| 授权 | 范围、强度（明确 / 推断）、策略版本 | Worker 自报越界；Partner 复核 |

订阅简化为“工作单元挂在哪条对话上”。没有外部线程，不做原型那种一条消息扇出给多个工作单元。

**状态转换**（来自原型 `src/core/tickets.ts` 与 `assignments.ts`，按个人使用裁掉 PR 相关判定）：

```
工作单元：待启动 → 执行中 → 等你判断 / 等输入 / 已结束
输入：    待送达 → 已送达 → 未读 / 已读
派工：    待启动 → 执行中 → 已结束
```

- 报 `ready`：执行者进入“等你判断”，启发者直接“已结束”。
- 报 `dropped`：直接“已结束”，不发消息。
- 报 `blocked` / `failed`：进入“等你判断”，等待输入。
- 新的输入到达：从“等你判断”回到“执行中”。
- 中止只结束当前派工，工作单元不动。
- 结束是终态；要再做同一件事，开新的工作单元。

### 三种状态归属

状态转换全部在插件代码里，有测试。Partner 和 Secretary 只读，不写状态。Partner 独有的判断（值不值得开活、派给谁、要不要现在说）没有一行在代码里。

### 三个入口

| 入口 | 谁判断 | 后续 |
|---|---|---|
| wish 与 Partner 的对话 | Partner，以良师益友的身份谈、以项目经理的身份办 | 谈清楚后开活、追问、中止；执行期间是否说话按打扰原则 |
| 外部事件（文件、定时） | Secretary，按设定时确定的规则 | 开活或判掉并记录；未开活的事件只在表里 |
| Worker 回报 | 插件代码 | `ready` / `blocked` / `failed` / `dropped` 和提问按规则推给 Partner；`progress` 不推 |

### Partner 的工具面

五个工具。

| 工具 | 挂在哪个 preset | 作用 |
|---|---|---|
| `partner_dispatch` | Partner | 起一个工作单元，返回工作单元 id。参数含类型、标题、正文，可选模型 |
| `partner_followup` | Partner | 向一个工作单元追加输入 |
| `partner_stop` | Partner | 中止当前这一轮，工作单元仍在 |
| `partner_list` | Partner | 查工作单元状态和被判掉的外部事件；状态含义写在这个工具的描述里 |
| `partner_report` | 两个 Worker preset | Worker 报状态和摘要 |

工具定义需要 `output` 块，`parameters` 必须是 provider 接受的 JSON Schema（ADR-0004）。

### 回报的身份与推送

- 回报是一条 source 为 `agent-message` 的消息，带 `form: 'relay'` 和 `senderSessionId`。消息构造集中在同一个模块。
- 推送规则在代码里：`ready`、`blocked`、`failed`、`dropped` 和提问推给 Partner；`progress` 不推。
- 一轮结束没有回报时补一条 `waiting`，与原型同法。
- 去重键为工作单元 + 轮次 + 状态 + 摘要。

### 持久化

用 `ctx.storageDomain.open(spec)`，`defineDomain` 加 `domainTable(schema)` 声明表。本机 profile 已加载 `storage`、`storage-json`（root 为 stateDir 下的 storages）、`storage-domain`。不使用原型的 SQLite 层和迁移。

### 派发与执行

- 工作单元一个工作目录，追问沿用，结束后保留。目录名带工作单元 id，标题改了也不改名。
- Worker 会话 id 由工作单元 id 派生，会话被外部删除时按工作单元 id 重建。
- 权限、命名、送第一条消息沿用现有七步链路（`docs/impl/superagent-impl.md` 第二节）。
- 模型：派发时可选指定，不填用会话默认（R15）。
- 并发：执行者槽位上限可配置，默认 2；启发者和 wish 的追问不占槽。
- 叫停：中止当前派工，调 `agent.cancel`。工作单元保持。

### Secretary

- 随新的 Partner 会话创建，普通会话不创建。判断方式：监听 `agent/created`，用 `agentPresets.presetForSession(agent.session)` 读 preset id。
- 读得到当前对话，只读，不写入；它的话不进入 Partner 的历史。
- 判断依据在设定时确定：目录清单、文件类型、每类默认处理存在事件源的配置块里；判断规则以规则文本形式保存在策略里，每次请求时注入。
- 只在需要 wish 决定时说话；其余判断结果写进表。
- 定时事件的判断依据同样在设定时确定，事件触发时没有 Partner 会话也照常记录，等下次有会话时 Secretary 看得到。

### 事件源

- 文件入口和定时各自是事件源，各有配置块。
- 定时用 `ctx.schedule`，投递结果写进域表，不唤醒对话。
- 事件源配置和策略规则通过 Partner 的工具调用修改，不打开文件手改。

### 策略版本

- 建活时记录当时的策略版本。
- 规则变化只通知受影响且未结束的工作单元，不撤销授权。
- 已结束的工作单元恢复前重新校验。

### 模块划分

- 状态机：纯代码，不碰 Host，转换进、状态出。
- 执行器：起会话、投递、回报、叫停、恢复。
- Partner 子模块：提示词、派发、追问、中止、查询五个工具。
- Secretary 子模块：preset 与提示词。
- 事件源：文件入口、定时。
- 入口：只做注册，按 ADR-0002 每个 preset 一个子路径。

## Testing Decisions

**什么算好测试。** 只断言外部行为：交给 Host 服务的调用和参数，以及交给 `followup` / `steer` 的消息。不断言私有函数名、内部数据结构、日志文本。

**两道接缝。**

1. **插件入口**，沿用现有唯一接缝 `apply(ctx, config)` 配 `test/host-fake.js`。这层验证 preset 注册、工具注册、工具参数形状、派发链路、回报投递、事件源的行为。
2. **状态机**，新增一道进程内接缝：转换进、状态出，不碰 Host。这层验证顺序和幂等，例如先投递再出队、未读输入在结束时退回、同一轮不重复投递。

两道缝的理由：假 Host 测不出顺序规则，只能直接测状态机；而状态机测试不需要 Host，也就不用为它造第二套假对象。

**测试哪些模块。** 插件入口（`apply`）和状态机。执行器、Partner 子模块、Secretary、事件源都通过入口进，不为它们各自开缝。

**先例。** 本仓库现有测试（`test/dispatch.test.js` 等）用假 Host 记录调用；原型 `dsh-superagent` 有对应的领域测试。本轮的测试沿用本仓库的形状。

## Out of Scope

- 表格和面板：排期以后做。
- GitHub 和飞书事件源：本轮只做文件入口和定时。
- 目录级写入拦截：`scope` 是行为约束，越界靠 Worker 自报和 Partner 复核，与原型一致。
- 跨会话记忆：Secretary 的了解范围限于当前对话。
- 提示词版本管理和覆盖：提示词写在 preset 模块里。
- 外部频道的出站消息（回执、回复到来源）。
- 多人、多来源、多线程订阅。
- 工作单元的落盘备份和迁移工具。

## Further Notes

**实施顺序。**

1. 状态机与域表，加测试。
2. Partner 的五个工具与 `partner_list` 的状态描述。
3. 回报推送规则，回报来源改为 `agent-message`。
4. Secretary preset 与随新会话创建。
5. 事件源：文件入口与定时，配置块和规则文本。
6. 策略版本。

第一步完成后，直接在 DSH 里跑一次真实派发验证，不以“测试全绿”作为验收。之前有 8 次真实运行时失败都来自测试替身接受了真实 Host 拒绝的形状：工具定义缺 `output`、`parameters` 用作者 DSL、`restrict` 用在未注册的工具上、往 `ctx` 上赋值、读未声明的服务、相对工作目录、`UserMessage` 缺 `id` / `source`。加 Host 调用前先核对 DSH 类型声明。

**删代码的范围。** 删掉 `partner.js`、`report-channel.js`、`channel-registry.js`、`report.js`、`tools.js`、`messages.js`、`worker-shared.js`、`worker-discoverer.js`、`worker-implementer.js`，以及 `test/` 下除 `host-fake.js` 外的测试。保留 `test/host-fake.js` 作为唯一入口接缝，保留 `cordis.patch.yml`、`locale/`、`icon.svg`，重写 `index.js` 和 `package.json` 的 exports。

**preset id。** Partner 由 `superagent-wish-recruiter` 改为 `superagent-wish-partner`，新增 `superagent-wish-secretary`。文档已按新名写，`index.js` 和 `test/presets.test.js` 还是旧名，本轮一并改。

**原型参照。** `dsh-superagent`（commit `8c32a9d`）是本轮的参照。领域规则照搬，实现方式按 DSH 的接口重做。

| 本轮要做的 | 原型里的落点 |
|---|---|
| 工作单元、输入、派工、授权四张表 | `src/core/model.ts` 的类型定义、`src/core/tickets.ts` 的生命周期、`src/core/assignments.ts` 的派工回调 |
| 输入排队与串行投递 | `src/executor/dsh.ts` 的 `deliverQueued` / `deliverInput` |
| 外部事件的进入 | `src/core/intake.ts` 的 `receive`、`src/app/settings.ts` 的 `sources.<id> = { enabled, config }` |
| 判断规则作为提示词 | `src/policy.ts` 的 `rules` 与 `policyVersion`、`runtime/policy` 段 |
| 状态查询 | `src/app/resources.ts` 的 `RESOURCES`，`tickets` 那一项的说明格式 |
| 推送规则 | `src/app/notices.ts` 的 `reportRelay`、`eventNotice` |
| 会话的创建 | `src/app/sessions.ts` 的 `ensure` |

**原型本身也是 DSH 插件，能力上不缺东西。** 它的入口是 `src/index.ts`，`inject` 列的是 DSH Host 服务：`agents`、`sessionController`、`sessionPersistence`、`workspaceRegistry`、`permissionPresets`、`tools`、`systemPrompt`、`skills`、`webServer`、`llm`、`subprocess`。存储、队列、轮询、面板、事件源都是它用这些服务自己实现的，不是宿主给的现成件。

按面积拆开（92 个 TypeScript 文件，12390 行）：

| 区域 | 行数 | 内容 | 本插件 |
|---|---|---|---|
| `core/` | 2088 | 领域规则，无 IO | 照搬 |
| `app/` | 5292 | 组合根、存储、队列、轮询、设置、提示词、读资源、HTTP | 部分照搬 |
| `sources/` | 2059 | GitHub 901 行、飞书 756 行、公共 402 行 | 公共部分照搬 |
| `executor/` | 838 | 启动、投递、轮次结束、叫停、重启恢复 | 照搬 |
| `infra/` | 347 | 命令、健康、路径、文本 | 少量照搬 |
| `client/` | 4037 | 浏览器界面 | 不做 |
| 根文件 | 约 700 | 入口、部署、环境探测、策略、准入 | 少量照搬 |

`app/` 再拆一层：

| 模块 | 本插件 | 用什么替 |
|---|---|---|
| `runtime.ts`（组合根） | 简化做 | 插件入口自己装配 |
| `store.ts`（SQLite + 迁移） | 不做 | `ctx.storageDomain` + `defineDomain` |
| `effects.ts`（持久队列、失败重试、按种类限并发） | 简化做 | 域表存待办 + 一个小泵 |
| `passes.ts`（2 秒轮询） | 简化做 | 插件里 `setInterval`，只管派发、投递、超时 |
| `outbox.ts`（出站消息回执、按会话保序） | 不做 | 没有外部频道 |
| `sessions.ts` | 做 | 复用已有链路 |
| `assessment.ts`（研判的模型调用与超时） | 不做 | 外部事件由 Secretary 按规则判断，不另起研判模型 |
| `settings.ts` + `policy.ts` | 简化做 | 设置存域表；策略版本只做记录和重新校验 |
| `prompts.ts` + `skill-files.ts` | 不做 | 提示词写在 preset 模块里 |
| `resources.ts` + `cards.ts` + `views/`（约 1300 行） | 简化做 | `partner_list`，不建资源目录 |
| `http.ts` + `api.ts`（约 300 行） | 不做 | 无面板 |
| `client/`（4037 行） | 不做 | 无界面 |

**机制能照搬，有四处在 DSH 插件里必须重做**，照抄会直接出错：

1. **存储。** 原型用 `node:sqlite`，自己管迁移（`migration.ts`、`SCHEMA_VERSION`）。DSH 里用 `ctx.storageDomain.open(spec)`，表和版本声明在域规格里，迁移交给 `compatibleVersions`。本机 profile 已加载 `storage`、`storage-json`、`storage-domain`，不用额外装。
2. **定时。** 原型的 `Passes` 每 2 秒跑一次，靠进程常驻。插件没有自己的进程，定时要么用 `ctx.schedule`，要么自己 `setInterval` 并在 `ctx.effect` 里清理。文件入口的巡查用 `ctx.schedule`；派发、投递、超时用 `setInterval`。
3. **队列。** 原型的 `Effects` 是持久队列，失败按 2 秒翻倍重试到 1 分钟，按种类限并发。本插件没有这个件，要用域表存待办、写一个小泵自己实现，或者退化成直接调用。退化的代价是进程重启时未完成的工作丢失。
4. **面板。** 原型有 6 个标签页、HTTP 路由和 React 界面，主 Session 靠 `orchestrator_read` 读同一批视图。本插件没有面板，`partner_list` 是唯一的读口，状态含义要写进工具描述。

剩下几处照原型不动：领域规则、状态转换、投递顺序、推送规则、会话创建与恢复。这几处是原型最值钱的部分，也是重复踩坑最多的部分。

**第六节需求编号待修正。****第六节需求编号待修正。** `docs/PROJECT-NEEDS.md` 第六节“外部入口”那行写的 `R23、R24、R29` 有误：R23 是 Hindsight，R24 是记忆层，文件入口是 R25–R27。这一处等你确认后改。
