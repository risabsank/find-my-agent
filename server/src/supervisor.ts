import Anthropic from "@anthropic-ai/sdk";
import type {
  Alignment,
  InterventionEntry,
  Mission,
  NormalizedEvent,
  SupervisorStatus,
} from "../../shared/types.ts";
import {
  SUPERVISOR_MODEL,
  SUPERVISOR_INTERVAL_MS,
  AUTONOMOUS_DEFAULT,
  MEMORY_RECALL_K,
} from "../../shared/config.ts";
import type { AgentStore } from "./store.ts";
import type { Broadcaster } from "./ws.ts";
import { persistMission, persistIntervention, redisEnabled } from "./redis.ts";
import { recallMemories, recordMemory, memoryMode } from "./memory.ts";

/** What the hook response should do for one event (computed instantly). */
export type Decision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "inject"; context: string };

export interface Supervisor {
  readonly enabled: boolean;
  start(): void;
  stop(): void;
  status(): SupervisorStatus;
  setAutonomy(opts: { autonomous?: boolean; killSwitch?: boolean }): SupervisorStatus;
  setMission(agentId: string, mission: Mission): void;
  /** Memory partition (the mapped repo name). */
  setRepo(name: string): void;
  /** Rehydrate persisted mission/interventions on boot (Redis). */
  loadMission(agentId: string, mission: Mission): void;
  loadInterventions(entries: InterventionEntry[]): void;
  /** Called from /events: auto-derive mission from prompts, etc. */
  noteEvent(ev: NormalizedEvent): void;
  /** Instant, no-LLM enforcement decision for a hook response. */
  decide(ev: NormalizedEvent): Decision;
  recentInterventions(): InterventionEntry[];
}

// ---- glob matching for deny guardrails --------------------------------------
function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const re = esc
    .replace(/\*\*/g, "::DSTAR::")
    .replace(/\*/g, "[^/]*")
    .replace(/::DSTAR::/g, ".*");
  return new RegExp("^" + re + "$");
}
function matchGlob(path: string, pattern: string): boolean {
  if (!pattern) return false;
  const p = pattern.replace(/\/$/, "");
  if (globToRegExp(p).test(path)) return true;
  return path === p || path.startsWith(p + "/"); // bare prefix: "auth" → "auth/x"
}

// ---- no-API-key fallback ----------------------------------------------------
export class DisabledSupervisor implements Supervisor {
  readonly enabled = false;
  start(): void {}
  stop(): void {}
  status(): SupervisorStatus {
    return {
      enabled: false,
      autonomous: false,
      killSwitch: false,
      model: SUPERVISOR_MODEL,
      persisted: redisEnabled(),
      memory: memoryMode(),
    };
  }
  setAutonomy(): SupervisorStatus {
    return this.status();
  }
  setMission(): void {}
  setRepo(): void {}
  loadMission(): void {}
  loadInterventions(): void {}
  noteEvent(): void {}
  decide(): Decision {
    return { kind: "allow" };
  }
  recentInterventions(): InterventionEntry[] {
    return [];
  }
}

const SYSTEM = `You are the alignment supervisor for an autonomous coding agent.
Given the agent's MISSION (goal, guardrails, off-limits paths) and its RECENT ACTIONS,
judge whether it is staying on mission.

Respond with ONLY a JSON object, no prose, no code fences:
{"state":"on_track"|"drifting"|"off_track","reason":"<one short sentence>","correction":"<imperative instruction to get back on mission, empty if on_track>","severity":"low"|"med"|"high"}

Rules:
- "off_track": clearly violating a guardrail, editing off-limits paths, or working on something unrelated to the goal.
- "drifting": starting to wander, scope-creeping, or repeating/looping without progress.
- "on_track": actions are consistent with the goal and guardrails.
- The "correction" must be specific and actionable (name the file/scope), since it is injected back into the agent verbatim.`;

interface Verdict {
  state: Alignment["state"];
  reason: string;
  correction: string;
  severity: Alignment["severity"];
}

function parseVerdict(text: string): Verdict | null {
  const cleaned = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end < 0) return null;
  try {
    const o = JSON.parse(cleaned.slice(start, end + 1));
    const state = ["on_track", "drifting", "off_track"].includes(o.state) ? o.state : "unknown";
    return {
      state,
      reason: String(o.reason ?? ""),
      correction: String(o.correction ?? ""),
      severity: ["low", "med", "high"].includes(o.severity) ? o.severity : "med",
    };
  } catch {
    return null;
  }
}

const BAD = (s: Alignment["state"]) => s === "drifting" || s === "off_track";

export class ClaudeSupervisor implements Supervisor {
  readonly enabled = true;
  private client = new Anthropic();
  private timer: ReturnType<typeof setInterval> | null = null;
  private autonomous = AUTONOMOUS_DEFAULT;
  private killSwitch = false;
  private repoName = "repo";

