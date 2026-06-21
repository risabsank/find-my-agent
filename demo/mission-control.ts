// Reliable hackathon demo for CartoAI's mission-control features.
//
// Drives the collector with fake Claude Code hook payloads and mission API calls:
// - two top-level agents with assigned territories
// - one nested subagent
// - allowed/touched/risky/forbidden overlays
// - amber territory breach warnings
// - red forbidden-path blocks
// - live map expansion/contraction with a temporary demo file
//
// Run against a clean collector:
//   COLLECTOR_PORT=4100 REDIS_URL= TARGET_REPO=$PWD bun run server
//   open http://localhost:4100
//   COLLECTOR_PORT=4100 bun run demo:mission
//
// Repeat continuously for a booth/demo table:
//   COLLECTOR_PORT=4100 bun run demo:mission -- --loop

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { COLLECTOR_HTTP } from "../shared/config.ts";

const CWD = process.env.TARGET_REPO || process.cwd();
const CLIENT = "demo-client-agent";
const SERVER = "demo-server-agent";
const SUB = "demo-client-reviewer";
const TEMP_FILE = "client/src/__fma_demo_validation.ts";
const LOOP = process.argv.includes("--loop");

type Hook = Record<string, any>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function cleanupTemp(): void {
  try {
    rmSync(join(CWD, TEMP_FILE), { force: true });
  } catch {
    /* best effort */
  }
}

function logStep(title: string): void {
  console.log(`\n▶ ${title}`);
}

