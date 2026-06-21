import { resolve, join } from "node:path";
import { existsSync, statSync } from "node:fs";
import type { TreeNode } from "../../shared/types.ts";
import { COLLECTOR_PORT } from "../../shared/config.ts";
import { AgentStore } from "./store.ts";
import { Broadcaster } from "./ws.ts";
import { normalize, type RawHook } from "./normalize.ts";
import { scanTree } from "./tree.ts";
import { createSupervisor, type Decision } from "./supervisor.ts";
import {
  connectRedis,
  persistAgent,
  appendEvent,
  loadAgents,
  loadMissions,
  loadInterventions,
} from "./redis.ts";
import { ensureMemoryIndex } from "./memory.ts";

// ---- Mapped repo resolution -------------------------------------------------
// The repo whose file tree becomes the map. Override with TARGET_REPO; defaults
// to the directory the collector is launched from. If the first event arrives
// with a cwd and no tree exists yet, we adopt that cwd.
let targetRepo = resolve(process.env.TARGET_REPO || process.cwd());

// Tools whose completion may have created/changed/deleted files on disk.
const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

// Built client UI, served from the install dir (not the mapped repo).
const DIST_DIR = resolve(import.meta.dir, "../../client/dist");

// ---- Tree cache (re-scan with a short TTL so edits show up) ------------------
let treeCache: { node: TreeNode; at: number } | null = null;
const TREE_TTL_MS = 8000;

/** Flatten every path contained in a tree into a set. */
function collectPaths(node: TreeNode, out = new Set<string>()): Set<string> {
  out.add(node.path);
  if (node.children) for (const c of node.children) collectPaths(c, out);
  return out;
}

/** Paths in the last tree we broadcast — the baseline for "what's new". */
let lastBroadcastPaths = new Set<string>();

function getTree(): TreeNode | null {
  if (!existsSync(targetRepo)) return null;
  const now = Date.now();
  if (!treeCache || now - treeCache.at > TREE_TTL_MS) {
    const node = scanTree(targetRepo);
    treeCache = { node, at: now };
    // Establish the diff baseline the first time we ever build the tree, so a
    // later file event flashes only genuinely-new files (not the whole repo).
    if (lastBroadcastPaths.size === 0) lastBroadcastPaths = collectPaths(node);
  }
  return treeCache.node;
}

const store = new AgentStore();
const bus = new Broadcaster();
const supervisor = createSupervisor(store, bus);

// Connect Redis (if REDIS_URL) and rehydrate prior state, then start the loop.
async function bootPersistence(): Promise<void> {
  const ok = await connectRedis();
  if (ok) {
    await ensureMemoryIndex();
    for (const agent of await loadAgents()) store.hydrate(agent);
    const missions = await loadMissions();
    for (const [agentId, m] of Object.entries(missions)) supervisor.loadMission(agentId, m);
    supervisor.loadInterventions(await loadInterventions(50));
    const n = store.snapshot().length;
    if (n > 0) console.log(`[redis] rehydrated ${n} agent(s)`);
  }
  supervisor.setRepo(getTree()?.name ?? "repo");
  supervisor.start();
}
void bootPersistence();

/** Map a supervisor Decision to the Claude Code hook response JSON. */
function buildHookResponse(decision: Decision, ev: { event: string }): unknown {
  if (decision.kind === "deny") {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: decision.reason,
      },
    };
  }
  if (decision.kind === "inject") {
    return {
      hookSpecificOutput: {
        hookEventName: ev.event,
        additionalContext: decision.context,
      },
    };
  }
  return {}; // allow
}

// ---- Live tree updates ------------------------------------------------------
// Re-scan the repo (debounced) and push the new tree to clients when it changes.
const RESCAN_DEBOUNCE_MS = 800;
let rescanTimer: ReturnType<typeof setTimeout> | null = null;

function runRescan(): void {
  rescanTimer = null;
  if (!existsSync(targetRepo)) return;
  const next = scanTree(targetRepo);
  treeCache = { node: next, at: Date.now() };

  const nextPaths = collectPaths(next);
  const newPaths: string[] = [];
  for (const p of nextPaths) if (!lastBroadcastPaths.has(p)) newPaths.push(p);
  // Changed if anything was added (newPaths) or the total count shifted (removed).
  const changed = newPaths.length > 0 || nextPaths.size !== lastBroadcastPaths.size;
  if (!changed) return; // stay quiet

  lastBroadcastPaths = nextPaths;
  bus.broadcast({ type: "tree", tree: next, repoName: next.name, newPaths });
}

