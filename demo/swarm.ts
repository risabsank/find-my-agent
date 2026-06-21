// High-density demo for showing CartoAI with many simultaneous dots.
//
// This is intentionally busier than demo:mission. Use it when you want the map
// to look alive with many parallel agents/subagents while still exercising the
// same mission + territory machinery as real hook events.
//
// Recommended:
//   COLLECTOR_PORT=4100 REDIS_URL= TARGET_REPO=$PWD bun run server
//   open http://localhost:4100
//   COLLECTOR_PORT=4100 bun run demo:swarm
//
// Options:
//   --loop              repeat until Ctrl-C
//   --agents N          number of top-level agents, default 8
//   --subagents N       number of subagents per top-level agent, default 2
//   --waves N           movement waves before breaches/blocks, default 8
//   --pace N            speed multiplier, default 1.8 (higher = slower)

import { COLLECTOR_HTTP } from "../shared/config.ts";

const CWD = process.env.TARGET_REPO || process.cwd();
const LOOP = process.argv.includes("--loop");
const AGENT_COUNT = numberArg("--agents", 8);
const SUBAGENTS_PER_AGENT = numberArg("--subagents", 2);
const WAVES = numberArg("--waves", 8);
const PACE = numberArg("--pace", 1.8);

type Hook = Record<string, any>;

interface AgentSpec {
  id: string;
  label: string;
  territory: string;
  deny: string[];
  files: string[];
  drift: string;
  blocked: string;
  subTypes: string[];
}

