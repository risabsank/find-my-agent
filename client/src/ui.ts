import type { AgentState, AgentStatus } from "./types.ts";

/** Status → ring color + label, matching the design's near-monochrome palette. */
export const STATUS: Record<AgentStatus, { ring: string; label: string }> = {
  working: { ring: "oklch(0.74 0.12 150)", label: "working" },
  waiting: { ring: "oklch(0.78 0.13 75)", label: "waiting" },
  stopped: { ring: "oklch(0.6 0.01 250)", label: "stopped" },
  failed: { ring: "oklch(0.64 0.16 25)", label: "failed" },
};

export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

/** The label shown on a pin / as a row id: agent type when known, else short id. */
export function agentLabel(a: AgentState): string {
  return a.agentType ?? shortId(a.sessionId);
}

/** The human "name" for an agent (type, or generic role). */
export function typeName(a: AgentState): string {
  return a.agentType ?? (a.isSubagent ? "subagent" : "agent");
}

export function fmtTok(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k";
  return String(n);
}

export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function agoLabel(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 2) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

export function clockAt(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}
