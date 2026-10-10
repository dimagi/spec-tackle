import { useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { apiBase, logicKey, useLogic } from "../../api/queries";
import { request } from "../../api/request";
import type { LogicBlock, LogicMap, LogicState } from "../../api/types";
import { allParentIds, withoutTests } from "../../lib/logicFlow";
import {
  containing, entries, pathBlocks, stepForBlock, takenEdges, walkMarks, type Walk,
} from "../../lib/walkthrough";
import { loadPref, savePref, type PRRef } from "../../state/storage";
import { FunctionPanel } from "./FunctionPanel";
import { useWalk } from "./useWalk";
import { WalkthroughPanel } from "./WalkthroughPanel";

// React Flow and ELK load only when a map is shown.
const FlowChart = lazy(() => import("./FlowChart"));

type Props = {
  pr: PRRef;
  /** The head commit of the page being reviewed. */
  head: string;
  /** The walkthrough's entry block id (`?walk=`), or null when its panel is closed. */
  walk: string | null;
  onWalk: (entry: string | null) => void;
  onShowInReview: (path: string, line: number) => void;
};

type Run = { head: string; progress: string };

/** The Logic tab: generate a map of the PR's behaviour, then explore it. */
export function LogicView({ pr, head: pageHead, walk, onWalk, onShowInReview }: Props) {
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
        <MapView key={map.id} pr={pr} map={map} walk={walk} onWalk={onWalk} onShowInReview={onShowInReview} />
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

function MapView({ pr, map, walk, onWalk, onShowInReview }: {
  pr: PRRef; map: LogicMap; walk: Props["walk"]; onWalk: Props["onWalk"]; onShowInReview: Props["onShowInReview"];
}) {
  const parents = useMemo(() => new Set(allParentIds(map.blocks)), [map.blocks]);
  const [expanded, setExpanded] = useState(
    () => new Set(loadPref<string[]>(pr, "logicExpanded", []).filter((id) => parents.has(id))),
  );
  const [selected, setSelected] = useState<LogicBlock | null>(null);
  // Test blocks describe the PR's tests, not its behaviour: hidden unless asked for.
  const [showTests, setShowTests] = useState(() => loadPref(pr, "logicShowTests", false));

  // -- the walkthrough ----------------------------------------------------------
  const entryList = useMemo(() => entries(showTests ? map.blocks : withoutTests(map.blocks).blocks), [map.blocks, showTests]);
  // An entry that's no longer in the map (regenerated, or a hidden test) falls back to the first.
  const entry = walk === null ? null : entryList.some((e) => e.id === walk) ? walk : entryList[0]?.id ?? null;
  const walkRun = useWalk(map.id, entry);
  const trace = entry ? walkRun.data?.trace ?? null : null;
  const [step, setStep] = useState(0);
  const [reached, setReached] = useState(0);
  useEffect(() => { setStep(0); setReached(0); }, [trace?.id]);
  const goTo = (n: number) => { setStep(n); setReached((r) => Math.max(r, n)); };
  const steps = useMemo(() => trace?.steps ?? [], [trace]);
  const onPath = useMemo(() => pathBlocks(map.blocks, steps), [map.blocks, steps]);
  const byId = useMemo(() => {
    const m = new Map<string, LogicBlock>();
    const add = (list: LogicBlock[]) => list.forEach((b) => { m.set(b.id, b); add(b.children ?? []); });
    add(map.blocks);
    return m;
  }, [map.blocks]);

  const pruned = useMemo(() => withoutTests(map.blocks, onPath), [map.blocks, onPath]);
  const blocks = showTests ? map.blocks : pruned.blocks;
  const toggleTests = () => {
    savePref(pr, "logicShowTests", !showTests);
    setShowTests(!showTests);
  };
  // ELK couldn't lay the map out: show it as a list instead.
  const [failed, setFailed] = useState(false);

  // The path's blocks open while the walkthrough is up, without touching the saved choice.
  const shownExpanded = useMemo(
    () => (trace ? new Set([...expanded, ...containing(map.blocks, steps)]) : expanded),
    [expanded, trace, map.blocks, steps],
  );
  const walkMarksFor: Walk | null = useMemo(() => trace && {
    marks: walkMarks(blocks, steps, step),
    taken: takenEdges(blocks, steps, step),
    path: takenEdges(blocks, steps, steps.length - 1),
  }, [trace, blocks, steps, step]);

  const setOpen = (next: Set<string>) => {
    setExpanded(next);
    savePref(pr, "logicExpanded", [...next]);
  };
  /** A click shows a block's code; Ctrl/⌘-click expands or collapses a block with steps inside. */
  const activate = (block: LogicBlock, expand: boolean) => {
    if (expand && block.children?.length) {
      const next = new Set(expanded);
      if (next.has(block.id)) next.delete(block.id);
      else next.add(block.id);
      setOpen(next);
    } else {
      const at = trace && !block.children?.length ? stepForBlock(steps, block.id, reached) : null;
      if (at !== null) goTo(at);
      else setSelected(block);
    }
  };

  useEffect(() => {
    if (!selected && entry === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (selected) setSelected(null);
      else onWalk(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selected, entry, onWalk]);

  return (
    <div className="flex items-start gap-6">
      <div className="min-w-0 flex-1">
        <p className="max-w-3xl text-[15px] leading-relaxed">{map.summary}</p>
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-stone-500">
          <Legend />
          <span className="ml-auto flex gap-2">
            {pruned.hidden > 0 && (
              <button type="button" className="nav-btn" aria-pressed={showTests} onClick={toggleTests}>
                {showTests ? "Hide" : "Show"} tests ({pruned.hidden})
              </button>
            )}
            <button type="button" className="nav-btn" aria-pressed={entry !== null}
              disabled={!entryList.length} title={entryList.length ? undefined : "This map has no entry blocks"}
              onClick={() => onWalk(entry === null ? entryList[0].id : null)}>
              ⏵ Walkthrough
            </button>
            <button type="button" className="nav-btn" onClick={() => setOpen(new Set(parents))}>Expand all</button>
            <button type="button" className="nav-btn" onClick={() => setOpen(new Set())}>Collapse all</button>
          </span>
        </div>
        {failed ? (
          <div className="mt-4 rounded-xl border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
            <p className="mb-3 text-xs text-stone-500">The flowchart couldn't be laid out, so here it is as a list.</p>
            <BlockList blocks={blocks} expanded={shownExpanded} onActivate={activate} />
          </div>
        ) : (
          <Suspense fallback={<div className="mt-4 h-[72vh] animate-pulse rounded-xl bg-stone-100 dark:bg-stone-900" />}>
            <FlowChart blocks={blocks} expanded={shownExpanded} walk={walkMarksFor} selected={selected?.id ?? null}
              onActivate={activate} onFailed={() => setFailed(true)} />
          </Suspense>
        )}
      </div>
      {selected ? (
        <FunctionPanel pr={pr} mapId={map.id} block={selected} headSha={map.headSha}
          onClose={() => setSelected(null)} onShowInReview={onShowInReview}
          onBack={entry !== null ? () => setSelected(null) : undefined} />
      ) : entry !== null && (
        <WalkthroughPanel entries={entryList} entry={entry} onEntry={(id) => onWalk(id)} blocks={byId}
          walk={walkRun} step={step} onStep={goTo} onShowCode={setSelected} onClose={() => onWalk(null)} />
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
      <span>⊕ has finer steps: Ctrl-click (⌘ on Mac) to expand</span>
      <span>◇ decision · ↻ loop · ⚡ async</span>
      <span className="flex items-center gap-1.5"><span className="logic-swatch exit" />red outline: exit (where the flow ends)</span>
    </span>
  );
}

/** The map as a nested list: shown when ELK can't lay it out. */
function BlockList({ blocks, expanded, onActivate, root = true }: {
  blocks: LogicBlock[]; expanded: Set<string>; onActivate: (b: LogicBlock, expand: boolean) => void; root?: boolean;
}) {
  return (
    <ul role={root ? "tree" : "group"} aria-label={root ? "Logic map" : undefined} className={root ? "space-y-1 text-sm" : "ml-5 mt-1 space-y-1 border-l border-stone-200 pl-3 dark:border-stone-700"}>
      {blocks.map((b) => {
        const open = expanded.has(b.id);
        return (
          <li key={b.id} role="treeitem" aria-expanded={b.children?.length ? open : undefined}>
            {b.children?.length ? (
              <button type="button" aria-label={`${open ? "Collapse" : "Expand"} ${b.label}`} onClick={() => onActivate(b, true)}
                className="mr-1 rounded px-1 text-stone-500 hover:bg-stone-200 dark:hover:bg-stone-800">
                {open ? "⊖" : "⊕"}
              </button>
            ) : <span className="mr-1 px-1 text-stone-400">▸</span>}
            <button type="button" onClick={(e) => onActivate(b, e.ctrlKey || e.metaKey)} className={`logic-item ${b.change}`}>
              {b.label}
              <span className="ml-2 text-xs text-stone-500">{b.kind}</span>
            </button>
            {open && b.children && <BlockList blocks={b.children} expanded={expanded} onActivate={onActivate} root={false} />}
          </li>
        );
      })}
    </ul>
  );
}
