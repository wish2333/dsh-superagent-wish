# 02: Partner 能派、能追、能停、能查

**What to build:** Partner 能用四个工具管一个活：开一个工作单元、向同一个工作单元追加要求、中止当前这一轮、查它的状态。Worker 用 `partner_report` 报状态和摘要。这是第一条能真跑通的竖切：派一个活，然后对同一个活说“再细一点”，再中止，最后查它现在什么状态，全程不新建会话、不重建目录。

**Blocked by:** 01

**Status:** resolved

- [ ] `partner_dispatch` 返回工作单元 id，不是会话 id
- [ ] Worker 会话 id 与工作目录都由工作单元 id 派生，标题改了目录也不改名
- [ ] 同一个工作单元再次派发复用已有会话，不新建
- [ ] `partner_dispatch` 可指定模型，不填用会话默认
- [ ] 未知的 Worker 类型被拒绝，且不创建任何会话
- [ ] 取不到调用方会话时直接拒绝，不创建工作单元
- [ ] `partner_followup` 把追加输入排进队列，投给当前 Worker 会话
- [ ] 追加输入不需要重新确认，也不重建工作目录
- [ ] `partner_stop` 结束当前派工，工作单元仍在，之后可继续追问
- [ ] `partner_list` 返回名字、类型、状态、停了多久；状态含义写在工具描述里
- [ ] 工作单元被删掉会话后，下次投递能按工作单元 id 重建会话
- [ ] 五个工具的定义都带 `output` 块，`parameters` 是 provider 接受的 JSON Schema
- [ ] 工具结果只含文本内容块，错误返回可读的一句话

**Notes:** 派发链路照 `docs/impl/superagent-impl.md` 第二节的七步。`partner_list` 只读，不改状态。并发上限不在这票，见 06。

---

## Answer

派发链路照 `docs/impl/superagent-impl.md` 第二节七步；会话 id 与目录都由工作单元 id 派生（ADR-0006），标题改了不改目录，会话被删按同一 id 重建。八个工具当时全部带 `output` 与 provider 可接受的 JSON Schema；结果只有文本块，错误是一句话。

**落点**：partner.js / sessions.js / worker.js

**提交**：`f3e6bf0`、`91093cf`
