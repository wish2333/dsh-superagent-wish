# 工作单元设计

本文件是重写 dsh-superagent-wish 的方案。需求见 `../PROJECT-NEEDS.md`，术语见仓库根目录 `GLOSSARY.md`。
设计取自 dsh-superagent 原型的机制，判断位置按本插件的需要重新安排。

---

## 一、角色

三个角色各是独立的 DSH 会话，职责不重叠。

| 角色 | preset | 与谁通信 | 承担的判断 |
|---|---|---|---|
| Partner | `superagent-wish-partner` | 只与 wish | 这件事值不值得开一个工作单元；派给启发者还是执行者；此刻要不要对 wish 说；Worker 的回报怎么整合成 wish 能判断的形式 |
| Secretary | `superagent-wish-secretary` | 需要 wish 决定时对 wish 说；被 Partner 询问时回答 | 外部进来的东西要不要开成工作单元 |
| Worker | `superagent-wish-discoverer` / `superagent-wish-implementer` | 不与任何人直接通信，消息由插件代码投递 | 工作单元内部的事；越界时报 `blocked` |

Partner 同时承担两个角色：项目经理（开活、追活、汇报进展）和良师益友（追问、直言、摆选项）。两个角色都由它自己做，不拆成两个会话。

**上下文边界**：

- Partner 的上下文围绕对话组织，只包含 wish 说的话、它自己说的话、工作单元的名字与状态。
- Secretary 读得到 Partner 会话的当前对话，只读，不写入。
- Worker 的上下文独立，只含它的指派和收到的输入。

---

## 二、一个工作单元的形状

一个工作单元是一件事，不是一次会话。它有自己的身份、状态和输入队列；Worker 会话只是它在某个时段的执行者。

四张表照原型的领域模型，字段按个人使用收窄。

| 表 | 关键字段 | 谁读 |
|---|---|---|
| 工作单元 | id、类型、状态、标题、来源、输入队列、未送达输入、派工记录、授权 | Partner 查活；Secretary 读判断结果 |
| 输入 | 内容、来源、送达时间、Worker 读入时间 | 追问投递、失败重投、恢复 |
| 派工 | 状态（待启动 / 执行中 / 已结束）、对应的 Worker 会话、最近一次回报 | 中止、重试、恢复 |
| 授权 | 范围、强度（明确 / 推断）、策略版本 | Worker 自报越界；Partner 复核 |

**订阅模型简化**：一个工作单元挂在哪条对话上，就是它订阅的线程。没有外部线程，不做原型那种“一条消息扇出给多个工作单元”。

**两种类型的差别**：

| 项 | 启发者单元 | 执行者单元 |
|---|---|---|
| 工作区 | 一个工作单元一个目录，追问沿用，结束后保留 | 同左 |
| 写入工具 | 有（产出写成文件） | 有 |
| 结束条件 | Worker 报 `ready` 即结束，追问开新单元 | 报 `ready` 后等你判断 |
| 并发 | 不占执行者槽位 | 占槽位，默认 2（`implementerSlots` 可配）；槽位满时排队，同一目录不并发 |

---

## 三、状态由谁改

原型把四张表交给代码，主 Session 不参与状态转换。这里照做。

- 所有状态转换在插件代码里，有测试覆盖。
- Partner 和 Secretary 只读，不写。
- 例：输入送达、Worker 读入、派工结束、工作单元结束，都由插件在收到对应事件时改写，Partner 不参与。

Partner 独有的判断不在状态里：这句话值不值得开活、派给谁、要不要现在告诉 wish。这类判断没有一行在代码里。

---

## 四、三个入口

| 入口 | 谁判断 | 后续 |
|---|---|---|
| wish 与 Partner 的对话 | Partner 以良师益友的身份谈，以项目经理的身份办 | 谈清楚之后开活、追问、中止；执行期间是否对 wish 说话，由 Partner 按打扰原则判断 |
| 外部事件（文件、定时） | Secretary | 按规则判断，开活或判掉并记录；未开活的事件只在表里，等你或 Partner 查看 |
| Worker 回报 | 插件代码 | `ready`、`blocked`、`failed`、`dropped` 和提问推给 Partner；`progress` 不推；推与不推的规则在代码里 |

**为什么不在对话入口做研判**：wish 说的话本身就是授权，不需要判断值不值得做。研判只对外部事件。

**为什么状态不自动注入 Partner**：每轮注入会让 Partner 的上下文随工作单元数量增长，与“上下文薄，和人的交流才更深”冲突。状态按第五节的规则推送，按第六节的工具查询。

---

## 五、Secretary

Secretary 是 Partner 新会话创建时随之创建的独立会话。普通会话不创建 Secretary。

