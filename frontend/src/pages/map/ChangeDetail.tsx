import type { ChangeEdgeType, ChangeNode, Changes } from "../../api/map";
import { Html } from "../../components/Html";
import { sliceDiff } from "./focus";

const TONE: Partial<Record<ChangeEdgeType, string>> = { "breaks-signature": "warn", "breaks-removed": "bad" };

type Props = {
  node: ChangeNode;
  changes: Changes;
  /** The file's rendered diff, if it has one. */
  diff: string | null;
  onGo: (id: string) => void;
  onOpenReview: (path: string) => void;
};

/** The selected change: what it is, its diff, and what it uses / what uses it. */
export function ChangeDetail({ node, changes, diff, onGo, onOpenReview }: Props) {
  const byId = new Map(changes.nodes.map((n) => [n.id, n]));
  const uses = changes.edges.filter((e) => e.from === node.id);
  const usedBy = changes.edges.filter((e) => e.to === node.id);
  const link = (id: string, type: ChangeEdgeType) => (
    <button key={id} className={`change-link ${TONE[type] ?? ""}`} title={type} onClick={() => onGo(id)}>
      {byId.get(id)?.label ?? id}
    </button>
  );
  return (
    <div className="change-detail">
      <div className="flex flex-wrap items-center gap-2">
        <b className="font-mono text-sm">{node.label}</b>
        <span className={`change-badge ${node.change}`}>{node.change === "caller" ? "unchanged caller" : node.change}</span>
        {node.signatureChanged && <span className="map-flag warn">signature changed</span>}
      </div>
      <div className="mt-1 font-mono text-[11px] text-stone-500">{node.file}{node.additions + node.deletions > 0 ? ` · +${node.additions} −${node.deletions}` : ""}</div>
      {node.from && <div className="mt-1 font-mono text-[11px] text-stone-500">was {node.from.file} · {node.from.name}</div>}
      <div className="mt-3 text-xs"><b>Uses:</b> {uses.length ? uses.map((e) => link(e.to, e.type)) : <span className="text-stone-400">nothing changed</span>}</div>
      <div className="mt-1 text-xs"><b>Used by:</b> {usedBy.length ? usedBy.map((e) => link(e.from, e.type)) : <span className="text-stone-400">nothing in view</span>}</div>
      {diff && (node.lines || node.baseLines) && (
        <Html className="change-diff mt-3 overflow-x-auto" html={sliceDiff(diff, node.lines, node.baseLines)} />
      )}
      {node.change !== "caller" && (
        <button className="mt-2 text-xs font-medium text-amber-700 hover:underline" onClick={() => onOpenReview(node.file)}>Open in Review →</button>
      )}
    </div>
  );
}
