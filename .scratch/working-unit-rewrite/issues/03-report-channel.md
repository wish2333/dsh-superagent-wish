# 03: Worker 回报走对通道

**What to build:** Worker 的回报不再冒充 wish 说的话。回报带着发送方会话 id 送进 Partner，Partner 读得出“某个 Worker 报了什么”。哪些状态推送、哪些不推，由代码按固定规则决定，不靠 Partner 判断。两类 Worker 的结束条件在这一票定下来。

**Blocked by:** 02

**Status:** resolved

- [ ] 回报以 `agent-message` 为来源送进 Partner，带 `form: 'relay'` 和发送方会话 id
- [ ] 消息构造集中在一处，不再有第二处拼消息
- [ ] `ready`、`blocked`、`failed`、`dropped` 和提问推给 Partner
- [ ] `progress` 不推给 Partner
- [ ] 一轮结束没有回报时补一条 `waiting`
- [ ] 同一个回报重复到达时只送一次
- [ ] 启发者报 `ready` 后工作单元结束；追问开新的工作单元
- [ ] 执行者报 `ready` 后进入“等你判断”；追问投给同一个工作单元
- [ ] `dropped` 结束时不给 wish 发消息

**Notes:** 推送规则照原型 `src/app/notices.ts` 的 `reportRelay`。结束条件差别见 `docs/design/working-unit.md` 第二节。

---

## Answer

回报以 `agent-message`、`form: 'relay'`、`senderSessionId` 从唯一一处构造后 `steer` 给 Partner。推送规则在 `state.js` 的 `pushes()`：`ready`、`blocked`、`failed` 和提问推，`progress` 不推。一轮没有回报时补 `waiting`，去重键含 Partner 会话、工作单元、轮次、状态、摘要与来源。`dropped` 不发消息（用户故事 13）。过程中顺带修掉两个会让回报根本送不到的缺陷：`partnerSessionId` 被覆盖、`nextId()` 取到 NaN。

**落点**：relay.js

**提交**：`f98abec`、`d994264`、`a20c983`、`430992c`
