// Shared configuration constants for Find My Agent.

/** Collector server port. Override with COLLECTOR_PORT env var. */
export const COLLECTOR_PORT = Number(
  (typeof process !== "undefined" && process.env?.COLLECTOR_PORT) || 4000,
);

/** Base URL of the collector (HTTP). */
export const COLLECTOR_HTTP = `http://localhost:${COLLECTOR_PORT}`;

/** WebSocket URL the client connects to. */
export const COLLECTOR_WS = `ws://localhost:${COLLECTOR_PORT}/ws`;

/** Seconds without any event before an agent decays to "waiting". */
export const STALE_SECONDS = 45;

/** Seconds after stop/end before an agent is removed from the map. */
export const REMOVE_AFTER_SECONDS = 120;

// ---- Alignment Autopilot ----
/** Model that judges whether agents are on-mission. */
export const SUPERVISOR_MODEL = "claude-sonnet-4-6";
/** How often the background judgment loop runs. */
export const SUPERVISOR_INTERVAL_MS = 5000;
/** Whether interventions act automatically by default (vs observe-only). */
export const AUTONOMOUS_DEFAULT = true;
