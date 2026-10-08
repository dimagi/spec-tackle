import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiBase, logicKey, useLogic } from "../../api/queries";
import { request } from "../../api/request";
import type { LogicBlock, LogicMap, LogicState } from "../../api/types";
import { allParentIds, toMermaid, type MermaidChart } from "../../lib/logicMermaid";
import { loadPref, savePref, type PRRef } from "../../state/storage";
import { FunctionPanel } from "./FunctionPanel";

type Props = {
  pr: PRRef;
  /** The head commit of the page being reviewed. */
  head: string;
  onShowInReview: (path: string, line: number) => void;
};

type Run = { head: string; progress: string };

/** The Logic tab: generate a map of the PR's behaviour, then explore it. */
export function LogicView({ pr, head: pageHead, onShowInReview }: Props) {
  // A run is for the PR's real head, which can be newer than the page's; follow that one.
  const [head, setHead] = useState(pageHead);
  useEffect(() => setHead(pageHead), [pageHead]);
  const logic = useLogic(pr, head);
  const queryClient = useQueryClient();
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const api = apiBase(pr);
  const refetch = () => queryClient.invalidateQueries({ queryKey: logicKey(pr, head) });

  // Rejoin a run that's already going (another tab, or before a reload).
  useEffect(() => {
    if (logic.data?.running && !run) setRun({ head, progress: "Working…" });
  }, [logic.data?.running, run, head]);

  useEffect(() => {
    if (!run) return;
    const source = new EventSource(`${api}/logic/events?head=${encodeURIComponent(run.head)}`);
    const end = () => {
      source.close();
      setRun(null);
      refetch();
    };
    source.onmessage = (e) => {
      const event = JSON.parse(e.data) as { type: string; text?: string };
      if (event.type === "tool") setRun((r) => r && { ...r, progress: event.text ?? r.progress });
      else {
        if (event.type === "error") setError(event.text ?? "Generating the map failed");
        end();
      }
    };
    source.onerror = end;
    return () => source.close();
    // Only a new run (a new head) opens a new stream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.head, api]);

  const generate = async () => {
    setError(null);
    setPosting(true);
    try {
      const started = await request<LogicState>("POST", `${api}/logic`);
      const runHead = started.head ?? head;
      setHead(runHead);
      setRun({ head: runHead, progress: "Starting…" });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPosting(false);
    }
  };

  if (!logic.data) {
    if (logic.error) return <Card tone="error">Couldn't load the Logic view: {(logic.error as Error).message}</Card>;
    return <div className="py-16 text-center text-sm text-stone-500">Loading…</div>;
  }
  const { available, map, stale } = logic.data;
  if (!available) return null;
  // A run that failed while this tab wasn't watching is reported by the server.
  const failure = run ? null : error ?? logic.data.error ?? null;

  return (
    <div className="mx-auto max-w-[1600px] px-4 py-8 lg:px-8">
      {run && (
        <Card>
          <div className="flex items-center gap-3">
            <span className="spinner" aria-hidden="true" />
            <span className="font-medium">{run.progress}</span>
          </div>
          <p className="mt-1 text-xs text-stone-500">Claude is mapping this PR. You can leave this tab; it keeps going.</p>
        </Card>
      )}
      {failure && (
        <Card tone="error">
          <p>{failure}</p>
          <button type="button" className="mt-2 font-semibold underline" onClick={generate} disabled={posting}>Try again</button>
        </Card>
      )}
      {map && stale && !run && (
        <Card tone="notice">
          <span>Generated for <code>{map.headSha.slice(0, 7)}</code>; the PR is now at <code>{head.slice(0, 7)}</code>.</span>{" "}
          <button type="button" className="ml-2 font-semibold underline" onClick={generate} disabled={posting}>Regenerate</button>
        </Card>
      )}
      {map ? (
        <MapView key={map.id} pr={pr} map={map} onShowInReview={onShowInReview} />
      ) : !run && !failure && (
        <div className="mx-auto max-w-xl py-16 text-center">
          <h2 className="font-serif text-2xl font-semibold">See what this PR does</h2>
          <p className="mt-3 text-sm text-stone-600 dark:text-stone-400">
            Claude reads the change and the code around it, and draws the logic as a flowchart of
            pseudo-code steps. Expand any step to see the finer steps inside it, down to the real functions.
          </p>
          <button type="button" onClick={generate} disabled={posting}
            className="mt-6 rounded-xl bg-violet-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-violet-500 disabled:opacity-60">
            Generate logic map
          </button>
          <p className="mt-3 text-xs text-stone-500">Private: runs on your machine with your Claude Code. Takes a minute or two.</p>
        </div>
      )}
    </div>
  );
}

function Card({ children, tone = "info" }: { children: React.ReactNode; tone?: "info" | "error" | "notice" }) {
  const tones = {
    info: "border-violet-200 bg-violet-50 dark:border-violet-900 dark:bg-violet-950/40",
    error: "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200",
    notice: "border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200",
  };
  return <div className={`mb-4 rounded-xl border px-4 py-3 text-sm ${tones[tone]}`}>{children}</div>;
}

// -- the map ------------------------------------------------------------------

function MapView({ pr, map, onShowInReview }: { pr: PRRef; map: LogicMap; onShowInReview: Props["onShowInReview"] }) {
  const parents = useMemo(() => new Set(allParentIds(map.blocks)), [map.blocks]);
  const [expanded, setExpanded] = useState(
    () => new Set(loadPref<string[]>(pr, "logicExpanded", []).filter((id) => parents.has(id))),
  );
  const [selected, setSelected] = useState<LogicBlock | null>(null);
  const chart = useMemo(() => toMermaid(map.blocks, expanded), [map.blocks, expanded]);

  const setOpen = (next: Set<string>) => {
    setExpanded(next);
    savePref(pr, "logicExpanded", [...next]);
  };
  const activate = (block: LogicBlock) => {
    if (block.children?.length) {
      const next = new Set(expanded);
      if (next.has(block.id)) next.delete(block.id);
      else next.add(block.id);
      setOpen(next);
    } else {
      setSelected(block);
    }
  };

  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSelected(null); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selected]);

  return (
    <div className="flex items-start gap-6">
      <div className="min-w-0 flex-1">
        <p className="max-w-3xl text-[15px] leading-relaxed">{map.summary}</p>
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-stone-500">
          <Legend />
          <span className="ml-auto flex gap-2">
            <button type="button" className="nav-btn" onClick={() => setOpen(new Set(parents))}>Expand all</button>
            <button type="button" className="nav-btn" onClick={() => setOpen(new Set())}>Collapse all</button>
          </span>
        </div>
        <Chart chart={chart} selected={selected?.id ?? null} onActivate={activate}
          fallback={<BlockList blocks={map.blocks} expanded={expanded} onActivate={activate} />} />
      </div>
      {selected && (
        <FunctionPanel pr={pr} mapId={map.id} block={selected} headSha={map.headSha}
          onClose={() => setSelected(null)} onShowInReview={onShowInReview} />
      )}
    </div>
  );
}

