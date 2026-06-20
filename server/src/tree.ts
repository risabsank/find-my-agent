import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join, relative, basename } from "node:path";
import type { TreeNode } from "../../shared/types.ts";

// Directories/files we always skip, regardless of .gitignore.
const DEFAULT_IGNORE = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".cache",
  ".DS_Store",
  "coverage",
  ".turbo",
]);

/**
 * Very small .gitignore matcher. Supports the common cases:
 *   - bare names / paths (e.g. `dist`, `build/`)
 *   - leading `*` / trailing `*` simple globs (e.g. `*.log`)
 * It deliberately does NOT implement full gitignore semantics (negation,
 * nested .gitignore, `**`). Good enough to keep the map clean in v1.
 */
function loadIgnore(rootDir: string): (name: string) => boolean {
  const patterns: string[] = [];
  const gitignorePath = join(rootDir, ".gitignore");
  if (existsSync(gitignorePath)) {
    for (const line of readFileSync(gitignorePath, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      if (trimmed.startsWith("!")) continue; // negation unsupported
      patterns.push(trimmed.replace(/\/$/, "").replace(/^\//, ""));
    }
  }
  return (name: string) => {
    if (DEFAULT_IGNORE.has(name)) return true;
    for (const p of patterns) {
      if (p === name) return true;
      if (p.startsWith("*") && name.endsWith(p.slice(1))) return true;
      if (p.endsWith("*") && name.startsWith(p.slice(0, -1))) return true;
    }
    return false;
  };
}

const MAX_DEPTH = 12;

function scanDir(
  absPath: string,
  rootDir: string,
  isIgnored: (name: string) => boolean,
  depth: number,
): TreeNode {
  const relPath = relative(rootDir, absPath);
  const node: TreeNode = {
    name: relPath === "" ? basename(rootDir) : basename(absPath),
    path: relPath,
    type: "dir",
    children: [],
  };
  if (depth >= MAX_DEPTH) return node;

  let entries: string[];
  try {
    entries = readdirSync(absPath);
  } catch {
    return node;
  }

  for (const entry of entries.sort()) {
    if (entry.startsWith(".") && entry !== ".claude") {
      // Skip dotfiles/dirs except .claude (useful to see hook config land).
      if (isIgnored(entry)) continue;
    }
    if (isIgnored(entry)) continue;
    const childAbs = join(absPath, entry);
    let st;
    try {
      st = statSync(childAbs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      const child = scanDir(childAbs, rootDir, isIgnored, depth + 1);
      // Drop empty directories to keep the treemap tidy.
      if (child.children && child.children.length > 0) node.children!.push(child);
    } else if (st.isFile()) {
      node.children!.push({
        name: entry,
        path: relative(rootDir, childAbs),
        type: "file",
        size: Math.max(st.size, 1),
      });
    }
  }
  return node;
}

/** Scan a repo directory into a TreeNode, respecting .gitignore (subset). */
export function scanTree(rootDir: string): TreeNode {
  const isIgnored = loadIgnore(rootDir);
  return scanDir(rootDir, rootDir, isIgnored, 0);
}
