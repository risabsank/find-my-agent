// fma-sidebar.jsx — right sidebar: agent LIST (default) and DETAIL panel (focus).
(function(){
const { fmtTok } = window.FMADots;

function elapsed(ago) {
  const s = Math.max(0, Math.floor(ago / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
function agoLabel(ago) {
  const s = Math.max(0, Math.floor(ago / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}
function clockAt(ago) {
  const d = new Date(Date.now() - ago);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

// ---- LIST -------------------------------------------------------------
function AgentRow({ agent, status, hovered, onHover, onLeave, onClick }) {
  return (
    <li
      className={"row" + (agent.isSubagent ? " row--sub" : "") + (hovered ? " row--hover" : "")}
      onMouseEnter={() => onHover(agent.agentId)}
      onMouseLeave={onLeave}
      onClick={() => onClick(agent.agentId)}
    >
      <div className="row-head">
        <span className="row-swatch" style={{ background: agent.swatch }} />
        <span className="row-name">
          {agent.agentType || (agent.isSubagent ? "subagent" : "agent")}
          <span className="row-id mono"> {agent.label}</span>
        </span>
        <span className="row-badge">
          <span className="badge-dot" style={{ background: status.ring }} />
          {status.label}
        </span>
      </div>
      <div className="row-task">{agent.taskLabel}</div>
      <div className="row-meta mono">
        <span className="row-file" title={agent.currentFile || "thinking"}>
          {agent.currentFile || "thinking…"}
        </span>
        <span className="row-elapsed">{elapsed(agent.startedAtAgo)}</span>
      </div>
      <div className="row-tokens mono">
        <span>{fmtTok(agent.tokens.totalTokens)} tok</span>
        <span className="row-cost">${agent.tokens.costUsd.toFixed(4)}</span>
        {agent.tokens.isStub && <span className="stub">stub</span>}
      </div>
    </li>
  );
}

function AgentListPanel({ agents, statusOf, hoveredId, onHover, onLeave, onClick }) {
  const tops = agents.filter((a) => !a.parentId);
  const ordered = [];
  for (const t of tops) {
    ordered.push(t);
    for (const c of agents.filter((a) => a.parentId === t.agentId)) ordered.push(c);
  }
  for (const a of agents) if (!ordered.includes(a)) ordered.push(a);

  return (
    <ul className="agent-list">
      {ordered.map((a) => (
        <AgentRow key={a.agentId} agent={a} status={statusOf(a)}
          hovered={hoveredId === a.agentId} onHover={onHover} onLeave={onLeave} onClick={onClick} />
      ))}
    </ul>
  );
}

// ---- DETAIL -----------------------------------------------------------
function StatBlock({ label, value, sub }) {
  return (
    <div className="stat">
      <div className="stat-val mono">{value}</div>
      <div className="stat-label">{label}{sub && <span className="stat-sub"> {sub}</span>}</div>
    </div>
  );
}

function DetailPanel({ agent, parent, status, accent, onBack }) {
  const p = agent.progress;
  const pct = Math.round((p.step / p.steps.length) * 100);
  const tk = agent.tokens;
  const inPct = Math.round((tk.inputTokens / tk.totalTokens) * 100);

  return (
    <div className="detail">
      <button className="back" onClick={onBack}>
        <span className="back-arrow">‹</span> Back to all agents
      </button>

      <div className="detail-head">
        <span className="detail-swatch" style={{ background: agent.swatch, boxShadow: `0 0 0 2px ${accent}` }} />
        <div className="detail-id">
          <div className="detail-type">{agent.agentType || (agent.isSubagent ? "subagent" : "agent")}</div>
          <div className="detail-sid mono">{agent.label}</div>
        </div>
        <span className="detail-status">
          <span className="badge-dot" style={{ background: status.ring }} />{status.label}
        </span>
      </div>

      {parent && (
        <div className="detail-parent">
          subagent of <span className="mono">{parent.agentType || "agent"} {parent.label}</span>
        </div>
      )}

      <section className="d-sec">
        <h4>Working on</h4>
        <p className="d-task">{agent.taskLabel}</p>
      </section>

      <section className="d-sec">
        <div className="d-sec-head">
          <h4>Progress</h4>
          <span className="estimate-tag">estimated</span>
        </div>
        <div className="steps">
          {p.steps.map((s, i) => (
            <div key={s} className={"step" + (i < p.step ? " step--done" : "") + (i === p.step - 1 ? " step--cur" : "")}>
              <span className="step-tick" style={i < p.step ? { background: accent, borderColor: accent } : null} />
              <span className="step-name">{s}</span>
            </div>
          ))}
        </div>
        <div className="pbar"><span className="pbar-fill" style={{ width: pct + "%", background: accent }} /></div>
        <div className="d-now mono">
          <span className="d-now-tool">{agent.currentTool}</span>
          <span className="d-now-file">{agent.currentFile || "thinking…"}</span>
        </div>
      </section>

      <section className="d-sec">
        <h4>Token usage <span className="stub">stub</span></h4>
        <div className="tok-bar">
          <span className="tok-in" style={{ width: inPct + "%" }} />
          <span className="tok-out" style={{ width: (100 - inPct) + "%" }} />
        </div>
        <div className="tok-legend mono">
          <span><i className="sw sw-in" />in {fmtTok(tk.inputTokens)}</span>
          <span><i className="sw sw-out" />out {fmtTok(tk.outputTokens)}</span>
        </div>
        <div className="stat-row">
          <StatBlock label="total tokens" value={tk.totalTokens.toLocaleString()} />
          <StatBlock label="est. cost" value={"$" + tk.costUsd.toFixed(4)} sub="stub" />
        </div>
      </section>

      <section className="d-sec">
        <div className="stat-row">
          <StatBlock label="elapsed" value={elapsed(agent.startedAtAgo)} />
          <StatBlock label="started" value={clockAt(agent.startedAtAgo)} />
        </div>
      </section>

      <section className="d-sec">
        <h4>Recent activity</h4>
        <ul className="activity">
          {agent.activity.map((ev, i) => (
            <li key={i} className="act">
              <span className="act-tool">{ev.tool}</span>
              <span className="act-file mono">{ev.file}</span>
              <span className="act-ago mono">{agoLabel(ev.ago)}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

window.FMASidebar = { AgentListPanel, DetailPanel, elapsed };
})();
