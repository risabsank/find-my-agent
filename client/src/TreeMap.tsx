import { useMemo } from "react";
import {
  hierarchy,
  treemap,
  treemapSquarify,
  type HierarchyRectangularNode,
} from "d3-hierarchy";
import type { TreeNode } from "./types.ts";

export interface Rect {
  path: string;
  name: string;
  type: "dir" | "file";
  depth: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Layout {
  width: number;
  height: number;
  rects: Rect[];
  byPath: Map<string, Rect>;
}

export interface FileOverlay {
  policy?: "allowed" | "risky" | "forbidden";
  touched?: boolean;
}

/** Squarified treemap layout for the file tree at the given pixel size. */
export function useTreemapLayout(
  tree: TreeNode | null,
  width: number,
  height: number,
): Layout {
  return useMemo(() => {
    if (!tree || width <= 0 || height <= 0) {
      return { width, height, rects: [], byPath: new Map() };
    }
    // Weight every file equally (not by byte size) so each file gets a legible
    // cell and small newly-created files are clearly visible — this map is about
    // structure and agent location, not disk usage.
    const root = hierarchy<TreeNode>(tree, (d) => d.children)
      .sum((d) => (d.type === "file" ? 1 : 0))
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

    treemap<TreeNode>()
      .size([width, height])
      .paddingOuter(3)
      .paddingTop(18)
      .paddingInner(2.5)
      .round(true)
      .tile(treemapSquarify)(root);

    const rects: Rect[] = [];
    const byPath = new Map<string, Rect>();
    for (const n of root.descendants() as HierarchyRectangularNode<TreeNode>[]) {
      const r: Rect = {
        path: n.data.path,
        name: n.data.name,
        type: n.data.type,
        depth: n.depth,
        x0: n.x0,
        y0: n.y0,
        x1: n.x1,
        y1: n.y1,
      };
      rects.push(r);
      byPath.set(n.data.path, r);
    }
    return { width, height, rects, byPath };
  }, [tree, width, height]);
}

/** Resolve the cell for a path: exact file, else nearest existing ancestor. */
export function resolveCell(
  path: string | null,
  byPath: Map<string, Rect>,
): Rect | null {
  let p = path;
  while (p) {
    const r = byPath.get(p);
    if (r) return r;
    const slash = p.lastIndexOf("/");
    p = slash > 0 ? p.slice(0, slash) : null;
  }
  return byPath.get("") ?? null;
}

/** The depth-1 region (top-level dir) a file belongs to; root files → own cell. */
export function regionRect(
  currentFile: string | null,
  layout: Layout,
): Rect | null {
  if (!currentFile) return null;
  const seg = currentFile.split("/")[0];
  const dir = layout.byPath.get(seg);
  if (dir && dir.type === "dir") return dir;
  return resolveCell(currentFile, layout.byPath);
}

export function cellCenter(r: Rect): { x: number; y: number } {
  return { x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2 };
}

export function containingFolder(
  layout: Layout,
  x: number,
  y: number,
): Rect | null {
  let best: Rect | null = null;
  for (const r of layout.rects) {
    if (x < r.x0 || x > r.x1 || y < r.y0 || y > r.y1) continue;
    if (r.type === "dir" && (!best || r.depth > best.depth)) best = r;
  }
  return best ?? layout.byPath.get("") ?? null;
}

export function rectAtPoint(
  layout: Layout,
  x: number,
  y: number,
): Rect | null {
  let best: Rect | null = null;
  for (const r of layout.rects) {
    if (x < r.x0 || x > r.x1 || y < r.y0 || y > r.y1) continue;
    if (!best || r.depth > best.depth) best = r;
  }
  return best ?? layout.byPath.get("") ?? null;
}

function inRegion(path: string, region: string | null): boolean {
  if (!region) return true;
  return path === region || path.startsWith(region + "/");
}

function truncate(name: string, widthPx: number, perChar: number): string {
  const max = Math.max(1, Math.floor((widthPx - 8) / perChar));
  return name.length > max ? name.slice(0, max - 1) + "…" : name;
}

const DIR_FILL = [
  "oklch(0.205 0.006 250)",
  "oklch(0.235 0.007 250)",
  "oklch(0.265 0.008 250)",
  "oklch(0.295 0.009 250)",
];
const FILE_FILL = "oklch(0.255 0.007 250)";
const FILE_FILL_HI = "oklch(0.305 0.008 250)";

const OVERLAY_FILL: Record<NonNullable<FileOverlay["policy"]>, string> = {
  allowed: "color-mix(in oklch, oklch(0.74 0.12 150) 20%, oklch(0.255 0.007 250))",
  risky: "color-mix(in oklch, oklch(0.80 0.14 75) 22%, oklch(0.255 0.007 250))",
  forbidden: "color-mix(in oklch, oklch(0.64 0.19 25) 26%, oklch(0.255 0.007 250))",
};

const OVERLAY_STROKE: Record<NonNullable<FileOverlay["policy"]>, string> = {
  allowed: "oklch(0.62 0.12 150)",
  risky: "oklch(0.75 0.13 75)",
  forbidden: "oklch(0.64 0.19 25)",
};

/** The "territory": treemap directories and file cells, with focus dimming. */
export function Territory({
  layout,
  showLabels,
  focusRegion,
  focusFile,
  activeFiles,
  overlays,
}: {
  layout: Layout;
  showLabels: boolean;
  focusRegion: string | null;
  focusFile: string | null;
  activeFiles: Set<string>;
  overlays?: Map<string, FileOverlay>;
}) {
  return (
    <g>
      {layout.rects.map((r) => {
        const w = r.x1 - r.x0;
        const h = r.y1 - r.y0;
        if (w < 1 || h < 1) return null;
        const dim = focusRegion != null && !inRegion(r.path, focusRegion);

        if (r.type === "dir") {
          if (r.depth === 0) return null; // root frame is the map background
          const fill = DIR_FILL[Math.min(r.depth, DIR_FILL.length - 1)];
          return (
            <g key={r.path} opacity={dim ? 0.28 : 1} style={{ transition: "opacity .5s ease" }}>
              <rect
                x={r.x0}
                y={r.y0}
                width={w}
                height={h}
                rx={4}
                fill={fill}
                stroke="oklch(0.16 0.006 250)"
                strokeWidth={1}
              />
              {h > 14 && w > 30 && (
                <text
                  x={r.x0 + 6}
                  y={r.y0 + 12}
                  className="dir-label"
                  fill="oklch(0.6 0.012 250)"
                >
                  {truncate(r.name, w, 6.4)}
                </text>
              )}
            </g>
          );
        }

        // file cell
        const isFocusFile = focusFile != null && r.path === focusFile;
        const isActive = activeFiles.has(r.path);
        const overlay = overlays?.get(r.path);
        const policy = overlay?.policy;
        let stroke = "oklch(0.32 0.008 250)";
        let strokeW = 0.75;
        let fill = FILE_FILL;
        if (policy) {
          fill = OVERLAY_FILL[policy];
          stroke = OVERLAY_STROKE[policy];
          strokeW = 1;
        } else if (overlay?.touched) {
          fill = FILE_FILL_HI;
          stroke = "var(--accent)";
          strokeW = 1.25;
        }
        if (isActive && !focusRegion) {
          fill = FILE_FILL_HI;
          stroke = "oklch(0.45 0.01 250)";
          strokeW = 1;
        }
        if (isFocusFile) {
          fill = `color-mix(in oklch, var(--accent) 22%, ${FILE_FILL})`;
          stroke = "var(--accent)";
          strokeW = 1.5;
        }
        return (
          <g key={r.path} opacity={dim ? 0.3 : 1} style={{ transition: "opacity .5s ease" }}>
            <rect
              x={r.x0}
              y={r.y0}
              width={w}
              height={h}
              rx={3}
              fill={fill}
              stroke={stroke}
              strokeWidth={strokeW}
            >
              <title>{r.path}</title>
            </rect>
            {showLabels && w > 38 && h > 13 && (
              <text
                x={r.x0 + 5}
                y={r.y0 + h / 2 + 3.2}
                className="file-label"
                fill="oklch(0.6 0.01 250)"
              >
                {truncate(r.name, w, 5.6)}
              </text>
            )}
            {overlay?.touched && w > 8 && h > 8 && (
              <circle cx={r.x1 - 5} cy={r.y0 + 5} r={2} fill="var(--accent)" />
            )}
          </g>
        );
      })}
    </g>
  );
}

export function TerritoryOutlines({
  outlines,
}: {
  outlines: { rect: Rect; color: string; label: string; active?: boolean }[];
}) {
  return (
    <g className="territory-outlines">
      {outlines.map(({ rect, color, label, active }) => {
        const w = rect.x1 - rect.x0;
        const h = rect.y1 - rect.y0;
        if (w < 2 || h < 2) return null;
        return (
          <g key={`${label}:${rect.path}`} opacity={active ? 0.95 : 0.58}>
            <rect
              x={rect.x0 + 2}
              y={rect.y0 + 2}
              width={Math.max(0, w - 4)}
              height={Math.max(0, h - 4)}
              rx={6}
              fill="none"
              stroke={color}
              strokeWidth={active ? 2 : 1.35}
              strokeDasharray={active ? "none" : "5 4"}
            />
            {w > 54 && h > 22 && (
              <text
                x={rect.x0 + 7}
                y={rect.y0 + 28}
                className="territory-label"
                fill={color}
              >
                {label}
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
}

export function DropTargetHighlight({ rect }: { rect: Rect | null }) {
  if (!rect) return null;
  const w = rect.x1 - rect.x0;
  const h = rect.y1 - rect.y0;
  return (
    <g className="drop-target">
      <rect
        x={rect.x0 + 2}
        y={rect.y0 + 2}
        width={Math.max(0, w - 4)}
        height={Math.max(0, h - 4)}
        rx={7}
        fill="color-mix(in oklch, var(--accent) 10%, transparent)"
        stroke="var(--accent)"
        strokeWidth={2}
      />
      {w > 70 && h > 22 && (
        <text x={rect.x0 + 8} y={rect.y0 + 28} className="drop-label" fill="var(--accent)">
          {rect.type === "file" ? "request focus" : "assign territory"}: {rect.path || "repo"}
        </text>
      )}
    </g>
  );
}
