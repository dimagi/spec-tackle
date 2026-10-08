import ELK from "elkjs/lib/elk.bundled.js";
import type { ChangeEdge, ChangeNode } from "../../api/map";
import { boxId, collapse } from "./changeFilters";

export { boxId, collapse, isBreakage, visibleChanges, type ChangeFilters } from "./changeFilters";

export const CHANGE_W = 190;
export const CHANGE_H = 46;
export const BOX_HEADER = 30;
export const COLLAPSED_H = 58;

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
