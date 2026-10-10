import { useCallTree, useLogicFunctions } from "../../api/queries";
import type { CallTree, LogicBlock, LogicFunction } from "../../api/types";
import { Html } from "../../components/Html";
import { matchCallNode } from "../../lib/callTree";
import type { PRRef } from "../../state/storage";

type Props = {
  pr: PRRef;
  mapId: string;
  block: LogicBlock;
  headSha: string;
  onClose: () => void;
  onShowInReview: (path: string, line: number) => void;
  /** The PR changes Python files, so its functions may be in the call tree. */
  python: boolean;
  onShowCalls: (nodeId: string) => void;
};

/** The real functions behind a leaf block, with this PR's changes highlighted. */
export function FunctionPanel({ pr, mapId, block, headSha, onClose, onShowInReview, python, onShowCalls }: Props) {
  const fns = useLogicFunctions(mapId, block.id);
  // Only once a panel is open: the call tree costs a checkout and a read of the repo.
  const tree = useCallTree(pr, headSha, python);
  return (
    <aside aria-label={block.label}
      className="sticky top-20 max-h-[calc(100vh-6rem)] w-[40%] shrink-0 overflow-y-auto rounded-xl border border-stone-200 bg-white shadow-sm dark:border-stone-800 dark:bg-stone-900">
      <div className="sticky top-0 flex items-start gap-2 border-b border-stone-200 bg-white/95 px-4 py-3 backdrop-blur dark:border-stone-800 dark:bg-stone-900/95">
        <h2 className="min-w-0 flex-1 text-sm font-semibold">{block.label}</h2>
        <button type="button" aria-label="Close" onClick={onClose} className="rounded px-1.5 text-stone-400 hover:bg-stone-200 hover:text-stone-700 dark:hover:bg-stone-800">×</button>
      </div>
      <div className="space-y-5 p-4">
        {fns.isPending && <p className="text-sm text-stone-500">Loading the code…</p>}
        {fns.error && <p className="text-sm text-red-700 dark:text-red-300">Couldn't load the code: {(fns.error as Error).message}</p>}
        {fns.data && !fns.data.functions.length && (
          <p className="text-sm text-stone-500">No single function implements this{block.children?.length ? " block's steps" : " step"}.</p>
        )}
        {fns.data?.functions.map((fn, i) => (
          <Function key={i} pr={pr} fn={fn} headSha={headSha} onShowInReview={onShowInReview} tree={tree.data} onShowCalls={onShowCalls}
            step={fn.step !== block.label ? fn.step : null} />
        ))}
      </div>
    </aside>
  );
}

type FunctionProps = {
  pr: PRRef; fn: LogicFunction; headSha: string; onShowInReview: Props["onShowInReview"];
  /** The step this function belongs to, when the panel is for a block with steps inside. */
  step: string | null;
  tree: CallTree | undefined;
  onShowCalls: Props["onShowCalls"];
};

function Function({ pr, fn, headSha, onShowInReview, step, tree, onShowCalls }: FunctionProps) {
  const callNode = tree && !fn.missing ? matchCallNode(tree, fn.path, fn.start) : null;
  const firstChange = fn.lines.find((l) => l.changed)?.n;
  const untouched = !fn.inDiff || firstChange === undefined;
  return (
    <section>
      {step && <div className="logic-step mb-1 text-xs font-semibold uppercase tracking-wider text-violet-700 dark:text-violet-300">{step}</div>}
      <div className="mb-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <div className="font-mono text-sm font-semibold">{fn.symbol}</div>
        <div className="font-mono text-xs text-stone-500">{fn.path}:{fn.start}–{fn.end}</div>
        {untouched && <span className="text-xs text-stone-500">unchanged by this PR</span>}
        <span className="ml-auto flex gap-3">
          {callNode && (
            <button type="button" className="text-xs font-semibold text-violet-700 hover:underline dark:text-violet-300"
              title="Who calls this, and what it calls" onClick={() => onShowCalls(callNode.id)}>
              Calls
            </button>
          )}
          {fn.inDiff ? (
            <button type="button" className="text-xs font-semibold text-amber-700 hover:underline dark:text-amber-300"
              onClick={() => onShowInReview(fn.path, firstChange ?? fn.start)}>
              Show in Code view
            </button>
          ) : (
            <a className="text-xs font-semibold text-amber-700 hover:underline dark:text-amber-300" target="_blank" rel="noopener"
              href={`https://github.com/${pr.owner}/${pr.repo}/blob/${headSha}/${fn.path}#L${fn.start}-L${fn.end}`}>
              View on GitHub
            </a>
          )}
        </span>
      </div>
      {fn.missing ? (
        <p className="text-sm text-stone-500">{fn.missing}</p>
      ) : (
        <pre className="logic-code">
          {fn.lines.map((l) => (
            <div key={l.n} className={`logic-line${l.changed ? " changed" : ""}`}>
              <span className="ln">{l.n}</span>
              <Html as="code" html={l.html} />
            </div>
          ))}
        </pre>
      )}
    </section>
  );
}
