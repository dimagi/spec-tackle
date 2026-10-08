import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMap, useNarration, type PRMap } from "../../api/map";
import type { Page } from "../../api/types";
import type { PRRef } from "../../state/storage";
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
};

function Notice({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "warn" | "error" }) {
  return <div className={`map-notice ${tone}`}>{children}</div>;
}

export function MapView({ page, pr, head, onOpenFile, renderGraph }: Props) {
  const { map, updating, error, retry } = useMap(pr, head, true);
  const narrate = useNarration(pr);
  const [hover, setHover] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [reviewed, setReviewed] = useState(() => loadReviewed(pr));
  const diffOf = (path: string) => page.files.find((f) => f.path === path)?.diff ?? "";
  const isDone = (path: string) => isReviewed(reviewed, path, diffOf(path));
  const toggle = (path: string) => setReviewed(toggleReviewed(pr, path, diffOf(path)));

  const linkFor = (path: string) => `https://github.com/${pr.owner}/${pr.repo}/blob/${head}/${path}`;
  const inPR = (path: string) => map?.nodes.find((n) => n.id === path)?.hop !== 1;
  // Files in the PR open in Review; dependents (not in the PR) open on GitHub.
  const open = (path: string) => (inPR(path) ? onOpenFile(path) : window.open(linkFor(path), "_blank", "noopener"));

  // j/k walk the rows as shown, x ticks (files in the PR only), Enter opens.
  const order = map ? pathGroups(map.readingPath, map.nodes).flatMap((g) => [...g.files, ...g.dependents]) : [];
  const keys = useRef({ order, selected, toggle, open, inPR });
  keys.current = { order, selected, toggle, open, inPR };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as Element).closest?.("input, textarea, dialog") || e.metaKey || e.ctrlKey || e.altKey) return;
      const { order, selected, toggle, open, inPR } = keys.current;
      if (!order.length) return;
      const onControl = !!(e.target as Element).closest?.("button, a, select");
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
      <div className={`map-grid ${renderGraph ? "" : "single"}`}>
        {renderGraph && <div className="map-graph">{renderGraph({ map, hover, selected, onHover: setHover, onSelect: setSelected, onOpen: open })}</div>}
        <ReadingPath
          phases={map.readingPath} nodes={map.nodes} reviewed={isDone} narration={narrate.data ?? {}}
          selected={selected} hover={hover} onHover={setHover} onSelect={setSelected} onOpen={open} onToggleReviewed={toggle}
          linkFor={linkFor}
        />
      </div>
    </div>
  );
}