**判断依据在设定时确定**：

- 监听的目录清单、文件类型、每类文件的默认处理，存在事件源的配置块里。
- 判断规则以规则文本的形式保存在策略里，每次请求时注入 Secretary 的上下文。
- 改这两样都通过 Partner 的工具调用完成，不打开文件手改。

**上下文**：Secretary 读得到当前对话，用于判断某个文件此刻值不值得开活。它的话不进入 Partner 的历史。

**说话**：只在需要 wish 决定时说。其余判断结果写进表，wish 或 Partner 查看时看到。

**定时事件**：定时任务的上下文在设定时确定。事件触发时没有 Partner 会话也照常处理，结果存进表，等下次有会话时 Secretary 看得到。

---

## 六、Partner 的工具面

Partner 挂五个工具，两个 Worker preset 各挂报告一个，Secretary 挂判断、巡查和读对话三个。

| 工具 | 挂在哪个 preset | 作用 |
|---|---|---|
| `partner_dispatch` | Partner | 起一个工作单元，返回工作单元 id |
| `partner_followup` | Partner | 向一个工作单元追加输入，投给当前的 Worker 会话 |
| `partner_stop` | Partner | 中止当前这一轮；工作单元仍在，之后可以追问 |
| `partner_list` | Partner | 查工作单元的状态和被判掉的外部事件；状态含义写在这个工具的描述里 |
| `partner_setup` | Partner | 读写判断规则与两个事件源的配置块，不打开文件手改 |
| `partner_report` | 两个 Worker preset | Worker 报状态和摘要 |
| `partner_decide` | Secretary | 把对一个事件的判断写回表：开成工作单元，或判掉并记下理由 |
| `partner_patrol` | Secretary | 定时任务到点时记录一次巡查；只写表，不打扰 wish |
| `partner_read_conversation` | Secretary | 只读地读当前 Partner 对话最近的几条消息，供判断某个事件此刻值不值得开活 |

Partner 不能直接结束工作单元。wish 说“这个活不要了”时，Partner 用 `partner_stop` 并明确说明，是否要单独的工具留到实际使用后再定。

---

## 七、实施顺序

按以下顺序做，先写代码，后接入口。

1. 宿主侧状态机：工作单元、输入、派工、授权四张表，加测试。
2. Partner 的工具与 `partner_list` 的状态描述。
3. Worker 回报的推送规则，回报来源改为 `agent-message`。
4. Secretary preset，随 Partner 新会话创建。
5. 事件源：文件入口与定时入口，加配置块和规则文本。
6. 策略版本：建活时记录版本；规则变了只通知受影响且在跑的工作单元，不撤销授权；已结束的工作单元恢复前重新校验。

第一步完成后，直接在 DSH 里跑一次真实派发验证，不以“测试全绿”作为验收。之前的 8 次真实运行时失败都来自测试替身接受了真实 Host 拒绝的形状。

---

## 八、本方案不包含

- 目录级写入拦截。`scope` 是行为约束，越界靠 Worker 自报 `blocked` 和 Partner 复核，与原型一致。
- 跨会话的记忆。Secretary 的了解范围限于当前对话。
- 多人、多来源、多线程订阅。
- 界面。工作单元的状态只在会话里呈现。

---

## 九、实现约束

本节的每一条都由一次真实运行失败换来，写在这里是因为它们改变代码的位置，不只是细节。

**常驻逻辑放 manager。** 预设的 `plugins` 行只在那个预设被挂载时才加载。任何需要在“没有该预设会话时也运行”的逻辑——轮询、监听、队列泵——都必须放在 `index.js`。放在预设子模块里，它会在预设第一次被选中之前一直不存在。

**判断预设看两个信号。** 桌面版先建会话、后写 preset，`agent/created` 触发时 `presetForSession` 仍为 `null`，要用 `agentPresets.composedPreset(agent.ctx)`；用户主动选预设这件事只有 `agent-preset/selected` 能捕捉到。两者都要听，创建逻辑保持幂等。

**prompt section 同步返回字符串。** `systemPrompt.section` 的 `text` 会被同步调用，异步数据要在挂载时读好、变化时刷新，`text()` 只做拼接。

**Host 服务先声明再读。** 未声明的读取会让整个预设挂载失败，而失败是静默的：用 `agentPresets.resolve(id)` 检查返回的 `broken`。

**存储 schema 接受 `null`。** “已送达未读”这类中间态要显式写出，并补一条重载测试——`storage-domain` 在打开域时校验全部已存记录，一条不合规的记录会让整个域打不开。

**调用方用真实 Agent。** 需要工作目录、模型、会话 id 时，从真实 Agent 上读，不要拼 `{ id, session: { id } }` 这样的假对象。
