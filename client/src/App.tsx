import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useCollector, setMissionApi, setSupervisorApi } from "./useCollector.ts";
import {
  useTreemapLayout,
  Territory,
  resolveCell,
  regionRect,
  cellCenter,
} from "./TreeMap.tsx";
import { Pin, Trails, Tooltip, type TrailData } from "./Pins.tsx";
import { AgentListPanel } from "./AgentList.tsx";
import { AgentDetail } from "./AgentDetail.tsx";
import { STATUS, ALIGNMENT, typeName, agentLabel } from "./ui.ts";

export function App() {
  const { connected, tree, repoName, agents, supervisor, interventions } = useCollector();

  const mapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useLayoutEffect(() => {
    const el = mapRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  const layout = useTreemapLayout(tree, size.w, size.h);

  // Clear focus if the focused agent disappears.
  useEffect(() => {
    if (focusId && !agents.some((a) => a.agentId === focusId)) setFocusId(null);
  }, [agents, focusId]);

  // Search: which agents match the query (empty query → all match).
  const q = query.trim().toLowerCase();
  const matches = (a: (typeof agents)[number]) =>
    q === "" ||
    typeName(a).toLowerCase().includes(q) ||
    agentLabel(a).toLowerCase().includes(q) ||
    (a.currentFile ?? "").toLowerCase().includes(q) ||
    a.taskLabel.toLowerCase().includes(q);

  const positions = useMemo(() => {
    const m = new Map<string, { x: number; y: number; thinking: boolean }>();
    for (const a of agents) {
      if (!a.currentFile) {
        m.set(a.agentId, { x: 30, y: size.h - 26, thinking: true });
        continue;
      }
      const cell = resolveCell(a.currentFile, layout.byPath);
      m.set(
        a.agentId,
        cell ? { ...cellCenter(cell), thinking: false } : { x: 30, y: size.h - 26, thinking: true },
      );
    }
    return m;
  }, [agents, layout, size.h]);

  // Movement trails: distinct recent files each agent touched (map space).
  const trails = useMemo<TrailData[]>(() => {
    return agents.map((a) => {
      const files: string[] = [];
      for (const e of a.recentActivity) {
        if (e.filePath && files[files.length - 1] !== e.filePath) files.push(e.filePath);
      }
      const points: { x: number; y: number }[] = [];
      for (const f of files.slice(-6)) {
        const c = resolveCell(f, layout.byPath);
        if (c) points.push(cellCenter(c));
      }
      return { agentId: a.agentId, points };
    });
  }, [agents, layout]);

  const focusAgent = focusId ? agents.find((a) => a.agentId === focusId) ?? null : null;
  const region = focusAgent ? regionRect(focusAgent.currentFile, layout) : null;
  const focusParent =
    focusAgent && focusAgent.parentId
      ? agents.find((a) => a.agentId === focusAgent.parentId) ?? null
      : null;

  // Zoom/pan transform toward the focused region.
  const transform = useMemo(() => {
    if (!region || size.w === 0) return { k: 1, tx: 0, ty: 0 };
    const rw = region.x1 - region.x0;
    const rh = region.y1 - region.y0;
    const pad = 0.74;
    let k = Math.min((size.w * pad) / rw, (size.h * pad) / rh);
    k = Math.max(1.3, Math.min(k, 2.8));
    const cx = (region.x0 + region.x1) / 2;
    const cy = (region.y0 + region.y1) / 2;
    return { k, tx: size.w / 2 - k * cx, ty: size.h / 2 - k * cy };
  }, [region, size.w, size.h]);

  const screen = (p: { x: number; y: number }) => ({
    x: transform.tx + transform.k * p.x,
    y: transform.ty + transform.k * p.y,
  });
  const layerTransform = `translate(${transform.tx}px, ${transform.ty}px) scale(${transform.k})`;

  const activeFiles = useMemo(() => {
    const s = new Set<string>();
    for (const a of agents) if (a.currentFile && a.status !== "stopped") s.add(a.currentFile);
    return s;
  }, [agents]);

  const hovered = hoveredId ? agents.find((a) => a.agentId === hoveredId) ?? null : null;
  const hoveredPos = hovered ? positions.get(hovered.agentId) : null;
  const hoveredScreen = hoveredPos ? screen(hoveredPos) : null;

  return (
    <div className={"app" + (focusId ? " app--focus" : "")}>
      {/* ---------- TOP BAR ---------- */}
      <header className="topbar">
        <div className="brand">
          <svg className="pin-glyph" viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
            <path
              d="M12 2.5c-3.6 0-6.5 2.8-6.5 6.4 0 4.5 5.3 11 6 11.8.3.3.7.3 1 0 .7-.8 6-7.3 6-11.8 0-3.6-2.9-6.4-6.5-6.4z"
              fill="none"
              stroke="var(--accent)"
              strokeWidth="1.6"
            />
            <circle cx="12" cy="9" r="2.4" fill="var(--accent)" />
          </svg>
          <span className="brand-name">Find My Agent</span>
        </div>
        <div className="repo mono">
          <span className="repo-glyph" />
          {repoName}
        </div>

        <div className="search">
          <span className="search-icn" />
          <input
            placeholder="Find a file or agent…"
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className="topbar-right">
          {/* Persistence (Redis) indicator */}
          {supervisor?.persisted && (
            <span className="persist" title={`Redis persistence on · memory: ${supervisor.memory}`}>
              <span className="persist-dot" /> Redis
              {supervisor.memory !== "off" && <span className="persist-mem">{supervisor.memory}</span>}
            </span>
          )}
          {/* Autopilot control */}
          {supervisor?.enabled ? (
            <div className="autopilot">
              <span className={"ap-dot" + (supervisor.killSwitch ? " ap-off" : supervisor.autonomous ? " ap-on" : " ap-watch")} />
              <span className="ap-label">
                Autopilot {supervisor.killSwitch ? "paused" : supervisor.autonomous ? "on" : "watch"}
              </span>
              <button
                className="ap-toggle"
                title={supervisor.autonomous ? "Switch to observe-only" : "Enable autonomous steering"}
                onClick={() => setSupervisorApi({ autonomous: !supervisor.autonomous, killSwitch: false })}
              >
                {supervisor.autonomous ? "observe" : "autonomous"}
              </button>
              <button
                className={"ap-kill" + (supervisor.killSwitch ? " armed" : "")}
                title="Kill switch: stop all interventions"
                onClick={() => setSupervisorApi({ killSwitch: !supervisor.killSwitch })}
              >
                {supervisor.killSwitch ? "resume" : "stop"}
              </button>
            </div>
          ) : (
            <span className="autopilot ap-disabled" title="Set ANTHROPIC_API_KEY to enable the AI supervisor">
              <span className="ap-dot" /> Autopilot off
            </span>
          )}
          <span className={"conn " + (connected ? "conn--on" : "conn--off")}>
            <span className="conn-dot" />
            {connected ? "connected" : "disconnected"}
          </span>
          <span className="agent-count">
            <span className="count-n">{agents.length}</span> agent
            {agents.length === 1 ? "" : "s"}
          </span>
        </div>
      </header>

      {/* ---------- BODY ---------- */}
      <div className="body">
        <div
          className={"map" + (connected ? "" : " map--offline")}
          ref={mapRef}
          onClick={() => setFocusId(null)}
        >
          <svg className="territory" width={size.w} height={size.h}>
            <g className="territory-g" style={{ transform: layerTransform }}>
              <Territory
                layout={layout}
                showLabels={true}
                focusRegion={region ? region.path : null}
                focusFile={focusAgent ? focusAgent.currentFile : null}
                activeFiles={activeFiles}
              />
              <Trails trails={trails} focusId={focusId} focusRegion={region ? region.path : null} />
            </g>
          </svg>

          {/* pins share the territory transform, counter-scaled to stay constant size */}
          {size.w > 0 && (
            <div className="pin-layer" style={{ transform: layerTransform }}>
              {agents.map((a) => {
                const p = positions.get(a.agentId);
                if (!p) return null;
                const dimmed =
                  (focusId !== null && focusId !== a.agentId) || (q !== "" && !matches(a));
                return (
                  <Pin
                    key={a.agentId}
                    agent={a}
                    x={p.x}
                    y={p.y}
                    invK={1 / transform.k}
                    focused={focusId === a.agentId}
                    dimmed={dimmed}
                    onEnter={setHoveredId}
                    onLeave={() => setHoveredId(null)}
                    onClick={setFocusId}
                  />
                );
              })}
            </div>
          )}

          {/* hover tooltip */}
          {hovered && hoveredScreen && hoveredId !== focusId && (
            <Tooltip
              agent={hovered}
              x={Math.min(hoveredScreen.x + 18, size.w - 244)}
              y={Math.max(hoveredScreen.y - 12, 10)}
            />
          )}

          {/* empty state */}
          {agents.length === 0 && connected && (
            <div className="map-hint">
              <div className="hint-card">
                <span className="hint-radar" />
                <div className="hint-title">Waiting for agents to connect</div>
                <div className="hint-sub">
                  The map is live. Start a Claude Code session in
                  <span className="mono"> {repoName}</span> and its agents will appear here.
                </div>
              </div>
            </div>
          )}

          {/* offline veil */}
          {!connected && (
            <div className="offline-tag">
              <span className="conn-dot" /> connection lost · showing last-known positions
            </div>
          )}

          {/* live autopilot intervention strip */}
          {interventions.length > 0 && (
            <div className="iv-strip">
              {interventions.slice(-3).reverse().map((i, idx) => {
                const a = agents.find((x) => x.agentId === i.agentId);
                const color =
                  i.kind === "block" ? ALIGNMENT.off_track.color
                  : i.kind === "detected" ? ALIGNMENT.drifting.color
                  : i.kind === "recovered" ? ALIGNMENT.on_track.color
                  : "var(--accent)";
                const verb =
                  i.kind === "block" ? "blocked" : i.kind === "detected" ? "drift" : i.kind === "recovered" ? "recovered" : "steered";
                return (
                  <div key={idx} className="iv-toast" style={{ borderColor: color }}>
                    <span className="iv-toast-kind" style={{ color }}>
                      {verb}
                    </span>
                    <span className="iv-toast-who">{a ? typeName(a) : i.agentId.slice(0, 8)}</span>
                    <span className="iv-toast-reason">{i.reason}</span>
                  </div>
                );
              })}
            </div>
          )}

          {/* status legend */}
          <div className="legend">
            {(["working", "waiting", "stopped", "failed"] as const).map((k) => (
              <span key={k} className="legend-item">
                <span className="legend-dot" style={{ background: STATUS[k].ring }} />
                {STATUS[k].label}
              </span>
            ))}
          </div>
        </div>

        {/* ---------- SIDEBAR ---------- */}
        <aside className="sidebar">
          {focusAgent ? (
            <AgentDetail
              agent={focusAgent}
              parent={focusParent}
              now={now}
              interventions={interventions}
              onBack={() => setFocusId(null)}
              onSetMission={setMissionApi}
            />
          ) : (
            <div className="list-wrap">
              <div className="sidebar-head">
                <h2>Agents</h2>
                <span className="sidebar-count">{agents.length}</span>
              </div>
              {agents.length === 0 ? (
                <p className="list-empty">No agents connected yet. The dashboard is listening.</p>
              ) : (
                <AgentListPanel
                  agents={agents.filter(matches)}
                  now={now}
                  hoveredId={hoveredId}
                  onHover={setHoveredId}
                  onLeave={() => setHoveredId(null)}
                  onClick={setFocusId}
                />
              )}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
