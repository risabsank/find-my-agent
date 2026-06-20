import { resolve } from "node:path";
import { existsSync } from "node:fs";
import type { TreeNode } from "../../shared/types.ts";
import { COLLECTOR_PORT } from "../../shared/config.ts";
import { AgentStore } from "./store.ts";
import { Broadcaster } from "./ws.ts";
import { normalize, type RawHook } from "./normalize.ts";
import { scanTree } from "./tree.ts";

// ---- Mapped repo resolution -------------------------------------------------
// The repo whose file tree becomes the map. Override with TARGET_REPO; defaults
// to the directory the collector is launched from. If the first event arrives
// with a cwd and no tree exists yet, we adopt that cwd.
let targetRepo = resolve(process.env.TARGET_REPO || process.cwd());

// ---- Tree cache (re-scan with a short TTL so edits show up) ------------------
let treeCache: { node: TreeNode; at: number } | null = null;
const TREE_TTL_MS = 8000;

function getTree(): TreeNode | null {
  if (!existsSync(targetRepo)) return null;
  const now = Date.now();
  if (!treeCache || now - treeCache.at > TREE_TTL_MS) {
    treeCache = { node: scanTree(targetRepo), at: now };
  }
  return treeCache.node;
}

const store = new AgentStore();
const bus = new Broadcaster();

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
      }

      const ev = normalize(raw, targetRepo);
      const agent = store.apply(ev);
      bus.broadcast({ type: "event", event: ev, agent });
      return json({ ok: true }); // respond immediately — never blocks the agent
    }

    if (url.pathname === "/api/tree") {
      return json(getTree());
    }

    if (url.pathname === "/api/agents") {
      return json(store.snapshot());
    }

    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        targetRepo,
        agents: store.snapshot().length,
        clients: bus.size,
      });
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
}, 5000);

console.log(`\n  Find My Agent collector running`);
console.log(`  HTTP    http://localhost:${server.port}`);
console.log(`  Events  POST http://localhost:${server.port}/events`);
console.log(`  WS      ws://localhost:${server.port}/ws`);
console.log(`  Mapping ${targetRepo}\n`);
