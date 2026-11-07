Status: ready-for-agent
Seam: A（插件入口的 Host 边界，见「Testing Decisions」）

## Problem Statement

wish 在 DeepSeek Harness 里希望有一个只负责对话和派活的协作者 Partner，把执行交给独立的 Worker 会话。现在仓库只注册了 Partner 一个 preset，并向它注入协作模式提示词；Partner 没有任何派发能力，两个 Worker preset 不存在，Worker 的回报也没有回到 Partner 的通道。

由此产生的具体问题：

- Partner 提到「派启发者」「派执行者」时，没有可调用的工具，派发只能靠 wish 手动新建会话。
- 启发者和执行者没有注册，wish 无法在会话选择器里看到它们，也没有工具白名单来保证「启发者不写文件」。
- 即使手动起了 Worker 会话，它的结论也回不到 Partner 的上下文，R16「派出后持续汇报」和 R18「只汇报卡点」都没有落点。
- R17 的「原因＋影响＋选项」偏差汇报没有数据来源，因为 Worker 没有结构化的回报入口。

## Solution

Partner preset 增加一个 `partner_dispatch` 工具，调用它即按既定七步链路起 Worker 会话；两个 Worker preset 各带一个 `partner_report` 工具，Worker 用它提交状态和摘要，经队列以 `steer` 送进 Partner。Worker 一轮结束却没有回报时，插件补一条 `waiting` 回报，保证不静默。

wish 的体验是：在 Partner 会话里讨论清楚后，Partner 说「我准备做 X，因为 Y，同意吗？」，wish 同意后 Partner 调用 `partner_dispatch`，多出一个按任务标题命名的 Worker 会话；Worker 干活时 Partner 只在三种情况下打断 wish，其余时间不出现；Worker 结束时 Partner 带着整合后的结论回来，而不是把 Worker 的原始输出转贴过来。

## User Stories

1. As wish, I want Partner to have a `partner_dispatch` tool, so that it can start a worker session without me creating one by hand.
2. As wish, I want the dispatch tool to refuse when the worker type is unknown, so that a typo cannot create a session with the wrong preset.
3. As wish, I want a dispatcher worker session created with the `superagent-wish-discoverer` preset, so that exploratory work runs without write tools.
4. As wish, I want an implementer worker session created with the `superagent-wish-implementer` preset, so that delivery work runs with write tools.
5. As wish, I want each worker to get its own workspace directory, so that two workers cannot overwrite each other's files.
6. As wish, I want the worker session renamed to the task title, so that I can tell sessions apart in the session list.
7. As wish, I want the worker session's permission set to `danger-full-access`, so that the implementer can write inside its workspace without approval prompts.
8. As wish, I want the dispatched message to reach the worker as its first turn, so that the worker starts from the task spec or exploratory prompt rather than an empty context.
9. As wish, I want a dispatch to an undispatched task to reuse nothing and create exactly one worker session, so that repeated tool calls do not leave orphan sessions.
10. As wish, I want dispatch to be idempotent per dispatch request, so that a retry after a timeout does not create a second worker for the same task.
11. As wish, I want the dispatcher preset to be the only preset carrying `partner_dispatch`, so that a worker cannot start another worker.
12. As wish, I want the discoverer preset to carry `partner_report` but not `write`, `edit` or `bash`, so that exploration cannot change files.
13. As wish, I want the implementer preset to carry `partner_report` together with `write`, `edit` and `bash`, so that delivery can produce artifacts.
14. As wish, I want both worker presets to share the same read-only tool set, so that the difference between them stays exactly one whitelist row.
15. As wish, I want the worker to call `partner_report` with one of five states, so that the same abstract state always means the same thing.
16. As wish, I want a `progress` report not to reach me when I did not ask for it, so that routine execution stays quiet.
17. As wish, I want a `ready` report to reach me, so that I know the deliverable is complete.
18. As wish, I want a `blocked` report to reach me with a reason, an impact and options, so that a product decision stays with me.
19. As wish, I want a `failed` report to reach me, so that a worker dead end does not look like silence.
20. As wish, I want a `waiting` report to be synthesised when a worker's turn ends without a report, so that I learn the worker stopped working.
21. As wish, I want reports to arrive as a `steer` message into the Partner session, so that Partner is woken and processes them in the same turn.
22. As wish, I want a repeat of the same report not to reach Partner twice, so that a retried delivery does not read as two events.
23. As wish, I want Partner to keep the outcome and drop the process detail, so that its context stays organised around the conversation.
24. As wish, I want the partner session's prompt to mention both tools by name, so that Partner calls them instead of describing a dispatch it cannot perform.
25. As wish, I want the dispatch tool's confirmation to stay a behaviour rule, so that no session is created before I say yes.
26. As wish, I want a failed dispatch to return a readable error to Partner instead of throwing blindly, so that Partner can report the blocker.
27. As wish, I want the worker's preset list to appear when I start a session, so that I can inspect the worker without dispatching one.
28. As wish, I want the plugin to load with no worker-related Host service available, so that an old DSH profile does not break the partner preset.
29. As wish, I want the dispatch tool to report which preset it used, so that I can confirm a discoverer was not accidentally created as an implementer.
30. As wish, I want a test double of the Host boundary, so that a regression in any of the seven dispatch steps fails a test rather than surfacing during a real session.