const SPECS: AgentSpec[] = [
  {
    id: "swarm-client-ui",
    label: "UI polish",
    territory: "client/src/**",
    deny: ["server/src/**"],
    files: ["client/src/App.tsx", "client/src/TreeMap.tsx", "client/src/Pins.tsx", "client/src/styles.css"],
    drift: "README.md",
    blocked: "server/src/index.ts",
    subTypes: ["Designer", "Accessibility"],
  },
  {
    id: "swarm-server-core",
    label: "Collector core",
    territory: "server/src/**",
    deny: ["client/src/App.tsx"],
    files: ["server/src/index.ts", "server/src/supervisor.ts", "server/src/store.ts", "server/src/normalize.ts"],
    drift: "shared/types.ts",
    blocked: "client/src/App.tsx",
    subTypes: ["Reviewer", "Guardrails"],
  },
  {
    id: "swarm-map",
    label: "Treemap behavior",
    territory: "client/src/**",
    deny: ["hooks/**"],
    files: ["client/src/TreeMap.tsx", "client/src/Pins.tsx", "client/src/useCollector.ts", "client/src/ui.ts"],
    drift: "server/src/tree.ts",
    blocked: "hooks/install.ts",
    subTypes: ["Geometry", "Motion"],
  },
  {
    id: "swarm-cli",
    label: "CLI packaging",
    territory: "cli/**",
    deny: ["client/src/**"],
    files: ["cli/fma.ts", "package.json", "README.md", "hooks/install.ts"],
    drift: "server/src/index.ts",
    blocked: "client/src/styles.css",
    subTypes: ["Installer", "Docs"],
  },
  {
    id: "swarm-hooks",
    label: "Hook installer",
    territory: "hooks/**",
    deny: ["server/src/redis.ts"],
    files: ["hooks/install.ts", "hooks/settings.snippet.json", "README.md", "context.md"],
    drift: "client/src/App.tsx",
    blocked: "server/src/redis.ts",
    subTypes: ["Settings", "Schema"],
  },
  {
    id: "swarm-memory",
    label: "Redis memory",
    territory: "server/src/**",
    deny: ["client/src/**"],
    files: ["server/src/redis.ts", "server/src/memory.ts", "server/src/supervisor.ts", "docker-compose.yml"],
    drift: "demo/autopilot.ts",
    blocked: "client/src/AgentDetail.tsx",
    subTypes: ["Persistence", "Recall"],
  },
  {
    id: "swarm-demo",
    label: "Demo scripts",
    territory: "demo/**",
    deny: ["shared/types.ts"],
    files: ["demo/simulate.ts", "demo/autopilot.ts", "demo/mission-control.ts", "README.md"],
    drift: "client/src/Pins.tsx",
    blocked: "shared/types.ts",
    subTypes: ["Narrator", "Fallback"],
  },
  {
    id: "swarm-design",
    label: "Design prototype",
    territory: "Design/**",
    deny: ["server/src/**"],
    files: ["Design/fma-app.jsx", "Design/fma-sidebar.jsx", "Design/fma-treemap.jsx", "Design/Canvas.dc.html"],
    drift: "client/src/styles.css",
    blocked: "server/src/store.ts",
    subTypes: ["Visuals", "Prototype"],
  },
  {
    id: "swarm-shared",
    label: "Shared contract",
    territory: "shared/**",
    deny: ["Design/**"],
    files: ["shared/types.ts", "shared/config.ts", "server/src/normalize.ts", "client/src/types.ts"],
    drift: "cli/fma.ts",
    blocked: "Design/fma-app.jsx",
    subTypes: ["Types", "Config"],
  },
  {
    id: "swarm-docs",
    label: "Docs update",
    territory: "**",
    deny: ["server/src/**"],
    files: ["README.md", "context.md", "hooks/settings.snippet.json", "demo/mission-control.ts"],
    drift: "client/src/App.tsx",
    blocked: "server/src/supervisor.ts",
    subTypes: ["Writer", "Editor"],
  },
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const pause = (ms: number) => sleep(Math.round(ms * PACE));

function numberArg(name: string, fallback: number): number {
  const idx = process.argv.indexOf(name);
  if (idx < 0) return fallback;
  const n = Number(process.argv[idx + 1]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function selectedSpecs(): AgentSpec[] {
  const out: AgentSpec[] = [];
  for (let i = 0; i < AGENT_COUNT; i++) {
    const base = SPECS[i % SPECS.length];
    out.push(i < SPECS.length ? base : { ...base, id: `${base.id}-${i + 1}` });
  }
  return out;
}

async function post(payload: Hook): Promise<Record<string, any>> {
  const res = await fetch(`${COLLECTOR_HTTP}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch((err) => {
    console.error(`POST /events failed — is the collector running at ${COLLECTOR_HTTP}?`, err);
    process.exit(1);
  });
  return (await res.json().catch(() => ({}))) as Record<string, any>;
}

async function setMission(agentId: string, spec: AgentSpec, territory = spec.territory): Promise<void> {
  await fetch(`${COLLECTOR_HTTP}/api/mission`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agentId,
      goal: spec.label,
      allowedGlobs: [territory],
      guardrails: [`Stay inside ${territory}`],
      denyGlobs: spec.deny,
    }),
  }).catch((err) => {
    console.error(`POST /api/mission failed — is the collector running at ${COLLECTOR_HTTP}?`, err);
    process.exit(1);
  });
}

async function startAgent(spec: AgentSpec): Promise<void> {
  await post({ session_id: spec.id, cwd: CWD, hook_event_name: "SessionStart", source: "startup" });
  await pause(160);
  await post({
    session_id: spec.id,
    cwd: CWD,
    hook_event_name: "UserPromptSubmit",
    prompt: `${spec.label}: work in ${spec.territory}`,
  });
  await setMission(spec.id, spec);
}

async function startSubagent(spec: AgentSpec, index: number): Promise<Hook> {
  const subagent_id = `${spec.id}-sub-${index + 1}`;
  const subagent_type = spec.subTypes[index % spec.subTypes.length] ?? `Subagent ${index + 1}`;
  const extra = {
    subagent_id,
    parent_session_id: spec.id,
    subagent_type,
  };
  await post({
    session_id: spec.id,
    cwd: CWD,
    hook_event_name: "SubagentStart",
    tool_input: { description: `${subagent_type} for ${spec.label}` },
    ...extra,
  });
  await setMission(`${spec.id}:${subagent_id}`, spec);
  return extra;
}

async function visit(spec: AgentSpec, tool: string, file: string, extra: Hook = {}): Promise<void> {
  const decision = await post({
    session_id: spec.id,
    cwd: CWD,
    hook_event_name: "PreToolUse",
    tool_name: tool,
    tool_input: { file_path: file },
    ...extra,
  });
  if (decision?.hookSpecificOutput?.permissionDecision === "deny") {
    await pause(420);
    return;
  }
  await pause(900);
  await post({
    session_id: spec.id,
    cwd: CWD,
    hook_event_name: "PostToolUse",
    tool_name: tool,
    tool_input: { file_path: file },
    tool_response: { ok: true },
    ...extra,
  });
  await pause(260);
}

async function runOnce(): Promise<void> {
  const specs = selectedSpecs();
  console.log(`\nCartoAI swarm demo`);
  console.log(`Collector: ${COLLECTOR_HTTP}`);
  console.log(`Agents:    ${specs.length} top-level + ${specs.length * SUBAGENTS_PER_AGENT} subagents`);
  console.log(`Runtime:   ${WAVES} waves at ${PACE}x pace`);
  console.log(`Tip: click any dot to focus its territory overlay; use --loop for booth mode.\n`);

  console.log("▶ Starting top-level agents");
  await Promise.all(specs.map(startAgent));
  await pause(1100);

  console.log("▶ Starting subagents");
  const subagents = new Map<string, Hook[]>();
  for (const spec of specs) {
    const extras: Hook[] = [];
    for (let i = 0; i < SUBAGENTS_PER_AGENT; i++) {
      extras.push(await startSubagent(spec, i));
      await pause(130);
    }
    subagents.set(spec.id, extras);
  }
  await pause(1200);

  console.log("▶ Moving everyone through their territories");
  for (let wave = 0; wave < WAVES; wave++) {
    console.log(`  wave ${wave + 1}/${WAVES}`);
    await Promise.all(
      specs.map(async (spec, i) => {
        const file = spec.files[(wave + i) % spec.files.length];
        await visit(spec, wave % 2 === 0 ? "Read" : "Edit", file);
        const extras = subagents.get(spec.id) ?? [];
        await Promise.all(
          extras.map((extra, j) =>
            visit(spec, "Read", spec.files[(wave + j + 1) % spec.files.length], extra),
          ),
        );
      }),
    );
    await pause(1200);
  }

  console.log("▶ Creating amber territory breaches");
  await Promise.all(specs.slice(0, Math.min(6, specs.length)).map((spec) => visit(spec, "Read", spec.drift)));
  await pause(1800);

  console.log("▶ Creating red blocked edits");
  await Promise.all(specs.slice(0, Math.min(6, specs.length)).map((spec) => visit(spec, "Edit", spec.blocked)));
  await pause(2400);

  console.log("▶ Wrapping up");
  for (const spec of specs) {
    for (const extra of subagents.get(spec.id) ?? []) {
      await post({ session_id: spec.id, cwd: CWD, hook_event_name: "SubagentStop", ...extra });
    }
    await post({ session_id: spec.id, cwd: CWD, hook_event_name: "Stop" });
  }

  console.log("\nSwarm demo complete. Dots linger briefly for inspection.\n");
}

do {
  await runOnce();
  if (LOOP) await pause(4500);
} while (LOOP);
