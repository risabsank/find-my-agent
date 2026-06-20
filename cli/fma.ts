#!/usr/bin/env bun
// fma — Find My Agent launcher. Run it inside the repo you're coding in.
//
//   fma                 watch the current directory; serve UI; open the browser
//   fma watch [path]    watch a specific repo
//   fma install         install HTTP hooks globally (~/.claude/settings.json)
//   fma install --project [path]   install hooks into one repo instead
//   fma uninstall [--project path] remove our hooks
//   fma help
//
// Flags: --port N (collector port), --no-open (don't open the browser).

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  installHooks,
  uninstallHooks,
  globalSettingsPath,
  projectSettingsPath,
} from "../hooks/install.ts";

const ROOT = resolve(import.meta.dir, "..");
const SERVER_ENTRY = resolve(ROOT, "server/src/index.ts");
const CLIENT_DIR = resolve(ROOT, "client");
const DIST_INDEX = resolve(CLIENT_DIR, "dist/index.html");

function arg(flags: string[], name: string): string | undefined {
  const i = flags.indexOf(name);
  return i >= 0 ? flags[i + 1] : undefined;
}

function port(flags: string[]): number {
  const p = arg(flags, "--port");
  return p ? Number(p) : Number(process.env.COLLECTOR_PORT || 4000);
}

async function isCollectorUp(p: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${p}/api/health`, {
      signal: AbortSignal.timeout(700),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
  } catch {
    /* best effort */
  }
}

async function ensureBuilt(): Promise<void> {
  if (existsSync(DIST_INDEX)) return;
  console.log("Building the UI (one-time)…");
  const proc = Bun.spawn(["bun", "run", "--cwd", CLIENT_DIR, "build"], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0 || !existsSync(DIST_INDEX)) {
    console.error("UI build failed.");
    process.exit(1);
  }
}

async function watch(flags: string[]): Promise<void> {
  const repoArg = flags.find((a) => !a.startsWith("--"));
  const repo = resolve(repoArg ?? process.cwd());
  const p = port(flags);
  const url = `http://localhost:${p}`;
  const noOpen = flags.includes("--no-open");

  if (!existsSync(repo)) {
    console.error(`Repo does not exist: ${repo}`);
    process.exit(1);
  }

  // If a collector is already running, don't start a second — just open the URL.
  if (await isCollectorUp(p)) {
    console.log(`A collector is already running on ${url} (it maps whatever repo it was started with).`);
    console.log("Stop it first if you want to switch repos. Opening the dashboard…");
    if (!noOpen) openBrowser(url);
    return;
  }

  await ensureBuilt();

  process.env.TARGET_REPO = repo;
  process.env.COLLECTOR_PORT = String(p);

  console.log(`\n  Find My Agent`);
  console.log(`  Watching ${repo}`);
  console.log(`  Open     ${url}\n`);

  // Start the collector (serves UI + API + WS) in this process.
  await import(SERVER_ENTRY);

  // Once it answers health, open the browser. The server keeps the process alive.
  if (!noOpen) {
    for (let i = 0; i < 20; i++) {
      if (await isCollectorUp(p)) {
        openBrowser(url);
        break;
      }
      await Bun.sleep(150);
    }
  }
}

function doInstall(flags: string[]): void {
  const p = port(flags);
  const projIdx = flags.indexOf("--project");
  if (projIdx >= 0) {
    const repo = flags[projIdx + 1] && !flags[projIdx + 1].startsWith("--")
      ? flags[projIdx + 1]
      : process.cwd();
    const r = installHooks({ settingsPath: projectSettingsPath(repo), port: p });
    console.log(`✓ ${r.added} hook(s) added, ${r.skipped} already present`);
    console.log(`  ${r.settingsPath}`);
  } else {
    const r = installHooks({ settingsPath: globalSettingsPath(), port: p });
    console.log(`✓ Global hooks: ${r.added} added, ${r.skipped} already present`);
    console.log(`  ${r.settingsPath}`);
    console.log(`\n  Every Claude Code session now reports to ${r.url}.`);
    console.log(`  Run \`fma\` inside the repo you want to watch, then open the link.`);
  }
}

function doUninstall(flags: string[]): void {
  const p = port(flags);
  const projIdx = flags.indexOf("--project");
  const settingsPath =
    projIdx >= 0
      ? projectSettingsPath(
          flags[projIdx + 1] && !flags[projIdx + 1].startsWith("--")
            ? flags[projIdx + 1]
            : process.cwd(),
        )
      : globalSettingsPath();
  const r = uninstallHooks({ settingsPath, port: p });
  console.log(`✓ Removed ${r.removed} hook(s) from ${r.settingsPath}`);
}

function help(): void {
  console.log(`Find My Agent — live map of your Claude Code agents

Usage:
  fma                       watch the current directory and open the dashboard
  fma watch [path]          watch a specific repo
  fma install               install HTTP hooks globally (~/.claude/settings.json)
  fma install --project [p] install hooks into one repo instead
  fma uninstall [--project p]
  fma help

Flags:
  --port N     collector port (default 4000)
  --no-open    don't open the browser

First time:  fma install   (once)
Each session: cd <your repo> && fma`);
}

const argv = process.argv.slice(2);
const cmd = argv[0];
if (cmd === "install") {
  doInstall(argv.slice(1));
} else if (cmd === "uninstall") {
  doUninstall(argv.slice(1));
} else if (cmd === "help" || cmd === "--help" || cmd === "-h") {
  help();
} else if (cmd === "watch") {
  await watch(argv.slice(1));
} else {
  // No args, a path, or flags (e.g. `fma`, `fma /repo`, `fma --no-open`) → watch.
  await watch(argv);
}
