import { useEffect, useState } from "react";
import type { AgentState, InterventionEntry, Mission } from "./types.ts";
import {
  STATUS,
  ALIGNMENT,
  agentLabel,
  typeName,
  fmtTok,
  elapsed,
  agoLabel,
  clockAt,
} from "./ui.ts";

const KIND_LABEL: Record<InterventionEntry["kind"], string> = {
  detected: "drift detected",
  nudge: "steered",
  block: "blocked",
  boundary: "territory breach",
  recovered: "recovered",
};
const KIND_COLOR: Record<InterventionEntry["kind"], string> = {
  detected: ALIGNMENT.drifting.color,
  nudge: "var(--accent)",
  block: ALIGNMENT.off_track.color,
  boundary: ALIGNMENT.drifting.color,
  recovered: ALIGNMENT.on_track.color,
};

/** Editable mission form (goal + guardrails + off-limits paths). */
function MissionEditor({
  mission,
  onSave,
}: {
  mission?: Mission;
  onSave: (m: Pick<Mission, "goal" | "allowedGlobs" | "guardrails" | "denyGlobs">) => void;
}) {
  const [goal, setGoal] = useState(mission?.goal ?? "");
  const [allowedGlobs, setAllowedGlobs] = useState((mission?.allowedGlobs ?? []).join(", "));
  const [guardrails, setGuardrails] = useState((mission?.guardrails ?? []).join("\n"));
  const [denyGlobs, setDenyGlobs] = useState((mission?.denyGlobs ?? []).join(", "));
  const lines = (s: string) => s.split(/[\n]/).map((x) => x.trim()).filter(Boolean);
  const csv = (s: string) => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);

  useEffect(() => {
    setGoal(mission?.goal ?? "");
    setAllowedGlobs((mission?.allowedGlobs ?? []).join(", "));
    setGuardrails((mission?.guardrails ?? []).join("\n"));
    setDenyGlobs((mission?.denyGlobs ?? []).join(", "));
  }, [mission]);
  return (
    <div className="mission-form">
      <textarea
        className="mission-goal"
        placeholder="Goal — what should this agent do?"
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        rows={2}
      />
      <textarea
        className="mission-rules"
        placeholder="Guardrails (one per line) — e.g. don't modify tests"
        value={guardrails}
        onChange={(e) => setGuardrails(e.target.value)}
        rows={2}
      />
      <input
        className="mission-allowed"
        placeholder="Assigned territory — e.g. client/src/**"
        value={allowedGlobs}
        onChange={(e) => setAllowedGlobs(e.target.value)}
      />
      <input
        className="mission-deny"
        placeholder="Off-limits paths (comma) — e.g. auth/**, .env"
        value={denyGlobs}
        onChange={(e) => setDenyGlobs(e.target.value)}
      />
      <button
        className="mission-save"
        onClick={() => onSave({ goal: goal.trim(), allowedGlobs: csv(allowedGlobs), guardrails: lines(guardrails), denyGlobs: csv(denyGlobs) })}
      >
        Set mission
      </button>
    </div>
  );
}

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

function shortGlobs(globs: string[] | undefined): string {
  if (!globs || globs.length === 0) return "unassigned";
  return globs.join(", ");
}

/** Detail panel shown when an agent is focused. */
export function AgentDetail({
  agent,
  parent,
  now,
  interventions,
  onBack,
  onSetMission,
}: {
  agent: AgentState;
  parent: AgentState | null;
  now: number;
  interventions: InterventionEntry[];
  onBack: () => void;
  onSetMission: (agentId: string, m: Pick<Mission, "goal" | "allowedGlobs" | "guardrails" | "denyGlobs">) => void;
}) {
  const status = STATUS[agent.status];
  const align = agent.alignment;
  const alignMeta = align ? ALIGNMENT[align.state] : null;
  const log = interventions.filter((i) => i.agentId === agent.agentId).slice(-12).reverse();
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

      <section className="d-sec d-sec--primary">
        <h4>Current Work</h4>
        <p className="d-task">{agent.taskLabel}</p>
        <div className="d-now mono">
          <span className="d-now-tool">{agent.currentTool ?? "—"}</span>
          <span className="d-now-file">{agent.currentFile ?? "thinking…"}</span>
        </div>
        <div className="mission-summary mono">
          territory · {shortGlobs(agent.mission?.allowedGlobs)}
        </div>
        {agent.focusRequest && (
          <div className={"focus-request mono" + (agent.focusRequest.deliveredAt ? " focus-request--sent" : "")}>
            focus {agent.focusRequest.deliveredAt ? "sent" : "requested"} · {agent.focusRequest.filePath}
          </div>
        )}
      </section>

      {align && align.state !== "unknown" && (
        <section className="d-sec">
          <div className="d-sec-head">
            <h4>Alignment</h4>
            <span className="align-badge" style={{ color: alignMeta!.color, borderColor: alignMeta!.color }}>
              ● {alignMeta!.label}
            </span>
          </div>
          {align.reason && <p className="d-task">{align.reason}</p>}
          {align.correction && align.state !== "on_track" && (
            <p className="align-correction">↪ {align.correction}</p>
          )}
          {!!align.recalled && align.recalled > 0 && (
            <p className="align-recall">🧠 informed by {align.recalled} recalled memor{align.recalled === 1 ? "y" : "ies"}</p>
          )}
        </section>
      )}

      <section className="d-sec">
        <div className="d-sec-head">
          <h4>Mission</h4>
          <span className="estimate-tag">{agent.mission?.source ?? "unset"}</span>
        </div>
        <MissionEditor mission={agent.mission} onSave={(m) => onSetMission(agent.agentId, m)} />
      </section>

      {log.length > 0 && (
        <section className="d-sec">
          <h4>Interventions</h4>
          <ul className="feed intervene">
            {log.map((i, idx) => (
              <li key={idx}>
                <span className="iv-kind" style={{ color: KIND_COLOR[i.kind] }}>
                  {KIND_LABEL[i.kind]}
                </span>
                <span className="iv-reason">{i.reason}</span>
                <span className="iv-ago mono">{agoLabel(now - i.ts)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <details className="diagnostics">
        <summary>Diagnostics</summary>

        <section className="d-sec">
          <div className="d-sec-head">
            <h4>Lifecycle</h4>
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
      </details>
    </div>
  );
}
