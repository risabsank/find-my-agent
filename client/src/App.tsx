import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useCollector, requestFocusApi, setMissionApi, setSupervisorApi } from "./useCollector.ts";
import {
  useTreemapLayout,
  Territory,
  TerritoryOutlines,
  DropTargetHighlight,
  resolveCell,
  regionRect,
  cellCenter,
  containingFolder,
  rectAtPoint,
  type FileOverlay,
  type Rect,
} from "./TreeMap.tsx";
import { Pin, Trails, Tooltip, type TrailData } from "./Pins.tsx";
import { AgentListPanel } from "./AgentList.tsx";
import { AgentDetail } from "./AgentDetail.tsx";
import { STATUS, ALIGNMENT, typeName, agentLabel, agoLabel } from "./ui.ts";

/** Bucket an intervention into the red (error) or yellow (warning) circle. */
function ivSeverity(kind: string): "error" | "warning" | null {
  if (kind === "block") return "error"; // hard deny
  if (kind === "detected" || kind === "nudge" || kind === "boundary") return "warning";
  return null; // recovered / other → not an alert
}

function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const re = esc
    .replace(/\*\*/g, "::DSTAR::")
    .replace(/\*/g, "[^/]*")
    .replace(/::DSTAR::/g, ".*");
  return new RegExp("^" + re + "$");
}

function matchesGlob(path: string, glob: string): boolean {
  const p = glob.replace(/\/$/, "");
  if (p === "**" || p === "*") return true;
  if (globToRegExp(p).test(path)) return true;
  return path === p || path.startsWith(p + "/");
}

function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((g) => matchesGlob(path, g));
}

function interventionKey(i: {
  agentId: string;
  kind: string;
  reason: string;
  tool?: string;
  filePath?: string;
  ts: number;
}): string {
  return [i.agentId, i.kind, i.tool ?? "", i.filePath ?? "", i.reason, i.ts].join("|");
}

