# dsh-superagent-wish

A DeepSeek Harness bundle that registers the **总控** (super-agent) preset for wish's personal AI workflow.

When the 总控 preset is selected in a session, the agent receives the full collaboration protocol as part of its system prompt:

- **Topic anchoring** — restates the session topic at the start and after any tangent.
- **Layered requirement building** — merges every addition into one shared requirement model, marking each item as stated or inferred.
- **Human-owned decisions** — assembles authoritative sources, current state, requirements, and options before presenting them; gives opinions only when asked.
- **Confirm then dispatch** — always confirms before handing off a task; only reports blockers during execution.
- **Worker dispatch by thinking mode** — divergent exploration uses `subagent_fork` (discoverer); confirmed direction uses `subagent` with a full task spec (implementer).

## Installation

```sh
# Clone and link into the desktop profile
git clone https://github.com/wish2333/dsh-superagent-wish
cd dsh-superagent-wish
dsh plugin --profile desktop add "link:$PWD"
```

Or install with `plugin_manager install_bundle` from inside a DSH session, pointing at the cloned directory.

After installation, select the **总控** preset when starting a new session.

## Requirements

- DeepSeek Harness with the `agentPresets` and `systemPrompt` Host services (shipped with `@deepseek-ai/dsh-base`).
- The following files must exist on the host machine (they are not bundled here):
  - `~/AI/docs/interaction-spec.md`
  - `~/AI/docs/composition-spec.md`
  - `~/AI/docs/dispatch-guide.md`
  - `~/AI/docs/superagent-impl.md`
  - `~/AI/workspace/tickets/README.md`

## Repository layout

```
.
├── index.js            Host plugin (two roles: manager + instructions)
├── cordis.patch.yml    Bundle patch — inserts the manager entry
├── locale/
│   ├── en.json         Plugin metadata (English)
│   └── zh.json         Plugin metadata (Chinese)
├── icon.svg            Hub-and-spoke icon representing worker coordination
└── package.json
```

## License

MIT
