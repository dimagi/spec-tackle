import { useLogicFunctions } from "../../api/queries";
import type { LogicBlock, LogicFunction } from "../../api/types";
import type { PRRef } from "../../state/storage";
import { SourceLines, SourceLink } from "./Source";

type Props = {
  pr: PRRef;
  mapId: string;
  block: LogicBlock;
  headSha: string;
  onClose: () => void;
  onShowInReview: (path: string, line: number) => void;
  /** Open a function in the call tree; absent when the PR changes no Python. */
  onShowCalls?: (path: string, line: number) => void;
};

/** The real functions behind a leaf block, with this PR's changes highlighted. */
export function FunctionPanel({ pr, mapId, block, headSha, onClose, onShowInReview, onShowCalls }: Props) {
  const fns = useLogicFunctions(mapId, block.id);
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
          <Function key={i} pr={pr} fn={fn} headSha={headSha} onShowInReview={onShowInReview} onShowCalls={onShowCalls}
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
  onShowCalls: Props["onShowCalls"];
};

function Function({ pr, fn, headSha, onShowInReview, step, onShowCalls }: FunctionProps) {
  // The Calls view finds the function from its place; a Python file is all it needs.
  const showCalls = onShowCalls && fn.path.endsWith(".py") && !fn.missing ? () => onShowCalls(fn.path, fn.start) : null;
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
          {showCalls && (
            <button type="button" className="text-xs font-semibold text-violet-700 hover:underline dark:text-violet-300"
              title="Who calls this, and what it calls" onClick={showCalls}>
              Calls
            </button>
          )}
          <SourceLink pr={pr} head={headSha} path={fn.path} start={fn.start} end={fn.end} inDiff={fn.inDiff}
            line={firstChange ?? fn.start} onShowInReview={onShowInReview} />
        </span>
      </div>
      {fn.missing ? (
        <p className="text-sm text-stone-500">{fn.missing}</p>
      ) : (
        <SourceLines lines={fn.lines} />
      )}
    </section>
  );
}
