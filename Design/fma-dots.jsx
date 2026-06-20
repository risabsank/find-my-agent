// fma-dots.jsx — agent pins (constant screen size), movement trails, tooltip.
(function(){

// Faint trail through the last few files an agent visited. Lives in map space
// (rendered inside the transformed territory group), so it zooms with the map.
function Trails({ trails, accent, focusId, focusRegion }) {
  return (
    <g>
      {trails.map((t) => {
        if (t.points.length < 2) return null;
        const dim = focusRegion && t.agentId !== focusId;
        const focused = t.agentId === focusId;
        const pts = t.points.map((p) => `${p.x},${p.y}`).join(" ");
        return (
          <g key={t.agentId} opacity={dim ? 0.12 : focused ? 0.9 : 0.4}
             style={{ transition: "opacity .5s ease" }}>
            <polyline points={pts} fill="none"
              stroke={focused ? accent : "oklch(0.5 0.01 250)"}
              strokeWidth={focused ? 1.6 : 1.2} strokeDasharray="2 4"
              strokeLinecap="round" strokeLinejoin="round" />
            {t.points.slice(0, -1).map((p, i) => (
              <circle key={i} cx={p.x} cy={p.y} r={focused ? 2 : 1.6}
                fill={focused ? accent : "oklch(0.5 0.01 250)"} />
            ))}
          </g>
        );
      })}
    </g>
  );
}

// A single agent pin in SCREEN space — stays a constant size as the map zooms.
function Pin({ agent, x, y, invK, status, focused, dimmed, focusMode, accent, onEnter, onLeave, onClick }) {
  const showAccent = focused;
  return (
    <div
      className={"pin" + (dimmed ? " pin--dim" : "") + (focused ? " pin--focused" : "")}
      style={{ left: x, top: y, transform: `translate(-50%,-50%) scale(${invK})` }}
      onMouseEnter={() => onEnter(agent.agentId)}
      onMouseLeave={onLeave}
      onClick={(e) => { e.stopPropagation(); onClick(agent.agentId); }}
    >
      <div className="pin-anchor">
        {agent.status === "working" && !dimmed && (
          <span className="pin-pulse" style={{ background: showAccent ? accent : status.ring }} />
        )}
        <span
          className="pin-dot"
          style={{
            background: agent.swatch,
            boxShadow: `0 0 0 2px ${showAccent ? accent : status.ring}, 0 0 0 3.5px oklch(0.16 0.006 250)`,
          }}
        />
      </div>
      <span className={"pin-label" + (showAccent ? " pin-label--accent" : "")}
            style={showAccent ? { borderColor: accent } : null}>
        {agent.isSubagent && <span className="pin-sub">↳</span>}
        {agent.label}
      </span>
    </div>
  );
}

function fmtTok(n) {
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k";
  return String(n);
}

// Hover tooltip — compact, near the pin.
function Tooltip({ agent, x, y, status }) {
  return (
    <div className="tooltip" style={{ left: x, top: y }}>
      <div className="tt-head">
        <span className="tt-swatch" style={{ background: agent.swatch }} />
        <span className="tt-name">{agent.agentType || (agent.isSubagent ? "subagent" : "agent")} </span>
        <span className="tt-id">{agent.label}</span>
        <span className="tt-status" style={{ color: status.ring }}>● {status.label}</span>
      </div>
      <div className="tt-task">{agent.taskLabel}</div>
      <dl className="tt-grid">
        <dt>tool</dt><dd className="mono">{agent.currentTool || "—"}</dd>
        <dt>file</dt><dd className="mono tt-file">{agent.currentFile || "thinking…"}</dd>
        <dt>tokens</dt><dd className="mono">{fmtTok(agent.tokens.totalTokens)} · ${agent.tokens.costUsd.toFixed(4)}
          {agent.tokens.isStub && <span className="stub">stub</span>}</dd>
      </dl>
    </div>
  );
}

window.FMADots = { Trails, Pin, Tooltip, fmtTok };
})();
