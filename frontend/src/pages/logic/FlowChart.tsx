/** The Logic map as a React Flow chart, laid out by ELK. Loaded lazily with the Logic view's map. */
import {
  applyNodeChanges, Background, Controls, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, useReactFlow,
  type Edge, type NodeChange, type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { LogicBlock, LogicKind } from "../../api/types";
import { layoutFlow, type FlowNode } from "../../lib/logicFlow";
import { EFFECT_LABEL, edgeWalkClass, type Walk, type WalkMark } from "../../lib/walkthrough";

type Props = {
  blocks: LogicBlock[];
  expanded: Set<string>;
  selected: string | null;
  /** A walkthrough's marks, while its panel is open. */
  walk?: Walk | null;
  /** A click shows a block's code; with Ctrl/⌘ it expands or collapses a block with steps inside. */
  onActivate: (block: LogicBlock, expand: boolean) => void;
  /** ELK couldn't lay the map out; the view shows it as a list instead. */
  onFailed: () => void;
};

const ICON: Record<LogicKind, string> = { entry: "▶", step: "▸", decision: "◇", loop: "↻", async: "⚡", exit: "■" };

const TONE = {
  added: "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/60",
  changed: "border-amber-500 bg-amber-50 dark:bg-amber-950/50",
  unchanged: "border-stone-300 bg-white dark:border-stone-600 dark:bg-stone-900",
};

const countSteps = (b: LogicBlock): number => (b.children ?? []).reduce((n, c) => n + 1 + countSteps(c), 0);
const countFunctions = (b: LogicBlock): number =>
  (b.functions?.length ?? 0) + (b.children ?? []).reduce((n, c) => n + countFunctions(c), 0);

/** What a screen reader hears, and what a hover shows. */
export function blockLabel(b: LogicBlock, expanded: boolean, mark?: WalkMark): string {
  const flagged = (mark?.danger ? "; looks malicious" : "")
    + (mark?.effects.length ? `; effects: ${mark.effects.map((k) => EFFECT_LABEL[k]).join(", ")}` : "");
  if (expanded) return `⊖ ${b.label}: show its code; Ctrl-click to collapse${flagged}`;
  const more = !!b.children?.length;
  return `${b.label}${more ? " ⊕" : ""}: ${b.kind}, show its code${more ? "; Ctrl-click to expand" : ""}${flagged}`;
}

type Ctx = { selected: string | null; onActivate: Props["onActivate"]; activated: React.MutableRefObject<string | null>; walk: Walk | null };
const FlowCtx = createContext<Ctx>(null!);

/** Click and keyboard handling shared by cards and groups. */
function useActivate(block: LogicBlock) {
  const { selected, onActivate, activated } = useContext(FlowCtx);
  const go = (e: React.MouseEvent | React.KeyboardEvent) => {
    activated.current = block.id;
    onActivate(block, e.ctrlKey || e.metaKey);
  };
  return {
    selected: selected === block.id,
    props: {
      // Dragging a card moves it (React Flow swallows the click that ends a drag); its "nopan"
      // class keeps a drag from panning the chart. Drag the background to pan.
      role: "button",
      tabIndex: 0,
      "data-block": block.id,
      onClick: go,
      onKeyDown: (e: React.KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(e); }
      },
    },
  };
}

function walkClass(m: WalkMark | undefined): string {
  if (!m) return "";
  return [m.current && "walk-current", m.visited && !m.current && "walk-visited", m.dim && "walk-dim"].filter(Boolean).join(" ");
}

function WalkBadges({ mark }: { mark: WalkMark | undefined }) {
  if (!mark) return null;
  return (
    <>
      {mark.step !== null && <span className="walk-step" aria-hidden="true">{mark.step}</span>}
      {(mark.danger || mark.effects.length > 0) && (
        <span className="walk-flags" aria-hidden="true">
          {mark.danger && <span className="walk-danger">⚠</span>}
          {mark.effects.length > 0 && <span className="walk-effects">ⓘ</span>}
        </span>
      )}
    </>
  );
}

function Handles() {
  return (
    <>
      <Handle type="target" position={Position.Top} isConnectable={false} className="!border-0 !bg-transparent" />
      <Handle type="source" position={Position.Bottom} isConnectable={false} className="!border-0 !bg-transparent" />
    </>
  );
}

