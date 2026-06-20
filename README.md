# Find My Agent

A real-time, spatial **"Find My"-style live map for parallel Claude Code agents**.
Instead of a log timeline, the **codebase itself is the map**: the file tree is
rendered as territory (a treemap of directories and files), and each agent — and
each of its subagents — is an animated dot that moves to whatever file it's
currently touching. See each agent's task, current tool, elapsed time, and
(stubbed for now) token/cost in real time.

![status](https://img.shields.io/badge/status-v1-blue)

> **Working on this codebase (new session / different agent)?** Read
> [context.md](context.md) first — it's the handoff doc with architecture,
> gotchas, open questions, and a Codex-migration note. Keep it updated.

```
 ┌──────────────────────────────┬───────────────┐
 │  server/                     │  AGENTS  2    │
 │   ┌──────┬──────┐  ●demo-ses │ ● agent  ●●●  │
 │   │store │index │            │   Refactor…   │
 │   ├──────┴──────┤            │ ● Explore     │
 │  client/  shared/ ●Explore   │   Explore…    │
 └──────────────────────────────┴───────────────┘
        the repo as a map            live agent list
```

## How it works

```
 Claude Code  ──HTTP hooks──▶  Collector (Bun)  ──WebSocket──▶  React map
 (PreToolUse,                  POST /events                     treemap + dots
  PostToolUse,                 in-memory store
  Subagent*, …)                normalize → AgentState
```

- **`server/`** — a Bun HTTP + WebSocket collector. Receives raw Claude Code hook
  payloads on `POST /events`, normalizes them into `AgentState`, keeps everything
  in memory (no DB in v1), and broadcasts updates to the frontend.
- **`client/`** — a React + d3 single-page app. Renders the repo as a treemap and
  animates a dot per agent. Subagents are nested under / shaded from their parent.
- **`hooks/`** — a ready-to-merge `.claude/settings.json` snippet (native
  `type: "http"` hooks) plus an installer that merges it into any target repo.
- **`demo/`** — a simulator that fires fake-but-realistic hook events so you can
  watch the map move **without a live agent**.
- **`shared/`** — the `AgentState` / event data model and shared config.

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.3 (`curl -fsSL https://bun.sh/install | bash`)

## Quickest start (the `fma` CLI)

The collector serves the dashboard itself, so the whole app is **one link**:
`http://localhost:4000`.

```bash
# one-time setup
bun install
bun link          # exposes the global `fma` command (needs ~/.bun/bin on PATH)
fma install       # adds HTTP hooks to ~/.claude/settings.json (global, once)

# every coding session — run inside the repo you're working in:
cd ~/your-project && fma
```

`fma` builds the UI if needed, starts the collector mapping the current repo,
and opens the dashboard. Keep the tab open on the side; Ctrl-C to stop. With the
global hooks installed, **every** Claude Code session reports automatically (and
when the collector isn't running the hooks fail instantly — no slowdown).

Flags/commands: `fma --port N`, `fma --no-open`, `fma watch [path]`,
`fma install --project [path]`, `fma uninstall [--project path]`, `fma help`.

> On zsh, make sure `~/.bun/bin` is on your PATH (Bun's installer only writes
> `~/.bash_profile`): `echo 'export PATH="$HOME/.bun/bin:$PATH"' >> ~/.zshrc`.

## Install (manual / dev)

```bash
bun install
```

## Quick start (fake events — see the map move first)

Open **three terminals** from the repo root:

```bash
# 1. collector (maps THIS repo's file tree by default)
bun run server

# 2. frontend  → http://localhost:5173
bun run client

# 3. fire a scripted sequence of fake agent events
bun run demo
```

Watch the dots: a main agent reads/edits files under `server/`, spawns an
`Explore` subagent that roams `client/`, then both stop. Hover any dot for its
task/tool/file/tokens; the right-hand list shows live status badges.

> Token/cost values are **stubbed** (flagged `stub` in the UI). See
> [Token / cost](#token--cost-stubbed-for-now) below.

## Wire up real Claude Code agents

The data source is Claude Code's **real, documented hook system** — specifically
native HTTP hooks (`{"type":"http","url":…,"timeout":5}`), which POST the exact
JSON a command hook would receive on stdin. No forwarder script needed.

### 1. Install the hooks into a target repo

```bash
# merges into <target-repo>/.claude/settings.json (preserves existing hooks)
bun run hooks:install -- /path/to/your/project

# custom port:
bun run hooks:install -- /path/to/your/project --port 4100

# just print the snippet without writing anything:
bun run hooks:install -- --print
```

Or paste [`hooks/settings.snippet.json`](hooks/settings.snippet.json) into the
repo's `.claude/settings.json` by hand. It registers HTTP hooks for
`SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
`SubagentStart`, `SubagentStop`, and `Stop`.

### 2. Start the collector pointed at that repo

The collector draws the map from `TARGET_REPO` (defaults to its own cwd):

```bash
TARGET_REPO=/path/to/your/project bun run server
```

### 3. Run Claude Code in that repo

```bash
cd /path/to/your/project
claude
```

Hooks fire as the agent works; a live dot appears and moves across the map.

> **The map is live.** The collector re-scans the repo as the session runs, so
> the treemap **expands when Claude creates files and contracts when it deletes
> them**, and a dot lands on a file the moment it's written. Edits, renames, and
> Bash-created files are all reflected (debounced re-scan, ~1s).

> **Non-blocking:** there is no `async` hook field. We achieve non-blocking by a
> short `timeout` and the collector replying `200 {}` instantly, so hooks never
> stall the agent.

> **Confirming the real payload schema.** The collector logs every raw hook
> payload (`[event] …`). Run a real session — especially one that spawns a Task
> subagent — and inspect those logs to confirm the actual subagent-id field, then
> trim the `SUBAGENT_ID_FIELDS` probe list in
> [server/src/normalize.ts](server/src/normalize.ts). v1 ships a defensive guess
> rather than inventing the schema.

### 4. Two agents in parallel (multiple dots) via git worktrees

Run two agents against the same project from separate worktrees:

```bash
cd /path/to/your/project
git worktree add ../proj-a -b agent-a
git worktree add ../proj-b -b agent-b

# install hooks into each worktree
bun run hooks:install -- ../proj-a
bun run hooks:install -- ../proj-b

# terminal A
cd ../proj-a && claude
# terminal B
cd ../proj-b && claude
```

Both sessions report to the same collector. Because file paths are normalized
relative to each agent's own `cwd`, both worktrees land on the **same** tree —
so you see two independent dots roaming one map.

## Token / cost (stubbed for now)

`AgentState` carries a `TokenUsage` field, and the UI renders it — but v1 values
are **placeholders** (`isStub: true`, shown with a `stub` chip). Claude Code emits
real usage natively via OpenTelemetry
(`CLAUDE_CODE_ENABLE_TELEMETRY=1`, metric `claude_code.token.usage`, broken down
by model/subagent). The plug-in point is the `TokenSource` interface in
[`server/src/tokens.ts`](server/src/tokens.ts) — implement an `OtelTokenSource`
and swap it for `StubTokenSource`. (See the `TODO: OTEL adapter` there.)

## A note on subagent identity

The docs confirm `SubagentStart` / `SubagentStop` exist and match on agent type,
but do **not** document an explicit subagent-id field on the payload. Rather than
guess, the collector:

- logs every raw payload (`console.log` in `POST /events`) for schema discovery,
- probes a few plausible id fields (`subagent_id`, `parent_session_id`, …) — see
  `SUBAGENT_ID_FIELDS` in [`server/src/normalize.ts`](server/src/normalize.ts),
- falls back to treating events as the main agent when no discriminator exists.

When you run a real Task subagent, check the collector's `[event]` logs to confirm
the actual field names, then trim that probe list. The demo uses assumed field
names purely to illustrate dot nesting.

## Project layout

```
find-my-agent/
  shared/      types.ts (AgentState model), config.ts (port, timing)
  server/      src/{index,store,normalize,tree,tokens,ws}.ts  — Bun collector
  client/      src/{App,TreeMap,AgentDot,AgentList,useCollector}.tsx — React map
  hooks/       settings.snippet.json + install.ts (merge CLI)
  demo/        simulate.ts (fake event generator)
```

## Configuration

| Env var          | Default      | Meaning                          |
| ---------------- | ------------ | -------------------------------- |
| `COLLECTOR_PORT` | `4000`       | Collector HTTP/WS port           |
| `TARGET_REPO`    | server cwd   | Repo whose tree becomes the map  |

If you change `COLLECTOR_PORT`, pass `--port` to `hooks:install` so the registered
hook URLs match.

## Endpoints

| Method | Path          | Purpose                                           |
| ------ | ------------- | ------------------------------------------------- |
| POST   | `/events`     | Hook intake (any JSON; replies `{}`)              |
| GET    | `/api/tree`   | Current file tree (`TreeNode`)                    |
| GET    | `/api/agents` | Snapshot of all `AgentState`                      |
| GET    | `/api/health` | Liveness + target repo + counts                  |
| WS     | `/ws`         | Live `snapshot` / `event` / `agentRemoved` stream |

## Constraints (v1)

TypeScript everywhere · in-memory store (no DB) · no auth · localhost only ·
uses only real, documented Claude Code hook behavior.
