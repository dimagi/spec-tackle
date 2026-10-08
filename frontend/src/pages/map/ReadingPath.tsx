import type { MapNode, Phase } from "../../api/map";

const PHASE_LABEL: Record<Phase, string> = { data: "Data", core: "Core logic", edges: "Edges", tests: "Tests", other: "Other" };
const PHASES: Phase[] = ["data", "core", "edges", "tests", "other"];

export type ReadingPathProps = {
  phases: { phase: Phase; files: string[] }[];
  nodes: MapNode[];
  reviewed: (path: string) => boolean;
  narration: Record<string, string>;
  selected: string | null;
  hover: string | null;
  onHover: (path: string | null) => void;
  onSelect: (path: string) => void;
  onOpen: (path: string) => void;
  onToggleReviewed: (path: string) => void;
};

const size = (n: MapNode) => (n.additions ?? 0) + (n.deletions ?? 0);
const dot = (n: MapNode) =>
  n.hop === 1 ? "bg-stone-300" : n.status === "added" ? "bg-emerald-500" : n.status === "removed" ? "bg-rose-500" : "bg-sky-500";

export function ReadingPath({ phases, nodes, reviewed, narration, selected, hover, onHover, onSelect, onOpen, onToggleReviewed }: ReadingPathProps) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const changed = phases.flatMap((p) => p.files);
  const done = changed.filter(reviewed).length;
  const largest = Math.max(1, ...nodes.filter((n) => n.hop === 0).map(size));
  const groups = PHASES.map((phase) => ({
    phase,
    files: phases.find((p) => p.phase === phase)?.files ?? [],
    dependents: nodes.filter((n) => n.hop === 1 && n.phase === phase).map((n) => n.id),
  })).filter((g) => g.files.length || g.dependents.length);

  const row = (path: string, step: number | null) => {
    const n = byId.get(path);
    const dependent = n?.hop === 1;
    const name = path.split("/").pop()!;
    const dir = path.slice(0, -name.length);
    return (
      <div key={path}>
        <div
          data-testid="path-row" data-path={path}
          className={`map-row ${selected === path ? "sel" : ""} ${hover === path ? "hl" : ""} ${dependent ? "dependent" : ""}`}
          onMouseEnter={() => onHover(path)} onMouseLeave={() => onHover(null)}
          onClick={() => onSelect(path)}
        >
          <input type="checkbox" checked={!dependent && reviewed(path)} disabled={dependent}
            aria-label={`Reviewed ${path}`} onClick={(e) => e.stopPropagation()} onChange={() => onToggleReviewed(path)} />
          <span className="w-5 text-right font-mono text-[10px] text-stone-400">{step ?? ""}</span>
          <span className={`h-2 w-2 shrink-0 rounded-sm ${n ? dot(n) : "bg-stone-300"}`} />
          <button className="min-w-0 flex-1 truncate text-left font-mono text-xs" title={path} onClick={(e) => { e.stopPropagation(); onOpen(path); }}>
            <span className="text-stone-400">{dir}</span>{name}
          </button>
          {dependent ? (
            <span className="map-tag check" title={n?.references?.length ? `uses ${n.references.join(", ")}` : undefined}>not in PR · check</span>
          ) : (
            <>
              <span className="map-bar"><i style={{ width: `${(100 * (n ? size(n) : 0)) / largest}%` }} /></span>
              {n?.tag && <span className={`map-tag ${n.tag}`}>{n.tag}</span>}
            </>
          )}
        </div>
        {narration[path] && <div className="map-note">{narration[path]}</div>}
      </div>
    );
  };

  let step = 0;
  return (
    <div className="map-path">
      <div className="map-progress">
        Reviewed {done} of {changed.length} files
        <i><b style={{ width: `${changed.length ? (100 * done) / changed.length : 0}%` }} /></i>
      </div>
      {groups.map((g) => (
        <section key={g.phase}>
          <h3 className="map-phase">{PHASE_LABEL[g.phase]}</h3>
          {g.files.map((p) => row(p, ++step))}
          {g.dependents.map((p) => row(p, null))}
        </section>
      ))}
    </div>
  );
}
