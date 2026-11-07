# 05: 文件和定时进来先由 Secretary 判断

**What to build:** 放进指定目录的文件、到点的定时，都由 Secretary 判断要不要开成工作单元。判断的依据在设定时就定好，不靠触发时的临时决定。判掉的东西留一行记录，wish 或 Partner 查得到。不需要 wish 决定的，不打扰 wish。

**Blocked by:** 04

**Status:** resolved

- [ ] 文件入口是一个事件源，配置块里有目录清单、文件类型、每类默认处理
- [ ] 定时入口是一个事件源，配置块里有巡查周期
- [ ] 定时用 `ctx.schedule`，触发后结果落进表，不唤醒对话
- [ ] 判断规则以规则文本存在策略里，每次请求时注入 Secretary 的上下文
- [ ] 规则命中时开一个工作单元，来源记为该事件
- [ ] 规则不命中时判掉，并留一行记录：什么时候、什么事件、因为什么
- [ ] 判掉的记录 Partner 查得到
- [ ] 事件触发时没有 Partner 会话，事件照常记录，等下次有会话时 Secretary 看得到
- [ ] 已经处理过的文件不重复开活

**Notes:** 事件源配置照原型 `src/app/settings.ts` 的 `sources.<id> = { enabled, config }` 与 `src/policy.ts` 的 `rules`。本机已加载 `storage`、`storage-json`、`storage-domain` 和 `schedule`。

---

## Answer

文件入口与定时入口各有配置块，存在策略的 `sources.<id>` 里；判断规则每次请求时注入 Secretary 的上下文。判掉的事件留一行（时间、事件、理由），经 `partner_list` 读得到。已处理文件按路径、大小、mtime 去重，重启后仍不重复开活。定时用 `ctx.schedule`，目标是一个 Secretary 会话：Host 的任务必须绑定会话，到点必然写进该会话收件箱，所以它唤醒的是 Secretary 而不是 Partner 对话（见「与 spec 的偏差」）。

**落点**：sources.js / judge.js / secretary.js

**提交**：`6f3add0`、`2e12ffb`、`cef0af1`、`918873b`、`f36fc11`
