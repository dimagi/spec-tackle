import type { ChangeNode, Changes } from "../../api/map";

const LABEL: Record<string, string> = { data: "Data", core: "Core logic", edges: "Edges", tests: "Tests", other: "Other", check: "Check, not in PR" };
const dot = (n: ChangeNode) =>
  n.change === "caller" ? "bg-stone-300" : n.change === "added" ? "bg-emerald-500" : n.change === "removed" ? "bg-rose-500" : "bg-sky-500";

type Props = {
  changes: Changes;
  visible: Set<string>;
  selected: string | null;
  hover: string | null;
  onHover: (id: string | null) => void;
  onSelect: (id: string) => void;
};

/** The changes in reading order, dependencies first; callers to check at the end. */
export function ChangePath({ changes, visible, selected, hover, onHover, onSelect }: Props) {
  const byId = new Map(changes.nodes.map((n) => [n.id, n]));
  return (
    <div className="map-path">
      {changes.readingPath.map((g) => {
        const ids = g.ids.filter((id) => visible.has(id));
        if (!ids.length) return null;
        return (
          <section key={g.phase}>
            <h3 className="map-phase">{LABEL[g.phase] ?? g.phase}</h3>
            {ids.map((id) => {
              const n = byId.get(id)!;
              return (
                <div key={id} data-testid="change-row" data-id={id}
                  className={`map-row ${selected === id ? "sel" : ""} ${hover === id ? "hl" : ""} ${n.change === "caller" ? "dependent" : ""}`}
                  onMouseEnter={() => onHover(id)} onMouseLeave={() => onHover(null)} onClick={() => onSelect(id)}>
                  <span className={`h-2 w-2 shrink-0 rounded-sm ${dot(n)}`} />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{n.label} <span className="text-stone-400">{n.file.split("/").pop()}</span></span>
                  {n.signatureChanged && <span className="map-flag warn">✎sig</span>}
                  {n.change === "moved" && <span className="map-flag new">⇄moved</span>}
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}
