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

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { COLLECTOR_HTTP } from "../shared/config.ts";

const CWD = process.env.TARGET_REPO || process.cwd();
const MAIN = "demo-session-main";
const SUB = "demo-subagent-1";

// Real (throwaway) files the demo creates so the map genuinely expands —
// the server scans the filesystem, so fake events alone can't add cells.
const SCRATCH_REL = "demo/scratch";
const SCRATCH_DIR = join(CWD, SCRATCH_REL);
function cleanupScratch(): void {
  try {
    rmSync(SCRATCH_DIR, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

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

// Actually create a file on disk, then emit the matching Write events. The file
// must exist for the server's filesystem re-scan to add a cell to the map.
async function createFile(
  session: string,
  relPath: string,
  content: string,
): Promise<void> {
  await post({
    session_id: session,
    cwd: CWD,
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file_path: relPath },
  });
  await sleep(900);
  writeFileSync(join(CWD, relPath), content); // now it exists on disk
  await post({
    session_id: session,
    cwd: CWD,
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: relPath },
    tool_response: { ok: true },
  });
  await sleep(1700); // let the debounced re-scan broadcast the expanded tree
}

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
      await visitFile(MAIN, "Read", "client/src/Pins.tsx", subExtra);
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

  // Main wraps a final edit.
  await visitFile(MAIN, "Edit", "server/src/index.ts");

  // --- Main creates brand-new files: watch the map EXPAND live ---
  mkdirSync(SCRATCH_DIR, { recursive: true });
  await createFile(MAIN, `${SCRATCH_REL}/feature-a.ts`, "export const a = 1;\n");
  await createFile(MAIN, `${SCRATCH_REL}/feature-b.ts`, "export const b = 2;\n");
  await sleep(2500); // linger so the new cells are clearly visible

  // --- Main cleans up: watch the map CONTRACT ---
  console.log("main  cleanup          rm -rf demo/scratch");
  cleanupScratch();
  await post({ session_id: MAIN, cwd: CWD, hook_event_name: "Stop" }); // triggers a re-scan → cells vanish

  console.log("\nDemo complete. Dots will linger, then sweep away.");
}

process.on("SIGINT", () => {
  cleanupScratch();
  process.exit(130);
});

main().finally(cleanupScratch);
