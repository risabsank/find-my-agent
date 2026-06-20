// Installs Find My Agent's HTTP hooks into a target repo's
// .claude/settings.json by deep-merging the snippet (existing hooks preserved).
//
//   bun run hooks/install.ts <target-repo> [--port 4000] [--print]
//
// Examples:
//   bun run hooks/install.ts ../my-project
//   bun run hooks/install.ts ../my-project --port 4100
//   bun run hooks/install.ts --print        # just print the snippet, install nothing

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { COLLECTOR_PORT } from "../shared/config.ts";

const EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "SubagentStart",
  "SubagentStop",
  "Stop",
] as const;

const TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse"]);

type HookEntry = { type: string; url?: string; timeout?: number };
type MatcherGroup = { matcher?: string; hooks: HookEntry[] };
type Settings = { hooks?: Record<string, MatcherGroup[]> } & Record<string, unknown>;

function buildSnippet(port: number): Record<string, MatcherGroup[]> {
  const url = `http://localhost:${port}/events`;
  const out: Record<string, MatcherGroup[]> = {};
  for (const ev of EVENTS) {
    const group: MatcherGroup = {
      hooks: [{ type: "http", url, timeout: 5 }],
    };
    if (TOOL_EVENTS.has(ev)) group.matcher = "";
    out[ev] = [group];
  }
  return out;
}

function hasHttpHookFor(groups: MatcherGroup[], url: string): boolean {
  return groups.some((g) =>
    (g.hooks ?? []).some((h) => h.type === "http" && h.url === url),
  );
}

function parseArgs(argv: string[]) {
  let target: string | null = null;
  let port = COLLECTOR_PORT;
  let print = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--print") print = true;
    else if (a === "--port") port = Number(argv[++i]);
    else if (!a.startsWith("--")) target = a;
  }
  return { target, port, print };
}

function main() {
  const { target, port, print } = parseArgs(process.argv.slice(2));
  const snippet = buildSnippet(port);

  if (print || !target) {
    if (!target && !print) {
      console.error("Usage: bun run hooks/install.ts <target-repo> [--port N] [--print]\n");
    }
    console.log(JSON.stringify({ hooks: snippet }, null, 2));
    if (!target) process.exit(print ? 0 : 1);
    return;
  }

  const repo = resolve(target);
  if (!existsSync(repo)) {
    console.error(`Target repo does not exist: ${repo}`);
    process.exit(1);
  }

  const claudeDir = join(repo, ".claude");
  const settingsPath = join(claudeDir, "settings.json");
  mkdirSync(claudeDir, { recursive: true });

  let settings: Settings = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch (e) {
      console.error(`Could not parse existing ${settingsPath}:`, e);
      process.exit(1);
    }
  }

  settings.hooks ??= {};
  const url = `http://localhost:${port}/events`;
  let added = 0;
  let skipped = 0;

  for (const ev of EVENTS) {
    const existing = (settings.hooks[ev] ??= []);
    if (hasHttpHookFor(existing, url)) {
      skipped++;
      continue;
    }
    existing.push(...snippet[ev]);
    added++;
  }

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");

  console.log(`✓ Wrote ${settingsPath}`);
  console.log(`  ${added} event hook(s) added, ${skipped} already present.`);
  console.log(`  Collector URL: ${url}`);
  console.log(`\n  Start the collector from this repo so it maps the right tree:`);
  console.log(`    TARGET_REPO=${repo} COLLECTOR_PORT=${port} bun run server`);
  console.log(`  Then run \`claude\` inside ${repo} and watch the dots move.`);
}

main();
