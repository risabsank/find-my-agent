// Installs/uninstalls CartoAI's HTTP hooks into a .claude/settings.json by
// deep-merging the snippet (existing hooks preserved). Reused by the `fma` CLI.
//
// Standalone usage (project-scoped):
//   bun run hooks/install.ts <target-repo> [--port 4000] [--print]
//   bun run hooks/install.ts --print        # just print the snippet

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
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

export function hookUrl(port: number): string {
  return `http://localhost:${port}/events`;
}

/** Path to the user-level (global) Claude settings file. */
export function globalSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

/** Path to a project's Claude settings file. */
export function projectSettingsPath(repo: string): string {
  return join(resolve(repo), ".claude", "settings.json");
}

export function buildSnippet(port: number): Record<string, MatcherGroup[]> {
  const url = hookUrl(port);
  const out: Record<string, MatcherGroup[]> = {};
  for (const ev of EVENTS) {
    const group: MatcherGroup = { hooks: [{ type: "http", url, timeout: 5 }] };
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

function readSettings(settingsPath: string): Settings {
  if (!existsSync(settingsPath)) return {};
  try {
    return JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch (e) {
    throw new Error(`Could not parse existing ${settingsPath}: ${String(e)}`);
  }
}

/** Merge our HTTP hooks into settingsPath (idempotent). */
export function installHooks(opts: { settingsPath: string; port?: number }): {
  added: number;
  skipped: number;
  url: string;
  settingsPath: string;
} {
  const port = opts.port ?? COLLECTOR_PORT;
  const snippet = buildSnippet(port);
  const url = hookUrl(port);
  mkdirSync(dirname(opts.settingsPath), { recursive: true });
  const settings = readSettings(opts.settingsPath);
  settings.hooks ??= {};

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
  writeFileSync(opts.settingsPath, JSON.stringify(settings, null, 2) + "\n");
  return { added, skipped, url, settingsPath: opts.settingsPath };
}

/** Remove our HTTP hooks from settingsPath. */
export function uninstallHooks(opts: { settingsPath: string; port?: number }): {
  removed: number;
  settingsPath: string;
} {
  const port = opts.port ?? COLLECTOR_PORT;
  const url = hookUrl(port);
  if (!existsSync(opts.settingsPath)) return { removed: 0, settingsPath: opts.settingsPath };
  const settings = readSettings(opts.settingsPath);
  if (!settings.hooks) return { removed: 0, settingsPath: opts.settingsPath };

  let removed = 0;
  for (const ev of Object.keys(settings.hooks)) {
    const groups = settings.hooks[ev];
    const kept: MatcherGroup[] = [];
    for (const g of groups) {
      const before = g.hooks?.length ?? 0;
      g.hooks = (g.hooks ?? []).filter((h) => !(h.type === "http" && h.url === url));
      removed += before - g.hooks.length;
      if (g.hooks.length > 0) kept.push(g);
    }
    if (kept.length > 0) settings.hooks[ev] = kept;
    else delete settings.hooks[ev];
  }
  writeFileSync(opts.settingsPath, JSON.stringify(settings, null, 2) + "\n");
  return { removed, settingsPath: opts.settingsPath };
}

// ---- Standalone CLI (project-scoped) ----------------------------------------
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

  if (print || !target) {
    if (!target && !print) {
      console.error("Usage: bun run hooks/install.ts <target-repo> [--port N] [--print]\n");
    }
    console.log(JSON.stringify({ hooks: buildSnippet(port) }, null, 2));
    if (!target) process.exit(print ? 0 : 1);
    return;
  }

  const repo = resolve(target);
  if (!existsSync(repo)) {
    console.error(`Target repo does not exist: ${repo}`);
    process.exit(1);
  }

  const settingsPath = projectSettingsPath(repo);
  const { added, skipped, url } = installHooks({ settingsPath, port });
  console.log(`✓ Wrote ${settingsPath}`);
  console.log(`  ${added} event hook(s) added, ${skipped} already present.`);
  console.log(`  Collector URL: ${url}`);
  console.log(`\n  Start the collector from this repo so it maps the right tree:`);
  console.log(`    TARGET_REPO=${repo} COLLECTOR_PORT=${port} bun run server`);
  console.log(`  Then run \`claude\` inside ${repo} and watch the dots move.`);
}

if (import.meta.main) main();
