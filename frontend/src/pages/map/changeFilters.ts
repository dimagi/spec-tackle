import type { ChangeEdge, ChangeEdgeType, Changes } from "../../api/map";

// No ELK in here: MapView imports this eagerly, and ELK (1.4 MB) only loads with the graph.

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

