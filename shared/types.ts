// Shared data model for Find My Agent.
// Imported by both the collector server and the React client.

export type AgentStatus = "working" | "waiting" | "stopped" | "failed";

/**
 * Token / cost usage for an agent.
 *
 * STUB in v1 — all values are placeholders and `isStub` is true. Claude Code
 * emits real usage natively via OpenTelemetry (CLAUDE_CODE_ENABLE_TELEMETRY=1,
 * metric `claude_code.token.usage` broken down by model/subagent). A future
 * OTEL adapter (see server/src/tokens.ts) will populate these for real.
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  model?: string;
  /** true until a real TokenSource feeds this agent. */
  isStub: boolean;
}

/** A single past action by an agent, for the detail panel's activity feed. */
export interface ActivityEntry {
  event: string;
  tool: string | null;
  filePath: string | null;
  ts: number;
}

export interface AgentState {
  /** sessionId for top-level agents, or `sessionId:subagentKey` for subagents. */
  agentId: string;
  sessionId: string;
  /** null = top-level agent; otherwise the parent agent's agentId. */
  parentId: string | null;
  isSubagent: boolean;
  /** Subagent matcher/type when known (e.g. "Explore", "general-purpose"). */
  agentType?: string;
  status: AgentStatus;
  /** Repo-relative path; drives the dot's position on the map. null = "thinking". */
  currentFile: string | null;
  currentTool: string | null;
  /** Last user prompt / Task description / tool summary. */
  taskLabel: string;
  /** Last hook_event_name seen for this agent. */
  lastEvent: string;
  startedAt: number; // epoch ms
  lastSeenAt: number; // epoch ms
  tokens: TokenUsage;
  /** Total number of events seen for this agent (a rough activity measure). */
  eventCount: number;
  /** Most recent actions, newest last. Capped server-side. */
  recentActivity: ActivityEntry[];
  /** Assigned per top-level agent; subagents inherit + shade. CSS color string. */
  color: string;
}

/**
 * Normalized envelope produced by the server from any raw hook payload.
 * This is what the server broadcasts alongside the updated AgentState.
 */
export interface NormalizedEvent {
  agentId: string;
  sessionId: string;
  parentId: string | null;
  isSubagent: boolean;
  /** Subagent matcher/type when known (e.g. "Explore"). */
  agentType?: string;
  /** hook_event_name */
  event: string;
  tool: string | null;
  /** Resolved repo-relative path, or null when there is no file. */
  filePath: string | null;
  taskLabel?: string;
  cwd?: string;
  ts: number; // epoch ms
  /** Full original payload, for debugging / schema discovery. */
  raw: unknown;
}

export interface TreeNode {
  name: string;
  /** Repo-relative path ("" for the root). */
  path: string;
  type: "dir" | "file";
  children?: TreeNode[];
  /** Bytes, for treemap weighting (files only). */
  size?: number;
}

// ---- WebSocket protocol (server -> client) ----

export interface SnapshotMessage {
  type: "snapshot";
  agents: AgentState[];
  tree: TreeNode | null;
  /** Repo-relative path used to anchor "thinking" dots, or repo name. */
  repoName: string;
}

export interface EventMessage {
  type: "event";
  event: NormalizedEvent;
  /** The full, updated AgentState after applying this event. */
  agent: AgentState;
}

export interface AgentRemovedMessage {
  type: "agentRemoved";
  agentId: string;
}

export type ServerMessage =
  | SnapshotMessage
  | EventMessage
  | AgentRemovedMessage;
