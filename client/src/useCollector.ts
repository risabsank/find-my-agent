import { useEffect, useRef, useState } from "react";
import type {
  AgentState,
  ServerMessage,
  TreeNode,
  InterventionEntry,
  SupervisorStatus,
  Mission,
} from "./types.ts";

// Connect to the collector on the same origin that served this page, so the app
// works on any host/port (the collector serves the UI and the WS together).
const WS_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

// Control helpers (client → collector) over the same origin.
export async function setMissionApi(
  agentId: string,
  m: Pick<Mission, "goal" | "allowedGlobs" | "guardrails" | "denyGlobs">,
): Promise<void> {
  await fetch("/api/mission", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId, ...m }),
  }).catch(() => {});
}

export async function requestFocusApi(agentId: string, filePath: string): Promise<void> {
  await fetch("/api/focus", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId, filePath }),
  }).catch(() => {});
}

export async function setSupervisorApi(opts: {
  autonomous?: boolean;
  killSwitch?: boolean;
}): Promise<void> {
  await fetch("/api/supervisor", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  }).catch(() => {});
}

export interface CollectorState {
  connected: boolean;
  tree: TreeNode | null;
  repoName: string;
  agents: AgentState[];
  supervisor: SupervisorStatus | null;
  interventions: InterventionEntry[];
}

/**
 * Opens a WebSocket to the collector and reduces snapshot + event messages into
 * live state. Auto-reconnects if the socket drops. The tree is re-applied
 * whenever the server pushes a change, so the map expands/contracts live.
 */
export function useCollector(): CollectorState {
  const [connected, setConnected] = useState(false);
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [repoName, setRepoName] = useState("repo");
  const [agents, setAgents] = useState<AgentState[]>([]);
  const [supervisor, setSupervisor] = useState<SupervisorStatus | null>(null);
  const [interventions, setInterventions] = useState<InterventionEntry[]>([]);
  const agentsRef = useRef<Map<string, AgentState>>(new Map());

  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const flush = () => setAgents([...agentsRef.current.values()]);

    const applyTree = (next: TreeNode) => {
      setTree(next);
      setRepoName(next.name);
    };

    const connect = () => {
      ws = new WebSocket(WS_URL);

      ws.onopen = () => setConnected(true);

      ws.onmessage = (e) => {
        const msg: ServerMessage = JSON.parse(e.data);
        switch (msg.type) {
          case "snapshot": {
            if (msg.tree) applyTree(msg.tree);
            else setRepoName(msg.repoName);
            agentsRef.current = new Map(msg.agents.map((a) => [a.agentId, a]));
            flush();
            setSupervisor(msg.supervisor);
            setInterventions(msg.interventions);
            break;
          }
          case "intervention": {
            setInterventions((cur) => [...cur, msg.entry].slice(-60));
            break;
          }
          case "supervisorStatus": {
            setSupervisor(msg.supervisor);
            break;
          }
          case "event": {
            agentsRef.current.set(msg.agent.agentId, msg.agent);
            flush();
            break;
          }
          case "agentRemoved": {
            agentsRef.current.delete(msg.agentId);
            flush();
            break;
          }
          case "tree": {
            applyTree(msg.tree);
            break;
          }
        }
      };

      ws.onclose = () => {
        setConnected(false);
        if (!closed) reconnectTimer = setTimeout(connect, 1500);
      };

      ws.onerror = () => ws?.close();
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, []);

  return { connected, tree, repoName, agents, supervisor, interventions };
}
