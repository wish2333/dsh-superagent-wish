# 01: 工作单元与四张表

**What to build:** 一个活能被当作对象记录、查询和改变状态。工作单元有 id、类型、状态、标题、来源；输入排队，能记录是否送达、Worker 是否读入；派工能记录当前由哪个会话执行；授权记录范围和强度。状态转换全部在插件代码里，Partner 和 Secretary 只读。这一票没有可见行为，是后面所有票的地基。

**Blocked by:** None (can start immediately)

**Status:** resolved

- [ ] 四张表持久化在 `ctx.storageDomain` 打开的域里，插件重启后读得回
- [ ] 工作单元的状态转换可测：待启动 → 执行中 → 等你判断 / 等输入 → 已结束
- [ ] 报 `ready` 时，执行者的工作单元进入“等你判断”，启发者的直接结束
- [ ] 报 `dropped` 时直接结束，不产生待推送的消息
- [ ] 新的输入到达时，工作单元从“等你判断”回到“执行中”
- [ ] 中止只结束当前派工，工作单元状态不动
- [ ] 结束是终态；对已结束的工作单元追加输入会被拒绝
- [ ] 输入按顺序排队，未送达的输入在派工结束时退回队列
- [ ] 授权记录创建时的策略版本，供后面重新校验用

**Notes:** 状态机是纯代码，不碰 Host，测试直接喂转换、断言状态。字段照原型 `dsh-superagent` 的 `src/core/model.ts` 与 `src/core/tickets.ts`，按个人使用收窄。

---

## Answer

状态机是纯代码（`state.js`，不 import 任何 Host 模块），转换进、状态出，测试直接喂状态。四张表在 `ctx.storageDomain` 的 `working_units` 域里，`ctx.effect` 持有 `domain.close()`。`dropped` 直接结束、不推送；结束是终态，追问被拒；未读输入在派工结束时退回队首。

**落点**：state.js / schema.js / working-units.js

**提交**：`0464b14`、`9fcaf27`
