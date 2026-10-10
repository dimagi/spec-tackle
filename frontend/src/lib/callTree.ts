/** The Calls view's data: what to show for the reviewer's filters, and its ELK layout. */

import type { Edge, Node } from "@xyflow/react";
import type { CallEdge, CallNode, CallTree, PageFile } from "../api/types";

export type CallFilters = { up: number; down: number; tests: boolean; probable: boolean; breakage: boolean };
export type CallData = { node: CallNode; tests: number };
export type CallFlowNode = Node<CallData>;

export const isRoot = (n: CallNode) => n.up === 0 && n.down === 0;

/** True when the PR changes a Python file it doesn't remove: the call tree has something to show. */
export const hasPython = (files: PageFile[]) => files.some((f) => f.path.endsWith(".py") && f.status !== "removed");

/**
 * The nodes and edges to draw: the roots, plus what's reachable from them within the
 * chosen hops over the edges the filters keep. Hidden test callers are counted per node.
 */
export function visibleTree(tree: CallTree, f: CallFilters): { nodes: CallNode[]; edges: CallEdge[]; hiddenTests: Map<string, number> } {
  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  const shown = (id: string) => { const n = byId.get(id); return !!n && (f.tests || !n.test); };
  let edges = tree.edges.filter((e) => shown(e.from) && shown(e.to) && (f.probable || e.kind !== "probable"));
  let roots = tree.nodes.filter((n) => isRoot(n) && shown(n.id));
  if (f.breakage) {
    roots = roots.filter((n) => n.signatureChanged);
    edges = edges.filter((e) => e.notUpdated);
  }
  const ids = roots.map((n) => n.id);
  const { callers, callees } = adjacency(edges);
  const keep = new Set([...reach(ids, callers, f.up), ...reach(ids, callees, f.breakage ? 0 : f.down)]);

  const hiddenTests = new Map<string, number>();
  if (!f.tests) {
    const testCallers = new Map<string, Set<string>>();
    for (const e of tree.edges) {
      if (!byId.get(e.from)?.test || !keep.has(e.to)) continue;
      if (!testCallers.has(e.to)) testCallers.set(e.to, new Set());
      testCallers.get(e.to)!.add(e.from);
    }
    testCallers.forEach((s, id) => hiddenTests.set(id, s.size));
  }
  return {
    nodes: tree.nodes.filter((n) => keep.has(n.id)),
    edges: edges.filter((e) => keep.has(e.from) && keep.has(e.to)),
    hiddenTests,
  };
}

/** Who calls each node, and what each node calls. */
function adjacency(edges: CallEdge[]) {
  const callers = new Map<string, string[]>();
  const callees = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, key: string, value: string) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(value);
  };
  for (const e of edges) {
    add(callers, e.to, e.from);
    add(callees, e.from, e.to);
  }
  return { callers, callees };
}

/** Every node reachable from `starts` within `hops` steps of `next`, the starts included. */
function reach(starts: string[], next: Map<string, string[]>, hops = Infinity): Set<string> {
  const seen = new Set(starts);
  let frontier = starts;
  for (let i = 0; i < hops && frontier.length; i++) {
    frontier = frontier.flatMap((id) => next.get(id) ?? []).filter((id) => !seen.has(id) && (seen.add(id), true));
  }
  return seen;
}

/** A node, everything that leads to it, and everything it leads to. */
export function connected(edges: CallEdge[], id: string): Set<string> {
  const { callers, callees } = adjacency(edges);
  return new Set([...reach([id], callers), ...reach([id], callees)]);
}

/** What a card shows as its name: functions and methods with (), classes without. */
export const callName = (n: CallNode) => (n.kind === "class" ? n.symbol : `${n.symbol}()`);

export function callCardSize(n: CallNode): { width: number; height: number } {
  const longest = Math.max(callName(n).length, `${n.path}:${n.start}`.length * 0.85);
  return { width: Math.min(360, Math.max(180, Math.round(longest * 7.6 + 40))), height: 74 };
}

/** Lay the visible tree out top-down, callers above their callees. */
export async function layoutCalls(
  nodes: CallNode[], edges: CallEdge[], hiddenTests: Map<string, number>,
): Promise<{ nodes: CallFlowNode[]; edges: Edge[] }> {
  const { default: ELK } = await import("elkjs/lib/elk.bundled.js");
  const id = (e: CallEdge) => `${e.from}>${e.to}`;
  const laid = await new ELK().layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.layered.spacing.nodeNodeBetweenLayers": "64",
      "elk.spacing.nodeNode": "32",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
    },
    children: nodes.map((n) => ({ id: n.id, ...callCardSize(n) })),
    edges: edges.map((e) => ({ id: id(e), sources: [e.from], targets: [e.to] })),
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return {
    nodes: (laid.children ?? []).map((n) => ({
      id: n.id,
      type: "call",
      position: { x: n.x ?? 0, y: n.y ?? 0 },
      style: { width: n.width, height: n.height },
      data: { node: byId.get(n.id)!, tests: hiddenTests.get(n.id) ?? 0 },
      selectable: false,
      focusable: false,
    })),
    edges: edges.map((e) => ({ id: id(e), source: e.from, target: e.to, data: { edge: e } })),
  };
}

/** The call tree node a Logic function points at: same file, the innermost span holding its first line. */
export function matchCallNode(tree: CallTree, path: string, line: number): CallNode | null {
  const holding = tree.nodes.filter((n) => n.path === path && n.start <= line && line <= n.end);
  holding.sort((a, b) => (a.end - a.start) - (b.end - b.start));
  return holding[0] ?? null;
}
