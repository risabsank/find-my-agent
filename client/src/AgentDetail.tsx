import type { AgentState } from "./types.ts";
import {
  STATUS,
  agentLabel,
  typeName,
  fmtTok,
  elapsed,
  agoLabel,
  clockAt,
} from "./ui.ts";

function StatBlock({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat">
      <div className="stat-val mono">{value}</div>
      <div className="stat-label">
        {label}
        {sub && <span className="stat-sub"> {sub}</span>}
      </div>
    </div>
  );
}

// Coarse lifecycle phases derived from real status (tagged "estimated" in the UI).
const PHASES = ["Started", "Active", "Finished"];
function lifecycleStep(status: AgentState["status"]): number {
  if (status === "stopped" || status === "failed") return 3;
  if (status === "working" || status === "waiting") return 2;
  return 1;
}

/** Detail panel shown when an agent is focused. */
export function AgentDetail({
  agent,
  parent,
  now,
  onBack,
}: {
  agent: AgentState;
  parent: AgentState | null;
  now: number;
  onBack: () => void;
}) {
  const status = STATUS[agent.status];
  const step = lifecycleStep(agent.status);
  const pct = Math.round((step / PHASES.length) * 100);
  const tk = agent.tokens;
  const inPct = tk.totalTokens > 0 ? Math.round((tk.inputTokens / tk.totalTokens) * 100) : 0;
  const activity = [...agent.recentActivity].reverse();

  return (
    <div className="detail">
      <button className="back" onClick={onBack}>
        <span className="back-arrow">‹</span> Back to all agents
      </button>

      <div className="detail-head">
        <span
          className="detail-swatch"
          style={{ background: agent.color, boxShadow: "0 0 0 2px var(--accent)" }}
        />
        <div className="detail-id">
          <div className="detail-type">{typeName(agent)}</div>
          <div className="detail-sid mono">{agentLabel(agent)}</div>
        </div>
        <span className="detail-status">
          <span className="badge-dot" style={{ background: status.ring }} />
          {status.label}
        </span>
      </div>

      {parent && (
        <div className="detail-parent">
          subagent of <span className="mono">{typeName(parent)} {agentLabel(parent)}</span>
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
          {PHASES.map((s, i) => (
            <div
              key={s}
              className={
                "step" + (i < step ? " step--done" : "") + (i === step - 1 ? " step--cur" : "")
              }
            >
              <span
                className="step-tick"
                style={i < step ? { background: "var(--accent)" } : undefined}
              />
              <span className="step-name">{s}</span>
            </div>
          ))}
        </div>
        <div className="pbar">
          <span className="pbar-fill" style={{ width: pct + "%", background: "var(--accent)" }} />
        </div>
        <div className="d-now mono">
          <span className="d-now-tool">{agent.currentTool ?? "—"}</span>
          <span className="d-now-file">{agent.currentFile ?? "thinking…"}</span>
        </div>
      </section>

      <section className="d-sec">
        <h4>
          Token usage <span className="stub">stub</span>
        </h4>
        <div className="tok-bar">
          <span className="tok-in" style={{ width: inPct + "%" }} />
          <span className="tok-out" style={{ width: 100 - inPct + "%" }} />
        </div>
        <div className="tok-legend mono">
          <span>
            <i className="sw sw-in" />in {fmtTok(tk.inputTokens)}
          </span>
          <span>
            <i className="sw sw-out" />out {fmtTok(tk.outputTokens)}
          </span>
        </div>
        <div className="stat-row">
          <StatBlock label="total tokens" value={tk.totalTokens.toLocaleString()} />
          <StatBlock label="est. cost" value={"$" + tk.costUsd.toFixed(4)} sub="stub" />
        </div>
      </section>

      <section className="d-sec">
        <div className="stat-row">
          <StatBlock label="elapsed" value={elapsed(now - agent.startedAt)} />
          <StatBlock label="started" value={clockAt(agent.startedAt)} />
          <StatBlock label="actions" value={String(agent.eventCount)} />
        </div>
      </section>

      <section className="d-sec">
        <h4>Recent activity</h4>
        {activity.length === 0 && <p className="d-task">No activity yet.</p>}
        <ul className="activity">
          {activity.map((ev, i) => (
            <li key={i} className="act">
              <span className="act-tool">{ev.tool ?? ev.event}</span>
              <span className="act-file mono">{ev.filePath ?? "—"}</span>
              <span className="act-ago mono">{agoLabel(now - ev.ts)}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
