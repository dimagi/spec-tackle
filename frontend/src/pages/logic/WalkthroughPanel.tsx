import { useEffect, useState } from "react";
import type { EffectKind, LogicBlock, Trace, WalkInput, WalkStep } from "../../api/types";
import { changedKeys, dangerSteps, EFFECT_LABEL, effectSteps, type Highlight } from "../../lib/walkthrough";
import type { WalkRun } from "./useWalk";

type Props = {
  entries: LogicBlock[];
  entry: string;
  onEntry: (id: string) => void;
  blocks: Map<string, LogicBlock>;
  walk: WalkRun;
  step: number;
  onStep: (n: number) => void;
  onShowCode: (block: LogicBlock) => void;
  onClose: () => void;
  /** False while the panel is kept mounted but hidden: it must not react to the keyboard. */
  active?: boolean;
};

const ICON: Record<LogicBlock["kind"], string> = { entry: "▶", step: "▸", decision: "◇", loop: "↻", async: "⚡", exit: "■" };
const show = (v: unknown) => JSON.stringify(v, null, 2);
const valuesOf = (inputs: WalkInput[]) => Object.fromEntries(inputs.map((i) => [i.name, i.value]));

/** The walkthrough beside the Logic map: pick an entry, set its inputs, step through the trace. */
export function WalkthroughPanel({ entries, entry, onEntry, blocks, walk, step, onStep, onShowCode, onClose, active = true }: Props) {
  const { data, progress, error, posting } = walk;
  const trace = data?.trace ?? null;
  const starting = data?.starting ?? null;
  const last = trace ? trace.steps.length - 1 : 0;

  useEffect(() => {
    if (!trace || !active) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.altKey || e.ctrlKey || e.metaKey || t?.closest("input, textarea, select, [contenteditable]")) return;
      if (e.key === "ArrowRight" && step < last) onStep(step + 1);
      if (e.key === "ArrowLeft" && step > 0) onStep(step - 1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [trace, step, last, onStep, active]);

  const flagged = trace ? dangerSteps(trace.steps) : [];
  const effects = trace ? effectSteps(trace.steps) : [];
  const labelOf = (i: number) => blocks.get(trace!.steps[i].blockId)?.label ?? trace!.steps[i].blockId;
  const current = trace?.steps[step];

  return (
    <aside aria-label="Walkthrough" hidden={!active}
      className="sticky top-20 max-h-[calc(100vh-6rem)] w-[40%] shrink-0 overflow-y-auto rounded-xl border border-stone-200 bg-white shadow-sm dark:border-stone-800 dark:bg-stone-900">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-stone-200 bg-white/95 px-4 py-3 backdrop-blur dark:border-stone-800 dark:bg-stone-900/95">
        <h2 className="flex-1 text-sm font-semibold">Walkthrough</h2>
        <button type="button" aria-label="Close" onClick={onClose} className="rounded px-1.5 text-stone-400 hover:bg-stone-200 hover:text-stone-700 dark:hover:bg-stone-800">×</button>
      </div>

      <div className="space-y-3 border-b border-stone-200 px-4 py-3 dark:border-stone-800">
        <label className="block text-xs font-semibold uppercase tracking-wider text-stone-500">
          Entry
          <select aria-label="Entry" value={entry} onChange={(e) => onEntry(e.target.value)}
            className="mt-1 block w-full rounded-lg border border-stone-300 bg-white px-2 py-1.5 text-sm font-normal normal-case tracking-normal text-stone-900 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100">
            {entries.map((e) => <option key={e.id} value={e.id}>▶ {e.label}</option>)}
          </select>
        </label>
        {flagged.length > 0 && (
          <div role="alert" className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/60 dark:text-red-200">
            <p className="font-semibold">⚠ {flagged.length} {flagged.length === 1 ? "step looks" : "steps look"} malicious</p>
            <ul className="mt-1 space-y-0.5">
              {flagged.map((i) => (
                <li key={i}>
                  <button type="button" className="text-left hover:underline" onClick={() => onStep(i)}>{labelOf(i)}</button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {effects.length > 0 && <EffectsSummary groups={effects} label={labelOf} onStep={onStep} />}
      </div>

      {!data && !walk.loadError && <p className="p-4 text-sm text-stone-500">Loading…</p>}
      {walk.loadError && <p className="p-4 text-sm text-red-700 dark:text-red-300">Couldn't load the walkthrough: {walk.loadError.message}</p>}

      {progress && (
        <div className="m-4 rounded-xl border border-violet-200 bg-violet-50 px-4 py-3 text-sm dark:border-violet-900 dark:bg-violet-950/40">
          <div className="flex items-center gap-3"><span className="spinner" aria-hidden="true" /><span className="font-medium">{progress}</span></div>
          {!trace && <p className="mt-1 text-xs text-stone-500">Private: runs on your machine with your Claude Code. Takes a minute or two.</p>}
        </div>
      )}
      {error && (
        <div className="m-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          <p>{error}</p>
          <button type="button" className="mt-2 font-semibold underline" disabled={posting}
            onClick={() => void walk.retry()}>Try again</button>
        </div>
      )}

      {starting && (
        <Inputs key={trace?.id ?? "none"} trace={trace} starting={starting} busy={!!progress || posting} onRun={walk.run} />
      )}

      {trace && current && (
        <>
          <div className="sticky top-[49px] z-10 flex items-center gap-2 border-b border-stone-200 bg-stone-50 px-4 py-2 dark:border-stone-800 dark:bg-stone-950">
            <button type="button" className="nav-btn" disabled={step === 0} onClick={() => onStep(step - 1)}>◀ Prev</button>
            <span className="flex-1 text-center text-sm font-semibold">
              Step {step + 1} of {trace.steps.length}
              <span className="block text-[10px] font-normal text-stone-500">← → to step</span>
            </span>
            <button type="button" className="nav-btn" disabled={step >= last} onClick={() => onStep(step + 1)}>Next ▶</button>
            <button type="button" className="nav-btn" aria-label="Back to step 1" onClick={() => onStep(0)}>↺</button>
          </div>
          <StepCard step={current} block={blocks.get(current.blockId)} trace={trace} isLast={step === last} onShowCode={onShowCode} />
        </>
      )}
    </aside>
  );
}

const EFFECT_PHRASE: Record<EffectKind, (n: number) => string> = {
  external: (n) => `${n} external call${n === 1 ? "" : "s"}`,
  destructive: (n) => `${n} deletes data`,
  unsafe: (n) => `${n} security risk${n === 1 ? "" : "s"}`,
  irreversible: (n) => `${n} irreversible`,
};

/** A neutral line of effect counts; each phrase opens the steps that have it. */
function EffectsSummary({ groups, label, onStep }: {
  groups: { kind: EffectKind; steps: number[] }[]; label: (i: number) => string; onStep: (i: number) => void;
}) {
  const [open, setOpen] = useState<EffectKind | null>(null);
  const shown = groups.find((g) => g.kind === open);
  return (
    <div className="walk-effects-summary text-xs text-stone-600 dark:text-stone-400">
      <p>
        Effects:{" "}
        {groups.map((g, i) => (
          <span key={g.kind}>
            {i > 0 && " · "}
            <button type="button" aria-expanded={open === g.kind} className="underline decoration-dotted hover:text-stone-900 dark:hover:text-stone-100"
              onClick={() => setOpen(open === g.kind ? null : g.kind)}>
              {EFFECT_PHRASE[g.kind](g.steps.length)}
            </button>
          </span>
        ))}
      </p>
      {shown && (
        <ul className="mt-1 space-y-0.5 pl-3">
          {shown.steps.map((i) => (
            <li key={i}><button type="button" className="text-left hover:underline" onClick={() => onStep(i)}>{label(i)}</button></li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Inputs({ trace, starting, busy, onRun }: {
  trace: Trace | null; starting: WalkInput[]; busy: boolean; onRun: WalkRun["run"];
}) {
  const shown = trace?.inputs ?? starting;
  const [drafts, setDrafts] = useState(() => Object.fromEntries(shown.map((i) => [i.name, show(i.value)])));
  const [open, setOpen] = useState(!trace);
  const parsed = Object.fromEntries(Object.entries(drafts).map(([k, v]) => {
    try { return [k, { ok: true, value: JSON.parse(v) as unknown }]; } catch { return [k, { ok: false, value: undefined }]; }
  }));
  const bad = Object.values(parsed).some((p) => !p.ok);
  const edited = starting.some((i) => !parsed[i.name]?.ok || show(parsed[i.name].value) !== show(i.value));
  const values = () => Object.fromEntries(Object.entries(parsed).map(([k, p]) => [k, p.value]));
  const reset = () => {
    setDrafts(Object.fromEntries(starting.map((i) => [i.name, show(i.value)])));
    void onRun(valuesOf(starting));
  };

  return (
    <section className="border-b border-stone-200 px-4 py-3 dark:border-stone-800">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between text-xs font-semibold uppercase tracking-wider text-stone-500">
        <span>Inputs {open ? "▾" : "▸"}</span>
        <span className="font-normal normal-case tracking-normal">
          {starting.length} value{starting.length === 1 ? "" : "s"} · {edited ? "edited" : "proposed by Claude"}
        </span>
      </button>
      {open && (
        <div className="mt-3 space-y-3">
          {starting.map((i) => (
            <label key={i.name} className="block">
              <span className="font-mono text-xs font-semibold">{i.name}</span>
              <span className="block text-xs text-stone-500">{i.description}</span>
              <textarea aria-label={i.name} value={drafts[i.name] ?? ""} spellCheck={false}
                rows={Math.min(8, (drafts[i.name] ?? "").split("\n").length)}
                onChange={(e) => setDrafts({ ...drafts, [i.name]: e.target.value })}
                className={`mt-1 block w-full rounded-lg border px-2 py-1 font-mono text-xs ${parsed[i.name]?.ok === false ? "border-red-500 bg-red-50 dark:bg-red-950/40" : "border-stone-300 dark:border-stone-700 dark:bg-stone-950"}`} />
              {parsed[i.name]?.ok === false && <span className="text-xs text-red-700 dark:text-red-300">Not valid JSON</span>}
            </label>
          ))}
          <div className="flex gap-2">
            <button type="button" className="rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
              disabled={bad || busy} onClick={() => onRun(values())}>Run</button>
            <button type="button" className="nav-btn" disabled={busy} onClick={reset}>Reset</button>
          </div>
        </div>
      )}
    </section>
  );
}

function StepCard({ step, block, trace, isLast, onShowCode }: {
  step: WalkStep; block: LogicBlock | undefined; trace: Trace; isLast: boolean; onShowCode: (b: LogicBlock) => void;
}) {
  const failed = isLast && trace.outcome.kind === "error";
  const outcomeTone = {
    exit: "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-200",
    error: "border-red-300 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/60 dark:text-red-200",
    stopped: "border-stone-300 bg-stone-100 text-stone-800 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-200",
  }[trace.outcome.kind];
  const outcomeIcon = { exit: "■", error: "✕", stopped: "⏸" }[trace.outcome.kind];
  return (
    <div className="space-y-3 p-4">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold">
        <span aria-hidden="true" className="text-stone-500">{block ? ICON[block.kind] : "▸"}</span>{block?.label ?? step.blockId}
      </h3>
      <p className="text-sm">{step.note}</p>
      {step.danger?.map((d, i) => (
        <div key={i} className="walk-flag rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/60 dark:text-red-200">
          <span className="font-semibold">⚠ Looks malicious</span> <span>{d.note}</span>
        </div>
      ))}
      {step.effects?.length ? (
        <div className="flex flex-wrap gap-1">
          {step.effects.map((e, i) => (
            <span key={i} className="walk-effect rounded-lg border border-stone-300 bg-stone-100 px-2 py-0.5 text-xs text-stone-800 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-200">
              {EFFECT_LABEL[e.kind]} · {e.note}
            </span>
          ))}
        </div>
      ) : null}
      {step.assumed?.length ? (
        <div className="flex flex-wrap gap-1">
          {step.assumed.map((a, i) => (
            <span key={i} title="Claude couldn't read this from the code, so it assumed it"
              className="rounded-full border border-orange-300 bg-orange-50 px-2 py-0.5 text-xs text-orange-900 dark:border-orange-800 dark:bg-orange-950/50 dark:text-orange-200">
              assumed: {a}
            </span>
          ))}
        </div>
      ) : null}
      <Json label="Input" value={step.input} highlight={null} />
      <Json label="Output" value={step.output} highlight={changedKeys(step.input, step.output)} error={failed} />
      {block && (
        <button type="button" className="text-xs font-semibold text-violet-700 hover:underline dark:text-violet-300" onClick={() => onShowCode(block)}>
          Show code →
        </button>
      )}
      {isLast && <div className={`rounded-lg border px-3 py-2 text-sm font-semibold ${outcomeTone}`}><span aria-hidden="true">{outcomeIcon}</span> <span>{trace.outcome.message}</span></div>}
    </div>
  );
}

/** A value as formatted JSON; top-level keys in `highlight` (or all of it) are marked as changed. */
function Json({ label, value, highlight, error = false }: { label: string; value: unknown; highlight: Highlight; error?: boolean }) {
  const isObject = typeof value === "object" && value !== null && !Array.isArray(value);
  const id = `walk-${label.toLowerCase()}`;
  return (
    <div>
      <div id={id} className="mb-1 text-xs font-semibold uppercase tracking-wider text-stone-500">{label}</div>
      <pre aria-labelledby={id} className={`walk-json${error ? " error" : ""}`}>
        {isObject ? (
          <>
            <div>{"{"}</div>
            {Object.entries(value as Record<string, unknown>).map(([k, v], i, all) => (
              <div key={k} className={highlight instanceof Set && highlight.has(k) ? "changed" : undefined}>
                {`  ${JSON.stringify(k)}: ${show(v).replace(/\n/g, "\n  ")}${i < all.length - 1 ? "," : ""}`}
              </div>
            ))}
            <div>{"}"}</div>
          </>
        ) : (
          <div className={highlight === "all" ? "changed" : undefined}>{show(value)}</div>
        )}
      </pre>
    </div>
  );
}
