// fma-treemap.jsx — treemap layout (d3-hierarchy) + the "territory" renderer.
(function(){

// Compute a squarified treemap for the file tree at a given pixel size.
function computeLayout(tree, width, height) {
  if (!tree || width <= 0 || height <= 0) {
    return { width, height, rects: [], byPath: new Map() };
  }
  const root = window.d3
    .hierarchy(tree, (d) => d.children)
    .sum((d) => (d.type === "file" ? Math.max(d.size || 1, 1) : 0))
    .sort((a, b) => (b.value || 0) - (a.value || 0));

  window.d3
    .treemap()
    .size([width, height])
    .paddingOuter(3)
    .paddingTop(18)
    .paddingInner(2.5)
    .round(true)
    .tile(window.d3.treemapSquarify)(root);

  const rects = [];
  const byPath = new Map();
  for (const n of root.descendants()) {
    const r = {
      path: n.data.path, name: n.data.name, type: n.data.type, depth: n.depth,
      x0: n.x0, y0: n.y0, x1: n.x1, y1: n.y1,
    };
    rects.push(r);
    byPath.set(n.data.path, r);
  }
  return { width, height, rects, byPath };
}

// Resolve the cell (rect) for a path: exact file, else nearest existing ancestor.
function resolveCell(path, byPath) {
  let p = path;
  while (p) {
    const r = byPath.get(p);
    if (r) return r;
    const slash = p.lastIndexOf("/");
    p = slash > 0 ? p.slice(0, slash) : null;
  }
  return byPath.get("") || null;
}

function inRegion(path, region) {
  if (!region) return true;
  return path === region || path.startsWith(region + "/");
}

function truncate(name, widthPx, perChar) {
  const max = Math.max(1, Math.floor((widthPx - 8) / (perChar || 6.0)));
  return name.length > max ? name.slice(0, max - 1) + "…" : name;
}

// Grayscale directory fills by depth (near-monochrome, cool-neutral).
const DIR_FILL = [
  "oklch(0.205 0.006 250)",
  "oklch(0.235 0.007 250)",
  "oklch(0.265 0.008 250)",
  "oklch(0.295 0.009 250)",
];
const FILE_FILL = "oklch(0.255 0.007 250)";
const FILE_FILL_HI = "oklch(0.305 0.008 250)";

function Territory({ layout, showLabels, focusRegion, focusFile, activeFiles, accent }) {
  return (
    <g>
      {layout.rects.map((r) => {
        const w = r.x1 - r.x0, h = r.y1 - r.y0;
        if (w < 1 || h < 1) return null;
        const dim = focusRegion && !inRegion(r.path, focusRegion);

        if (r.type === "dir") {
          if (r.depth === 0) return null; // root frame handled by background
          const fill = DIR_FILL[Math.min(r.depth, DIR_FILL.length - 1)];
          return (
            <g key={r.path} opacity={dim ? 0.28 : 1} style={{ transition: "opacity .5s ease" }}>
              <rect x={r.x0} y={r.y0} width={w} height={h} rx={4}
                fill={fill} stroke="oklch(0.16 0.006 250)" strokeWidth={1} />
              {h > 14 && w > 30 && (
                <text x={r.x0 + 6} y={r.y0 + 12} className="dir-label"
                  fill="oklch(0.6 0.012 250)">{truncate(r.name, w, 6.4)}</text>
              )}
            </g>
          );
        }

        // file cell
        const isFocusFile = focusFile && r.path === focusFile;
        const isActive = activeFiles && activeFiles.has(r.path);
        let stroke = "oklch(0.32 0.008 250)", strokeW = 0.75, fill = FILE_FILL;
        if (isActive && !focusRegion) { fill = FILE_FILL_HI; stroke = "oklch(0.45 0.01 250)"; strokeW = 1; }
        if (isFocusFile) { fill = "color-mix(in oklch, " + accent + " 22%, " + FILE_FILL + ")"; stroke = accent; strokeW = 1.5; }
        return (
          <g key={r.path} opacity={dim ? 0.3 : 1} style={{ transition: "opacity .5s ease" }}>
            <rect x={r.x0} y={r.y0} width={w} height={h} rx={3}
              fill={fill} stroke={stroke} strokeWidth={strokeW} />
            {showLabels && w > 38 && h > 13 && (
              <text x={r.x0 + 5} y={r.y0 + h / 2 + 3.2} className="file-label"
                fill="oklch(0.6 0.01 250)">{truncate(r.name, w, 5.6)}</text>
            )}
          </g>
        );
      })}
    </g>
  );
}

window.FMATree = { computeLayout, resolveCell, Territory };
})();
