import { Background, Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useMemo, useState } from "react";
import type { MapNode, Phase, PRMap } from "../../api/map";
import { layoutLanes, NODE_WIDTH } from "./layout";

const PHASE_LABEL: Record<Phase, string> = { data: "Data", core: "Core", edges: "Edges", tests: "Tests", other: "Other" };
const size = (n: MapNode) => (n.additions ?? 0) + (n.deletions ?? 0);

type CardProps = { node: MapNode; maxSize: number; highlighted: boolean; selected?: boolean; onOpen?: (path: string) => void };

/** One file in the graph: a changed file (expandable into symbols) or an unchanged dependent. */
export function FileNodeCard({ node: n, maxSize, highlighted, selected, onOpen }: CardProps) {
  const [open, setOpen] = useState(false);
  const [showIndirect, setShowIndirect] = useState(false);
  const name = n.id.split("/").pop()!;
  const border = n.hop === 0 ? 1.5 + 2.5 * Math.sqrt(size(n) / Math.max(1, maxSize)) : 1.5;
  const symbols = n.symbols?.filter((s) => s.kind !== "module") ?? [];
  return (
    <div
      className={`map-node ${n.hop === 1 ? "dependent" : `status-${n.status}`} ${highlighted ? "is-hl" : ""} ${selected ? "is-sel" : ""}`}
      style={{ borderWidth: border, width: NODE_WIDTH }}
      title={n.id}
    >
      <div className="flex items-center gap-1">
        <button className="min-w-0 flex-1 truncate text-left font-mono text-[12px] font-semibold" onClick={() => onOpen?.(n.id)}>{name}</button>
        {n.hop === 0 && n.tag && <span className={`map-tag ${n.tag}`}>{n.tag}</span>}
      </div>
      {n.hop === 0 ? (
        <div className="flex items-center gap-2 text-[11px] text-stone-500">
          <span className="font-mono">
            {n.status === "added" ? "new · " : n.status === "removed" ? "removed · " : ""}
            <span className="text-emerald-600">+{n.additions}</span> <span className="text-rose-600">−{n.deletions}</span>
          </span>
          {symbols.length > 0 && (
            <button className="ml-auto text-[11px] font-medium hover:underline" onClick={() => setOpen(!open)}>
              {open ? "▾" : "▸"} {symbols.length} symbols
            </button>
          )}
        </div>
      ) : (
        <div className="text-[11px] text-stone-500">
          {n.references?.length ? `unchanged · uses ${n.references.join(", ")}` : "unchanged · imports it"}
        </div>
      )}
      {open && (
        <ul className="map-symbols">
          {symbols.map((s) => (
            <li key={s.name}>
              <span className="font-mono">{s.name}{s.kind === "function" || s.kind === "method" ? "()" : ""}</span>
              {s.signatureChanged && <span className="map-flag warn">signature changed</span>}
              {s.change === "removed" && <span className="map-flag bad">removed</span>}
              {s.change === "added" && <span className="map-flag new">new</span>}
            </li>
          ))}
        </ul>
      )}
      {n.hop === 1 && (n.indirectCount ?? 0) > 0 && (
        <>
          <button className="map-badge" onClick={() => setShowIndirect(!showIndirect)}>+{n.indirectCount} indirect</button>
          {showIndirect && <ul className="map-indirect">{n.indirect!.map((p) => <li key={p} className="font-mono">{p}</li>)}</ul>}
        </>
      )}
    </div>
  );
}

type FileData = { node: MapNode; maxSize: number; highlighted: boolean; selected: boolean; onOpen: (path: string) => void };

function FileNode({ data }: NodeProps<Node<FileData>>) {
  return (
    <>
      <Handle type="target" position={Position.Bottom} className="map-handle" />
      <FileNodeCard node={data.node} maxSize={data.maxSize} highlighted={data.highlighted} selected={data.selected} onOpen={data.onOpen} />
      <Handle type="source" position={Position.Top} className="map-handle" />
    </>
  );
}

function LaneNode({ data }: NodeProps<Node<{ label: string }>>) {
  return <div className="map-lane">{data.label}</div>;
}

const nodeTypes = { file: FileNode, lane: LaneNode };

type Props = {
  map: PRMap;
  hover: string | null;
  selected: string | null;
  onHover: (path: string | null) => void;
  onSelect: (path: string) => void;
  onOpen: (path: string) => void;
};

/** Changed files in lanes by phase (data at the top), arrows from importer to imported. */
export function MapGraph({ map, hover, selected, onHover, onSelect, onOpen }: Props) {
  const [hoverEdge, setHoverEdge] = useState<string | null>(null);
  const { positions, lanes } = useMemo(() => layoutLanes(map.nodes, map.readingPath), [map]);
  const maxSize = Math.max(1, ...map.nodes.filter((n) => n.hop === 0).map(size));
  const focus = hover ?? selected;

  const nodes: Node[] = [
    ...lanes.map((l) => ({
      id: `lane:${l.phase}`, type: "lane", position: { x: 0, y: l.y + 24 }, data: { label: PHASE_LABEL[l.phase] },
      selectable: false, draggable: false, focusable: false,
    })),
    ...map.nodes.filter((n) => positions.has(n.id)).map((n) => ({
      id: n.id, type: "file", position: positions.get(n.id)!, draggable: false,
      data: { node: n, maxSize, highlighted: n.id === focus, selected: n.id === selected, onOpen },
      zIndex: n.id === focus ? 10 : 1,
    })),
  ];
  const edges: Edge[] = map.edges
    .filter((e) => positions.has(e.from) && positions.has(e.to))
    .map((e) => {
      const id = `${e.from}->${e.to}`;
      const lit = focus === e.from || focus === e.to;
      const dependent = map.nodes.find((n) => n.id === e.from)?.hop === 1;
      return {
        id, source: e.from, target: e.to,
        label: hoverEdge === id && e.symbols.length ? e.symbols.join(", ") : undefined,
        animated: lit,
        style: { stroke: lit ? "#d97706" : "#a8a29e", strokeWidth: lit ? 2 : 1.25, strokeDasharray: dependent ? "5 4" : undefined },
        markerEnd: { type: MarkerType.ArrowClosed, color: lit ? "#d97706" : "#a8a29e" },
      };
    });

  return (
    <ReactFlow
      nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView minZoom={0.2}
      nodesConnectable={false} elementsSelectable={false} proOptions={{ hideAttribution: true }}
      onNodeMouseEnter={(_, node) => { if (node.type === "file") onHover(node.id); }}
      onNodeMouseLeave={() => onHover(null)}
      onNodeClick={(_, node) => { if (node.type === "file") onSelect(node.id); }}
      onEdgeMouseEnter={(_, edge) => setHoverEdge(edge.id)}
      onEdgeMouseLeave={() => setHoverEdge(null)}
    >
      <Background gap={24} size={1} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

