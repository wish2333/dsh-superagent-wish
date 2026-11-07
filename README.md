# dsh-superagent-wish

A DeepSeek Harness bundle that adds **Partner**, a super-agent preset for a personal AI workflow. Partner talks to wish and dispatches work; each piece of work is a **working unit** that keeps its own state, inputs and worker, so wish can keep talking to it instead of starting over.

When the Partner preset is selected in a session, the agent receives a prompt section
(`PARTNER_SECTION` in `partner.js`) that fixes the working-unit protocol:

- **Confirm then dispatch** — a unit is started only after wish agrees to the job.
- **Working units, not sessions** — Partner names a job by its working unit id, never by a
  session id; `partner_followup` continues the same unit, the same Worker session and the
  same directory.
- **Worker dispatch by thinking mode** — an open question goes to a discoverer, an agreed
  direction to an implementer.
- **Reports are Worker messages** — a report is read as "a Worker reported this", `ready`
  results are checked against what wish asked for, and a `blocked` or `failed` report is
  answered with cause, effect and options, without a recommendation unless asked.

The fuller collaboration behaviour — topic anchoring, layered requirement building,
human-owned decisions, sparse interruption — is specified in
`docs/spec/interaction-spec.md`; it is not part of the prompt today.

A **Secretary** session is created alongside each new Partner session. It judges whether an incoming file or scheduled event should become a working unit, and speaks only when wish must decide something.

## Requirements

- DeepSeek Harness with the `agentPresets`, `systemPrompt` and `tools` Host services.
- For the working-unit tables: `storageDomain`.
- For dispatch: `sessionController`, `workspaceRegistry`, `permissionPresets`, `agents` and
  `workingDirectory`. A Worker is a separate DSH session, not a subagent (R28).
- For the Secretary: `sessionController`, `agents` and the `agent-presets` registry events
  (`agent-preset/selected`, `agent/created`).
- For the schedule source: `schedule`. A Host without it reads no scheduled event and opens
  no patrol task; the file source and everything else still run.

A Host that lacks one of these leaves the tools that need it absent rather than failing the
preset.

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
├── index.js                    Manager: registers the five presets, starts the
│                               pollers and listeners that must outlive a preset
├── state.js                    Working unit state machine (pure, no Host access)
├── schema.js                   Record schemas and the domain spec of the tables
├── working-units.js            The tables, opened over ctx.storageDomain
├── sessions.js                 Executor: the dispatch chain, delivery, stop, model
├── partner.js                  Partner preset: prompt + the five partner_* tools
├── secretary.js                Secretary preset: prompt, judging tools, and the
│                               listener that starts one per Partner session
├── worker.js                   partner_report, shared by both Worker presets
├── worker-discoverer.js        启发者 preset
├── worker-implementer.js       执行者 preset
├── relay.js                    The one place a report becomes a message to Partner
├── policy.js                   Judging rules, event-source config, policy version
├── sources.js                  File source and schedule source
├── judge.js                    Wakes a Secretary for each waiting event
├── queue.js / pump.js / advance.js   Implementer slots and the dispatch queue
├── test/                       node:test suite against a fake Host (test/host-fake.js)
├── cordis.patch.yml            Bundle patch — inserts the manager entry
├── locale/                     Plugin metadata (en, zh)
├── icon.svg
├── docs/                       Design, implementation notes, ADRs, specs, guides
└── .scratch/                   Issue tracker: specs, tickets, implementation record
```

`docs/design/working-unit.md` §九 lists the placement rules that real runs enforced;
`.scratch/working-unit-rewrite/implementation-record.md` records every defect found by
running against a real Host, with the fix for each.

## Status

Five presets are registered; each mounts from its own submodule (ADR-0002) with its tool
plugins listed as preset rows (ADR-0003).

A dispatch starts a **working unit**: Partner gets its id, and every later tool names that
id instead of a Session. The unit keeps one Worker session (`superagent-wish-<unit id>`) and
one directory (`<Partner directory>/superagent-wish/<unit id>`) for its whole life, so a
follow-up reaches the same Worker and a title change renames the session only.

What runs today, all verified in a real DSH session:

- **Dispatch, follow up, stop, list.** `partner_followup` appends input to the same unit and
  the same Worker session; `partner_stop` ends the current round and keeps the unit and its
  directory; `partner_list` reports each unit's name, type, state, scope and last report.
- **Reports reach Partner.** A Worker's `partner_report` is relayed as a message whose source
  is `agent-message` with the sender's Session id, so Partner reads "a Worker reported this".
  `ready`, `blocked`, `failed` and questions are pushed; `progress` and `dropped` are not. A
  turn that ends without a report gets a `waiting` report.
- **A Secretary per Partner session.** It judges files dropped into watched directories and
  scheduled patrols, opens a working unit when a rule says so and records each dropped event
  with its reason.
- **Policy version and concurrency.** Each unit records the policy version it was opened
  under; implementer slots default to 2 and are configurable; a full queue waits instead of
  failing.
- **Tables survive a restart.** Units, inputs, assignments, mandates and events are stored
  over `ctx.storageDomain` and read back after a reload.

Not done on purpose:

- No directory-level write interception: `scope` is a behavioural limit, and a Worker that
  leaves it is expected to report `blocked`.
- Policy revalidation compares the whole policy version, so any rule change makes an older
  mandate fail to revalidate. Rule-level attribution is not implemented.
- `partner.js` is large and holds prompt, schemas, formatting and the tools; a split is
  recorded but not done.

`npm test` covers the plugin entry (presets, tools, dispatch chain, relay, event sources,
Secretary) and the pure state machine. Tests assert Host calls and arguments only.

## License

MIT
