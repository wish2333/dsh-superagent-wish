# 04: Secretary 建起来并被调用

**What to build:** 每开一个新的 Partner 会话，就有一个 Secretary 跟着起来；普通会话不创建。Secretary 读得到当前对话，只在需要 wish 决定时说话。这一票先把会话、preset 和身份做出来，判断规则在 05。

**Blocked by:** 01

**Status:** resolved

- [ ] 新的 Partner 会话创建时，同时创建一个 Secretary 会话
- [ ] 普通会话创建时不创建 Secretary
- [ ] Secretary 用 `agentPresets.presetForSession` 读出 preset id 来判断对方是不是 Partner
- [ ] 读不到 preset id 时当它不是 Partner，不创建 Secretary，也不报错
- [ ] Secretary 读得到当前对话，只读，它的话不进入 Partner 的历史
- [ ] Secretary 不直接和 wish 对话，它的结论落在表里，Partner 查得到
- [ ] 已有 Partner 会话重开时不重复创建 Secretary

**Notes:** 判断方式用 `agent/created` 事件，载荷里有 `agent`。这是 DSH 的开发者预览接口，加之前先核一次类型声明。

---

## Answer

`agent/created` 监听器用 `agentPresets.presetForSession` 判断是不是 Partner 的新会话；Secretary 会话 id 由 Partner id 派生（`<partnerId>-secretary`），先解析再创建，重启后不会重复创建。`agent/created` 是串行事件，所以创建失败只记录不抛出，不拖垮 Partner 会话。真实运行暴露过一处缺陷：`inject` 漏了 `tools`，Cordis 拒绝未声明读取，整个 Secretary preset 挂载失败；已在 `5c1bab6` 修掉。

**落点**：secretary.js

**提交**：`1a61f41`、`5c1bab6`
