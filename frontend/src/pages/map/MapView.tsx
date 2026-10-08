import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMap, useNarration, type ChangeEdge, type ChangeNode, type PRMap } from "../../api/map";
import type { Page } from "../../api/types";
import type { PRRef } from "../../state/storage";
import { ChangeDetail } from "./ChangeDetail";
import { visibleChanges, type ChangeFilters } from "./changeFilters";
import { ChangePath } from "./ChangePath";
import { pathGroups, ReadingPath } from "./ReadingPath";
import { isReviewed, loadReviewed, toggleReviewed } from "./reviewed";

type Props = {
  page: Page;
  pr: PRRef;
  /** The PR's latest head commit (from live activity). */
  head: string;
  onOpenFile: (path: string) => void;
  /** The dependency graph, given the map and the shared hover/selection. */
  renderGraph?: (args: {
    map: PRMap; hover: string | null; selected: string | null;
    onHover: (p: string | null) => void; onSelect: (p: string) => void; onOpen: (p: string) => void;
  }) => ReactNode;
  /** The change graph (Changes mode). */
  renderChangeGraph?: (args: {
    nodes: ChangeNode[]; edges: ChangeEdge[]; selected: string | null; hover: string | null;
    onHover: (id: string | null) => void; onSelect: (id: string | null) => void; initialCollapsed: string[];
  }) => ReactNode;
};

const COLLAPSE_ABOVE = 60;
const CHANGES_LIMIT = 400;

function Notice({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "warn" | "error" }) {
  return <div className={`map-notice ${tone}`}>{children}</div>;
}

