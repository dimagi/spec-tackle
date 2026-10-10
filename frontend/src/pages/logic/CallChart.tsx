/** The call tree as a React Flow chart, laid out by ELK. Loaded lazily with the Calls view. */
import {
  applyNodeChanges, Background, Controls, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, useReactFlow,
  type Edge, type NodeChange, type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { CallEdge, CallNode } from "../../api/types";
import { callName, isRoot, layoutCalls, type CallFlowNode } from "../../lib/callTree";

type Props = {
  nodes: CallNode[];
  edges: CallEdge[];
  hiddenTests: Map<string, number>;
  selected: string | null;
  /** Nodes not connected to the focused one. */
  faded: Set<string>;
  onActivate: (id: string) => void;
  /** A click on the chart's background: clears the focus. */
  onBackground: () => void;
  onFailed: () => void;
};

const TONE = {
  added: "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/60",
  changed: "border-amber-500 bg-amber-50 dark:bg-amber-950/50",
  unchanged: "border-stone-300 bg-white dark:border-stone-600 dark:bg-stone-900",
};

// Route, task, command and signal handlers: called by a framework, so they have no callers here.
const ENTRY = /\.(get|post|put|patch|delete|route|task|command)\b|^(receiver|shared_task|task)\b/;
export const isEntry = (n: CallNode) => n.decorators.some((d) => ENTRY.test(d));

type Ctx = {
  selected: string | null;
  faded: Set<string>;
  counts: Map<string, { callers: number; callees: number }>;
  onActivate: (id: string) => void;
};
const CallCtx = createContext<Ctx>(null!);

/** What a screen reader hears, and what a hover shows. */
function nodeLabel(n: CallNode, tests: number, counts: { callers: number; callees: number }): string {
  return [
    `${n.change} ${n.kind} ${n.symbol}`,
    ...(n.signatureChanged ? ["signature changed"] : []),
    ...(isEntry(n) ? ["entry"] : []),
    ...(tests ? [`${tests} test${tests === 1 ? "" : "s"}`] : []),
    `called by ${counts.callers}, calls ${counts.callees}`,
  ].join(", ");
}

function Card({ data }: NodeProps<CallFlowNode>) {
  const { node: n, tests } = data;
  const { selected, faded, counts, onActivate } = useContext(CallCtx);
  const label = nodeLabel(n, tests, counts.get(n.id) ?? { callers: 0, callees: 0 });
  const entry = isEntry(n);
  return (
    <div role="button" tabIndex={0} data-node={n.id} aria-label={label} title={entry ? `${label}\n@${n.decorators.join("\n@")}` : label}
      onClick={() => onActivate(n.id)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onActivate(n.id); } }}
      className={`logic-card nopan h-full rounded-xl px-3 py-2 shadow-sm ${isRoot(n) ? "border-[3px]" : "border-2"} ${TONE[n.change]} ${selected === n.id ? "is-selected" : ""} ${faded.has(n.id) ? "faded" : ""}`}>
      <Handle type="target" position={Position.Top} isConnectable={false} className="!border-0 !bg-transparent" />
      <Handle type="source" position={Position.Bottom} isConnectable={false} className="!border-0 !bg-transparent" />
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-stone-500">
        {n.kind}
        <span className="ml-auto flex gap-1 normal-case tracking-normal">
          {n.signatureChanged && <span className="rounded-full bg-amber-600 px-1.5 text-white">✎ signature</span>}
          {entry && <span className="rounded-full bg-sky-700 px-1.5 text-white">entry</span>}
          {tests > 0 && <span className="rounded-full bg-stone-500 px-1.5 text-white">{tests} test{tests === 1 ? "" : "s"}</span>}
        </span>
      </div>
      <div className="mt-0.5 truncate font-mono text-[13px] font-semibold text-stone-900 dark:text-stone-100">{callName(n)}</div>
      <div className="truncate font-mono text-[11px] text-stone-500">{n.path}:{n.start}</div>
    </div>
  );
}

const nodeTypes = { call: Card };
const FIT = { duration: 300, padding: 0.12 };
const AMBER = "#d97706";

