import { isAbsolute, relative } from "node:path";
import type { NormalizedEvent } from "../../shared/types.ts";

/** Raw hook payload — loosely typed because schemas vary by event. */
export type RawHook = Record<string, any>;

/**
 * Candidate field names that *might* carry a subagent identifier. The Claude
 * Code docs confirm SubagentStart/SubagentStop exist and match on agent type,
 * but do NOT document an explicit subagent id field on the payload. So we probe
 * a few plausible names and fall back to treating events as the main agent.
 * The /events passthrough log lets us confirm the real field once a live
 * subagent run is observed, after which we can trim this list.
 * TODO: confirm subagent id field from a real Task subagent run.
 */
const SUBAGENT_ID_FIELDS = [
  "subagent_id",
  "subagentId",
  "agent_id",
  "agentId",
];
const PARENT_SESSION_FIELDS = ["parent_session_id", "parentSessionId"];
const AGENT_TYPE_FIELDS = [
  "subagent_type",
  "agent_type",
  "agentType",
  "matcher",
];

function firstString(raw: RawHook, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = raw[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

export interface SubagentInfo {
  isSubagent: boolean;
  /** Stable discriminator appended to sessionId, or null if none found. */
  subagentKey: string | null;
  parentSessionId: string | null;
  agentType?: string;
}

export function getSubagentInfo(raw: RawHook): SubagentInfo {
  const event: string = raw.hook_event_name ?? "";
  const explicitId = firstString(raw, SUBAGENT_ID_FIELDS);
  const parentSessionId = firstString(raw, PARENT_SESSION_FIELDS) ?? null;
  const agentType = firstString(raw, AGENT_TYPE_FIELDS);
  const looksSubagent =
    event === "SubagentStart" ||
    event === "SubagentStop" ||
    explicitId !== undefined ||
    parentSessionId !== null;

  return {
    isSubagent: looksSubagent,
    subagentKey: explicitId ?? agentType ?? (looksSubagent ? "sub" : null),
    parentSessionId,
    agentType,
  };
}

/**
 * Resolve a tool's file_path into a path relative to the mapped repo root.
 * Handles git worktrees: if the path is under the agent's own cwd, the cwd
 * prefix is stripped so it lands on the same tree as the main repo.
 */
export function resolveFilePath(
  raw: RawHook,
  rootDir: string,
): string | null {
  const input = raw.tool_input;
  const filePath: unknown = input?.file_path ?? input?.path ?? input?.notebook_path;
  if (typeof filePath !== "string" || filePath.length === 0) return null;

  const cwd: string | undefined = raw.cwd;
  let candidate = filePath;

  if (isAbsolute(candidate)) {
    // Prefer the agent's own cwd (worktree-aware), then the mapped root.
    if (cwd && candidate.startsWith(cwd)) {
      candidate = relative(cwd, candidate);
    } else if (candidate.startsWith(rootDir)) {
      candidate = relative(rootDir, candidate);
    } else {
      // Outside the mapped repo — show just the basename so it still maps.
      const parts = candidate.split("/");
      return parts[parts.length - 1] || null;
    }
  }
  return candidate.replace(/^\.\//, "");
}

/** Extract a human-readable task label from whatever the event carries. */
export function extractTaskLabel(raw: RawHook): string | undefined {
  const event: string = raw.hook_event_name ?? "";
  if (event === "UserPromptSubmit" && typeof raw.prompt === "string") {
    return truncate(raw.prompt);
  }
  // A Task call is the *parent* spawning a subagent; the description belongs to
  // the subagent (set from SubagentStart), so don't let it clobber the parent.
  if (raw.tool_name === "Task") return undefined;
  const input = raw.tool_input;
  if (typeof input?.description === "string") return truncate(input.description);
  return undefined;
}

function truncate(s: string, n = 140): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > n ? oneLine.slice(0, n - 1) + "…" : oneLine;
}

/**
 * Normalize any raw hook payload into a NormalizedEvent. The mapped repo root
 * is needed to make file paths repo-relative.
 */
export function normalize(raw: RawHook, rootDir: string): NormalizedEvent {
  const sessionId: string = raw.session_id ?? "unknown-session";
  const event: string = raw.hook_event_name ?? "Unknown";
  const sub = getSubagentInfo(raw);

  const agentId = sub.subagentKey
    ? `${sessionId}:${sub.subagentKey}`
    : sessionId;
  const parentId = sub.isSubagent ? sessionId : null;

  return {
    agentId,
    sessionId,
    parentId,
    isSubagent: sub.isSubagent,
    agentType: sub.agentType,
    event,
    tool: typeof raw.tool_name === "string" ? raw.tool_name : null,
    filePath: resolveFilePath(raw, rootDir),
    taskLabel: extractTaskLabel(raw),
    cwd: typeof raw.cwd === "string" ? raw.cwd : undefined,
    ts: Date.now(),
    raw,
  };
}
