/** The Logic view's tree as a React Flow graph, laid out by ELK. Expanded blocks become group nodes. */

import type { Edge, Node } from "@xyflow/react";
import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api";
import type { LogicBlock } from "../api/types";

export type Direction = "DOWN" | "RIGHT";
export type FlowData = { block: LogicBlock; direction: Direction };
export type FlowNode = Node<FlowData>;

const MIN_WIDTH = 190;
const MAX_WIDTH = 300;

/** A card wide enough for most labels and tall enough for the lines the label wraps to. */
export function cardSize(label: string): { width: number; height: number } {
  const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, label.length * 7 + 40));
  // Generous per-character width: long tokens like dotted paths wrap early.
  const lines = Math.max(1, Math.ceil((label.length * 7.6) / (width - 28)));
  return { width, height: 45 + lines * 19 };
}

/** Room above a group's steps for its title, which wraps onto a second line when long. */
const groupTop = (label: string) => (label.length > 40 ? 62 : 44);

export function toElkGraph(blocks: LogicBlock[], expanded: Set<string>, direction: Direction): ElkNode {
  const level = (list: LogicBlock[]): { children: ElkNode[]; edges: ElkExtendedEdge[] } => ({
    children: list.map((b) =>
      b.children?.length && expanded.has(b.id)
        ? { id: b.id, layoutOptions: { "elk.padding": `[top=${groupTop(b.label)},left=20,bottom=20,right=20]` }, ...level(b.children) }
        : { id: b.id, ...cardSize(b.label) },
    ),
    edges: list.flatMap((b) => b.next.map((e, i) => ({ id: edgeId(b.id, e.to, i), sources: [b.id], targets: [e.to] }))),
  });
  return {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": direction,
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.layered.spacing.nodeNodeBetweenLayers": "56",
      "elk.spacing.nodeNode": "36",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
    },
    ...level(blocks),
  };
}

const edgeId = (from: string, to: string, i: number) => `${from}>${to}#${i}`;

/** Lay the tree out and return React Flow nodes (parents before children) and edges. */
export async function layoutFlow(
  blocks: LogicBlock[], expanded: Set<string>, direction: Direction,
): Promise<{ nodes: FlowNode[]; edges: Edge[] }> {
  // Loaded on first use: ELK is most of the Logic view's download.
  const { default: ELK } = await import("elkjs/lib/elk.bundled.js");
  const laid = await new ELK().layout(toElkGraph(blocks, expanded, direction));

  const byId = new Map<string, LogicBlock>();
  const index = (list: LogicBlock[]) => list.forEach((b) => { byId.set(b.id, b); index(b.children ?? []); });
  index(blocks);

  const nodes: FlowNode[] = [];
  const place = (list: ElkNode[], parentId?: string) => list.forEach((n) => {
    const group = !!n.children?.length;
    nodes.push({
      id: n.id,
      // "box", not React Flow's built-in "group" type, which brings its own border and padding.
      type: group ? "box" : "card",
      // ELK gives positions relative to the parent, which is what React Flow wants for child nodes.
      position: { x: n.x ?? 0, y: n.y ?? 0 },
      ...(parentId ? { parentId, extent: "parent" as const } : {}),
      style: { width: n.width, height: n.height },
      data: { block: byId.get(n.id)!, direction },
      draggable: false,
      selectable: false,
      focusable: false,
    });
    if (group) place(n.children!, n.id);
  });
  place(laid.children ?? []);

  const edges: Edge[] = [];
  const connect = (list: LogicBlock[]) => {
    for (const b of list) {
      b.next.forEach((e, i) => edges.push({
        id: edgeId(b.id, e.to, i), source: b.id, target: e.to, type: "smoothstep",
        ...(e.label ? { label: e.label } : {}),
      }));
    }
    for (const b of list) if (b.children?.length && expanded.has(b.id)) connect(b.children);
  };
  connect(blocks);
  return { nodes, edges };
}

/** Every block that has children, for Expand all. */
export function allParentIds(blocks: LogicBlock[]): string[] {
  return blocks.flatMap((b) => (b.children?.length ? [b.id, ...allParentIds(b.children)] : []));
}
