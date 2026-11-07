# 真实 DSH 运行验证记录

环境搭建与命令见 `dsh-runtime-recon.md`。本文件记录每次真实运行验证了什么、暴露了什么。
踩坑与可复用解决方案的完整整理见 `../working-unit-rewrite/implementation-record.md`。

---

## 环境

- 运行时：`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh`（`0.2.2-rc.1`）
- profile：桌面版 profile 的副本 `wish-web`，`DSH_HOME=/tmp/dsh-scratch`
- 模型：magpie，`deepseek/deepseek-flash`
- 驱动：一次性驱动插件，用真实 `sessionController` / `agentPresets` / `tools` 建 Partner 会话并调工具

## 一、驱动脚本跑通的链路

| 步骤 | 结果 |
|---|---|
| Partner 会话（preset `superagent-wish-partner`） | 建成 |
| `partner_dispatch` | 返回 `unit-1`，Worker 会话 `superagent-wish-unit-1` 真实创建，目录落盘 |
| `partner_followup` | 投给同一 Worker 会话，返回排队数 |
| 一轮结束无回报 | 兜底 `waiting` 报告写进表并推给 Partner |
| 回报到达 Partner | 会话事件里出现 `agent-message` 来源、带 `senderSessionId` 的消息 |
| `partner_stop` | 中止派工，单元转 `waiting-for-input`，目录保留 |
| `partner_list` | 读出名字、类型、状态、停留时长、范围、最近报告、判掉事件段 |

## 二、驱动脚本暴露并修复的缺陷

| # | 缺陷 | 修复 |
|---|---|---|
| 1 | `secretary.js` 未声明 `tools` 就读取，Cordis 拒绝，Secretary preset 整体挂载失败 | `inject` 声明补全；`resolve(id)` 返回的 `broken` 是排查入口 |
| 2 | `inputs.readAt` 不接受 `null`，已送达未读的记录让 `storage-domain` 打开域时抛错 | schema 接受 `null`，补重载测试 |
| 3 | 派工已被 `waiting` 报告结束后再 `partner_stop`，单元卡在 `running` | 停止时把单元置为 `waiting-for-input` |
| 4 | Worker 回合结束未回报时执行者槽位永不释放 | `turnEnded` 返回回合结局，`closed` 时`advance()` 释放槽位 |
| 5 | 文件源轮询只由 `sources` 预设启动，而该预设从不被选中 | 轮询改由 manager 启动 |
| 6 | 事件开活时用只有 id 的假会话，取不到对话工作目录 | 改为解析真实 Partner Agent |
| 7 | 执行者目录只在会话首次创建时建 | 每次投递都确保目录存在 |

## 三、桌面版 GUI 里由 wish 走通的链路

这是唯一一次不经驱动脚本、由人操作的验证。

1. 让 Partner 调 `partner_setup`，把文件源挂到它自己的工作区，并写一条判断规则。
2. 往该目录放一个 `.md` 文件。等待约 10 秒。
3. Secretary 会话出现：调 `partner_read_conversation` 读对话，再调 `partner_decide` 作出判定（`turn/end` 为 `completed`）。
4. 判定开出工作单元，执行者会话 `superagent-wish-unit-1` 与目录建立，Worker 读取该文件并执行。
5. wish 对 Worker 说“这是测试，立刻返回”，Worker 调 `partner_report` 报 `ready`。
6. Partner 收件箱收到一条 `agent-message` 来源的消息，`senderSessionId` 为 `…-unit-1`，正文含状态与摘要。
7. 追问：Worker 会话共 3 轮，第 2、3 轮收到 wish 的新输入，cwd 始终未变，没有新建会话。
8. 中止：第 3 轮 `turn/end` 记为 `{"kind":"aborted","reason":{"kind":"user"}}`，单元保留。

## 四、GUI 之后暴露并修复的缺陷

| # | 缺陷 | 修复 |
|---|---|---|
| 8 | Secretary 的 prompt section 是 async 函数，Host 同步取文本后扫描变量，拿到 Promise，每轮报 `text.indexOf is not a function` | section 在挂载时读好、保存时刷新，`text()` 同步返回字符串 |
| 9 | Secretary 监听写在预设子模块里，第一个 Secretary 出现前不加载，形成死锁；且 `agent/created` 时 preset 尚未落定 | 监听移到 manager，同时听 `agent-preset/selected` 与 `agent/created` |

## 五、未在真实运行中覆盖

- 定时巡查到点：`ctx.schedule` 的任务在 web profile 下未触发过。
- 并发槽位：真实运行里只同时跑过 1 个执行者。
- 「一条消息扇出到多个单元」不在范围内，未验证也不打算支持。
