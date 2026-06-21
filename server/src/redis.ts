// Redis persistence: durable system-of-record for agent state, missions, and the
// event/intervention log (Redis Streams). Gated by REDIS_URL — when unset, the
// collector stays purely in-memory (today's behavior). Everything fails open.

import { createClient } from "redis";
import { REDIS_URL } from "../../shared/config.ts";
import type { AgentState, InterventionEntry, Mission, NormalizedEvent } from "../../shared/types.ts";

type Client = ReturnType<typeof createClient>;
let client: Client | null = null;
let ready = false;

const K = {
  agents: "fma:agents", // SET of agentIds
  agent: (id: string) => `fma:agent:${id}`,
  mission: (id: string) => `fma:mission:${id}`,
  events: "fma:events", // STREAM
  interventions: "fma:interventions", // STREAM
};

export function redisEnabled(): boolean {
  return ready;
}
export function getRedis(): Client | null {
  return ready ? client : null;
}

/** Connect to Redis if REDIS_URL is set. Returns true when persistence is on. */
export async function connectRedis(): Promise<boolean> {
  if (!REDIS_URL) return false;
  try {
    client = createClient({ url: REDIS_URL });
    client.on("error", (e: Error) => {
      if (ready) console.error("[redis] error:", e.message);
    });
    await client.connect();
    ready = true;
    console.log(`[redis] connected → ${REDIS_URL}`);
    return true;
  } catch (e) {
    console.error("[redis] connect failed (continuing in-memory):", (e as Error).message);
    client = null;
    ready = false;
    return false;
  }
}

// ---- writes (fire-and-forget; never block the hook response) ----------------
function safe(p: Promise<unknown> | undefined): void {
  p?.catch((e) => console.error("[redis] write failed:", (e as Error).message));
}

export function persistAgent(agent: AgentState): void {
  if (!ready || !client) return;
  safe(client.set(K.agent(agent.agentId), JSON.stringify(agent)));
  safe(client.sAdd(K.agents, agent.agentId));
}
export function persistMission(agentId: string, mission: Mission): void {
  if (!ready || !client) return;
  safe(client.set(K.mission(agentId), JSON.stringify(mission)));
  safe(client.sAdd(K.agents, agentId));
}
export function appendEvent(ev: NormalizedEvent): void {
  if (!ready || !client) return;
  safe(
    client.xAdd(K.events, "*", { data: JSON.stringify(ev) }, {
      TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: 5000 },
    }),
  );
}
export function persistIntervention(entry: InterventionEntry): void {
  if (!ready || !client) return;
  safe(
    client.xAdd(K.interventions, "*", { data: JSON.stringify(entry) }, {
      TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: 2000 },
    }),
  );
}

// ---- reads (rehydrate on boot) ----------------------------------------------
export async function loadAgents(): Promise<AgentState[]> {
  if (!ready || !client) return [];
  try {
    const ids = await client.sMembers(K.agents);
    const out: AgentState[] = [];
    for (const id of ids) {
      const raw = await client.get(K.agent(id));
      if (raw) out.push(JSON.parse(raw) as AgentState);
    }
    return out;
  } catch (e) {
    console.error("[redis] loadAgents failed:", (e as Error).message);
    return [];
  }
}
export async function loadMissions(): Promise<Record<string, Mission>> {
  if (!ready || !client) return {};
  try {
    const ids = await client.sMembers(K.agents);
    const out: Record<string, Mission> = {};
    for (const id of ids) {
      const raw = await client.get(K.mission(id));
      if (raw) out[id] = JSON.parse(raw) as Mission;
    }
    return out;
  } catch (e) {
    console.error("[redis] loadMissions failed:", (e as Error).message);
    return {};
  }
}
export async function loadInterventions(limit = 50): Promise<InterventionEntry[]> {
  if (!ready || !client) return [];
  try {
    const rows = await client.xRevRange(K.interventions, "+", "-", { COUNT: limit });
    const out: InterventionEntry[] = [];
    for (const r of rows) {
      const data = (r.message as Record<string, string>).data;
      if (data) out.push(JSON.parse(data) as InterventionEntry);
    }
    return out.reverse(); // chronological
  } catch (e) {
    console.error("[redis] loadInterventions failed:", (e as Error).message);
    return [];
  }
}
