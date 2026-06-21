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

// ---- Alignment Autopilot ----------------------------------------------------

/** What an agent is supposed to be doing — its intended scope + guardrails. */
export interface Mission {
  /** Plain-language objective (auto-derived from the prompt, or set in the UI). */
  goal: string;
  /** Glob-ish path patterns the agent is expected to stay inside. */
  allowedGlobs: string[];
  /** Human-readable rules, e.g. "don't modify tests". */
  guardrails: string[];
  /** Glob-ish path patterns the agent must NOT touch, e.g. "auth/**". */
  denyGlobs: string[];
  source: "prompt" | "manual" | "merged";
}

/** The AI's latest judgment of whether an agent is on-mission. */
export interface Alignment {
  state: "on_track" | "drifting" | "off_track" | "unknown";
  reason?: string;
  /** Concrete steering text injected/denied-with when off course. */
  correction?: string;
  severity?: "low" | "med" | "high";
  /** How many past memories were recalled to inform this verdict (Redis). */
  recalled?: number;
  at: number; // epoch ms
}

/** One supervisor action, for the live intervention timeline. */
export interface InterventionEntry {
  agentId: string;
  kind: "detected" | "nudge" | "block" | "boundary" | "recovered";
  reason: string;
  tool?: string;
  filePath?: string;
  ts: number;
}

/** Global autopilot state shown in the topbar. */
export interface SupervisorStatus {
  enabled: boolean; // false when no ANTHROPIC_API_KEY
  autonomous: boolean; // act automatically vs. observe-only
  killSwitch: boolean; // hard stop: never intervene
  model: string;
  /** Redis persistence on (REDIS_URL set + connected). */
  persisted: boolean;
  /** Agent-memory recall mode. */
  memory: "vector" | "fulltext" | "off";
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
  /** What this agent is supposed to be doing (autopilot). */
  mission?: Mission;
  /** Latest AI alignment verdict (autopilot). */
  alignment?: Alignment;
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
  /** Autopilot state + recent interventions (for late-joining clients). */
  supervisor: SupervisorStatus;
  interventions: InterventionEntry[];
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

/** Pushed whenever the mapped repo's file tree changes (create/delete/rename). */
export interface TreeMessage {
  type: "tree";
  tree: TreeNode;
  repoName: string;
  /** Repo-relative paths that appeared since the previous tree (create/rename). */
  newPaths: string[];
}

/** A supervisor action happened (live timeline). */
export interface InterventionMessage {
  type: "intervention";
  entry: InterventionEntry;
}

/** Autopilot status changed (enabled/autonomous/kill-switch). */
export interface SupervisorStatusMessage {
  type: "supervisorStatus";
  supervisor: SupervisorStatus;
}

export type ServerMessage =
  | SnapshotMessage
  | EventMessage
  | AgentRemovedMessage
  | TreeMessage
  | InterventionMessage
  | SupervisorStatusMessage;
