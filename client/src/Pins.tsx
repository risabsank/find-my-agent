import type { PointerEvent } from "react";
import type { AgentState } from "./types.ts";
import { STATUS, ALIGNMENT, agentLabel, typeName, fmtTok } from "./ui.ts";

export interface TrailData {
  agentId: string;
  points: { x: number; y: number }[];
}

/** Faint trail through the last few files an agent visited (map space). */
export function Trails({
  trails,
  focusId,
  focusRegion,
}: {
  trails: TrailData[];
  focusId: string | null;
  focusRegion: string | null;
}) {
  return (
    <g>
      {trails.map((t) => {
        if (t.points.length < 2) return null;
        const dim = focusRegion != null && t.agentId !== focusId;
        const focused = t.agentId === focusId;
        const pts = t.points.map((p) => `${p.x},${p.y}`).join(" ");
        return (
          <g
            key={t.agentId}
            opacity={dim ? 0.12 : focused ? 0.9 : 0.4}
            style={{ transition: "opacity .5s ease" }}
          >
            <polyline
              points={pts}
              fill="none"
              stroke={focused ? "var(--accent)" : "oklch(0.5 0.01 250)"}
              strokeWidth={focused ? 1.6 : 1.2}
              strokeDasharray="2 4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            {t.points.slice(0, -1).map((p, i) => (
              <circle
                key={i}
                cx={p.x}
                cy={p.y}
                r={focused ? 2 : 1.6}
                fill={focused ? "var(--accent)" : "oklch(0.5 0.01 250)"}
              />
            ))}
          </g>
        );
      })}
    </g>
  );
}

/** A single agent pin in screen space — constant size as the map zooms. */
export function Pin({
  agent,
  x,
  y,
  invK,
  focused,
  dimmed,
  onEnter,
  onLeave,
  onClick,
  onDragStart,
}: {
  agent: AgentState;
  x: number;
  y: number;
  invK: number;
  focused: boolean;
  dimmed: boolean;
  onEnter: (id: string) => void;
  onLeave: () => void;
  onClick: (id: string) => void;
  onDragStart: (id: string, e: PointerEvent<HTMLDivElement>) => void;
}) {
  const status = STATUS[agent.status];
  // Alignment drives the dot color when the agent is drifting/off-mission, so
  // the map itself shows the autopilot catching problems.
  const drift = agent.alignment && agent.alignment.state !== "on_track" && agent.alignment.state !== "unknown"
    ? ALIGNMENT[agent.alignment.state].color
    : null;
  const ring = focused ? "var(--accent)" : drift ?? status.ring;
  return (
    <div
      className={"pin" + (dimmed ? " pin--dim" : "") + (focused ? " pin--focused" : "")}
      style={{ left: x, top: y, transform: `translate(-50%,-50%) scale(${invK})` }}
      onMouseEnter={() => onEnter(agent.agentId)}
      onMouseLeave={onLeave}
      onPointerDown={(e) => onDragStart(agent.agentId, e)}
      onClick={(e) => {
        e.stopPropagation();
        onClick(agent.agentId);
      }}
    >
      <div className="pin-anchor">
        {(agent.status === "working" || drift) && !dimmed && (
          <span className="pin-pulse" style={{ background: ring }} />
        )}
        <span
          className="pin-dot"
          style={{
            background: agent.color,
            boxShadow: `0 0 0 2px ${ring}, 0 0 0 3.5px oklch(0.16 0.006 250)`,
          }}
        />
      </div>
      <span className={"pin-label" + (focused ? " pin-label--accent" : "")}>
        {agent.isSubagent && <span className="pin-sub">↳</span>}
        {agentLabel(agent)}
        {drift && <span className="pin-flag">⚠</span>}
      </span>
    </div>
  );
}

/** Hover tooltip — compact, near the pin. */
export function Tooltip({ agent, x, y }: { agent: AgentState; x: number; y: number }) {
  const status = STATUS[agent.status];
  return (
    <div className="tooltip" style={{ left: x, top: y }}>
      <div className="tt-head">
        <span className="tt-swatch" style={{ background: agent.color }} />
        <span className="tt-name">{typeName(agent)} </span>
        <span className="tt-id">{agentLabel(agent)}</span>
        <span className="tt-status" style={{ color: status.ring }}>
          ● {status.label}
        </span>
      </div>
      <div className="tt-task">{agent.taskLabel}</div>
      <dl className="tt-grid">
        <dt>tool</dt>
        <dd className="mono">{agent.currentTool || "—"}</dd>
        <dt>file</dt>
        <dd className="mono tt-file">{agent.currentFile || "thinking…"}</dd>
        <dt>tokens</dt>
        <dd className="mono">
          {fmtTok(agent.tokens.totalTokens)} · ${agent.tokens.costUsd.toFixed(4)}
          {agent.tokens.isStub && <span className="stub">stub</span>}
        </dd>
      </dl>
    </div>
  );
}