async function post(payload: Hook): Promise<unknown> {
  const res = await fetch(`${COLLECTOR_HTTP}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch((err) => {
    console.error(`POST /events failed — is the collector running at ${COLLECTOR_HTTP}?`, err);
    process.exit(1);
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, any>;
  const who = payload.subagent_id ? "  └─ reviewer" : payload.session_id === SERVER ? "server agent" : "client agent";
  const where = payload.tool_input?.file_path ?? "";
  const decision = body?.hookSpecificOutput?.permissionDecision === "deny" ? "DENIED" : "ok";
  console.log(`${who.padEnd(13)} ${payload.hook_event_name.padEnd(16)} ${(payload.tool_name ?? "").padEnd(9)} ${where} ${decision}`);
  return body;
}

async function setMission(
  agentId: string,
  mission: {
    goal: string;
    allowedGlobs: string[];
    guardrails: string[];
    denyGlobs: string[];
  },
): Promise<void> {
  await fetch(`${COLLECTOR_HTTP}/api/mission`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId, ...mission }),
  }).catch((err) => {
    console.error(`POST /api/mission failed — is the collector running at ${COLLECTOR_HTTP}?`, err);
    process.exit(1);
  });
  console.log(`${agentId.padEnd(18)} mission → territory ${mission.allowedGlobs.join(", ")}; forbidden ${mission.denyGlobs.join(", ") || "none"}`);
}

async function startAgent(sessionId: string, prompt: string): Promise<void> {
  await post({ session_id: sessionId, cwd: CWD, hook_event_name: "SessionStart", source: "startup" });
  await sleep(450);
  await post({ session_id: sessionId, cwd: CWD, hook_event_name: "UserPromptSubmit", prompt });
  await sleep(450);
}

async function visitFile(
  sessionId: string,
  tool: string,
  file: string,
  extra: Hook = {},
  opts: { postTool?: boolean } = {},
): Promise<void> {
  const postTool = opts.postTool ?? true;
  const decision = (await post({
    session_id: sessionId,
    cwd: CWD,
    hook_event_name: "PreToolUse",
    tool_name: tool,
    tool_input: { file_path: file },
    ...extra,
  })) as Record<string, any>;
  await sleep(1050);
  if (!postTool || decision?.hookSpecificOutput?.permissionDecision === "deny") {
    await sleep(450);
    return;
  }
  await post({
    session_id: sessionId,
    cwd: CWD,
    hook_event_name: "PostToolUse",
    tool_name: tool,
    tool_input: { file_path: file },
    tool_response: { ok: true },
    ...extra,
  });
  await sleep(650);
}

async function createTempFile(): Promise<void> {
  await post({
    session_id: CLIENT,
    cwd: CWD,
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file_path: TEMP_FILE },
  });
  await sleep(850);
  const abs = join(CWD, TEMP_FILE);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, "export const demoValidation = true;\n");
  await post({
    session_id: CLIENT,
    cwd: CWD,
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: TEMP_FILE },
    tool_response: { ok: true },
  });
  await sleep(1800);
}

async function runOnce(): Promise<void> {
  cleanupTemp();
  console.log(`\nCartoAI mission-control demo`);
  console.log(`Collector: ${COLLECTOR_HTTP}`);
  console.log(`Repo:      ${CWD}`);
  console.log(`Tip: click demo-client-agent, then watch the allowed/risky/forbidden/touched legend.\n`);

  logStep("1. Two agents appear and receive territories");
  await Promise.all([
    startAgent(CLIENT, "Own client/src. Add validation UI without touching server internals."),
    startAgent(SERVER, "Own server/src. Keep the collector stable without changing the app shell."),
  ]);
  await setMission(CLIENT, {
    goal: "Add validation UI in client/src.",
    allowedGlobs: ["client/src/**"],
    guardrails: ["Stay in the React client unless explicitly asked"],
    denyGlobs: ["server/src/**"],
  });
  await setMission(SERVER, {
    goal: "Improve collector behavior in server/src.",
    allowedGlobs: ["server/src/**"],
    guardrails: ["Stay in the Bun collector"],
    denyGlobs: ["client/src/App.tsx"],
  });
  await sleep(1600);

  logStep("2. Normal in-territory work paints allowed + touched files");
  await Promise.all([
    visitFile(CLIENT, "Read", "client/src/App.tsx"),
    visitFile(SERVER, "Read", "server/src/index.ts"),
  ]);
  await Promise.all([
    visitFile(CLIENT, "Edit", "client/src/AgentDetail.tsx"),
    visitFile(SERVER, "Edit", "server/src/supervisor.ts"),
  ]);

  logStep("3. A subagent appears under the client agent");
  await post({
    session_id: CLIENT,
    cwd: CWD,
    hook_event_name: "PreToolUse",
    tool_name: "Task",
    tool_input: { description: "Review client map overlays", subagent_type: "Reviewer" },
  });
  await sleep(500);
  const subExtra = { subagent_id: SUB, parent_session_id: CLIENT, subagent_type: "Reviewer" };
  await post({
    session_id: CLIENT,
    cwd: CWD,
    hook_event_name: "SubagentStart",
    tool_input: { description: "Review client map overlays" },
    ...subExtra,
  });
  await setMission(`${CLIENT}:${SUB}`, {
    goal: "Review client territory overlay code.",
    allowedGlobs: ["client/src/**"],
    guardrails: ["Read client code only"],
    denyGlobs: ["server/src/**"],
  });
  await visitFile(CLIENT, "Read", "client/src/TreeMap.tsx", subExtra);

  logStep("4. Territory breaches create amber warnings but continue");
  await visitFile(CLIENT, "Read", "README.md");
  await visitFile(SERVER, "Read", "shared/types.ts");

  logStep("5. Forbidden edits create red BLOCKED interventions");
  await visitFile(CLIENT, "Edit", "server/src/store.ts", {}, { postTool: false });
  await visitFile(SERVER, "Edit", "client/src/App.tsx", {}, { postTool: false });

  logStep("6. A temporary file appears inside the client territory, then disappears");
  await createTempFile();
  await sleep(2600);
  cleanupTemp();
  await post({ session_id: CLIENT, cwd: CWD, hook_event_name: "Stop" });
  await sleep(1000);
  await post({ session_id: CLIENT, cwd: CWD, hook_event_name: "SubagentStop", ...subExtra });
  await post({ session_id: SERVER, cwd: CWD, hook_event_name: "Stop" });

  console.log("\nDemo complete. Dots linger briefly so judges can inspect details.");
  console.log("Run with --loop to repeat automatically.\n");
}

process.on("SIGINT", () => {
  cleanupTemp();
  process.exit(130);
});

do {
  await runOnce();
  if (LOOP) await sleep(5000);
} while (LOOP);

if (existsSync(join(CWD, TEMP_FILE))) cleanupTemp();
