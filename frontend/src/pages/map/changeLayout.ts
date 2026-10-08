import ELK from "elkjs/lib/elk.bundled.js";
import type { ChangeEdge, ChangeEdgeType, ChangeNode, Changes } from "../../api/map";

export const CHANGE_W = 190;
export const CHANGE_H = 46;
export const BOX_HEADER = 30;
export const COLLAPSED_H = 58;

export type ChangeFilters = { hideTests: boolean; hideProbable: boolean; onlyRisky: boolean };

const SEVERITY: Record<ChangeEdgeType, number> = { "breaks-removed": 5, "breaks-signature": 4, uses: 3, probable: 2, tests: 1, replaced: 0 };
export const isBreakage = (t: ChangeEdgeType) => t === "breaks-removed" || t === "breaks-signature";
export const boxId = (file: string) => `box:${file}`;

/** The changes and edges left after the filter chips. */
export function visibleChanges(changes: Changes, f: ChangeFilters, phaseOf: (file: string) => string) {
  let nodes = changes.nodes;
  let edges = changes.edges;
  if (f.hideTests) {
    nodes = nodes.filter((n) => phaseOf(n.file) !== "tests");
    edges = edges.filter((e) => e.type !== "tests");
  }
  if (f.hideProbable) edges = edges.filter((e) => e.type !== "probable");
  if (f.onlyRisky) {
    const keep = new Set<string>();
    const broken = edges.filter((e) => isBreakage(e.type));
    for (const e of broken) keep.add(e.from).add(e.to);
    // ...and what the broken changes use, all the way down.
    const stack = broken.map((e) => e.to);
    while (stack.length) {
      const id = stack.pop()!;
      for (const e of edges) {
        if (e.from === id && (e.type === "uses" || e.type === "probable") && !keep.has(e.to)) {
          keep.add(e.to);
          stack.push(e.to);
        }
      }
    }
    nodes = nodes.filter((n) => keep.has(n.id));
    edges = edges.filter((e) => isBreakage(e.type) || (keep.has(e.from) && keep.has(e.to) && e.type !== "tests"));
  }
  const ids = new Set(nodes.map((n) => n.id));
  return { nodes, edges: edges.filter((e) => ids.has(e.from) && ids.has(e.to)) };
}

const fileOf = (id: string) => id.slice(0, id.indexOf("::"));

/** Edges with collapsed files' changes replaced by the file's box; duplicates keep the most severe. */
export function collapse(edges: ChangeEdge[], collapsed: Set<string>): ChangeEdge[] {
  const end = (id: string) => (collapsed.has(fileOf(id)) ? boxId(fileOf(id)) : id);
  const merged = new Map<string, ChangeEdge>();
  for (const e of edges) {
    const from = end(e.from), to = end(e.to);
    if (from === to) continue;
    const key = `${from}>${to}`;
    const prev = merged.get(key);
    if (!prev || SEVERITY[e.type] > SEVERITY[prev.type]) merged.set(key, { ...e, from, to });
  }
  return [...merged.values()];
}

export type LaidBox = { id: string; file: string; x: number; y: number; w: number; h: number; collapsed: boolean; count: number };
export type LaidNode = { id: string; parent: string; x: number; y: number };

const elk = new ELK();

/** File boxes with their changes inside, placed by ELK's layered algorithm (callers above what they use). */
export async function layoutChanges(nodes: ChangeNode[], edges: ChangeEdge[], collapsed: Set<string>) {
  const files = [...new Set(nodes.map((n) => n.file))];
  const graph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.spacing.nodeNode": "24",
      "elk.layered.spacing.nodeNodeBetweenLayers": "48",
      "elk.spacing.edgeNode": "18",
    },
    children: files.map((file) => {
      const inFile = nodes.filter((n) => n.file === file);
      const shut = collapsed.has(file);
      return {
        id: boxId(file),
        layoutOptions: { "elk.padding": `[top=${BOX_HEADER + 8},left=12,bottom=12,right=12]`, "elk.direction": "DOWN" },
        ...(shut ? { width: CHANGE_W + 24, height: COLLAPSED_H } : {}),
        children: shut ? [] : inFile.map((n) => ({ id: n.id, width: CHANGE_W, height: CHANGE_H })),
      };
    }),
    edges: collapse(edges, collapsed).map((e, i) => ({ id: `e${i}`, sources: [e.from], targets: [e.to] })),
  };
  const out = await elk.layout(graph);
  const boxes: LaidBox[] = [];
  const laid: LaidNode[] = [];
  for (const box of out.children ?? []) {
    const file = box.id.slice(4);
    boxes.push({
      id: box.id, file, x: box.x ?? 0, y: box.y ?? 0, w: box.width ?? 0, h: box.height ?? 0,
      collapsed: collapsed.has(file), count: nodes.filter((n) => n.file === file).length,
    });
    for (const child of box.children ?? []) laid.push({ id: child.id, parent: box.id, x: child.x ?? 0, y: child.y ?? 0 });
  }
  return { boxes, nodes: laid };
}