## Implementation Decisions

**Preset registration.** The bundle patch keeps a single manager row, as today. That manager registers three presets through `ctx.agentPresets.register`: `superagent-wish-recruiter` (display name Partner), `superagent-wish-discoverer` (启发者), `superagent-wish-implementer` (执行者). Registration is already async and the current code stores the disposer in `ctx.effect`; the same handling extends to three definitions.

**Module split (ADR-0002).** Each preset's `plugins` row names a subpath of this package, not a relative path: the partner tool and prompt live in one submodule, each worker role in its own. The package `exports` and `files` gain those subpaths. A probe confirmed that DSH resolves a preset row by package scope, so `./x.js` is not an option and the subpath must be listed in `exports`.

**Tool ownership.** `partner_dispatch` belongs to the partner preset's plugin list only. `partner_report` belongs to both worker presets' plugin lists only. No preset carries both. Each tool is registered on its own preset's context (`ctx.tools.register`), so visibility follows the preset and a worker neither sees nor runs `partner_dispatch`; no runtime check of the calling session is needed.

**Worker whitelist.** The worker whitelist is expressed as a restriction on the worker preset's context, matching the tool names in the composition spec: `read`, `glob`, `grep`, `web_search`, `web_fetch`, `todo_write`, `partner_report`, plus `write`, `edit`, `bash` for the implementer. The allow-list form is preferred over a deny-list so a later Host tool does not leak into worker sessions by default.

**Dispatch chain.** `partner_dispatch` takes a worker type, a task title, and a task body (the task spec or the exploratory prompt as already-formatted text). It runs, in order: resolve the session, create a workspace directory, create the session with the workspace and the worker preset, resolve the session again to the live agent, set `danger-full-access`, rename to the task title, deliver the body with `followup`. The session identity is derived from the dispatch request so a retry targets the same session; a resolve hit reuses the existing session instead of creating a second one. Each of these six Host calls is a single named step so the ordering is testable.

**Report tool.** `partner_report` takes `state` (one of `progress`, `ready`, `blocked`, `failed`) and `summary`, and returns a short acknowledgement. It does not take a session id; the worker's own session is supplied by the tool context. The queue entry is keyed by the worker session and the report content so a retried call is a no-op.

**Report relay.** Reports are delivered into the partner session with `steer`, not `inject`, because Partner must be woken to process a report. `progress` reports are still delivered to the queue but marked internal so Partner is not woken for them; the four other states wake Partner. Relaying a report must not fail the worker's tool call: a delivery error is recorded and Partner is told on the next delivery attempt.

**Missing-report fallback.** The plugin listens for the agent status event. When a worker session becomes idle and no report was recorded for that turn, the plugin synthesises a `waiting` report with a fixed summary, unless the worker ended without ever having a turn. The synthesised report goes through the same relay path as a real one, so Partner sees one report shape.

**Duplicate delivery.** A report carries a stable identity derived from the worker session and report content. Before delivery the plugin checks whether that identity is already in the partner session's history or inbox, and skips the delivery if so. The same identity is used as the delivery request id.

**Session persistence dependency.** The duplicate check needs the session persistence service to read partner history after a restart. If that service is absent, the plugin falls back to an in-memory set and logs a single warning at load.

**Error surface.** Dispatch and report tools return structured results: a success result naming the worker preset and session, or an error result with a one-line reason. Host errors are translated, never rethrown raw into the model turn.

