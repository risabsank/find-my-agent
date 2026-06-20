import type { AgentState } from "./types.ts";
import { STATUS, agentLabel, typeName, fmtTok, elapsed } from "./ui.ts";

function AgentRow({
  agent,
  now,
  hovered,
  onHover,
  onLeave,
  onClick,
}: {
  agent: AgentState;
  now: number;
  hovered: boolean;
  onHover: (id: string) => void;
  onLeave: () => void;
  onClick: (id: string) => void;
}) {
  const status = STATUS[agent.status];
  return (
    <li
      className={"row" + (agent.isSubagent ? " row--sub" : "") + (hovered ? " row--hover" : "")}
      onMouseEnter={() => onHover(agent.agentId)}
      onMouseLeave={onLeave}
      onClick={() => onClick(agent.agentId)}
    >
      <div className="row-head">
        <span className="row-swatch" style={{ background: agent.color }} />
        <span className="row-name">
          {typeName(agent)}
          <span className="row-id mono"> {agentLabel(agent)}</span>
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
        <span className="row-elapsed">{elapsed(now - agent.startedAt)}</span>
      </div>
      <div className="row-tokens mono">
        <span>{fmtTok(agent.tokens.totalTokens)} tok</span>
        <span className="row-cost">${agent.tokens.costUsd.toFixed(4)}</span>
        {agent.tokens.isStub && <span className="stub">stub</span>}
      </div>
    </li>
  );
}

/** Agent list with subagents ordered/indented under their parent. */
export function AgentListPanel({
  agents,
  now,
  hoveredId,
  onHover,
  onLeave,
  onClick,
}: {
  agents: AgentState[];
  now: number;
  hoveredId: string | null;
  onHover: (id: string) => void;
  onLeave: () => void;
  onClick: (id: string) => void;
}) {
  const tops = agents.filter((a) => !a.parentId);
  const ordered: AgentState[] = [];
  for (const t of tops) {
    ordered.push(t);
    for (const c of agents.filter((a) => a.parentId === t.agentId)) ordered.push(c);
  }
  for (const a of agents) if (!ordered.includes(a)) ordered.push(a);

  return (
    <ul className="agent-list">
      {ordered.map((a) => (
        <AgentRow
          key={a.agentId}
          agent={a}
          now={now}
          hovered={hoveredId === a.agentId}
          onHover={onHover}
          onLeave={onLeave}
          onClick={onClick}
        />
      ))}
    </ul>
  );
}