function Card({ data }: NodeProps<FlowNode>) {
  const b = data.block;
  const { selected, props } = useActivate(b);
  const { walk } = useContext(FlowCtx);
  const mark = walk?.marks.get(b.id);
  const steps = countSteps(b);
  const fns = countFunctions(b);
  const label = blockLabel(b, false, mark);
  return (
    <div {...props} aria-label={label} title={label}
      className={`logic-card nopan h-full rounded-xl border-2 px-3 py-2 shadow-sm ${TONE[b.change]} ${b.kind === "exit" ? "!border-rose-500" : ""} ${selected ? "is-selected" : ""} ${walkClass(mark)}`}>
      <Handles />
      <WalkBadges mark={mark} />
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-stone-500">
        <span className="text-xs" aria-hidden="true">{ICON[b.kind]}</span>{b.kind}
        <span className="ml-auto flex gap-1 normal-case tracking-normal">
          {steps > 0 && <span className="rounded-full bg-stone-800 px-1.5 text-white dark:bg-stone-200 dark:text-stone-900">⊕ {steps} steps</span>}
          {fns > 0 && <span className="rounded-full bg-violet-600 px-1.5 text-white">{fns} fn</span>}
        </span>
      </div>
      <div className="mt-0.5 text-[13px] font-medium leading-snug text-stone-900 dark:text-stone-100">{b.label}</div>
    </div>
  );
}

function Box({ data }: NodeProps<FlowNode>) {
  const b = data.block;
  const { selected, props } = useActivate(b);
  const { walk } = useContext(FlowCtx);
  const mark = walk?.marks.get(b.id);
  const label = blockLabel(b, true, mark);
  return (
    <div {...props} aria-label={label} title={label}
      className={`logic-box nopan h-full w-full rounded-2xl border-2 border-dashed ${TONE[b.change]} ${selected ? "is-selected" : ""} ${walkClass(mark)}`}>
      <Handles />
      <WalkBadges mark={mark} />
      <div className="flex items-start gap-1.5 px-3 py-2 text-xs font-semibold leading-snug text-stone-700 dark:text-stone-200">
        <span aria-hidden="true" className="shrink-0 whitespace-nowrap">⊖ {ICON[b.kind]}</span><span className="line-clamp-2">{b.label}</span>
      </div>
    </div>
  );
}

const nodeTypes = { card: Card, box: Box };
const FIT = { duration: 300, padding: 0.12 };

function Flow({ blocks, expanded, walk, onFailed }: Pick<Props, "blocks" | "expanded" | "onFailed"> & { walk: Walk | null }) {
  const [graph, setGraph] = useState<{ nodes: FlowNode[]; edges: Edge[] } | null>(null);
  const { fitView } = useReactFlow();
  const { activated } = useContext(FlowCtx);
  const failed = useRef(onFailed);
  failed.current = onFailed;

  useEffect(() => {
    let cancelled = false;
    layoutFlow(blocks, expanded, "DOWN").then(
      (laid) => {
        if (cancelled) return;
        setGraph(laid);
        requestAnimationFrame(() => {
          fitView(FIT);
          // A block that turned into a group (or back) is a new element: give it focus back.
          const id = activated.current;
          if (id) document.querySelector<HTMLElement>(`.logic-flow [data-block="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
        });
      },
      () => { if (!cancelled) failed.current(); },
    );
    return () => { cancelled = true; };
  }, [blocks, expanded, fitView, activated]);

  // Dragged blocks keep their place until the next layout (expanding or collapsing a block).
  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => {
    setGraph((g) => g && { ...g, nodes: applyNodeChanges(changes, g.nodes) });
  }, []);

  const edges = useMemo(() => (graph?.edges ?? []).map((e) => {
    const cls = walk ? edgeWalkClass(e.id, walk.taken, walk.path) : "";
    return {
      ...e,
      className: cls || undefined,
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, ...(cls === "walk-taken" ? { color: "#2563eb" } : {}) },
      labelBgPadding: [6, 3] as [number, number],
      labelBgBorderRadius: 6,
      style: cls === "walk-taken" ? { strokeWidth: 3, stroke: "#2563eb" } : { strokeWidth: 1.5 },
    };
  }), [graph, walk]);

  return (
    <ReactFlow
      nodes={graph?.nodes ?? []} edges={edges} nodeTypes={nodeTypes} colorMode={useDarkMode() ? "dark" : "light"}
      onNodesChange={onNodesChange} nodesConnectable={false} nodesFocusable={false} edgesFocusable={false} elementsSelectable={false}
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

export default function FlowChart({ blocks, expanded, selected, walk = null, onActivate, onFailed }: Props) {
  const activated = useRef<string | null>(null);
  const ctx = useMemo(() => ({ selected, onActivate, activated, walk }), [selected, onActivate, walk]);
  return (
    <div className="logic-flow mt-4 h-[72vh] overflow-hidden rounded-xl border border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900">
      <FlowCtx.Provider value={ctx}>
        <ReactFlowProvider>
          <FitOnResize />
          <Flow blocks={blocks} expanded={expanded} walk={walk} onFailed={onFailed} />
        </ReactFlowProvider>
      </FlowCtx.Provider>
    </div>
  );
}

/** Re-fit when the chart's box changes width, e.g. when the function panel opens beside it. */
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