export function MapView({ page, pr, head, onOpenFile, renderGraph, renderChangeGraph }: Props) {
  const { map, updating, error, retry } = useMap(pr, head, true);
  const narrate = useNarration(pr);
  const [hover, setHover] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [reviewed, setReviewed] = useState(() => loadReviewed(pr));
  const [mode, setMode] = useState<"files" | "changes">("files");
  const [filters, setFilters] = useState<ChangeFilters>({ hideTests: false, hideProbable: false, onlyRisky: false });
  const [change, setChange] = useState<string | null>(null);
  const [changeHover, setChangeHover] = useState<string | null>(null);
  const diffOf = (path: string) => page.files.find((f) => f.path === path)?.diff ?? "";
  const isDone = (path: string) => isReviewed(reviewed, path, diffOf(path));
  const toggle = (path: string) => setReviewed(toggleReviewed(pr, path, diffOf(path)));

  const linkFor = (path: string) => `https://github.com/${pr.owner}/${pr.repo}/blob/${head}/${path}`;
  const inPR = (path: string) => map?.nodes.find((n) => n.id === path)?.hop !== 1;
  // Files in the PR open in Review; dependents (not in the PR) open on GitHub.
  const open = (path: string) => (inPR(path) ? onOpenFile(path) : window.open(linkFor(path), "_blank", "noopener"));

  const changes = map?.changes;
  const changeCount = changes ? changes.tooMany ?? changes.nodes.filter((n) => n.change !== "caller").length : 0;
  // Memoised: a new array here would re-run the graph layout on every hover.
  const shown = useMemo(() => {
    if (!changes || mode !== "changes") return null;
    const phaseOf = (file: string) =>
      map?.nodes.find((n) => n.id === file)?.phase ?? (/(^|\/)(tests\/|test_)/.test(file) ? "tests" : "core");
    return visibleChanges(changes, filters, phaseOf);
  }, [changes, mode, filters, map]);
  const shownIds = useMemo(() => new Set(shown?.nodes.map((n) => n.id) ?? []), [shown]);
  const initialCollapsed = useMemo(
    () => (changes && changeCount > COLLAPSE_ABOVE ? [...new Set(changes.nodes.map((n) => n.file))] : []),
    [changes, changeCount],
  );

  // j/k walk the rows as shown, x ticks (files in the PR only), Enter opens; in Changes mode they walk the changes.
  const fileOrder = map ? pathGroups(map.readingPath, map.nodes).flatMap((g) => [...g.files, ...g.dependents]) : [];
  const changeOrder = changes ? changes.readingPath.flatMap((g) => g.ids).filter((id) => shownIds.has(id)) : [];
  const keys = useRef({ mode, fileOrder, changeOrder, selected, change, toggle, open, inPR });
  keys.current = { mode, fileOrder, changeOrder, selected, change, toggle, open, inPR };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as Element).closest?.("input, textarea, dialog") || e.metaKey || e.ctrlKey || e.altKey) return;
      const { mode, fileOrder, changeOrder, selected, change, toggle, open, inPR } = keys.current;
      if (mode === "changes") {
        const i = change ? changeOrder.indexOf(change) : -1;
        if (e.key === "j" && changeOrder.length) setChange(changeOrder[Math.min(changeOrder.length - 1, i + 1)]);
        else if (e.key === "k" && changeOrder.length) setChange(changeOrder[Math.max(0, i - 1)]);
        else if (e.key === "Escape") setChange(null);
        else return;
        e.preventDefault();
        return;
      }
      const order = fileOrder;
      if (!order.length) return;
      const onControl = !!(e.target as Element).closest?.(".map-view button, .map-view a, .map-view select");
      const i = selected ? order.indexOf(selected) : -1;
      if (e.key === "j") setSelected(order[Math.min(order.length - 1, i + 1)]);
      else if (e.key === "k") setSelected(order[Math.max(0, i - 1)]);
      else if (e.key === "x" && selected && inPR(selected)) toggle(selected);
      else if (e.key === "Enter" && selected && !onControl) open(selected);
      else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (selected) document.querySelector(`[data-path="${CSS.escape(selected)}"].map-row`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  if (!map) {
    return (
      <div className="map-view">
        {error ? (
          <Notice tone="error">{error} <button className="ml-2 font-semibold underline" onClick={() => retry()}>Retry</button></Notice>
        ) : (
          <Notice><span className="spinner mr-2" />Analysing the code… This takes a few seconds, longer the first time a repo is cloned.</Notice>
        )}
        <ol className="map-plain">
          {page.files.map((f) => (
            <li key={f.path}><button className="font-mono text-xs" onClick={() => onOpenFile(f.path)}>{f.path}</button></li>
          ))}
        </ol>
      </div>
    );
  }

  const notes: ReactNode[] = [];
  if (updating) notes.push(<Notice key="u"><span className="spinner mr-2" />Updating for the latest commits…</Notice>);
  if (error) notes.push(<Notice key="e" tone="error">{error} <button className="ml-2 font-semibold underline" onClick={() => retry()}>Retry</button></Notice>);
  if (!map.limits.importGraph) notes.push(<Notice key="g" tone="warn">Shown without import connections: no Python packages were found, or the import graph took too long to build.</Notice>);
  if (map.limits.graphTruncated) notes.push(<Notice key="t" tone="warn">The graph shows the 40 largest files; the reading path lists them all.</Notice>);
  if (map.limits.baseMissing) notes.push(<Notice key="b" tone="warn">GitHub didn't send the diff for some files, so removed and re-signed symbols aren't marked for them.</Notice>);
  const skipped = map.skipped.filter((s) => s.path);
  if (skipped.length) notes.push(<Notice key="s" tone="warn">Couldn't parse {skipped.map((s) => s.path).join(", ")}.</Notice>);

  return (
    <div className="map-view">
      <div className="map-toolbar">
        {changes && (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <div className="flex rounded-lg bg-stone-200/70 p-0.5 text-xs font-medium dark:bg-stone-800">
              <button className={`seg ${mode === "files" ? "on" : ""}`} onClick={() => setMode("files")}>Files</button>
              <button
                className={`seg ${mode === "changes" ? "on" : ""}`} disabled={changeCount > CHANGES_LIMIT}
                title={changeCount > CHANGES_LIMIT ? `This PR has too many changes to draw one by one (${changeCount}); use Files.` : "One node per changed function, class or field"}
                onClick={() => setMode("changes")}
              >Changes</button>
            </div>
            {mode === "changes" && ([
              ["hideTests", "Hide tests"], ["hideProbable", "Hide probable edges"], ["onlyRisky", "Only risky"],
            ] as const).map(([key, label]) => (
              <button key={key} className={`map-chip ${filters[key] ? "on" : ""}`} onClick={() => setFilters({ ...filters, [key]: !filters[key] })}>{label}</button>
            ))}
          </div>
        )}
        <div className="min-w-0 flex-1 space-y-2">{notes}</div>
        {page.claude && (
          <div className="flex shrink-0 items-center gap-2">
            {narrate.error && <span className="text-xs text-rose-600">{(narrate.error as Error).message}</span>}
            <button className="btn-ghost" disabled={narrate.isPending} onClick={() => narrate.mutate()}>
              {narrate.isPending ? "Narrating…" : "✦ Narrate with Claude"}
            </button>
          </div>
        )}
      </div>
      {shown && changes ? (
        <div className={`map-grid ${renderChangeGraph ? "" : "single"}`}>
          {renderChangeGraph && (
            <div className="map-graph">
              {renderChangeGraph({
                nodes: shown.nodes, edges: shown.edges, selected: change, hover: changeHover, onHover: setChangeHover, onSelect: setChange,
                initialCollapsed,
              })}
            </div>
          )}
          <div>
            {change && changes.nodes.find((n) => n.id === change) && (
              <ChangeDetail
                node={changes.nodes.find((n) => n.id === change)!} changes={{ ...changes, edges: shown.edges }}
                diff={page.files.find((f) => f.path === changes.nodes.find((n) => n.id === change)!.file)?.diff ?? null}
                onGo={setChange} onOpenReview={onOpenFile}
              />
            )}
            <ChangePath changes={changes} visible={shownIds} selected={change} hover={changeHover} onHover={setChangeHover} onSelect={setChange} />
          </div>
        </div>
      ) : (
      <div className={`map-grid ${renderGraph ? "" : "single"}`}>
        {renderGraph && <div className="map-graph">{renderGraph({ map, hover, selected, onHover: setHover, onSelect: setSelected, onOpen: open })}</div>}
        <ReadingPath
          phases={map.readingPath} nodes={map.nodes} reviewed={isDone} narration={narrate.data ?? {}}
          selected={selected} hover={hover} onHover={setHover} onSelect={setSelected} onOpen={open} onToggleReviewed={toggle}
          linkFor={linkFor}
        />
      </div>
      )}
    </div>
  );
}
