// fma-app.jsx — main dashboard: topbar, map (zoom/pan focus), sidebar, tweaks.
const { useState, useEffect, useLayoutEffect, useRef, useMemo } = React;
const { REPO_TREE, AGENTS_LIVE, STATUS, REPO_NAME } = window.FMA;
const { computeLayout, resolveCell, Territory } = window.FMATree;
const { Trails, Pin, Tooltip } = window.FMADots;
const { AgentListPanel, DetailPanel } = window.FMASidebar;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "scenario": "live",
  "accent": "#5b8cff",
  "showLabels": true,
  "showTrails": true
}/*EDITMODE-END*/;

const ACCENTS = ["#5b8cff", "#9a7cff", "#3fb6c6"];

function cellCenter(r) { return { x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2 }; }

// The depth-1 region (top-level dir) a file belongs to; root files -> own cell.
function regionRect(agent, layout) {
  if (!agent.currentFile) return null;
  const seg = agent.currentFile.split("/")[0];
  const dir = layout.byPath.get(seg);
  if (dir && dir.type === "dir") return dir;
  return resolveCell(agent.currentFile, layout.byPath);
}

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const accent = t.accent;
  const scenario = t.scenario; // live | empty | offline
  const connected = scenario !== "offline";
  const agents = scenario === "empty" ? [] : AGENTS_LIVE;

  const mapRef = useRef(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hoveredId, setHoveredId] = useState(null);
  const [focusId, setFocusId] = useState(null);

  useEffect(() => {
    document.documentElement.style.setProperty("--accent", accent);
  }, [accent]);

  useLayoutEffect(() => {
    const el = mapRef.current; if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure); ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Reset focus if the focused agent vanishes (scenario change).
  useEffect(() => {
    if (focusId && !agents.find((a) => a.agentId === focusId)) setFocusId(null);
  }, [scenario]);

  const layout = useMemo(() => computeLayout(REPO_TREE, size.w, size.h), [size.w, size.h]);

  const positions = useMemo(() => {
    const m = new Map();
    for (const a of agents) {
      if (!a.currentFile) { m.set(a.agentId, { x: 30, y: size.h - 26, thinking: true }); continue; }
      const cell = resolveCell(a.currentFile, layout.byPath);
      m.set(a.agentId, cell ? { ...cellCenter(cell), thinking: false } : { x: 30, y: size.h - 26, thinking: true });
    }
    return m;
  }, [agents, layout, size.h]);

  const trails = useMemo(() => {
    if (!t.showTrails) return [];
    return agents.map((a) => ({
      agentId: a.agentId,
      points: (a.trail || []).map((p) => { const c = resolveCell(p, layout.byPath); return c ? cellCenter(c) : null; }).filter(Boolean),
    }));
  }, [agents, layout, t.showTrails]);

  const focusAgent = focusId ? agents.find((a) => a.agentId === focusId) : null;
  const region = focusAgent ? regionRect(focusAgent, layout) : null;

  // Compute zoom/pan transform.
  const transform = useMemo(() => {
    if (!region || size.w === 0) return { k: 1, tx: 0, ty: 0 };
    const rw = region.x1 - region.x0, rh = region.y1 - region.y0;
    const pad = 0.74;
    let k = Math.min((size.w * pad) / rw, (size.h * pad) / rh);
    k = Math.max(1.3, Math.min(k, 2.8));
    const cx = (region.x0 + region.x1) / 2, cy = (region.y0 + region.y1) / 2;
    // Bias center slightly left so the focused region isn't hidden behind nothing.
    const tx = size.w / 2 - k * cx;
    const ty = size.h / 2 - k * cy;
    return { k, tx, ty };
  }, [region, size.w, size.h]);

  const screen = (p) => ({ x: transform.tx + transform.k * p.x, y: transform.ty + transform.k * p.y });

  const activeFiles = useMemo(() => {
    const s = new Set();
    for (const a of agents) if (a.currentFile && a.status !== "stopped") s.add(a.currentFile);
    return s;
  }, [agents]);

  const statusOf = (a) => STATUS[a.status];
  const hovered = hoveredId ? agents.find((a) => a.agentId === hoveredId) : null;
  const hoveredScreen = hovered && positions.get(hovered.agentId) ? screen(positions.get(hovered.agentId)) : null;
  const focusParent = focusAgent && focusAgent.parentId ? agents.find((a) => a.agentId === focusAgent.parentId) : null;

  return (
    <div className={"app" + (focusId ? " app--focus" : "")}>
      {/* ---------- TOP BAR ---------- */}
      <header className="topbar">
        <div className="brand">
          <svg className="pin-glyph" viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
            <path d="M12 2.5c-3.6 0-6.5 2.8-6.5 6.4 0 4.5 5.3 11 6 11.8.3.3.7.3 1 0 .7-.8 6-7.3 6-11.8 0-3.6-2.9-6.4-6.5-6.4z"
              fill="none" stroke="var(--accent)" strokeWidth="1.6" />
            <circle cx="12" cy="9" r="2.4" fill="var(--accent)" />
          </svg>
          <span className="brand-name">Find My Agent</span>
        </div>
        <div className="repo mono"><span className="repo-glyph" />{REPO_NAME}</div>

        <div className="search">
          <span className="search-icn" />
          <input placeholder="Find a file or agent…" spellCheck="false" />
        </div>

        <div className="topbar-right">
          <span className={"conn " + (connected ? "conn--on" : "conn--off")}>
            <span className="conn-dot" />
            {connected ? "connected" : "disconnected"}
          </span>
          <span className="agent-count">
            <span className="count-n">{agents.length}</span> agent{agents.length === 1 ? "" : "s"}
          </span>
        </div>
      </header>

      {/* ---------- BODY ---------- */}
      <div className="body">
        <div className={"map" + (connected ? "" : " map--offline")} ref={mapRef}
             onClick={() => setFocusId(null)}>
          <svg className="territory" width={size.w} height={size.h}>
            <g className="territory-g"
               style={{ transform: `translate(${transform.tx}px, ${transform.ty}px) scale(${transform.k})` }}>
              <Territory layout={layout} showLabels={t.showLabels}
                focusRegion={region ? region.path : null}
                focusFile={focusAgent ? focusAgent.currentFile : null}
                activeFiles={activeFiles} accent={accent} />
              {t.showTrails && (
                <Trails trails={trails} accent={accent}
                  focusId={focusId} focusRegion={region ? region.path : null} />
              )}
            </g>
          </svg>

          {/* pins (in a transform layer shared with the territory; counter-scaled to stay constant size) */}
          {size.w > 0 && (
            <div className="pin-layer"
                 style={{ transform: `translate(${transform.tx}px, ${transform.ty}px) scale(${transform.k})` }}>
              {agents.map((a) => {
                const p = positions.get(a.agentId); if (!p) return null;
                return (
                  <Pin key={a.agentId} agent={a} x={p.x} y={p.y} invK={1 / transform.k} status={statusOf(a)}
                    focused={focusId === a.agentId}
                    dimmed={focusId && focusId !== a.agentId}
                    focusMode={!!focusId} accent={accent}
                    onEnter={setHoveredId} onLeave={() => setHoveredId(null)}
                    onClick={setFocusId} />
                );
              })}
            </div>
          )}

          {/* hover tooltip */}
          {hovered && hoveredScreen && hoveredId !== focusId && (
            <Tooltip agent={hovered} status={statusOf(hovered)}
              x={Math.min(hoveredScreen.x + 18, size.w - 244)}
              y={Math.max(hoveredScreen.y - 12, 10)} />
          )}

          {/* empty state */}
          {agents.length === 0 && (
            <div className="map-hint">
              <div className="hint-card">
                <span className="hint-radar" />
                <div className="hint-title">Waiting for agents to connect</div>
                <div className="hint-sub">The map is live. Start a Claude Code session in
                  <span className="mono"> {REPO_NAME}</span> and its agents will appear here.</div>
              </div>
            </div>
          )}

          {/* offline veil */}
          {!connected && agents.length > 0 && (
            <div className="offline-tag"><span className="conn-dot" /> connection lost · showing last-known positions</div>
          )}

          {/* status legend */}
          <div className="legend">
            {["working", "waiting", "stopped", "failed"].map((k) => (
              <span key={k} className="legend-item">
                <span className="legend-dot" style={{ background: STATUS[k].ring }} />{STATUS[k].label}
              </span>
            ))}
          </div>
        </div>

        {/* ---------- SIDEBAR ---------- */}
        <aside className="sidebar">
          {focusAgent ? (
            <DetailPanel agent={focusAgent} parent={focusParent} status={statusOf(focusAgent)}
              accent={accent} onBack={() => setFocusId(null)} />
          ) : (
            <div className="list-wrap">
              <div className="sidebar-head">
                <h2>Agents</h2>
                <span className="sidebar-count">{agents.length}</span>
              </div>
              {agents.length === 0 ? (
                <p className="list-empty">No agents connected yet. The dashboard is listening.</p>
              ) : (
                <AgentListPanel agents={agents} statusOf={statusOf}
                  hoveredId={hoveredId} onHover={setHoveredId} onLeave={() => setHoveredId(null)}
                  onClick={setFocusId} />
              )}
            </div>
          )}
        </aside>
      </div>

      {/* ---------- TWEAKS ---------- */}
      <TweaksPanel>
        <TweakSection label="Scenario" />
        <TweakRadio label="State" value={scenario}
          options={["live", "empty", "offline"]}
          onChange={(v) => { setFocusId(null); setTweak("scenario", v); }} />
        <TweakSection label="Appearance" />
        <TweakColor label="Focus accent" value={accent} options={ACCENTS}
          onChange={(v) => setTweak("accent", v)} />
        <TweakToggle label="File labels" value={t.showLabels}
          onChange={(v) => setTweak("showLabels", v)} />
        <TweakToggle label="Movement trails" value={t.showTrails}
          onChange={(v) => setTweak("showTrails", v)} />
      </TweaksPanel>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
