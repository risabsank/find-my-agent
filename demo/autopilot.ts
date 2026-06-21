// Autopilot demo: an agent gets a mission with an off-limits zone, works on it,
// drifts into the forbidden zone (→ the supervisor BLOCKS it instantly and the
// AI judges it off-mission), then course-corrects (→ recovered). Watch the dot
// turn amber/red and the intervention strip light up.
//
//   bun run demo:autopilot         (needs the collector running WITH ANTHROPIC_API_KEY)
//
// Requires the AI supervisor (set ANTHROPIC_API_KEY before `fma` / `bun run server`).
// The deterministic guardrail block works on the key alone; the drift/recover
// verdicts come from the background Sonnet loop (~5s cadence).

import { COLLECTOR_HTTP } from "../shared/config.ts";

const CWD = process.env.TARGET_REPO || process.cwd();
const SESSION = "demo-autopilot";

type Hook = Record<string, any>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post(payload: Hook): Promise<void> {
  await fetch(`${COLLECTOR_HTTP}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: SESSION, cwd: CWD, ...payload }),
  }).catch((e) => {
    console.error("POST /events failed — is the collector running?", e);
    process.exit(1);
  });
}

async function visit(tool: string, file: string, label: string): Promise<void> {
  console.log(label);
  await post({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: { file_path: file } });
  await sleep(1200);
  await post({
    hook_event_name: "PostToolUse",
    tool_name: tool,
    tool_input: { file_path: file },
    tool_response: { ok: true },
  });
  await sleep(800);
}

async function main() {
  console.log(`Autopilot demo → ${COLLECTOR_HTTP} (repo: ${CWD})\n`);

  // 1) Start + state the mission (auto-derived from the prompt).
  await post({ hook_event_name: "SessionStart", source: "startup" });
  await sleep(600);
  await post({
    hook_event_name: "UserPromptSubmit",
    prompt:
      "Add input validation to the signup form in client/src. Stay in client/src; do not modify the server or tests.",
  });
  await sleep(400);

  // 2) Add explicit guardrails + an off-limits zone (server/src/**).
  await fetch(`${COLLECTOR_HTTP}/api/mission`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agentId: SESSION,
      goal: "Add input validation to the signup form in client/src.",
      guardrails: ["Stay within client/src", "Do not modify tests"],
      denyGlobs: ["server/src/**"],
    }),
  }).catch(() => {});
  console.log("mission set: work in client/src, off-limits server/src/**\n");
  await sleep(1500);

  // 3) On-mission work → should stay green / on_track.
  await visit("Read", "client/src/App.tsx", "main  on-mission  Read client/src/App.tsx");
  await visit("Edit", "client/src/ui.ts", "main  on-mission  Edit client/src/ui.ts");
  await sleep(6000); // let one judgment cycle confirm on_track

  // 4) DRIFT into the off-limits zone → instant guardrail BLOCK + AI off_track.
  console.log("\n--- drifting into off-limits server/src ---");
  await visit("Edit", "server/src/index.ts", "main  DRIFT      Edit server/src/index.ts (blocked)");
  await visit("Edit", "server/src/store.ts", "main  DRIFT      Edit server/src/store.ts (blocked)");
  await sleep(6000); // let the AI verdict land (off_track)

  // 5) Course-correct back into scope → recovered.
  console.log("\n--- back on mission ---");
  await visit("Edit", "client/src/AgentList.tsx", "main  on-mission  Edit client/src/AgentList.tsx");
  await visit("Edit", "client/src/App.tsx", "main  on-mission  Edit client/src/App.tsx");
  await sleep(6000); // let the AI verdict recover

  await post({ hook_event_name: "Stop" });
  console.log("\nDemo complete. (Detected → blocked/steered → recovered.)");
}

main();