/** Coalesce bursts: at most one re-scan per debounce window. */
function scheduleRescan(): void {
  if (rescanTimer) return;
  rescanTimer = setTimeout(runRescan, RESCAN_DEBOUNCE_MS);
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

const server = Bun.serve({
  port: COLLECTOR_PORT,
  async fetch(req, server) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    // WebSocket upgrade for the frontend.
    if (url.pathname === "/ws") {
      if (server.upgrade(req)) return undefined as unknown as Response;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // Hook event intake. Accept anything, never block.
    if (url.pathname === "/events" && req.method === "POST") {
      let raw: RawHook;
      try {
        raw = (await req.json()) as RawHook;
      } catch {
        return json({ ok: false, error: "invalid json" }, 400);
      }
      // Passthrough log for schema discovery (per project constraint).
      console.log("[event]", JSON.stringify(raw));

      // Adopt the agent's cwd as the mapped repo if we don't have a real one.
      if (
        typeof raw.cwd === "string" &&
        !process.env.TARGET_REPO &&
        !treeCache &&
        existsSync(raw.cwd)
      ) {
        targetRepo = resolve(raw.cwd);
        supervisor.setRepo(targetRepo.split("/").pop() || "repo");
      }

      const ev = normalize(raw, targetRepo);
      const agent = store.apply(ev);
      supervisor.noteEvent(ev);
      bus.broadcast({ type: "event", event: ev, agent });
      // Durable record (fire-and-forget; no-op without Redis).
      persistAgent(agent);
      appendEvent(ev);

      // Autopilot: decide instantly (cached verdict, no LLM in this path) whether
      // to allow / deny / inject a correction. Fail-open via {} on allow.
      const decision = supervisor.decide(ev);

      // Re-scan the file map when the repo may have changed: a file-mutating
      // tool finished, a path we've never seen showed up, or the session
      // started/stopped. Debounced, so bursts coalesce into one scan.
      if (
        ev.event === "SessionStart" ||
        ev.event === "Stop" ||
        ev.event === "SessionEnd" ||
        (ev.event === "PostToolUse" &&
          ev.tool != null &&
          FILE_TOOLS.has(ev.tool)) ||
        (ev.filePath != null && !lastBroadcastPaths.has(ev.filePath))
      ) {
        scheduleRescan();
      }
      // The response steers the agent (deny/inject) or is empty (allow).
      return json(buildHookResponse(decision, ev));
    }

    if (url.pathname === "/api/tree") {
      return json(getTree());
    }

    if (url.pathname === "/api/agents") {
      return json(store.snapshot());
    }

    // Autopilot: set/replace an agent's mission.
    if (url.pathname === "/api/mission" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as {
        agentId?: string;
        goal?: string;
        guardrails?: string[];
        denyGlobs?: string[];
      };
      if (!body.agentId) return json({ ok: false, error: "agentId required" }, 400);
      supervisor.setMission(body.agentId, {
        goal: body.goal ?? "",
        guardrails: body.guardrails ?? [],
        denyGlobs: body.denyGlobs ?? [],
        source: "manual",
      });
      return json({ ok: true });
    }

    // Autopilot: toggle autonomy / kill-switch, or read status.
    if (url.pathname === "/api/supervisor") {
      if (req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as {
          autonomous?: boolean;
          killSwitch?: boolean;
        };
        return json(supervisor.setAutonomy(body));
      }
      return json(supervisor.status());
    }

    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        targetRepo,
        agents: store.snapshot().length,
        clients: bus.size,
        persisted: supervisor.status().persisted,
        memory: supervisor.status().memory,
      });
    }

    // Static UI: serve the built client so the whole app lives on one port.
    if (req.method === "GET") {
      const indexPath = join(DIST_DIR, "index.html");
      if (!existsSync(indexPath)) {
        return new Response(
          "UI not built yet. Run `fma` (it builds automatically) or `bun run build`.",
          { status: 503, headers: CORS },
        );
      }
      const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const candidate = join(DIST_DIR, rel);
      if (
        candidate.startsWith(DIST_DIR) &&
        existsSync(candidate) &&
        statSync(candidate).isFile()
      ) {
        return new Response(Bun.file(candidate)); // asset (Bun infers MIME)
      }
      return new Response(Bun.file(indexPath)); // SPA fallback
    }

    return new Response("Find My Agent collector. See /api/health", {
      status: 404,
      headers: CORS,
    });
  },
  websocket: {
    open(ws) {
      bus.add(ws);
      const tree = getTree();
      bus.send(ws, {
        type: "snapshot",
        agents: store.snapshot(),
        tree,
        repoName: tree?.name ?? "repo",
        supervisor: supervisor.status(),
        interventions: supervisor.recentInterventions(),
      });
    },
    message() {
      // Frontend is read-only; ignore inbound messages.
    },
    close(ws) {
      bus.remove(ws);
    },
  },
});

// Periodic sweep: decay stale agents, remove long-stopped ones.
setInterval(() => {
  const { changed, removed } = store.sweep();
  for (const agent of changed) {
    bus.broadcast({
      type: "event",
      event: {
        agentId: agent.agentId,
        sessionId: agent.sessionId,
        parentId: agent.parentId,
        isSubagent: agent.isSubagent,
        event: "Sweep",
        tool: agent.currentTool,
        filePath: agent.currentFile,
        ts: Date.now(),
        raw: null,
      },
      agent,
    });
  }
  for (const agentId of removed) {
    bus.broadcast({ type: "agentRemoved", agentId });
  }
  // Safety net for files created via Bash (mkdir/touch/mv carry no file_path):
  // while any agent is active, periodically reconcile the map with disk.
  if (store.snapshot().some((a) => a.status === "working" || a.status === "waiting")) {
    scheduleRescan();
  }
}, 5000);

console.log(`\n  Find My Agent collector running`);
console.log(`  HTTP    http://localhost:${server.port}`);
console.log(`  Events  POST http://localhost:${server.port}/events`);
console.log(`  WS      ws://localhost:${server.port}/ws`);
console.log(`  Mapping ${targetRepo}\n`);
