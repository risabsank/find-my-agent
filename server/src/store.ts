import type {
  AgentState,
  AgentStatus,
  NormalizedEvent,
} from "../../shared/types.ts";
import { STALE_SECONDS, REMOVE_AFTER_SECONDS } from "../../shared/config.ts";
import { tokenSource } from "./tokens.ts";

// Distinct, "Find My"-ish colors assigned to top-level agents in order.
const PALETTE = [
  "#3b82f6", // blue
  "#22c55e", // green
  "#f59e0b", // amber
  "#ec4899", // pink
  "#8b5cf6", // violet
  "#14b8a6", // teal
  "#ef4444", // red
  "#eab308", // yellow
];

/** Map a hook event name to an agent status. */
function statusForEvent(event: string): AgentStatus | null {
  switch (event) {
    case "PreToolUse":
    case "PostToolUse":
    case "PostToolBatch":
    case "UserPromptSubmit":
    case "SessionStart":
    case "SubagentStart":
      return "working";
    case "Stop":
    case "SubagentStop":
    case "SessionEnd":
      return "stopped";
    case "Notification":
      return "waiting";
    case "PostToolUseFailure":
    case "StopFailure":
      return "failed";
    default:
      return null; // leave status unchanged
  }
}

/** Shade a hex color toward white for subagents. */
function shade(hex: string, amount = 0.4): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  const mix = (c: number) => Math.round(c + (255 - c) * amount);
  return `#${[mix(r), mix(g), mix(b)]
    .map((c) => c.toString(16).padStart(2, "0"))
    .join("")}`;
}

export class AgentStore {
  private agents = new Map<string, AgentState>();
  private colorIndex = 0;

  /** Apply a normalized event, returning the updated AgentState. */
  apply(ev: NormalizedEvent): AgentState {
    let agent = this.agents.get(ev.agentId);
    const now = ev.ts;

    if (!agent) {
      tokenSource.register?.(ev.agentId);
      agent = {
        agentId: ev.agentId,
        sessionId: ev.sessionId,
        parentId: ev.parentId,
        isSubagent: ev.isSubagent,
        status: "working",
        currentFile: null,
        currentTool: null,
        taskLabel: ev.taskLabel ?? "(starting…)",
        lastEvent: ev.event,
        startedAt: now,
        lastSeenAt: now,
        tokens: tokenSource.getUsage(ev.agentId),
        eventCount: 0,
        recentActivity: [],
        color: this.assignColor(ev),
      };
      this.agents.set(ev.agentId, agent);
    }

    // Update parentage if it became known later.
    if (ev.parentId && !agent.parentId) {
      agent.parentId = ev.parentId;
      agent.isSubagent = true;
      agent.color = this.assignColor(ev); // re-shade off parent
    }

    const status = statusForEvent(ev.event);
    if (status) agent.status = status;

    if (ev.agentType) agent.agentType = ev.agentType;
    if (ev.tool) agent.currentTool = ev.tool;
    if (ev.filePath) agent.currentFile = ev.filePath;
    // On Stop/SessionEnd, the agent is no longer "at" a file.
    if (status === "stopped") agent.currentTool = null;
    if (ev.taskLabel) agent.taskLabel = ev.taskLabel;

    agent.lastEvent = ev.event;
    agent.lastSeenAt = now;
    agent.tokens = tokenSource.getUsage(ev.agentId);
    agent.eventCount += 1;
    agent.recentActivity.push({
      event: ev.event,
      tool: ev.tool,
      filePath: ev.filePath,
      ts: now,
    });
    if (agent.recentActivity.length > 12) agent.recentActivity.shift();

    return agent;
  }

  private assignColor(ev: NormalizedEvent): string {
    if (ev.parentId) {
      const parent = this.agents.get(ev.parentId);
      if (parent) return shade(parent.color, 0.45);
    }
    const color = PALETTE[this.colorIndex % PALETTE.length];
    this.colorIndex++;
    return color;
  }

  get(agentId: string): AgentState | undefined {
    return this.agents.get(agentId);
  }

  /** Restore a persisted agent (rehydrate from Redis on boot). */
  hydrate(agent: AgentState): void {
    this.agents.set(agent.agentId, agent);
  }

  /** Autopilot: set/merge an agent's mission. Returns the agent if present. */
  setMission(agentId: string, mission: AgentState["mission"]): AgentState | undefined {
    const a = this.agents.get(agentId);
    if (a) a.mission = mission;
    return a;
  }

  /** Autopilot: record the latest alignment verdict. Returns the agent. */
  setAlignment(agentId: string, alignment: AgentState["alignment"]): AgentState | undefined {
    const a = this.agents.get(agentId);
    if (a) a.alignment = alignment;
    return a;
  }

  /** Queue a user-directed file focus request for the agent. */
  setFocusRequest(agentId: string, filePath: string, now = Date.now()): AgentState | undefined {
    const a = this.agents.get(agentId);
    if (a) a.focusRequest = { filePath, requestedAt: now };
    return a;
  }

  /** Mark the queued focus request as injected into the agent context. */
  markFocusDelivered(agentId: string, now = Date.now()): AgentState | undefined {
    const a = this.agents.get(agentId);
    if (a?.focusRequest && !a.focusRequest.deliveredAt) {
      a.focusRequest = { ...a.focusRequest, deliveredAt: now };
    }
    return a;
  }

  snapshot(): AgentState[] {
    // Refresh stub token usage so a late-joining client sees current values.
    for (const a of this.agents.values()) {
      a.tokens = tokenSource.getUsage(a.agentId);
    }
    return [...this.agents.values()];
  }

  /**
   * Periodic maintenance:
   *  - working/waiting agents idle > STALE_SECONDS decay to "waiting"
   *  - stopped/failed agents older than REMOVE_AFTER_SECONDS are removed
   * Returns the agents whose status changed and the ids that were removed.
   */
  sweep(now = Date.now()): { changed: AgentState[]; removed: string[] } {
    const changed: AgentState[] = [];
    const removed: string[] = [];
    for (const a of this.agents.values()) {
      const idleSec = (now - a.lastSeenAt) / 1000;
      if (
        (a.status === "stopped" || a.status === "failed") &&
        idleSec > REMOVE_AFTER_SECONDS
      ) {
        this.agents.delete(a.agentId);
        removed.push(a.agentId);
        continue;
      }
      if (
        (a.status === "working") &&
        idleSec > STALE_SECONDS
      ) {
        a.status = "waiting";
        changed.push(a);
      }
    }
    return { changed, removed };
  }
}