  private missions = new Map<string, Mission>();
  private manual = new Set<string>(); // agents with a user-set mission
  private pendingSteer = new Map<string, string>(); // correction queued for injection
  private prevState = new Map<string, Alignment["state"]>();
  private lastJudged = new Map<string, number>(); // agentId → eventCount at last judgment
  private interventions: InterventionEntry[] = [];
  private judging = false;

  constructor(
    private store: AgentStore,
    private bus: Broadcaster,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), SUPERVISOR_INTERVAL_MS);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(): SupervisorStatus {
    return {
      enabled: true,
      autonomous: this.autonomous,
      killSwitch: this.killSwitch,
      model: SUPERVISOR_MODEL,
      persisted: redisEnabled(),
      memory: memoryMode(),
    };
  }

  setAutonomy(opts: { autonomous?: boolean; killSwitch?: boolean }): SupervisorStatus {
    if (typeof opts.autonomous === "boolean") this.autonomous = opts.autonomous;
    if (typeof opts.killSwitch === "boolean") this.killSwitch = opts.killSwitch;
    const status = this.status();
    this.bus.broadcast({ type: "supervisorStatus", supervisor: status });
    return status;
  }

  setMission(agentId: string, mission: Mission): void {
    const m: Mission = {
      goal: mission.goal ?? "",
      guardrails: mission.guardrails ?? [],
      denyGlobs: mission.denyGlobs ?? [],
      source: "manual",
    };
    this.missions.set(agentId, m);
    this.manual.add(agentId);
    this.store.setMission(agentId, m);
    persistMission(agentId, m);
    this.broadcastAgent(agentId, "Mission");
    this.lastJudged.delete(agentId); // force a re-judge next tick
  }

  setRepo(name: string): void {
    if (name) this.repoName = name;
  }

  loadMission(agentId: string, mission: Mission): void {
    this.missions.set(agentId, mission);
    if (mission.source === "manual") this.manual.add(agentId);
    this.store.setMission(agentId, mission);
  }

  loadInterventions(entries: InterventionEntry[]): void {
    this.interventions = entries.slice(-200);
  }

  noteEvent(ev: NormalizedEvent): void {
    // Auto-derive a mission goal from the user's prompt, unless one was set.
    if (ev.event === "UserPromptSubmit" && !this.manual.has(ev.agentId)) {
      const raw = ev.raw as { prompt?: string } | null;
      const goal = (raw?.prompt ?? ev.taskLabel ?? "").trim();
      if (goal) {
        const existing = this.missions.get(ev.agentId);
        const m: Mission = {
          goal,
          guardrails: existing?.guardrails ?? [],
          denyGlobs: existing?.denyGlobs ?? [],
          source: "prompt",
        };
        this.missions.set(ev.agentId, m);
        this.store.setMission(ev.agentId, m);
      }
    }
  }

  decide(ev: NormalizedEvent): Decision {
    if (this.killSwitch || !this.autonomous) return { kind: "allow" };
    const mission = this.missions.get(ev.agentId);

    if (ev.event === "PreToolUse") {
      // Hard guardrail: deny edits to off-limits paths (deterministic, instant).
      if (mission && ev.filePath && mission.denyGlobs.some((g) => matchGlob(ev.filePath!, g))) {
        const reason = `Off-mission: ${ev.filePath} is excluded by a mission guardrail${
          mission.goal ? ` (mission: ${mission.goal})` : ""
        }. Do not modify it — return to the mission scope.`;
        this.log({ agentId: ev.agentId, kind: "block", reason, tool: ev.tool ?? undefined, filePath: ev.filePath ?? undefined, ts: Date.now() });
        return { kind: "deny", reason };
      }
      // Otherwise, nudge with any queued correction.
      const steer = this.pendingSteer.get(ev.agentId);
      if (steer) {
        this.pendingSteer.delete(ev.agentId);
        this.log({ agentId: ev.agentId, kind: "nudge", reason: steer, tool: ev.tool ?? undefined, filePath: ev.filePath ?? undefined, ts: Date.now() });
        return { kind: "inject", context: steer };
      }
      return { kind: "allow" };
    }

    if (ev.event === "UserPromptSubmit") {
      const parts: string[] = [];
      if (mission?.goal) parts.push(`Mission: ${mission.goal}`);
      if (mission?.guardrails.length) parts.push(`Guardrails: ${mission.guardrails.join("; ")}`);
      if (mission?.denyGlobs.length) parts.push(`Do not modify: ${mission.denyGlobs.join(", ")}`);
      const steer = this.pendingSteer.get(ev.agentId);
      if (steer) {
        this.pendingSteer.delete(ev.agentId);
        parts.push(`Course-correction: ${steer}`);
      }
      if (parts.length) return { kind: "inject", context: parts.join("\n") };
    }
    return { kind: "allow" };
  }

  recentInterventions(): InterventionEntry[] {
    return this.interventions.slice(-50);
  }

  // ---- background judgment loop ----------------------------------------------
  private async tick(): Promise<void> {
    if (this.judging) return;
    this.judging = true;
    try {
      const agents = this.store
        .snapshot()
        .filter((a) => a.status === "working" || a.status === "waiting");
      for (const a of agents) {
        const mission = this.missions.get(a.agentId);
        if (!mission?.goal) continue;
        if (this.lastJudged.get(a.agentId) === a.eventCount) continue; // nothing new
        this.lastJudged.set(a.agentId, a.eventCount);
        await this.judge(a.agentId, mission);
      }
    } finally {
      this.judging = false;
    }
  }

  private async judge(agentId: string, mission: Mission): Promise<void> {
    const agent = this.store.get(agentId);
    if (!agent) return;
    const activity = agent.recentActivity
      .slice(-10)
      .map((e) => `- ${e.event}${e.tool ? ` ${e.tool}` : ""}${e.filePath ? ` ${e.filePath}` : ""}`)
      .join("\n");
    // Recall relevant past memories (Redis) to inform this judgment.
    const memories = await recallMemories(
      this.repoName,
      `${mission.goal} ${agent.currentFile ?? ""}`,
      MEMORY_RECALL_K,
    );
    const user = [
      `MISSION GOAL: ${mission.goal}`,
      mission.guardrails.length ? `GUARDRAILS: ${mission.guardrails.join("; ")}` : "",
      mission.denyGlobs.length ? `OFF-LIMITS PATHS: ${mission.denyGlobs.join(", ")}` : "",
      `CURRENT FILE: ${agent.currentFile ?? "(none)"}`,
      `CURRENT TOOL: ${agent.currentTool ?? "(none)"}`,
      `RECENT ACTIONS:\n${activity || "(none yet)"}`,
      memories.length ? `RELEVANT PAST MEMORY (from prior sessions):\n${memories.map((m) => `- ${m}`).join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    let verdict: Verdict | null = null;
    try {
      const res = await this.client.messages.create({
        model: SUPERVISOR_MODEL,
        max_tokens: 400,
        system: SYSTEM,
        messages: [{ role: "user", content: user }],
      });
      const text = res.content.find((b) => b.type === "text")?.text ?? "";
      verdict = parseVerdict(text);
    } catch (err) {
      console.error("[supervisor] judge failed:", (err as Error).message);
      return; // keep previous verdict
    }
    if (!verdict) return;

    const alignment: Alignment = {
      state: verdict.state,
      reason: verdict.reason,
      correction: verdict.correction,
      severity: verdict.severity,
      recalled: memories.length,
      at: Date.now(),
    };
    this.store.setAlignment(agentId, alignment);

    const prev = this.prevState.get(agentId) ?? "unknown";
    this.prevState.set(agentId, verdict.state);

    // Persist a memory for notable verdicts so future sessions recall the lesson.
    if (BAD(verdict.state) || (verdict.state === "on_track" && BAD(prev))) {
      void recordMemory({
        repo: this.repoName,
        kind: verdict.state,
        text: `[${mission.goal}] ${agent.currentFile ? `at ${agent.currentFile}: ` : ""}${verdict.reason}${verdict.correction ? ` → ${verdict.correction}` : ""}`,
      });
    }

    // Transition into a bad state → detect + queue a steer (nudge on next hook).
    if (BAD(verdict.state) && !BAD(prev)) {
      this.log({
        agentId,
        kind: "detected",
        reason: verdict.reason || "Drifting from mission",
        filePath: agent.currentFile ?? undefined,
        ts: Date.now(),
      });
    }
    if (BAD(verdict.state) && verdict.correction) {
      this.pendingSteer.set(agentId, verdict.correction);
    }
    // Returned to on-track after being off → recovered.
    if (verdict.state === "on_track" && BAD(prev)) {
      this.pendingSteer.delete(agentId);
      this.log({ agentId, kind: "recovered", reason: "Back on mission", ts: Date.now() });
    }

    this.broadcastAgent(agentId, "Verdict");
  }

  private log(entry: InterventionEntry): void {
    this.interventions.push(entry);
    if (this.interventions.length > 200) this.interventions.shift();
    persistIntervention(entry);
    this.bus.broadcast({ type: "intervention", entry });
  }

  /** Push the agent's updated state (incl. mission/alignment) to clients. */
  private broadcastAgent(agentId: string, event: string): void {
    const agent = this.store.get(agentId);
    if (!agent) return;
    this.bus.broadcast({
      type: "event",
      event: {
        agentId: agent.agentId,
        sessionId: agent.sessionId,
        parentId: agent.parentId,
        isSubagent: agent.isSubagent,
        event,
        tool: agent.currentTool,
        filePath: agent.currentFile,
        ts: Date.now(),
        raw: null,
      },
      agent,
    });
  }
}

export function createSupervisor(store: AgentStore, bus: Broadcaster): Supervisor {
  return process.env.ANTHROPIC_API_KEY
    ? new ClaudeSupervisor(store, bus)
    : new DisabledSupervisor();
}
