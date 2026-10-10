import { useCallSource } from "../../api/queries";
import type { CallNode, CallTree } from "../../api/types";
import { Html } from "../../components/Html";
import { callName } from "../../lib/callTree";
import type { PRRef } from "../../state/storage";

type Props = {
  pr: PRRef;
  head: string;
  node: CallNode;
  tree: CallTree;
  onClose: () => void;
  /** Focus and open another node. */
  onOpen: (id: string) => void;
  onShowInReview: (path: string, line: number) => void;
};

/** One call tree node: its source, and who calls it and what it calls. */
export function CallPanel({ pr, head, node, tree, onClose, onOpen, onShowInReview }: Props) {
  const source = useCallSource(pr, head, node.id);
  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  // Each entry shows where the call is: in the caller's file.
  const callers = tree.edges.filter((e) => e.to === node.id).map((e) => ({ other: byId.get(e.from)!, path: byId.get(e.from)!.path, line: e.lines[0] }));
  const callees = tree.edges.filter((e) => e.from === node.id).map((e) => ({ other: byId.get(e.to)!, path: node.path, line: e.lines[0] }));
  const name = callName(node);
  const firstChange = source.data?.lines.find((l) => l.changed)?.n;
  return (
    <aside aria-label={name}
      className="sticky top-20 max-h-[calc(100vh-6rem)] w-[40%] shrink-0 overflow-y-auto rounded-xl border border-stone-200 bg-white shadow-sm dark:border-stone-800 dark:bg-stone-900">
      <div className="sticky top-0 flex items-start gap-2 border-b border-stone-200 bg-white/95 px-4 py-3 backdrop-blur dark:border-stone-800 dark:bg-stone-900/95">
        <div className="min-w-0 flex-1">
          <h2 className="font-mono text-sm font-semibold">{name}</h2>
          <div className="mt-0.5 flex flex-wrap gap-x-3 font-mono text-xs text-stone-500">
            <span>{node.path}:{node.start}–{node.end}</span>
            {node.change === "unchanged" && <span className="font-sans">unchanged by this PR</span>}
            {node.signatureChanged && <span className="font-sans text-amber-700 dark:text-amber-300">✎ signature changed</span>}
          </div>
        </div>
        <button type="button" aria-label="Close" onClick={onClose} className="rounded px-1.5 text-stone-400 hover:bg-stone-200 hover:text-stone-700 dark:hover:bg-stone-800">×</button>
      </div>
      <div className="space-y-4 p-4">
        {node.decorators.length > 0 && (
          <ul className="font-mono text-xs text-violet-700 dark:text-violet-300">
            {node.decorators.map((d) => <li key={d}>@{d}</li>)}
          </ul>
        )}
        <Links title="Called by" items={callers} empty="Nothing in the repository calls this directly." onOpen={onOpen} />
        <Links title="Calls" items={callees} empty="It calls nothing else in the repository." onOpen={onOpen} />
        <section>
          <div className="mb-1.5 flex items-baseline">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-stone-500">Source</h3>
            <span className="ml-auto">
              {source.data?.inDiff ? (
                <button type="button" className="text-xs font-semibold text-amber-700 hover:underline dark:text-amber-300"
                  onClick={() => onShowInReview(node.path, firstChange ?? node.start)}>
                  Show in Code view
                </button>
              ) : source.data && (
                <a className="text-xs font-semibold text-amber-700 hover:underline dark:text-amber-300" target="_blank" rel="noopener"
                  href={`https://github.com/${pr.owner}/${pr.repo}/blob/${head}/${node.path}#L${node.start}-L${node.end}`}>
                  View on GitHub
                </a>
              )}
            </span>
          </div>
          {source.isPending && <p className="text-sm text-stone-500">Loading the code…</p>}
          {source.error && <p className="text-sm text-red-700 dark:text-red-300">Couldn't load the code: {(source.error as Error).message}</p>}
          {source.data?.missing && <p className="text-sm text-stone-500">{source.data.missing}</p>}
          {source.data && !source.data.missing && (
            <pre className="logic-code">
              {source.data.lines.map((l) => (
                <div key={l.n} className={`logic-line${l.changed ? " changed" : ""}`}>
                  <span className="ln">{l.n}</span>
                  <Html as="code" html={l.html} />
                </div>
              ))}
            </pre>
          )}
        </section>
      </div>
    </aside>
  );
}

type Link = { other: CallNode; path: string; line: number };

function Links({ title, items, empty, onOpen }: { title: string; items: Link[]; empty: string; onOpen: (id: string) => void }) {
  return (
    <section>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-stone-500">{title} ({items.length})</h3>
      {items.length ? (
        <ul className="space-y-0.5">
          {items.map(({ other, path, line }) => (
            <li key={other.id}>
              <button type="button" onClick={() => onOpen(other.id)}
                className="flex w-full items-baseline gap-2 rounded px-1.5 py-0.5 text-left hover:bg-stone-100 dark:hover:bg-stone-800">
                <span className={`font-mono text-sm ${other.change !== "unchanged" ? "font-semibold" : ""}`}>{callName(other)}</span>
                <span className="font-mono text-xs text-stone-500">{path}:{line}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : <p className="text-xs text-stone-500">{empty}</p>}
    </section>
  );
}