export function App() {
  const { connected, tree, repoName, agents, supervisor, interventions } = useCollector();

  const mapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [now, setNow] = useState(Date.now());
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<Rect | null>(null);
  const [dismissedInterventions, setDismissedInterventions] = useState<Set<string>>(
    () => new Set(),
  );
  const [openAlert, setOpenAlert] = useState<"error" | "warning" | null>(null);
  const [jumpTo, setJumpTo] = useState<{ agentId: string; ts: number } | null>(null);
  const dragMoved = useRef(false);
  const suppressClick = useRef(false);
  const dropTargetRef = useRef<Rect | null>(null);

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

  useEffect(() => {
    dropTargetRef.current = dropTarget;
  }, [dropTarget]);

  const activeFiles = useMemo(() => {
    const s = new Set<string>();
    for (const a of agents) if (a.currentFile && a.status !== "stopped") s.add(a.currentFile);
    return s;
  }, [agents]);

  const hovered = hoveredId ? agents.find((a) => a.agentId === hoveredId) ?? null : null;
  const hoveredPos = hovered ? positions.get(hovered.agentId) : null;
  const hoveredScreen = hoveredPos ? screen(hoveredPos) : null;

  useEffect(() => {
    setDismissedInterventions((cur) => {
      const live = new Set(interventions.map(interventionKey));
      const next = new Set([...cur].filter((k) => live.has(k)));
      return next.size === cur.size ? cur : next;
    });
  }, [interventions]);

  const visibleInterventions = useMemo(() => {
    return interventions.filter((i) => !dismissedInterventions.has(interventionKey(i)));
  }, [dismissedInterventions, interventions]);

  // Bucket alerts into the two circles (red errors / yellow warnings).
  const { errorIvs, warnIvs } = useMemo(() => {
    const e: typeof visibleInterventions = [];
    const w: typeof visibleInterventions = [];
    for (const i of visibleInterventions) {
      const sev = ivSeverity(i.kind);
      if (sev === "error") e.push(i);
      else if (sev === "warning") w.push(i);
    }
    return { errorIvs: e, warnIvs: w };
  }, [visibleInterventions]);
  const alertList = openAlert === "error" ? errorIvs : openAlert === "warning" ? warnIvs : [];

  // Close the expanded panel when its category empties (e.g. cleared/dismissed).
  useEffect(() => {
    if (openAlert === "error" && errorIvs.length === 0) setOpenAlert(null);
    if (openAlert === "warning" && warnIvs.length === 0) setOpenAlert(null);
  }, [openAlert, errorIvs.length, warnIvs.length]);

  const clearAlerts = (list: typeof visibleInterventions) => {
    setDismissedInterventions((cur) => {
      const n = new Set(cur);
      for (const i of list) n.add(interventionKey(i));
      return n;
    });
    setOpenAlert(null);
  };
  const selectAlert = (i: { agentId: string; ts: number }) => {
    setFocusId(i.agentId);
    setJumpTo({ agentId: i.agentId, ts: i.ts });
    setOpenAlert(null);
  };

  const territoryOutlines = useMemo(() => {
    const out: { rect: Rect; color: string; label: string; active?: boolean }[] = [];
    for (const a of agents) {
      const globs = a.mission?.allowedGlobs ?? [];
      for (const glob of globs) {
        const path = glob === "**" || glob === "*" ? "" : glob.replace(/\/\*\*$/, "").replace(/\/\*$/, "").replace(/\/$/, "");
        const rect = layout.byPath.get(path);
        if (rect) out.push({ rect, color: a.color, label: agentLabel(a), active: a.agentId === focusId });
      }
    }
    return out;
  }, [agents, focusId, layout.byPath]);

  const focusOverlays = useMemo(() => {
    if (!focusAgent?.mission) return undefined;
    const touched = new Set(
      focusAgent.recentActivity
        .map((e) => e.filePath)
        .filter((p): p is string => Boolean(p)),
    );
    const out = new Map<string, FileOverlay>();
    for (const r of layout.rects) {
      if (r.type !== "file") continue;
      const overlay: FileOverlay = {};
      if (matchesAny(r.path, focusAgent.mission.denyGlobs ?? [])) {
        overlay.policy = "forbidden";
      } else if ((focusAgent.mission.allowedGlobs ?? []).length > 0) {
        overlay.policy = matchesAny(r.path, focusAgent.mission.allowedGlobs) ? "allowed" : "risky";
      }
      if (touched.has(r.path)) overlay.touched = true;
      if (overlay.policy || overlay.touched) out.set(r.path, overlay);
    }
    return out;
  }, [focusAgent, layout.rects]);

  const mapPoint = (clientX: number, clientY: number) => {
    const el = mapRef.current;
    if (!el) return null;
    const box = el.getBoundingClientRect();
    return {
      x: (clientX - box.left - transform.tx) / transform.k,
      y: (clientY - box.top - transform.ty) / transform.k,
    };
  };

  const startPinDrag = (agentId: string, e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragMoved.current = false;
    suppressClick.current = false;
    setDraggingId(agentId);
    const p = mapPoint(e.clientX, e.clientY);
    setDropTarget(p ? rectAtPoint(layout, p.x, p.y) : null);
  };

  useEffect(() => {
    if (!draggingId) return;
    const onMove = (e: PointerEvent) => {
      dragMoved.current = true;
      const p = mapPoint(e.clientX, e.clientY);
      setDropTarget(p ? rectAtPoint(layout, p.x, p.y) : null);
    };
    const onUp = () => {
      const target = dropTargetRef.current;
      const agent = agents.find((a) => a.agentId === draggingId);
      if (agent && target && dragMoved.current) {
        if (target.type === "file") {
          void requestFocusApi(agent.agentId, target.path);
          setFocusId(agent.agentId);
        } else {
          const folder = containingFolder(layout, (target.x0 + target.x1) / 2, (target.y0 + target.y1) / 2);
          const allowedGlobs = [folder?.path ? `${folder.path}/**` : "**"];
          void setMissionApi(agent.agentId, {
            goal: agent.mission?.goal ?? agent.taskLabel ?? "",
            allowedGlobs,
            guardrails: agent.mission?.guardrails ?? [],
            denyGlobs: agent.mission?.denyGlobs ?? [],
          });
        }
        suppressClick.current = true;
      }
      setDraggingId(null);
      setDropTarget(null);
      window.setTimeout(() => {
        suppressClick.current = false;
      }, 0);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [agents, draggingId, layout, transform.k, transform.tx, transform.ty]);

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
          <span className="brand-name">CartoAI</span>
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
          {supervisor?.enabled ? (
            <div className="autopilot">
              <span className={"ap-dot" + (supervisor.killSwitch ? " ap-off" : supervisor.autonomous ? " ap-on" : " ap-watch")} />
              <span className="ap-label">
                Mission Control {supervisor.killSwitch ? "paused" : supervisor.autonomous ? "on" : "watch"}
              </span>
              <button
                className={"ap-kill" + (supervisor.killSwitch ? " armed" : "")}
                title="Kill switch: stop all interventions"
                onClick={() => setSupervisorApi({ killSwitch: !supervisor.killSwitch })}
              >
                {supervisor.killSwitch ? "resume" : "stop"}
              </button>
            </div>
          ) : (
            <span className="autopilot ap-disabled" title="AI judgment is off; local territories and forbidden-path guardrails are active">
              <span className="ap-dot ap-watch" /> Local guardrails
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
                overlays={focusOverlays}
              />
              <TerritoryOutlines outlines={territoryOutlines} />
              <DropTargetHighlight rect={draggingId ? dropTarget : null} />
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
                    onClick={(id) => {
                      if (!suppressClick.current) setFocusId(id);
                    }}
                    onDragStart={startPinDrag}
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

          {/* alert circles: red = errors (blocks/territory), yellow = warnings (drift/steer) */}
          {(errorIvs.length > 0 || warnIvs.length > 0) && (
            <div className="alert-cluster" onClick={(e) => e.stopPropagation()}>
              <div className="alert-circles">
                {errorIvs.length > 0 && (
                  <button
                    className={"alert-circle alert-error" + (openAlert === "error" ? " open" : "")}
                    title={`${errorIvs.length} error${errorIvs.length === 1 ? "" : "s"} — click to view`}
                    onClick={() => setOpenAlert((o) => (o === "error" ? null : "error"))}
                  >
                    {errorIvs.length}
                  </button>
                )}
                {warnIvs.length > 0 && (
                  <button
                    className={"alert-circle alert-warn" + (openAlert === "warning" ? " open" : "")}
                    title={`${warnIvs.length} warning${warnIvs.length === 1 ? "" : "s"} — click to view`}
                    onClick={() => setOpenAlert((o) => (o === "warning" ? null : "warning"))}
                  >
                    {warnIvs.length}
                  </button>
                )}
              </div>

              {openAlert && (
                <div className="alert-panel">
                  <div className="alert-panel-head">
                    <span className="alert-panel-title">
                      {openAlert === "error" ? "Errors" : "Warnings"} ({alertList.length})
                    </span>
                    <button className="alert-clear" onClick={() => clearAlerts(alertList)}>
                      clear all
                    </button>
                  </div>
                  <ul className="alert-list">
                    {alertList
                      .slice()
                      .reverse()
                      .map((i) => {
                        const a = agents.find((x) => x.agentId === i.agentId);
                        const color =
                          openAlert === "error" ? ALIGNMENT.off_track.color : ALIGNMENT.drifting.color;
                        return (
                          <li key={interventionKey(i)}>
                            <button className="alert-row" onClick={() => selectAlert(i)}>
                              <span className="alert-row-dot" style={{ background: color }} />
                              <span className="alert-row-who">
                                {a ? typeName(a) : i.agentId.slice(0, 8)}
                              </span>
                              <span className="alert-row-reason">{i.filePath ?? i.reason}</span>
                              <span className="alert-row-ago mono">{agoLabel(now - i.ts)}</span>
                            </button>
                          </li>
                        );
                      })}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* status legend */}
          <div className="legend">
            {focusAgent?.mission ? (
              <>
                <span className="legend-item"><span className="legend-dot legend-allowed" />allowed</span>
                <span className="legend-item"><span className="legend-dot legend-risky" />risky</span>
                <span className="legend-item"><span className="legend-dot legend-forbidden" />forbidden</span>
                <span className="legend-item"><span className="legend-dot legend-touched" />touched</span>
              </>
            ) : (
              (["working", "waiting", "stopped", "failed"] as const).map((k) => (
                <span key={k} className="legend-item">
                  <span className="legend-dot" style={{ background: STATUS[k].ring }} />
                  {STATUS[k].label}
                </span>
              ))
            )}
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
              jumpTs={jumpTo && jumpTo.agentId === focusAgent.agentId ? jumpTo.ts : undefined}
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
