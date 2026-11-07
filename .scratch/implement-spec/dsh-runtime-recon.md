# DSH runtime headless recon (0.2.2-rc.1, macOS arm64)

Read-only recon on 2026-11-07. All claims cite `path:line`. Path abbreviations:

- `APP` = `/Applications/DeepSeek Harness.app/Contents/Resources`
- `RT` = `/tmp/asarx/out/dsh` (extracted `app.asar/dsh`, same files as `APP/app.asar/dsh`)
- `NM` = `RT/node_modules/@deepseek-ai`

## TL;DR

Two installations exist on this machine. They are not equivalent:

| | app-bundled runtime | PATH install |
|---|---|---|
| version | `0.2.2-rc.1` (`RT/package.json:4`) | **0.2.1-rc.3** (`/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/package.json`) |
| has `dsh-headless`, `dsh-desktop-host` | yes | `dsh-headless` yes, **`dsh-desktop-host` no** |
| rejects `--profile desktop` | yes (`RT/node_modules/@deepseek-ai/dsh/lib/bin.js:35-37, 112`) | yes (same code, `bin.js:36`) |
| node | Electron 44.7.0 → node `24.21.0` | `/opt/homebrew/bin/node` `v26.13.0` |

Use the **app-bundled** runtime for everything below. Otherwise the plugin loads against a different `@deepseek-ai/dsh-base` than the Desktop app uses, and `--profile desktop` is rejected.

Verified end to end: a headless one-shot agent run through the local magpie LLM gateway returned `PONG` from the model (commands in §5).

## 1. Exact command line

### 1.1 Entry points

- `bin` of `@deepseek-ai/dsh`: `"dsh": "lib/bin.js"` (`RT/node_modules/@deepseek-ai/dsh/package.json`, `bin`).
- Shipped launcher script (runs the CLI **inside** `app.asar`, so the asar and the unpacked runtime share one module tree):
  `APP/runtime/cli/bin/dsh:16` →
  `ELECTRON_RUN_AS_NODE=1 exec "$resources/../MacOS/DeepSeek Harness" --expose-internals "$resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js" "$@"`
- Desktop-host CLI wrapper: `RT/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js:106-118` calls `runCli({ manageDesktopProfile: true, packageManager })`. That flag is the only way to pass `--profile desktop` (`bin.js:98, 112, 119`).
- `APP/runtime/bin/node` is **not** a node binary: it is a 3-line shim that needs `DSH_DESKTOP_NODE_EXECUTABLE` and `ELECTRON_RUN_AS_NODE=1` (`APP/runtime/bin/node:1-3`). Plain `node` is fine; the Electron binary works as node too: `ELECTRON_RUN_AS_NODE=1 "$APP/../MacOS/DeepSeek Harness" -e 'console.log(process.versions.node)'` → `24.21.0`.

**Recommended invocation (headless, scratch home, bundled runtime):**

```sh
RT=/tmp/asarx/out/dsh/node_modules/@deepseek-ai
export DSH_HOME=/tmp/dsh-scratch          # must be set in the launching process, not in .env
export MAGPIE_GATEWAY_KEY="$(sed -n 's/^MAGPIE_GATEWAY_KEY=//p' ~/.dsh/.env)"   # or pass explicitly

node "$RT/dsh/lib/bin.js" --profile headless --patch /tmp/magpie-overlay.yml "your task"
```

Same thing through the shipped launcher, which is preferred because it resolves inside `app.asar` and gives the real production module layout:

```sh
DSH_HOME=/tmp/dsh-scratch MAGPIE_GATEWAY_KEY=... \
  "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  --profile headless --patch /tmp/magpie-overlay.yml "your task"
```

