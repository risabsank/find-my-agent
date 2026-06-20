// Fires a scripted sequence of *fake* Claude Code hook payloads at the
// collector so you can watch the map move with no live agent.
//
//   bun run demo            (from repo root)
//   bun run demo/simulate.ts
//
// Payload shapes mirror the documented hook schema: session_id, cwd,
// hook_event_name, tool_name, tool_input.file_path. Subagent events also carry
// `subagent_id` / `parent_session_id` — these are ASSUMED field names (the docs
// don't confirm a subagent id field) and exist here only to demonstrate dot
// nesting. The server's /events log will reveal the real fields from a live run.

import { COLLECTOR_HTTP } from "../shared/config.ts";

const CWD = process.env.TARGET_REPO || process.cwd();
const MAIN = "demo-session-main";
const SUB = "demo-subagent-1";

type Hook = Record<string, any>;

async function post(payload: Hook): Promise<void> {
  try {
    await fetch(`${COLLECTOR_HTTP}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const who = payload.subagent_id ? "  └─ sub" : "main";
    const where = payload.tool_input?.file_path ?? "";
    console.log(`${who}  ${payload.hook_event_name.padEnd(16)} ${payload.tool_name ?? ""} ${where}`);
  } catch (err) {
    console.error("POST /events failed — is the server running?", err);
    process.exit(1);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A tool-use pair against a file, with a pause so the dot visibly moves.
async function visitFile(
  session: string,
  tool: string,
  file: string,
  extra: Hook = {},
): Promise<void> {
  await post({
    session_id: session,
    cwd: CWD,
    hook_event_name: "PreToolUse",
    tool_name: tool,
    tool_input: { file_path: file },
    ...extra,
  });
  await sleep(1600);
  await post({
    session_id: session,
    cwd: CWD,
    hook_event_name: "PostToolUse",
    tool_name: tool,
    tool_input: { file_path: file },
    tool_response: { ok: true },
    ...extra,
  });
  await sleep(700);
}

async function main() {
  console.log(`Simulating fake agents against ${COLLECTOR_HTTP}\nMapping cwd: ${CWD}\n`);

  // --- Main agent starts ---
  await post({
    session_id: MAIN,
    cwd: CWD,
    hook_event_name: "SessionStart",
    source: "startup",
  });
  await sleep(800);
  await post({
    session_id: MAIN,
    cwd: CWD,
    hook_event_name: "UserPromptSubmit",
    prompt: "Refactor the collector server and add tests",
  });
  await sleep(800);

  // Main agent moves across real files in this repo.
  await visitFile(MAIN, "Read", "server/src/index.ts");
  await visitFile(MAIN, "Read", "server/src/store.ts");
  await visitFile(MAIN, "Edit", "server/src/normalize.ts");

  // A Bash command (no file_path) — dot should stay on its last file.
  await post({
    session_id: MAIN,
    cwd: CWD,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "bun test" },
  });
  await sleep(1500);

  // --- Main spawns a subagent via the Task tool ---
  await post({
    session_id: MAIN,
    cwd: CWD,
    hook_event_name: "PreToolUse",
    tool_name: "Task",
    tool_input: { description: "Explore the client code", subagent_type: "Explore" },
  });
  await sleep(600);
  await post({
    session_id: MAIN,
    cwd: CWD,
    hook_event_name: "SubagentStart",
    subagent_id: SUB,
    parent_session_id: MAIN,
    subagent_type: "Explore",
    tool_input: { description: "Explore the client code" },
  });
  await sleep(800);

  // Subagent explores files while main keeps working. Subagent tool events carry
  // the parent session_id plus a subagent_id discriminator (assumed schema).
  const subExtra = { subagent_id: SUB, parent_session_id: MAIN, subagent_type: "Explore" };
  await Promise.all([
    (async () => {
      await visitFile(MAIN, "Read", "client/src/TreeMap.tsx", subExtra);
      await visitFile(MAIN, "Read", "client/src/AgentDot.tsx", subExtra);
      await visitFile(MAIN, "Read", "shared/types.ts", subExtra);
    })(),
    (async () => {
      await visitFile(MAIN, "Edit", "server/src/tree.ts");
      await visitFile(MAIN, "Write", "README.md");
    })(),
  ]);

  // --- Subagent finishes ---
  await post({
    session_id: MAIN,
    cwd: CWD,
    hook_event_name: "SubagentStop",
    ...subExtra,
  });
  await sleep(1000);

  // Main wraps a final edit and stops.
  await visitFile(MAIN, "Edit", "server/src/index.ts");
  await post({
    session_id: MAIN,
    cwd: CWD,
    hook_event_name: "Stop",
  });

  console.log("\nDemo complete. Dots will linger, then sweep away.");
}

main();