**Prompt text.** The partner prompt section gains two short lines: dispatch happens only through `partner_dispatch`, and a worker's report is the only thing about an execution Partner may relay. No other prompt text changes.

**Config.** The plugin keeps a single `role` config key extended with the two worker roles. No new user-facing configuration is added; workspace directory naming and model selection stay defaults.

**Version guard.** The current bundle already declares only `agentPresets` and `systemPrompt` in `inject`. The worker roles add `workspaceRegistry`, `sessionController`, `permissionPresets`, `agents` and `tools` to the declared inject list, but the partner role must not fail when those are unavailable: the worker services are requested lazily inside the dispatch path, and a missing service produces an error result rather than a load-time rejection.

## Testing Decisions

**What makes a good test.** Assert external behaviour only: the sequence and arguments of Host service calls, and the messages handed to the session delivery methods. Do not assert private helper names, internal map shapes, or the text of log lines.

**One seam.** All tests run through `apply(ctx, config)` with a fake `ctx` that records calls. The fake provides `agentPresets.register`, `systemPrompt.section`, `tools.register`, `workspaceRegistry.create`, `sessionController.{resolveAgent,create,rename}`, `permissionPresets.set`, `agents.get`, `sessionPersistence`, and an event emitter for `agent/status`. No test reaches into a module below the entry point. This keeps the number of seams at one, as agreed.

**Modules tested.** Only the plugin entry points. The manager entry and each role submodule are entered through `apply(ctx, config)`; role branching, preset definitions, tool registration and the dispatch and report behaviour are all observed from the recorded Host calls. A submodule is loaded by its package subpath, the same way a preset row loads it, so a broken `exports` entry fails a test.

**Prior art.** None in this repo: it has no test runner, no dev dependencies and no scripts. The nearest prior art is the sibling `dsh-superagent` prototype, which tests the same class of behaviour (session creation and delivery) with a fake Host context.

**Runner.** Tests use the built-in `node:test` runner with `node --test`, not an installed framework. Reason: this environment cannot write a package manager cache outside the repo, so no dependency can be installed. The consequence is no third-party assertion or mocking library; the fake Host context is a plain object that records calls. If the environment later allows installs, switching to the prototype's runner is a separate change.

**Cases that must be covered.**

- Registering three presets with the expected ids and display names; the partner preset is the only one whose plugin list leads to `partner_dispatch`.
- Every role of the worker whitelist: a discoverer registration excludes `write`, `edit` and `bash`; an implementer registration includes them; both include `partner_report`.
- Dispatch produces the six Host calls in order, with the worker preset id, the task title as the session name, and `danger-full-access`.
- Dispatch on a retry reuses an existing session and does not call session creation twice.
- Dispatch with an unknown worker type returns an error result and makes no Host call.
- A `blocked` report reaches the partner session as a `steer` delivery carrying the summary.
- A `progress` report does not wake the partner session.
- A worker turning idle with no report produces a `waiting` delivery to the partner session.
- A worker turning idle after having reported produces no extra delivery.
- The same report delivered twice results in one delivery.

## Out of Scope

- Watchdog behaviour for a worker that never reaches idle (open question Q4).
- The Memory layer, Hindsight or cross-session continuity (R21, R22).
- Folder watching and the file entry point (R23, R24).
- Ticket, Mandate, Assignment or subscription models from the prototype; this spec keeps the two-tool shape from ADR-0001.
- Per-directory write restrictions for the implementer; the whitelist is the boundary.
- Any user-facing configuration for workspace naming, model choice or retry policy.
- A real end-to-end test that boots DSH and creates a real worker session; that arrives after the first live dispatch works.
- UI changes beyond the three presets appearing in the picker.

## Further Notes

The three `ROLE_SECTION_TEXT` behaviour rules that the worker relies on (report the five states; report `blocked` rather than decide; never leave a turn without a report) need to be present in the worker prompts, not only in the guide. The current repo has no worker prompt text at all, so the implementer adds a section per worker role.

The composition spec and `composition.yaml` are the source of truth for the whitelist; a change to either must change the other and the corresponding test in the same change.

The `waiting` fallback duplicates a decision from the prototype and is the only mechanism keeping R18 honest when the model forgets to report. It is deliberately not a monitor over worker output.
