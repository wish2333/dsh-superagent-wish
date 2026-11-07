# dsh-superagent-wish

A DeepSeek Harness bundle that adds **Partner**, a super-agent preset for a personal AI workflow.

When the Partner preset is selected in a session, the agent receives the collaboration protocol as part of its system prompt:

- **Topic anchoring** — restates the session topic at the start and after any tangent, and keeps a balance between a result-driven and an exploratory discussion.
- **Layered requirement building** — merges every addition into one shared requirement model, marking each item as stated or inferred.
- **Human-owned decisions** — assembles authoritative sources, current state, requirements, and options before presenting them; gives opinions only when asked.
- **Confirm then dispatch** — always confirms before handing off a task; only reports blockers during execution.
- **Worker dispatch by thinking mode** — divergent exploration goes to a discoverer, a confirmed direction goes to an implementer. Each Worker is a separate DSH session with its own preset and working directory.
- **Sparse interruption** — only during execution. Deep discussion happens at other times.

## Requirements

- DeepSeek Harness with the `agentPresets`, `systemPrompt` and `tools` Host services.
- For Worker dispatch: the `sessionController`, `workspaceRegistry`, `permissionPresets`, and `agents` Host services. A Worker is a separate DSH session, not a subagent (R28).

## Installation

```sh
git clone https://github.com/wish2333/dsh-superagent-wish
cd dsh-superagent-wish
dsh plugin --profile desktop add "link:$PWD"
```

Or install with `plugin_manager install_bundle` from inside a DSH session, pointing at the cloned directory.

After installation, select the **Partner** preset when starting a new session.

## Repository layout

```
.
├── index.js                    Manager: registers the three presets
├── partner.js                  Partner preset: collaboration prompt + partner_dispatch
├── worker-discoverer.js        启发者 preset: read-only whitelist + partner_report
├── worker-implementer.js       执行者 preset: write tools + partner_report
├── worker-shared.js            Prompt rules both worker roles share
├── tools.js                    Tool definitions and worker-kind to preset map
├── report.js                   Worker-side report tool
├── report-channel.js           Host side: report relay and the waiting fallback
├── test/                       node:test suite against a fake Host context
├── cordis.patch.yml            Bundle patch — inserts the manager entry
├── locale/
│   ├── en.json                 Plugin metadata (English)
│   └── zh.json                 Plugin metadata (Chinese)
├── icon.svg                    Hub-and-spoke icon representing worker coordination
├── docs/
│   ├── REQUIREMENTS.md         Numbered requirement list
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

All three presets are registered and load without a diagnostic; each is mounted from its own submodule (ADR-0002) with its tool plugins listed as preset rows (ADR-0003). A dispatch creates a worker session and delivers its first message; two real dispatches have run end to end.

Known gaps:

- `partner_followup` is documented but not implemented, so a worker currently gets one message. See `docs/impl/superagent-impl.md` §3b.
- Reports are relayed with a `user` source, so they read as wish's own words. They should carry `agent-message`.
- No input queue, claim, or mandate: one Partner names one worker. The cost table is in `docs/impl/superagent-impl.md` §6.

`npm test` covers the Host boundary, the dispatch chain, and the relay.

## License

MIT
