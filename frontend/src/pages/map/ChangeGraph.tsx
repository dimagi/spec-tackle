import { Background, Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useEffect, useMemo, useState } from "react";
import type { ChangeEdge, ChangeEdgeType, ChangeNode } from "../../api/map";
import { BOX_HEADER, CHANGE_H, CHANGE_W, collapse, layoutChanges, type LaidBox, type LaidNode } from "./changeLayout";
import { focusSet } from "./focus";

const EDGE_STYLE: Record<ChangeEdgeType, { stroke: string; width: number; dash?: string; label?: string }> = {
  uses: { stroke: "#78716c", width: 1.4 },
  probable: { stroke: "#a8a29e", width: 1.2, dash: "2 4" },
  "breaks-signature": { stroke: "#d97706", width: 2.4, label: "⚠ signature changed, caller not updated" },
  "breaks-removed": { stroke: "#dc2626", width: 2.4, label: "⚠ uses removed or renamed code" },
  replaced: { stroke: "#a78bfa", width: 1.3, dash: "1 5", label: "replaced by?" },
  tests: { stroke: "#78716c", width: 1.1, dash: "6 4" },
};

type ChangeData = { node: ChangeNode; faded: boolean; highlighted: boolean };
type BoxData = { box: LaidBox; faded: boolean; onToggle: () => void; summary: string };

function ChangeCard({ data }: NodeProps<Node<ChangeData>>) {
  const n = data.node;
  return (
    <>
      <Handle type="target" position={Position.Bottom} className="map-handle" />
      <div className={`change-node ${n.change} ${data.highlighted ? "is-hl" : ""}`} style={{ width: CHANGE_W, height: CHANGE_H, opacity: data.faded ? 0.2 : 1 }}>
        <div className="truncate font-mono text-[12px]">
          {n.label}
          {n.signatureChanged && <span className="ml-1 text-[10px] font-semibold text-amber-700">✎sig</span>}
          {n.change === "moved" && <span className="ml-1 text-[10px] font-semibold text-violet-700">⇄moved</span>}
        </div>
        <div className="truncate text-[10px] text-stone-500">
          {n.change === "caller" ? "unchanged" : n.change === "moved" && n.from ? `was ${n.from.name}` : `+${n.additions} −${n.deletions}`}
        </div>
      </div>
      <Handle type="source" position={Position.Top} className="map-handle" />
    </>
  );
}

function FileBox({ data }: NodeProps<Node<BoxData>>) {
  const b = data.box;
  return (
    <div className={`change-box ${b.collapsed ? "collapsed" : ""}`} style={{ width: b.w, height: b.h, opacity: data.faded ? 0.3 : 1 }}>
      <Handle type="target" position={Position.Bottom} className="map-handle" />
      <button className="change-box-head" style={{ height: BOX_HEADER }} onClick={data.onToggle} title={b.collapsed ? "Show the changes" : "Collapse this file"}>
        {b.collapsed ? "▸" : "▾"} {b.file}
      </button>
      {b.collapsed && <div className="px-3 text-xs text-stone-500">{data.summary}</div>}
      <Handle type="source" position={Position.Top} className="map-handle" />
    </div>
  );
}

const nodeTypes = { change: ChangeCard, box: FileBox };

type Props = {
  nodes: ChangeNode[];
  edges: ChangeEdge[];
  selected: string | null;
  hover: string | null;
  onHover: (id: string | null) => void;
  onSelect: (id: string | null) => void;
  /** Files whose boxes start collapsed. */
  initialCollapsed: string[];
};

/** Layout B: a box per file holding its changes, arrows from a change to what it uses. */
export function ChangeGraph({ nodes, edges, selected, hover, onHover, onSelect, initialCollapsed }: Props) {
  const [collapsed, setCollapsed] = useState(() => new Set(initialCollapsed));
  const [laid, setLaid] = useState<{ boxes: LaidBox[]; nodes: LaidNode[] } | null>(null);
  useEffect(() => {
    let live = true;
    layoutChanges(nodes, edges, collapsed).then((r) => { if (live) setLaid(r); });
    return () => { live = false; };
  }, [nodes, edges, collapsed]);

  const focus = useMemo(() => (selected ? focusSet(edges, selected) : null), [edges, selected]);
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  if (!laid) return <div className="grid h-full place-items-center text-sm text-stone-500">Laying out…</div>;

  const toggle = (file: string) => setCollapsed((prev) => {
    const next = new Set(prev);
    if (next.has(file)) next.delete(file); else next.add(file);
    return next;
  });
  const flowNodes: Node[] = [
    ...laid.boxes.map((b) => {
      const inBox = nodes.filter((n) => n.file === b.file);
      const summary = `${b.count} change${b.count === 1 ? "" : "s"}${inBox.some((n) => n.change === "caller") ? " · callers" : ""}`;
      return {
        id: b.id, type: "box", className: "nopan", position: { x: b.x, y: b.y }, draggable: false, selectable: false, zIndex: 0,
        style: { width: b.w, height: b.h },
        data: { box: b, summary, faded: !!focus && !inBox.some((n) => focus.has(n.id)), onToggle: () => toggle(b.file) },
      };
    }),
    ...laid.nodes.map((l) => ({
      // "nopan": pressing a change mustn't start panning, or the click lands on the pane instead.
      id: l.id, type: "change", className: "nopan", parentId: l.parent, extent: "parent" as const, position: { x: l.x, y: l.y }, draggable: false, zIndex: 1,
      data: { node: byId.get(l.id)!, faded: !!focus && !focus.has(l.id), highlighted: hover === l.id || selected === l.id },
    })),
  ];
  const flowEdges: Edge[] = collapse(edges, collapsed).map((e, i) => {
    const s = EDGE_STYLE[e.type];
    const faded = !!focus && !(focus.has(e.from) && focus.has(e.to));
    return {
      id: `c${i}`, source: e.from, target: e.to, zIndex: 2,
      label: !faded ? s.label : undefined,
      labelStyle: { fill: s.stroke, fontWeight: 600, fontSize: 10 },
      style: { stroke: s.stroke, strokeWidth: s.width, strokeDasharray: s.dash, opacity: faded ? 0.12 : 1 },
      markerEnd: { type: MarkerType.ArrowClosed, color: s.stroke },
    };
  });

  return (
    <ReactFlow
      nodes={flowNodes} edges={flowEdges} nodeTypes={nodeTypes} fitView minZoom={0.15}
      nodesConnectable={false} nodesDraggable={false} selectNodesOnDrag={false} elementsSelectable={false} proOptions={{ hideAttribution: true }}
      onNodeClick={(_, n) => { if (n.type === "change") onSelect(n.id); }}
      onNodeMouseEnter={(_, n) => { if (n.type === "change") onHover(n.id); }}
      onNodeMouseLeave={() => onHover(null)}
      onPaneClick={() => onSelect(null)}
    >
      <Background gap={24} size={1} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