function Legend() {
  const swatch = (cls: string, label: string) => (
    <span className="flex items-center gap-1.5"><span className={`logic-swatch ${cls}`} />{label}</span>
  );
  return (
    <span className="flex flex-wrap items-center gap-3">
      {swatch("added", "Added by this PR")}
      {swatch("changed", "Changed")}
      {swatch("unchanged", "Unchanged context")}
      <span>⊕ has finer steps</span>
      <span>◇ decision · ↻ loop · ⚡ async</span>
    </span>
  );
}

let renderCount = 0;
const NODE_ID = /(?:^|-)(n\d+)(?:-|$)/;
const CLUSTER_ID = /(?:^|-)(c\d+)$/;

type ChartProps = {
  chart: MermaidChart;
  selected: string | null;
  onActivate: (block: LogicBlock) => void;
  fallback: React.ReactNode;
};

/** The flowchart, drawn by Mermaid, with its nodes made clickable and focusable. */
function Chart({ chart, selected, onActivate, fallback }: ChartProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const activate = useRef(onActivate);
  activate.current = onActivate;
  // The block last activated from the keyboard gets focus back after a redraw.
  const refocus = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const draw = async () => {
      try {
        const { default: mermaid } = await import("mermaid");
        const dark = document.documentElement.classList.contains("dark");
        mermaid.initialize({ startOnLoad: false, theme: dark ? "dark" : "neutral", securityLevel: "strict" });
        const { svg } = await mermaid.render(`logic-chart-${++renderCount}`, chart.source);
        if (cancelled || !ref.current) return;
        ref.current.innerHTML = svg;
        wire(ref.current);
        setFailed(false);
      } catch {
        if (!cancelled) setFailed(true);
      }
    };
    const wire = (root: HTMLElement) => {
      const hook = (el: Element, block: LogicBlock, label: string) => {
        el.setAttribute("tabindex", "0");
        el.setAttribute("role", "button");
        el.setAttribute("aria-label", label);
        el.classList.add("logic-hit");
        const go = () => { refocus.current = block.id; activate.current(block); };
        el.addEventListener("click", go);
        el.addEventListener("keydown", (e) => {
          const key = (e as KeyboardEvent).key;
          if (key === "Enter" || key === " ") { e.preventDefault(); go(); }
        });
        if (refocus.current === block.id) (el as HTMLElement).focus();
      };
      root.querySelectorAll("g.node").forEach((el) => {
        const block = chart.nodes.get(NODE_ID.exec(el.id)?.[1] ?? "");
        if (!block) return;
        const more = block.children?.length;
        hook(el, block, `${block.label}${more ? " ⊕" : ""}: ${block.kind}, ${more ? "expand" : "show its functions"}`);
      });
      root.querySelectorAll("g.cluster").forEach((el) => {
        const block = chart.clusters.get(CLUSTER_ID.exec(el.id)?.[1] ?? "");
        if (block) hook(el, block, `⊖ ${block.label}: collapse`);
      });
    };
    window.addEventListener("spec-tackle:theme", draw);
    draw();
    return () => {
      cancelled = true;
      window.removeEventListener("spec-tackle:theme", draw);
    };
  }, [chart]);

  useEffect(() => {
    ref.current?.querySelectorAll(".logic-hit").forEach((el) => {
      const id = NODE_ID.exec(el.id)?.[1];
      el.classList.toggle("is-selected", !!id && chart.nodes.get(id)?.id === selected);
    });
  }, [selected, chart]);

  return (
    <div className="mt-4 rounded-xl border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
      <div ref={ref} className="logic-chart overflow-x-auto" hidden={failed} />
      {failed && (
        <>
          <p className="mb-3 text-xs text-stone-500">The flowchart couldn't be drawn, so here it is as a list.</p>
          {fallback}
        </>
      )}
    </div>
  );
}

/** The map as a nested list: shown when Mermaid can't draw it. */
function BlockList({ blocks, expanded, onActivate, root = true }: {
  blocks: LogicBlock[]; expanded: Set<string>; onActivate: (b: LogicBlock) => void; root?: boolean;
}) {
  return (
    <ul role={root ? "tree" : "group"} aria-label={root ? "Logic map" : undefined} className={root ? "space-y-1 text-sm" : "ml-5 mt-1 space-y-1 border-l border-stone-200 pl-3 dark:border-stone-700"}>
      {blocks.map((b) => {
        const open = expanded.has(b.id);
        return (
          <li key={b.id} role="treeitem" aria-expanded={b.children?.length ? open : undefined}>
            <button type="button" onClick={() => onActivate(b)} className={`logic-item ${b.change}`}>
              {b.children?.length ? (open ? "⊖ " : "⊕ ") : "▸ "}{b.label}
              <span className="ml-2 text-xs text-stone-500">{b.kind}</span>
            </button>
            {open && b.children && <BlockList blocks={b.children} expanded={expanded} onActivate={onActivate} root={false} />}
          </li>
        );
      })}
    </ul>
  );
}
