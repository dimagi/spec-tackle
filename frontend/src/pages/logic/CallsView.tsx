import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useCallTree } from "../../api/queries";
import type { CallEdge, CallNode, CallTree } from "../../api/types";
import { callName, connected, isRoot, visibleTree, type CallFilters } from "../../lib/callTree";
import { loadPref, savePref, type PRRef } from "../../state/storage";
import { CallPanel } from "./CallPanel";

// React Flow and ELK load only when a tree is shown.
const CallChart = lazy(() => import("./CallChart"));

type Props = {
  pr: PRRef;
  head: string;
  /** A node to focus and open, e.g. from the Flow view's function panel. */
  focus: string | null;
  onShowInReview: (path: string, line: number) => void;
};

/** The Calls view: the PR's changed Python functions, with who calls them and what they call. */
export function CallsView({ pr, head, focus, onShowInReview }: Props) {
  const tree = useCallTree(pr, head);
  if (tree.error) {
    return (
      <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
        <p>{(tree.error as Error).message}</p>
        <button type="button" className="mt-2 font-semibold underline" onClick={() => tree.refetch()}>Try again</button>
      </div>
    );
  }
  if (!tree.data) {
    return (
      <div className="py-16 text-center text-sm text-stone-500">
        <span className="spinner mr-2 align-middle" aria-hidden="true" />Reading the code…
        <p className="mt-1 text-xs">The first time, this clones the repository.</p>
      </div>
    );
  }
  if (!tree.data.nodes.length) {
    return (
      <div className="mx-auto max-w-xl py-16 text-center">
        <p className="font-medium">This PR changes no Python functions.</p>
        <Other tree={tree.data} open />
      </div>
    );
  }
  return <TreeView key={tree.data.headSha} pr={pr} tree={tree.data} focus={focus} onShowInReview={onShowInReview} />;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function summary(tree: CallTree): string {
  const real = tree.nodes.filter((n) => !n.test);
  const roots = real.filter(isRoot).length;
  const callers = real.filter((n) => !isRoot(n) && n.up !== null).length;
  const callees = real.filter((n) => !isRoot(n) && n.up === null).length;
  const tests = new Set(tree.nodes.filter((n) => n.test).map((n) => n.id));
  const notUpdated = new Set(tree.edges.filter((e) => e.notUpdated && !tests.has(e.from)).map((e) => e.from)).size;
  const parts = `${plural(roots, "changed function")}, ${plural(callers, "caller")}, ${plural(callees, "callee")}`;
  return notUpdated ? `${parts} · ${plural(notUpdated, "caller")} not updated` : parts;
}

function TreeView({ pr, tree, focus, onShowInReview }: { pr: PRRef; tree: CallTree; focus: string | null; onShowInReview: Props["onShowInReview"] }) {
  const clamp = (d: { up: number; down: number }) => ({ up: Math.min(d.up, tree.depth.up), down: Math.min(d.down, tree.depth.down) });
  const [depth, setDepthState] = useState(() => clamp(loadPref(pr, "callsDepth", { up: 2, down: 1 })));
  const testCount = tree.nodes.filter((n) => n.test).length;
  // A PR that only changes tests has nothing else to show.
  const onlyTests = tree.nodes.filter(isRoot).every((n) => n.test);
  const [tests, setTests] = useState(() => loadPref(pr, "callsShowTests", onlyTests));
  const [probable, setProbable] = useState(true);
  const [breakage, setBreakage] = useState(false);
  const [selected, setSelected] = useState<string | null>(focus);
  const [focused, setFocused] = useState<string | null>(focus);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (focus) { setSelected(focus); setFocused(focus); }
  }, [focus]);

  const setDepth = (next: { up: number; down: number }) => {
    setDepthState(next);
    savePref(pr, "callsDepth", next);
  };
  const toggleTests = () => {
    savePref(pr, "callsShowTests", !tests);
    setTests(!tests);
  };

  const filters: CallFilters = { ...depth, tests, probable, breakage };
  const visible = useMemo(() => visibleTree(tree, filters), [tree, depth.up, depth.down, tests, probable, breakage]); // eslint-disable-line react-hooks/exhaustive-deps
  const faded = useMemo(() => {
    if (!focused || !visible.nodes.some((n) => n.id === focused)) return new Set<string>();
    const keep = connected(visible.edges, focused);
    return new Set(visible.nodes.filter((n) => !keep.has(n.id)).map((n) => n.id));
  }, [focused, visible]);
  const byId = useMemo(() => new Map(tree.nodes.map((n) => [n.id, n])), [tree]);

  const open = (id: string) => { setSelected(id); setFocused(id); };
  const close = () => { setSelected(null); setFocused(null); };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const hasProbable = tree.edges.some((e) => e.kind === "probable");
  const hasBreakage = tree.edges.some((e) => e.notUpdated);
  const node = selected ? byId.get(selected) : undefined;

  return (
    <div className="flex items-start gap-6">
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-medium">{summary(tree)}</p>
        {tree.truncated === "nodes" && (
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
            Showing {plural(tree.depth.up, "caller hop")} and {plural(tree.depth.down, "callee hop")}; the full tree is too large.
          </p>
        )}
        {tree.truncated === "files" && (
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">This repository has more Python files than are read, so some callers may be missing.</p>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-stone-500">
          <Legend />
          <span className="ml-auto flex flex-wrap items-center gap-2">
            <Stepper label="Callers" what="caller" value={depth.up} max={tree.depth.up} onChange={(up) => setDepth({ ...depth, up })} />
            <Stepper label="Callees" what="callee" value={depth.down} max={tree.depth.down} onChange={(down) => setDepth({ ...depth, down })} />
            {testCount > 0 && (
              <button type="button" className="nav-btn" aria-pressed={tests} onClick={toggleTests}>{tests ? "Hide" : "Show"} tests ({testCount})</button>
            )}
            {hasProbable && (
              <button type="button" className="nav-btn" aria-pressed={probable} onClick={() => setProbable(!probable)}>Probable calls</button>
            )}
            {hasBreakage && (
              <button type="button" className="nav-btn" aria-pressed={breakage} onClick={() => setBreakage(!breakage)}>Only breakage</button>
            )}
          </span>
        </div>
        {failed ? (
          <div className="mt-4 rounded-xl border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
            <p className="mb-3 text-xs text-stone-500">The call tree couldn't be laid out, so here it is as a list.</p>
            <CallList nodes={visible.nodes} edges={visible.edges} onOpen={open} />
          </div>
        ) : (
          <Suspense fallback={<div className="mt-4 h-[72vh] animate-pulse rounded-xl bg-stone-100 dark:bg-stone-900" />}>
            <CallChart nodes={visible.nodes} edges={visible.edges} hiddenTests={visible.hiddenTests}
              selected={selected} faded={faded} onActivate={open} onBackground={() => setFocused(null)} onFailed={() => setFailed(true)} />
          </Suspense>
        )}
        <Other tree={tree} />
      </div>
      {node && (
        <CallPanel key={node.id} pr={pr} head={tree.headSha} node={node} tree={tree}
          onClose={close} onOpen={open} onShowInReview={onShowInReview} />
      )}
    </div>
  );
}

function Stepper({ label, what, value, max, onChange }: { label: string; what: string; value: number; max: number; onChange: (n: number) => void }) {
  return (
    <span className="flex items-center gap-1">
      {label}
      <button type="button" className="nav-btn !px-2 !py-0.5" aria-label={`Fewer ${what} hops`} disabled={value <= 0} onClick={() => onChange(value - 1)}>−</button>
      <output className="w-3 text-center font-semibold text-stone-700 dark:text-stone-200" aria-label={`${label}: ${value} hops`}>{value}</output>
      <button type="button" className="nav-btn !px-2 !py-0.5" aria-label={`More ${what} hops`} disabled={value >= max} onClick={() => onChange(value + 1)}>+</button>
    </span>
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
      {swatch("unchanged", "Unchanged")}
      <span>✎ signature changed</span>
      <span className="text-amber-700 dark:text-amber-300">amber arrow: caller not updated</span>
      <span>dashed: passes the function · dotted: probable call</span>
      <span>Only calls the code makes directly are shown</span>
    </span>
  );
}

const REASONS = { "not Python": "not Python", "module level": "changes outside any function", "syntax error": "couldn't be parsed", "too large": "too large to read" };

function Other({ tree, open = false }: { tree: CallTree; open?: boolean }) {
  if (!tree.other.length) return null;
  return (
    <details className="mt-4 text-left text-sm" open={open}>
      <summary className="cursor-pointer text-xs font-medium text-stone-500">Other changes ({tree.other.length})</summary>
      <ul className="mt-2 space-y-0.5 text-xs">
        {tree.other.map((o) => (
          <li key={o.path}><code>{o.path}</code> <span className="text-stone-500">{REASONS[o.reason]}</span></li>
        ))}
      </ul>
    </details>
  );
}

/** The tree as a list: shown when ELK can't lay it out. */
function CallList({ nodes, edges, onOpen }: { nodes: CallNode[]; edges: CallEdge[]; onOpen: (id: string) => void }) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const item = (n: CallNode) => (
    <button type="button" onClick={() => onOpen(n.id)} className={`logic-item ${n.change}`}>
      {callName(n)} <span className="ml-1 text-xs text-stone-500">{n.path}:{n.start}</span>
    </button>
  );
  const group = (title: string, ids: string[]) => ids.length > 0 && (
    <li role="treeitem" aria-expanded>
      <span className="text-xs text-stone-500">{title}</span>
      <ul role="group" className="ml-5 mt-1 space-y-1 border-l border-stone-200 pl-3 dark:border-stone-700">
        {ids.map((id) => byId.get(id)).filter(Boolean).map((n) => <li key={n!.id} role="treeitem">{item(n!)}</li>)}
      </ul>
    </li>
  );
  return (
    <ul role="tree" aria-label="Call tree" className="space-y-2 text-sm">
      {nodes.filter(isRoot).map((n) => (
        <li key={n.id} role="treeitem" aria-expanded>
          {item(n)}
          <ul role="group" className="ml-5 mt-1 space-y-1">
            {group("Called by", edges.filter((e) => e.to === n.id).map((e) => e.from))}
            {group("Calls", edges.filter((e) => e.from === n.id).map((e) => e.to))}
          </ul>
        </li>
      ))}
    </ul>
  );
}
