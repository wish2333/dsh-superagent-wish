# dsh-superagent-wish

A DeepSeek Harness bundle that adds **Partner**, a super-agent preset for a personal AI workflow. Partner talks to wish and dispatches work; each piece of work is a **working unit** that keeps its own state, inputs and worker, so wish can keep talking to it instead of starting over.

When the Partner preset is selected in a session, the agent receives the collaboration protocol as part of its system prompt:

- **Topic anchoring** — restates the session topic at the start and after any tangent, and keeps a balance between a result-driven and an exploratory discussion.
- **Layered requirement building** — merges every addition into one shared requirement model, marking each item as stated or inferred.
- **Human-owned decisions** — assembles authoritative sources, current state, requirements, and options before presenting them; gives opinions only when asked.
- **Confirm then dispatch** — always confirms before handing off a task; only reports blockers during execution.
- **Worker dispatch by thinking mode** — divergent exploration goes to a discoverer, a confirmed direction goes to an implementer. Each Worker is a separate DSH session with its own preset and working directory.
- **Sparse interruption** — only during execution. Deep discussion happens at other times.

A **Secretary** session is created alongside each new Partner session. It judges whether an incoming file or scheduled event should become a working unit, and speaks only when wish must decide something.

## Requirements

- DeepSeek Harness with the `agentPresets`, `systemPrompt` and `tools` Host services.
- For dispatch: the `sessionController`, `workspaceRegistry`, `permissionPresets`, `agents` and `workingDirectory` Host services. A Worker is a separate DSH session, not a subagent (R28).
- For the working-unit tables: the `storageDomain` Host service. A Host without it leaves the Partner tools absent and the rest of the preset mounted.
- For the Secretary: an event-source configuration block and the `agent/created` event.

## Installation

```sh
git clone https://github.com/wish2333/dsh-superagent-wish
cd dsh-superagent-wish
dsh plugin --profile desktop add "link:$PWD"
```

Or install with `plugin_manager install_bundle` from inside a DSH session, pointing at the cloned directory.

After installation, select the **Partner** preset when starting a new session. The Worker and Secretary presets are not meant to be selected by hand.

## Repository layout

```
.
├── index.js                    Manager: registers the four presets
├── state.js                    Working unit state machine (pure)
├── schema.js                   Record schemas and the domain spec of the four tables
├── working-units.js            The four tables, opened over ctx.storageDomain
├── sessions.js                 Executor: the dispatch chain, delivery, stop, model choice
├── partner.js                  Partner preset: collaboration prompt + the four partner_* tools
├── secretary.js                Secretary preset: judges external events, one per Partner session
├── worker.js                   partner_report, shared by both Worker presets
├── worker-discoverer.js        启发者 preset: writes inside its own directory + partner_report
├── worker-implementer.js       执行者 preset: write tools + partner_report
├── test/                       node:test suite against a fake Host context
├── cordis.patch.yml            Bundle patch — inserts the manager entry
├── locale/
│   ├── en.json                 Plugin metadata (English)
│   └── zh.json                 Plugin metadata (Chinese)
├── icon.svg                    Hub-and-spoke icon representing worker coordination
├── docs/
│   ├── REQUIREMENTS.md         Numbered requirement list
│   ├── PROJECT-NEEDS.md        What the plugin is for, requirement by requirement
│   ├── design/
│   │   └── working-unit.md     The rewrite: roles, working-unit shape, tool surface
│   ├── adr/                    Decision records
│   ├── spec/
│   │   ├── framework.md        Four-layer framework
│   │   ├── interaction-spec.md Partner behavior spec
│   │   ├── composition-spec.md Worker types and tool boundaries
│   │   └── composition.yaml    Machine-readable Worker config
│   ├── guides/
│   │   └── dispatch-guide.md   Dispatch operations
│   └── impl/
│       ├── superagent-impl.md  Super-agent layer dispatch design
│       └── plugin-manifest.md  DSH Host services used
└── package.json
```

## Status

Four presets are registered; each is mounted from its own submodule (ADR-0002) with its tool plugins listed as preset rows (ADR-0003).

A dispatch starts a **working unit**: Partner gets its id, and every later tool names that id. The unit keeps one Worker session (`superagent-wish-<unit id>`) and one directory (`<Partner directory>/superagent-wish/<unit id>`) for its whole life, so a follow-up reaches the same Worker and a title change renames the session only. All five `partner_*` tools exist; see `docs/impl/superagent-impl.md` §3-bis for what each one does.

Current gaps:

- A Worker's `partner_report` is recorded on its unit, but nothing carries it to Partner yet and a turn that ends without a report gets no `waiting` report.
- Dispatch takes no concurrency slot, so the number of implementers running at once is not limited.
- No event source yet, so `partner_list` shows no judged external events.

`npm test` covers the Host boundary, the dispatch chain, the four Partner tools and the report tool.

## License

MIT