(The `link-entry` Mach-O next to it, `APP/runtime/cli/link-entry`, is the CLI's own binary; I did not run it. `UNKNOWN` whether it differs from `bin/dsh`.)

### 1.2 Launcher flags (`bin.js:101-137`)

| Flag | Meaning | Evidence |
|---|---|---|
| `dsh <name>` | abbreviation of `--profile <name>` | `bin.js:129` |
| `--profile <name>` | profile under `$DSH_HOME/profiles` | `bin.js:105` |
| `--patch <path>` | repeatable overlay applied after the profile layer | `bin.js:105, 30` |
| `--from-default-profile <name>` | recreate a custom profile from a shipped template | `bin.js:105` |
| `--dump-config` / `--dump-default-config` / `--dump-config-schema` | print composed tree / bundles-only tree / JSON schema | `bin.js:105, 63-91` |
| `-V, --version` | version | `bin.js:105` |
| everything after the first unknown token | passed verbatim to the booted app (`ctx.cmdlineArgs`) | `bin.js:13-20, 308-312` in `profile-boot-e2mS45fC.js` |
| `plugin --profile <name> <pnpm args>` | forwards to pnpm in the profile dir | `bin.js:115-127` |

Shipped profile templates (`NM/dsh-official-bundles/lib/index.js:4-10`): `acp`, `web`, `headless`, `sdk`, `sdk-minimal`. Any other name is initialized by `dsh plugin --profile <name> add <pkg>` with bundles `["@deepseek-ai/dsh-base"]` (`dsh-official-bundles/lib/index.js:23`).

`dsh --help` works today: `/opt/homebrew/bin/dsh --help` prints exactly this flag set (exit 2 = commander help exit).

### 1.3 Headless app flags (`-N/dsh-headless/lib/startup.js:35-58`)

`--json`, `--session-id <id>`, `--permission-mode <preset>`, `--approval-policy <policy>` (`choices: APPROVAL_POLICIES`), `--add-dir <path>` (repeatable), `[task...]` (`-` reads stdin).

## 2. Environment variables

| Name | Effect | Evidence |
|---|---|---|
| `DSH_HOME` | sole config+state root; precedence explicit arg > `DSH_HOME` > `~/.dsh`; blank = unset | `NM/dsh-home-paths/lib/index.js:15, 83-86, 109-111` |
| `DSH_AGENTS_HOME` | shared agent root; default `~/.agents` | `NM/dsh-home-paths/lib/index.js:21, 124-126` |
| `DSH_TELEMETRY_DISABLED` | any non-empty value disables telemetry row | `NM/dsh-app-boot/lib/index.js:1886-1892`; read at `profile-boot-e2mS45fC.js:301` |
| `DSH_PERMISSION_MODE` | headless sandbox mode, default `workspace-write` | `NM/dsh-headless/cordis.patch.yml:41-42` |
| `DSH_LAUNCH_ENVIRONMENT_KEY` | launch-env snapshot service key (constant) | `profile-boot-e2mS45fC.js:8, 306` |
| `DEEPSEEK_API_KEY` | credential ref the `dsh-base` deepseek route needs | `NM/dsh-credentials-local/lib/index.js:13-18`; error text in §5 |
| `MAGPIE_GATEWAY_KEY` | credential ref for the `magpie` provider | `~/.dsh/profiles/desktop/cordis.patch.yml:29` |

There is **no** `DSH_PROFILE`, `DSH_STATE`, or `DSH_CONFIG` variable, and no port variable. The profile is a flag. State lives under `DSH_HOME` (`profiles/`, `storages/`, `sessions/`, `logs/`, `.credentials.yaml`, `cache/`). Every `process.env` read in `bin.js`/`profile-boot` is the list above, plus `process.env[name]` writes done by `.env` loading (`dsh-app-boot/lib/index.js:4486-4498`).

**`.env` layering** (`dsh-app-boot/lib/index.js:4486-4498`): inherited env > `$PWD/.env` > `$DSH_HOME/.env`; inherited values are never overwritten. `DSH_*` and XDG/DYLD/BASH_FUNC prefixes are **refused** in any `.env` (throw), except `HTTP(S)_PROXY`/`NO_PROXY`/`ALL_PROXY` in `$DSH_HOME/.env` (`dsh-app-boot/lib/index.js:4355-4425`). Practical consequence: put `DSH_HOME=...` on the command line, not in a `.env`.

## 3. Minimum profile layout

```
$DSH_HOME/
  cordis.patch.yml          # optional home-wide user layer, outranks profile layer
  .credentials.yaml         # optional (web/desktop); format "version: 1" + "refs:"
  .env                      # optional
  profiles/<name>/
    package.json            # REQUIRED: dsh.profile.bundles + dependencies
    cordis.patch.yml        # optional user layer (loaded if present)
    cordis.yml              # written by the launcher on every boot ([] content)
    node_modules/<pkg>      # needed only for out-of-tree bundles
```

- `package.json` must exist or the profile is initialized from a shipped template, or it errors (`dsh-app-boot/lib/index.js:1846-1852`). Shape: `{ "name", "private", "dependencies", "dsh": { "profile": { "bundles": [...] } } }` (`dsh-app-boot/lib/index.js:1386-1401`; live example `~/.dsh/profiles/desktop/package.json`).
- `cordis.yml` is optional input: `prepareProfile` **rewrites** it to `[]` on every boot (`profile-boot-e2mS45fC.js:121-126, 217-222`). It exists only to anchor the Loader `baseUrl` at the profile dir.
- `node_modules` is needed only for bundles that are not part of the installation. `pnpm-workspace.yaml` is created by `initProfile` for `dsh plugin` use (`dsh-app-boot/lib/index.js:1373-1378, 1400-1401`); it is not required for boot.

**Bundle resolution order** (`dsh-app-boot/lib/index.js:1341-1349, 1755-1780`): for each name, look up `createRequire(installAnchor).resolve.paths(name)` first, i.e. **the dsh installation** (`<app>.asar/dsh/node_modules`), then `<profile>/node_modules`. So `@deepseek-ai/*` always comes from the installation; a plugin like `@wish2333/dsh-superagent-wish` resolves from the profile only. pnpm's symlink layout is followed (`existsSync`, and the `link:` symlink in `~/.dsh/profiles/desktop/node_modules/@wish2333/dsh-superagent-wish` → the repo).

At runtime, `PluginPackages` installs a module-resolution interception (`dsh-app-boot/lib/index.js:4242-4255`) and adds **linked roots** (symlinks pointing outside `profiles/`) to the resolvable set (`dsh-app-boot/lib/index.js:1439-1460, 1554`). So the plugin's own bare imports resolve through the symlinked repo, and the repo needs no `node_modules` of its own (its `"type": "module"` + root `exports` are enough).

Bundle manifest contract: the package must declare `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` (`dsh-app-boot/lib/index.js:1306-1312, 1803-1809`). The repo satisfies this (`dsh-superagent-wish/package.json`, `dsh.bundle.patch`). A broken or incompatible bundle is **skipped with a warning**, not fatal (`dsh-app-boot/lib/index.js:1800-1821, 5216-5226`); check stderr for `skipping profile bundle`.

## 4. LLM providers and credentials

Profile `~/.dsh/profiles/desktop/cordis.patch.yml`: one LLM row, `llm-pi-ai`, provider id **`magpie`**:

- `apiKeyEnv: MAGPIE_GATEWAY_KEY`, `api: openai-completions`, `baseURL: http://127.0.0.1:3425/v1` (`cordis.patch.yml:23-31`)
- models: `auto/glm-5.3-flash`, `deepseek/deepseek-flash`, `deepseek/deepseek-v4-pro`, `zhipu/glm-5.3*`, `popgo-fuli/gpt-6.1-sol`, `popgo-cn/*`, `popgo-claude/*` (`:33-174`)
- default model: `provider: magpie`, `model: deepseek/deepseek-flash` (`:181-185`)

Credential availability:

- `~/.dsh/.env` contains key `MAGPIE_GATEWAY_KEY` (only key).
- `~/.dsh/.credentials.yaml` has `records` and `refs` entries for `DEEPSEEK_API_KEY` and `MAGPIE_GATEWAY_KEY` (key names only; values not printed).
- Gateway: `lsof -nP -iTCP:3425` → `magpie` PID 96370 `LISTEN` on `127.0.0.1:3425`; `curl http://127.0.0.1:3425/` → 200. The Desktop app (PID 2602) has established connections to it.

Resolution **differs by profile**: `dsh-headless/cordis.patch.yml:49-53` disables the `credentials` row, so in a headless run `apiKeyEnv` is read only from the launch environment or `.env` (`NM/dsh-llm-pi-ai/lib/index.js:2228-2234`). A value present only in `.credentials.yaml` is invisible to `--profile headless`. Export the key, or put it in `$DSH_HOME/.env`.

`dsh-base` alone wires only the DeepSeek routes (`llm-deepseek*`), with no pi-ai provider row (`/tmp/dump-wishtest.txt:51-52, 76-77`). A fresh profile therefore fails with `MISSING_CREDENTIAL` for `deepseek-official` unless you overlay a provider.

## 5. Programmatic session create + prompt

Four paths exist.

**(a) Headless one-shot (verified).** `dsh --profile headless "<task>"` creates a Session, runs one turn, prints the final text, and exits (`NM/dsh-headless/cordis.patch.yml:1-8`; runner `NM/dsh-headless/lib/index.js:301-345`). It has `session-persistence-jsonl` and `session-query-sqlite`, so `--session-id` can adopt and resume (`/tmp/dump-headless.txt:85-92`).

Verified recipe (scratch home `/tmp/dsh-recon-probe`, magpie overlay, key exported):

```sh
RT=/tmp/asarx/out/dsh/node_modules/@deepseek-ai
cat > /tmp/magpie-overlay.yml <<'YAML'
- id: llm-pi-ai
  config:
    providers:
      magpie:
        displayName: Magpie
        apiKeyEnv: MAGPIE_GATEWAY_KEY
        api: openai-completions
        baseURL: http://127.0.0.1:3425/v1
        models:
          - id: deepseek/deepseek-flash
            name: DeepSeek-V4.1-Flash
            contextWindow: 1048576
            maxTokens: 393216
            input: [text, image]
- id: agent-default-model
  config:
    provider: magpie
    model: deepseek/deepseek-flash
YAML

DSH_HOME=/tmp/dsh-recon-probe \
MAGPIE_GATEWAY_KEY="$(sed -n 's/^MAGPIE_GATEWAY_KEY=//p' ~/.dsh/.env)" \
node "$RT/dsh/lib/bin.js" --profile headless --patch /tmp/magpie-overlay.yml "Reply with exactly: PONG"
# stdout: PONG      stderr: reasoning stream      exit 0
```

With `--json` the stdout stream is NDJSON: `{"type":"session","sessionId":"session-…","cwd":…}`, `status`, `turn_end`, `final` (`NM/dsh-headless/lib/index.js:349-356`; observed in `/tmp/probe-headless.out`).

**(b) SDK JSON-RPC over stdio.** `dsh --profile sdk` (`bundles: ["@deepseek-ai/dsh-base","@deepseek-ai/dsh-sdk-app"]`, `dsh-official-bundles/lib/index.js:8`). Newline-delimited JSON-RPC methods (`NM/dsh-sdk-jsonrpc-server/lib/index.js:713-743`): `initialize`, `session/prompt`, `session/query`, `session/resume`, `session/wait`, `session/working-directory/get|set`, `shutdown`. Notifications: `session.event`, `session.status`, `session.query.completed`. The client side lives in `NM/dsh-sdk-protocol/lib/index.js:191-199`.

**(c) Web HTTP API (`--profile web`).** `--host <ip> --port <n> --no-open --public-url --trusted-host --tls-cert --tls-key` (`NM/dsh-web-app/lib/startup.js:25-31`). The transport is a plain **HTTP POST** RPC on the path `/api`, not a WebSocket: `rpcFetchHandler` requires `POST`, `content-type: application/json`, and maps the URL pathname to the Remote endpoint (`NM/dsh-client-connection/lib/index.js:873-900`). Remote endpoints are typert `"<namespace>/<method>"` names; the session namespace is `session` (`NM/dsh-api-session-controller/lib/index.js:3791`) with methods `list`, `search`, `create`, `selectModel`, `modelCatalog`, `rename`, `fork`, `prompt`, `cancel`, `events`, `state`, `wait`, `projections` (`:3416-3470`). Requests are fenced: an unauthenticated `GET /api` on the live GUI returns 401 `unauthorized` (`dsh-client-connection/lib/index.js:862-866`; observed on `127.0.0.1:54801`). `UNKNOWN`: the exact browser-trust token/header a headless client must present, and the exact JSON envelope of `/api/<endpoint>`.

**(d) ACP.** Shipped `acp` template: `["@deepseek-ai/dsh-base","@deepseek-ai/dsh-acp-app"]` (`dsh-official-bundles/lib/index.js:5`), packages `NM/dsh-acp`, `NM/dsh-acp-app`. `UNKNOWN`: whether the acp app has its own CLI flags beyond the launcher's passthrough.

For validating the plugin's **real dispatch path** (it needs `sessionController`, `workspaceRegistry`, `agents`, `workingDirectory` per the repo README), the headless profile has **no Host/HTTP layer**, so `sessionController` and the API controllers are absent. Use `--profile web` (or the desktop-host path) for that; use headless only as a "does the preset mount and does one turn work" smoke test.

Session storage on disk (verified): `$DSH_HOME/sessions/<cwd-with-slashes-as-dashes>/<session-id>/session.v4.jsonl.zstd`, plus `session.lock`. Example from the probe:
`/tmp/dsh-recon-probe/sessions/--Users-huangmiaosen-AI-repos-dsh-superagent-wish--/session-*/session.v4.jsonl.zstd`.

Also verified: neither `dsh-base` alone (`/tmp/dump-wishtest.txt`) nor the headless tree (`/tmp/dump-headless.txt`) contains an `agent-presets` row. The only "preset" row is `@deepseek-ai/dsh-permission-presets` (lines 153/165). The plugin's `inject = ['agentPresets']` (`dsh-superagent-wish/index.js:8`) therefore leaves the manager inactive (warned, not fatal) in a base-only profile, and it works only in a profile whose patch adds `@deepseek-ai/dsh-agent-preset-registry` (as `~/.dsh/profiles/desktop/cordis.patch.yml:176-180` does).

## 6. What the Desktop app passes

- Profile: **`desktop`**, hard-coded (`NM/dsh-desktop-host/lib/index.js:441`), with `args: ["--no-open","--host","127.0.0.1","--port","0"]` (`:447-454`).
- Path: `resolveDesktopPaths(dshHome = resolveDshHome())` → `profile: join(dshHome,"profiles","desktop")` (`/tmp/asarx/out/lib/main.js:1783-1787`). `DSH_HOME` therefore defaults to `~/.dsh` and is inherited unchanged.
- Spawn: `main.js:9977-9989` runs `node --expose-internals app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js <runtimeDir> <projectDir> <primaryRuntime> [pnpm] [nodeBin]`, `cwd = projectDir` (the desktop profile), `env = desktopNodeEnvironment(...)` (`main.js:9744-9753`), i.e. **the full Electron process env is inherited** (`DSH_*`/`ELECTRON_*` are launcher-owned, not scrubbed: `main.js:17239-17240`).
- Inside, it calls `loadProfileDirectory("dsh", projectDir, installAnchor)` then `runProfile({ profile:"desktop", resolvedProfile, patchFiles: [] })` (`NM/dsh-desktop-host/lib/index.js:439-455`). `installAnchor` = `<runtimeDir>/node_modules/@deepseek-ai/dsh/package.json` (`:438`).
- `RT/dsh/desktop-runtime.json` is a release descriptor (platform, arch, `sharedPackages`, a full `files[]` with sha256). It is read only for release version and integrity checks (`main.js:1807-1830`). It holds no profile or home paths.
- The direct equivalent of the Desktop boot, usable headlessly against a scratch home (needs an ipc parent for `ready`; `process.connected` is optional at `:428-433`):

```sh
R="/Applications/DeepSeek Harness.app/Contents/Resources"
DSH_HOME=/tmp/dsh-scratch ELECTRON_RUN_AS_NODE=1 "$R/../MacOS/DeepSeek Harness" --expose-internals \
  "$R/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js" \
  "$R/app.asar/dsh" "$DSH_HOME/profiles/mycopy" "$R/runtime/primary-runtime"
```
`UNKNOWN`: exact readiness/shutdown IPC contract for driving this unattended. Use `--profile web` instead unless the desktop-specific host is required.

## 7. Copying the Desktop profile to a scratch home

`~/.dsh/profiles/desktop/package.json` already lists the plugin: `bundles = ["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","@wish2333/dsh-superagent-wish"]` and `dependencies: { "@wish2333/dsh-superagent-wish": "link:/Users/huangmiaosen/AI/repos/dsh-superagent-wish" }`.

```sh
SCRATCH=/tmp/dsh-scratch
mkdir -p "$SCRATCH/profiles"
cp -R ~/.dsh/profiles/desktop "$SCRATCH/profiles/wish-web"   # drop a stale "lock" file if present
cp ~/.dsh/profiles/desktop/cordis.patch.yml "$SCRATCH/profiles/wish-web/cordis.patch.yml"
sed -i '' 's/"name": "dsh-profile-desktop"/"name": "dsh-profile-wish-web"/' "$SCRATCH/profiles/wish-web/package.json"
node /tmp/asarx/out/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js \
  --profile wish-web --dump-config | grep -n superagent-wish     # expect: - id: superagent-wish-manager
```

The `link:` dependency is absolute, so it keeps working in the scratch home. Do not name the copy `desktop`: the launcher refuses that name (`bin.js:35-37`).

## 8. Side effects to expect (important for a "read-only" claim)

Booting **any** profile, including `--dump-config` and `--dump-default-config`, writes into `$DSH_HOME`:

- rewrites `<profile>/cordis.yml` (`profile-boot-e2mS45fC.js:221`);
- creates `$DSH_HOME/profiles/<name>/` from a shipped template when it is missing (`dsh-app-boot/lib/index.js:1846-1852`);
- rewrites `package.json` if it lists a retired bundle (`dsh-app-boot/lib/index.js:1740-1746`);
- on startup failure writes `$DSH_HOME/logs/startup-*.log` (`bin.js:178-193`).

My probes against `$PWD/.scratch/dsh-home` created `.scratch/dsh-home/profiles/headless/` (4 files) and rewrote `.scratch/dsh-home/profiles/wish-test/cordis.yml` (same `[]` content). `.scratch/` is gitignored (`.gitignore:4`) and `git status --porcelain` is clean. The headless probes used `/tmp/dsh-recon-probe`; `/tmp/dsh-recon-overlay.yml` holds the overlay shown in §5.

`~/.dsh` was **not** modified: `~/.dsh/profiles/desktop` mtimes are unchanged (newest `cordis.patch.yml` 19:47, before this session), and `~/.dsh/logs` does not exist. **Always point `DSH_HOME` at a throwaway dir** (e.g. `/tmp/dsh-scratch`), never at `~/.dsh`.

## 9. UNKNOWN items

- Exact browser-trust authorization for `POST /api/session.create` (token source, header name, envelope).
- Whether electron-updater or other Desktop-only rows need to be disabled in a copied profile for a long-lived `--profile wish-web` run (not tested).
- The `link-entry` CLI binary's behavior versus `runtime/cli/bin/dsh`.
- ACP app flags beyond launcher passthrough.
- Whether the plugin's presets are reachable in headless at all: no (no `agentPresets` row, see §5).
