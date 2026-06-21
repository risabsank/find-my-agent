# context.md — agent handoff for "CartoAI"

> Purpose: everything a coding agent (Claude, Codex, or otherwise) needs to
> resume work on this repo in a fresh session. Read this first. **Keep it
> updated** when you change architecture, add features, or learn a non-obvious
> fact. This file is provider-agnostic — nothing here assumes Claude Code.

Last updated: 2026-06-21.

> Note: `fma` is already `bun link`-ed globally on this machine (lands in
> `~/.bun/bin/fma`). To remove it: run `bun unlink` from the repo root.

## What this project is
A real-time, "Find My"-style dashboard that visualizes parallel Claude Code
agents working on a codebase. The **repo's file tree is the map** (a treemap:
directories are regions, files are cells), and each agent is a moving dot placed
on the file it's currently touching. A side panel shows per-agent task, tool,
territory, interventions, and diagnostics. Clicking an agent zooms the map to
its region and opens a detail panel.

Data source: Claude Code's real **hook system** (native `type:"http"` hooks) →
a local collector → WebSocket → React UI.

## Tech stack & runtime
- **TypeScript everywhere.** Monorepo with Bun workspaces.
- **Runtime: Bun** (v1.3.14). Server runs directly on Bun (`Bun.serve`, built-in
  WebSocket). Client is Vite + React 18 + `d3-hierarchy`.
- No database (in-memory store). No auth. localhost only. v1.
- **Bun is at `~/.bun/bin/bun`.** It was installed via the official script, which
  only added it to `~/.bash_profile`; the user's shell is **zsh**, so `bun` is
  NOT on PATH in a fresh zsh terminal. Either prefix `PATH="$HOME/.bun/bin:$PATH"`
  or the user adds it to `~/.zshrc`. (`node` v24 is available but the project
  targets Bun.)

## Easiest way to use it (the `fma` CLI) — single port, one link
The collector now **serves the UI itself**, so the whole app is one URL:
`http://localhost:4000`. There is no separate Vite server in normal use.

One-time setup:
```bash
bun install
bun link            # exposes the global `fma` command (lands in ~/.bun/bin)
fma install         # adds HTTP hooks to ~/.claude/settings.json (global, once)
```
Each coding session:
```bash
cd ~/your-project && fma     # builds UI if needed, starts collector mapping cwd,
                             # opens http://localhost:4000 — keep it open on the side
```
`fma` flags: `--port N`, `--no-open`. Other commands: `fma watch [path]`,
`fma install --project [path]`, `fma uninstall [--project path]`, `fma help`.
With global hooks, every Claude Code session reports automatically; when the
collector isn't running the hooks fail instantly (no slowdown). Run `fma` in the
**one** repo you want to mapped at a time.

## Dev / manual run (without the CLI)
```bash
bun run server              # collector + UI on :4000 (TARGET_REPO env or cwd)
bun run client              # Vite dev server on :5173 (HMR; dev only)
bun run build               # build client/dist (what the collector serves)
```
- Mapped repo: `TARGET_REPO=/path bun run server`. Port: `COLLECTOR_PORT=4100`.
- Typecheck: `bunx tsc --noEmit`.

## Hooks (what `fma install` writes)
HTTP hooks (`type:"http"` → `http://localhost:4000/events`, `timeout:5`) for
SessionStart/SessionEnd/UserPromptSubmit/PreToolUse/PostToolUse/SubagentStart/
SubagentStop/Stop. Global = `~/.claude/settings.json`; project =
`<repo>/.claude/settings.json`. Merge logic lives in `hooks/install.ts`
(`installHooks`/`uninstallHooks`, reused by the CLI). The collector logs every
raw payload as `[event] {...}` for schema discovery.

## Architecture / data flow
```
Claude Code hooks ──HTTP POST /events──▶ collector (Bun)
   (SessionStart, UserPromptSubmit,        normalize → AgentStore (in-memory)
    PreToolUse, PostToolUse, Subagent*,     debounced repo re-scan (tree)
    Stop, SessionEnd)                       broadcast over WebSocket
                                                     │
                                          ws://localhost:4000/ws
                                                     ▼
                                          React client: treemap + dots + panel
```
WebSocket protocol (server→client), defined in `shared/types.ts` `ServerMessage`:
- `snapshot` — initial: `{agents, tree, repoName}`.
- `event` — `{event: NormalizedEvent, agent: AgentState}` per hook.
- `agentRemoved` — `{agentId}` when an agent is swept.
- `tree` — `{tree, repoName, newPaths}` pushed when the repo's files change.

