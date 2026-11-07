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

- DeepSeek Harness with the `agentPresets` and `systemPrompt` Host services.
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
├── index.js                    Host plugin (two roles: manager + instructions)
├── cordis.patch.yml            Bundle patch — inserts the manager entry
├── locale/
│   ├── en.json                 Plugin metadata (English)
│   └── zh.json                 Plugin metadata (Chinese)
├── icon.svg                    Hub-and-spoke icon representing worker coordination
├── docs/
│   ├── REQUIREMENTS.md         Numbered requirement list
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

The Partner preset and its system-prompt injection are implemented. Worker session creation is designed in `docs/impl/superagent-impl.md` and not implemented yet. Workers are separate DSH sessions created by Partner (R28); the dispatch chain follows the `dsh-superagent` prototype.

## License

MIT