function edgeStyle(e: CallEdge, dim: boolean): Partial<Edge> {
  const opacity = dim ? 0.15 : e.kind === "probable" ? 0.55 : 1;
  const stroke = e.notUpdated ? AMBER : undefined;
  return {
    type: "smoothstep",
    markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, ...(stroke ? { color: stroke } : {}) },
    style: {
      strokeWidth: e.notUpdated ? 2.5 : 1.5,
      opacity,
      ...(stroke ? { stroke } : {}),
      ...(e.kind === "ref" ? { strokeDasharray: "6 4" } : e.kind === "probable" ? { strokeDasharray: "2 4" } : {}),
    },
    ...(e.notUpdated ? { label: "caller not updated" } : e.kind === "ref" ? { label: "passes" } : {}),
    labelBgPadding: [6, 3] as [number, number],
    labelBgBorderRadius: 6,
    labelStyle: e.notUpdated ? { fill: AMBER, fontWeight: 600 } : undefined,
  };
}

function Flow({ nodes, edges, hiddenTests, faded, onBackground, onFailed }: Pick<Props, "nodes" | "edges" | "hiddenTests" | "faded" | "onBackground" | "onFailed">) {
  const [graph, setGraph] = useState<{ nodes: CallFlowNode[]; edges: Edge[] } | null>(null);
  const { fitView } = useReactFlow();
  const failed = useRef(onFailed);
  failed.current = onFailed;

  useEffect(() => {
    let cancelled = false;
    layoutCalls(nodes, edges, hiddenTests).then(
      (laid) => {
        if (cancelled) return;
        setGraph(laid);
        requestAnimationFrame(() => fitView(FIT));
      },
      () => { if (!cancelled) failed.current(); },
    );
    return () => { cancelled = true; };
  }, [nodes, edges, hiddenTests, fitView]);

  // Dragged cards keep their place until the next layout.
  const onNodesChange = useCallback((changes: NodeChange<CallFlowNode>[]) => {
    setGraph((g) => g && { ...g, nodes: applyNodeChanges(changes, g.nodes) });
  }, []);

  const styled = useMemo(() => (graph?.edges ?? []).map((e) => {
    const edge = (e.data as { edge: CallEdge }).edge;
    return { ...e, ...edgeStyle(edge, faded.has(edge.from) || faded.has(edge.to)) };
  }), [graph, faded]);

  return (
    <ReactFlow
      nodes={graph?.nodes ?? []} edges={styled} nodeTypes={nodeTypes} colorMode={useDarkMode() ? "dark" : "light"}
      onNodesChange={onNodesChange} onPaneClick={onBackground}
      nodesConnectable={false} nodesFocusable={false} edgesFocusable={false} elementsSelectable={false}
      minZoom={0.2} fitView fitViewOptions={FIT}
    >
      <Background gap={20} size={1} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

function useDarkMode() {
  const read = () => document.documentElement.classList.contains("dark");
  const [dark, setDark] = useState(read);
  useEffect(() => {
    const update = () => setDark(read());
    window.addEventListener("spec-tackle:theme", update);
    return () => window.removeEventListener("spec-tackle:theme", update);
  }, []);
  return dark;
}

export default function CallChart({ nodes, edges, hiddenTests, selected, faded, onActivate, onBackground, onFailed }: Props) {
  const counts = useMemo(() => {
    const c = new Map(nodes.map((n) => [n.id, { callers: 0, callees: 0 }]));
    for (const e of edges) {
      c.get(e.to)!.callers += 1;
      c.get(e.from)!.callees += 1;
    }
    return c;
  }, [nodes, edges]);
  const ctx = useMemo(() => ({ selected, faded, counts, onActivate }), [selected, faded, counts, onActivate]);
  return (
    <div className="logic-flow call-flow mt-4 h-[72vh] overflow-hidden rounded-xl border border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900">
      <CallCtx.Provider value={ctx}>
        <ReactFlowProvider>
          <FitOnResize />
          <Flow nodes={nodes} edges={edges} hiddenTests={hiddenTests} faded={faded} onBackground={onBackground} onFailed={onFailed} />
        </ReactFlowProvider>
      </CallCtx.Provider>
    </div>
  );
}

/** Re-fit when the chart's box changes width, e.g. when the panel opens beside it. */
function FitOnResize() {
  const { fitView } = useReactFlow();
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const box = ref.current?.closest(".logic-flow");
    if (!box) return;
    const observer = new ResizeObserver(() => fitView(FIT));
    observer.observe(box);
    return () => observer.disconnect();
  }, [fitView]);
  return <span ref={ref} hidden />;
}