## File map (what lives where)
- `shared/types.ts` — **the data model**: `AgentState`, `NormalizedEvent`,
  `TreeNode`, `TokenUsage`, `ActivityEntry`, `ServerMessage` union. Start here.
- `shared/config.ts` — `COLLECTOR_PORT` (4000), URLs, sweep timings.
- `server/src/index.ts` — `Bun.serve`: routes (`/events`, `/api/tree`,
  `/api/agents`, `/api/health`, `/ws`), CORS, `targetRepo` resolution (env or
  adopt first event's cwd), **debounced `scheduleRescan()` → `tree` broadcast**,
  5s sweep interval.
- `server/src/normalize.ts` — raw hook payload → `NormalizedEvent`. Resolves
  `tool_input.file_path` to a repo-relative path (worktree-aware). Subagent
  detection lives here (see "Open questions").
- `server/src/store.ts` — `AgentStore`: in-memory `Map<agentId, AgentState>`,
  status mapping, color assignment, `recentActivity`/`eventCount`, stale sweep.
- `server/src/tree.ts` — `scanTree(rootDir)`: filesystem → `TreeNode`,
  **honors `.gitignore`** (subset) + a default ignore list (node_modules, .git,
  dist…), drops empty dirs, depth cap 12.
- `server/src/tokens.ts` — `TokenSource` interface + `StubTokenSource`
  (placeholder numbers, `isStub:true`). **OTEL adapter is the intended real
  source** (`CLAUDE_CODE_ENABLE_TELEMETRY=1`, metric `claude_code.token.usage`).
- `server/src/supervisor.ts` — **Alignment Autopilot** (see its section). `Supervisor`
  interface + `ClaudeSupervisor` (background Sonnet 4.6 judgment loop → verdicts;
  queues steers / deny rules; `decide(ev)` is the instant enforcement used by
  `/events`) + `DisabledSupervisor` (no API key). Mirrors the `tokens.ts` pattern.
- `server/src/redis.ts` — optional Redis persistence (gated by `REDIS_URL`):
  connect, persist agent/mission, `XADD` event/intervention streams, and
  `loadAgents`/`loadMissions`/`loadInterventions` for boot rehydrate. See "Redis
  Agent Memory".
- `server/src/memory.ts` — RediSearch agent memory: `ensureMemoryIndex`,
  `recordMemory`, `recallMemories` (vector via Voyage, else full-text).
- `server/src/ws.ts` — `Broadcaster` (set of WS clients + broadcast).
- `client/src/useCollector.ts` — WS hook; reduces snapshot/event/tree/agentRemoved
  into state; auto-reconnects. Re-applies the tree on `tree` messages (live map).
- `client/src/TreeMap.tsx` — `useTreemapLayout` (d3 squarified treemap),
  `Territory` renderer, `resolveCell`/`regionRect`/`cellCenter` helpers.
- `client/src/Pins.tsx` — `Pin` (HTML, constant-size via counter-scale),
  `Trails`, `Tooltip`.
- `client/src/AgentList.tsx` — sidebar list (subagents nested).
- `client/src/AgentDetail.tsx` — focus panel: task, lifecycle "progress"
  (estimated), token split, stats, recent activity.
- `client/src/App.tsx` — composition: topbar (brand, repo, search, conn, count),
  map with zoom-to-region focus, sidebar (list ⇄ detail), legend.
- `client/src/ui.ts` — `STATUS` palette, `agentLabel`/`typeName`, formatters.
- `client/src/styles.css` — oklch dark theme, `--accent`. Geist fonts linked in
  `client/index.html`.
- `hooks/settings.snippet.json` — the `.claude/settings.json` hooks block
  (HTTP hooks → `http://localhost:4000/events`, `timeout:5`).
- `hooks/install.ts` — exported `installHooks`/`uninstallHooks` (global + project)
  + standalone CLI (guarded by `import.meta.main`).
- `cli/fma.ts` — the `fma` launcher (bin). `watch` (build-if-needed, start
  collector mapping cwd, serve UI, open browser, reuse a running collector),
  `install`/`uninstall` (global default, `--project` opt), `help`.

## Key behaviors & non-obvious decisions
- **Live file map (expand/contract).** The collector re-scans the repo (debounced
  ~800ms) on file-mutating events / unknown paths / session start-stop, plus a 5s
  sweep safety-net while agents are active, and pushes a `tree` message. Reflects
  create, delete, and rename. (Implemented in `server/src/index.ts`.)
- **Treemap weights every file EQUALLY** (`.sum(() => 1)`), NOT by byte size.
  Reason: size-weighting made small/new files sub-pixel and culled by the
  `w<1||h<1` guard; this map is about structure + agent location, not disk usage.
  Do not revert to size weighting without restoring visibility for tiny files.
- **Dots are HTML, in a transform layer counter-scaled by `1/k`** so they stay a
  constant screen size while the map zooms. File cells are SVG.
- **Drag-to-steer has two modes.** Drag an agent dot onto a folder to assign the
  containing folder as `mission.allowedGlobs` (e.g. `client/src/**`). Drag onto a
  file to create `agent.focusRequest`, which injects a one-shot focus instruction
  on the next eligible hook; the dot does not move until the agent actually
  touches the file. Focused agents show mission overlays: allowed, risky
  (outside territory), forbidden (`denyGlobs`), and touched files. "Completed" is
  intentionally NOT shown because there is no reliable per-file completion signal
  from hooks.
- **Token/cost is STUBBED** end-to-end (`isStub:true`, "stub" chip in UI). The
  swap-in point is `TokenSource` in `server/src/tokens.ts`.
- **"Progress" in the detail panel is estimated** from agent lifecycle/status
  (Started/Active/Finished), not real progress — it's explicitly tagged
  "estimated". There is no real progress signal from hooks.
- **`.gitignore` is honored by the map scan.** Good for real repos (keeps
  node_modules/build off the map).

## Alignment Autopilot (closed control loop — the flagship AI feature)
Turns the tool from observability into a controller: it knows each agent's
**mission**, an AI continuously judges whether the agent is on-track, and when it
drifts the system **autonomously steers it back** — nudging (inject context) or
blocking off-mission/destructive tool calls — all shown live on the map.

**The key enabler:** Claude Code hooks are bidirectional. The collector's HTTP
response to `/events` can **deny a tool** (`hookSpecificOutput.permissionDecision:
"deny"` + `permissionDecisionReason`) or **inject context**
(`hookSpecificOutput.additionalContext`). `buildHookResponse()` in
`server/src/index.ts` builds these. (Confirm exact field names against current
Claude Code hook docs if behavior seems off — this is the one spot that depends on
the response schema.)

**Architecture — judgment is decoupled from enforcement:**
- *Async judgment* (`ClaudeSupervisor.tick`/`judge`, every `SUPERVISOR_INTERVAL_MS`
  = 5s): sends each active+changed agent's mission + `recentActivity` to
  `SUPERVISOR_MODEL` (`claude-sonnet-4-6`) → `Alignment` verdict
  (`on_track|drifting|off_track` + reason + correction). Writes it to the agent,
  broadcasts, logs `detected`/`recovered` interventions, queues a steer.
- *Instant enforcement* (`supervisor.decide(ev)` called from `/events`): reads only
  cached state — **no LLM in the request path**, so the agent never stalls.
  Deterministic guardrails: `PreToolUse` editing a `mission.denyGlobs` path →
  deny; file events outside `mission.allowedGlobs` → amber `boundary`
  intervention + local drifting state, but **not** denial. Otherwise inject any
  queued correction. Fail-open (`{}`) on anything else.

**Mission** = `{goal, allowedGlobs[], guardrails[], denyGlobs[], source}` —
auto-derived from the agent's `UserPromptSubmit` prompt, set by dragging an agent
onto the map, and/or edited in the dashboard detail panel (`POST /api/mission`).
**Controls:** `POST /api/supervisor {autonomous?, killSwitch?}` (topbar Autopilot
toggle + kill-switch). **Requires `ANTHROPIC_API_KEY` for LLM judgment only** —
without it, mission storage, territory overlays, boundary warnings, and
deterministic deny-glob blocking still work; the topbar shows "Autopilot off".

**Data model** (`shared/types.ts`): `Mission`, `Alignment`, `InterventionEntry`,
`SupervisorStatus`; `AgentState.mission`/`.alignment`; `ServerMessage` adds
`intervention` + `supervisorStatus`; snapshot carries `supervisor` + `interventions`.

**UI:** pin color/⚠ flag by alignment (`client/src/Pins.tsx`); drag pins to assign
territory; focused map overlays allowed/risky/forbidden/touched files
(`TreeMap.tsx` + `App.tsx`); detail panel has a Mission editor, an Alignment
section (state + reason + correction), and an Interventions timeline
(`AgentDetail.tsx`); live intervention strip + Autopilot control in `App.tsx`;
`ALIGNMENT` palette in `ui.ts`.

## Redis Agent Memory (durable state + semantic recall)
Optional Redis layer that makes the project durable and gives the Autopilot
memory. **Gated by `REDIS_URL`** — unset = today's exact in-memory behavior
(same adapter+fallback philosophy as `TokenSource`/`Supervisor`). Everything
fails open.

- **Persistence / system-of-record** (`server/src/redis.ts`): node-redis client;
  on each event the collector persists the agent (`SET fma:agent:<id>`) and
  `XADD fma:events` (Redis Stream); missions (`SET fma:mission:<id>`) and
  interventions (`XADD fma:interventions`) persist too. On boot,
  `bootPersistence()` in `index.ts` connects and **rehydrates** agents/missions/
  recent interventions back into the in-memory `AgentStore` (`store.hydrate`) +
  supervisor (`loadMission`/`loadInterventions`) — so a restart restores the map.
- **Agent memory / recall** (`server/src/memory.ts`): a RediSearch index
  `fma:mem` (TAG `repo`/`kind`, TEXT `text`, optional `VECTOR`). The supervisor
  `recordMemory()` on notable verdicts (drift/off/recovered) and
  `recallMemories(repo, goal+file)` before each judgment, prepending
  `RELEVANT PAST MEMORY` to the prompt — so the Autopilot learns across sessions
  and restarts. `alignment.recalled` surfaces the count in the UI.
- **Embeddings:** Voyage (`VOYAGE_API_KEY`, `voyage-3-lite`, dim 512) → vector
  KNN; without it → RediSearch full-text recall. Mode shown via
  `SupervisorStatus.memory` (`vector|fulltext|off`) + `.persisted`.
- **Fallback matrix:** no `REDIS_URL` → in-memory only; Redis but no RediSearch →
  persistence+streams only; Redis+RediSearch, no Voyage → full-text recall;
  +Voyage → vector recall.
- **Run it:** `docker compose up -d` (Redis Stack on :6379, UI :8001), then
  `REDIS_URL=redis://localhost:6379 [VOYAGE_API_KEY=...] fma`. Inspect with
  `redis-cli KEYS 'fma:*'`, `XLEN fma:events`, `FT.INFO fma:mem`.
- Config in `shared/config.ts`: `REDIS_URL`, `VOYAGE_API_KEY`, `VOYAGE_MODEL`,
  `VOYAGE_DIM`, `MEMORY_RECALL_K`.

## Open questions / known gaps
- **Subagent identity is unconfirmed.** Docs confirm `SubagentStart`/`SubagentStop`
  exist but don't document an explicit subagent-id field. `normalize.ts` probes a
  defensive list `SUBAGENT_ID_FIELDS` (`subagent_id`, `parent_session_id`, …) and
  falls back to treating events as the main agent. **TODO:** run a real Task
  subagent, inspect the `[event]` logs, confirm the real field, trim the list.
- **A "new file flash" was attempted and removed.** The diff/`setNewPaths` state
  update would not commit reliably in the preview test harness (traced
  thoroughly; server + diff logic were correct). Removed rather than ship an
  unverified cosmetic. If re-adding, verify in a real browser, not the preview.
- The earlier "Fleet Observer" idea evolved into the **Alignment Autopilot**
  (built — see its own section above): not just observing, but a closed loop that
  judges mission-alignment and autonomously steers/blocks.

## Migrating the coding session to Codex (or another agent)
This project's *content* is provider-neutral, but two things are Claude-specific:
1. **The hook integration** (`hooks/`) targets Claude Code's hook system. Codex
   has a different (or no) hook mechanism — if the new agent can't emit hooks,
   you can still drive the dashboard by POSTing JSON to `/events` (any source).
   The `/events` endpoint accepts arbitrary JSON and normalizes defensively; the
   minimum useful payload is `{session_id, cwd, hook_event_name, tool_name,
   tool_input:{file_path}}`.
2. **The token layer** assumes Claude Code's OTEL metric. For another agent, feed
   `TokenSource` from whatever usage signal that agent provides.
Everything else (collector, treemap, UI, store) is plain TS and portable.

## Verification checklist (do this after changes)
1. `bunx tsc --noEmit` is clean.
2. `bun run build` succeeds.
3. Install hooks into a development repo, point `TARGET_REPO`
   at it, run the agent, create/delete a file, confirm the cell appears/vanishes
   within ~1-2s.
4. In the browser, confirm clicking an agent zooms + opens the detail panel.
