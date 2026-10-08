import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { useReviewRequests } from "../../api/queries";
import { RelativeTime } from "../../components/RelativeTime";
import { parsePrRef, prPath, samePr } from "../../lib/prRef";
import { loadRecents, removeRecent, type RecentPr } from "../../state/recents";
import type { PRRef } from "../../state/storage";

type Props = {
  current: PRRef & { title: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Asked before leaving this PR; false keeps the reviewer here (e.g. unsent composer text). */
  beforeLeave: () => boolean;
};

/** The top bar's PR title, which opens a list of PRs to switch to. */
export function PrSwitcher({ current, open, onOpenChange, beforeLeave }: Props) {
  const navigate = useNavigate();
  const requests = useReviewRequests(open);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [recents, setRecents] = useState<RecentPr[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setText("");
    setError(null);
    setHighlight(0);
    setRecents(loadRecents());
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onOpenChange(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, onOpenChange]);

  const pasted = parsePrRef(text);
  const query = pasted ? "" : text.trim().toLowerCase();
  const matches = (pr: PRRef, title: string) =>
    !query || `${pr.owner}/${pr.repo} #${pr.number} ${title}`.toLowerCase().includes(query);
  const queue = requests.data ?? [];
  const requested = queue.filter((r) => matches(r, r.title));
  const recent = recents.filter((r) => !queue.some((q) => samePr(q, r)) && matches(r, r.title));
  const rows: PRRef[] = [...requested, ...recent];

  const go = (pr: PRRef) => {
    if (samePr(pr, current)) return onOpenChange(false);
    if (!beforeLeave()) return;
    onOpenChange(false);
    navigate(prPath(pr));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setHighlight((h) => Math.min(h + 1, rows.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
    else if (e.key === "Escape") { e.preventDefault(); onOpenChange(false); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (pasted) go(pasted);
      else if (rows[highlight]) go(rows[highlight]);
      else setError("Not a GitHub pull request link");
    }
  };

  const option = (pr: PRRef, index: number, body: ReactNode, onRemove?: () => void) => (
    <Option key={`${pr.owner}/${pr.repo}#${pr.number}`} active={index === highlight} current={samePr(pr, current)}
      onPick={() => go(pr)} onHover={() => setHighlight(index)} onRemove={onRemove}
      removeLabel={`Remove ${pr.owner}/${pr.repo}#${pr.number} from recent`}>
      {body}
    </Option>
  );

  let queueBody: ReactNode;
  if (requests.isPending) queueBody = <Status>Loading…</Status>;
  else if (requests.error) queueBody = (
    <Status>
      Couldn't load review requests{" "}
      <button type="button" className="font-semibold underline" onClick={() => requests.refetch()}>Retry</button>
    </Status>
  );
  else if (!queue.length) queueBody = <Status>Nothing waiting on you</Status>;
  else if (!requested.length) queueBody = <Status>No matches</Status>;
  else queueBody = requested.map((r, i) => option(r, i, (
    <>
      <div className="flex items-center gap-2 text-xs text-stone-500">
        <span className="font-mono">{r.owner}/{r.repo} #{r.number}</span>
        {r.isDraft && <span className="rounded bg-stone-200 px-1.5 text-[10px] font-semibold uppercase dark:bg-stone-700">draft</span>}
      </div>
      <div className="truncate font-medium">{r.title}</div>
      <div className="text-xs text-stone-500">{r.author ?? "ghost"} · updated <RelativeTime iso={r.updatedAt} /></div>
    </>
  )));

  return (
    <div ref={rootRef} className="relative min-w-0">
      <h1 className="truncate text-sm font-semibold">
        <button type="button" aria-haspopup="listbox" aria-expanded={open} title="Switch pull request (p)"
          onClick={() => onOpenChange(!open)}
          className="max-w-full truncate rounded text-left hover:text-amber-700 dark:hover:text-amber-300">
          {current.title} <span className="font-normal text-stone-400">#{current.number}</span>
          <span aria-hidden="true" className="ml-1 text-stone-400">▾</span>
        </button>
      </h1>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-2 w-[min(36rem,90vw)] rounded-xl border border-stone-200 bg-white p-2 shadow-xl dark:border-stone-700 dark:bg-stone-900">
          <input
            autoFocus value={text} onKeyDown={onKeyDown}
            onChange={(e) => { setText(e.target.value); setError(null); setHighlight(0); }}
            aria-label="Pull request link or filter" placeholder="Paste a PR link or owner/repo#123, or type to filter"
            className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm outline-none ring-amber-400/40 placeholder:text-stone-400 focus:border-amber-500 focus:ring-4 dark:border-stone-700 dark:bg-stone-950"
          />
          {error && <p role="alert" className="px-2 pt-1 text-xs text-rose-600 dark:text-rose-400">{error}</p>}
          <div role="listbox" aria-label="Pull requests" className="mt-2 max-h-[60vh] overflow-y-auto">
            <Section title="Review requested">{queueBody}</Section>
            {recent.length > 0 && (
              <Section title="Recent">
                {recent.map((r, i) => option(r, requested.length + i, (
                  <>
                    <div className="font-mono text-xs text-stone-500">{r.owner}/{r.repo} #{r.number}</div>
                    <div className="truncate font-medium">{r.title}</div>
                  </>
                ), () => setRecents(removeRecent(r))))}
              </Section>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={title} className="mb-1">
      <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-stone-500">{title}</div>
      {children}
    </div>
  );
}

function Status({ children }: { children: ReactNode }) {
  return <div className="px-2 py-1.5 text-sm text-stone-500">{children}</div>;
}

type OptionProps = {
  active: boolean; current: boolean; children: ReactNode; removeLabel: string;
  onPick: () => void; onHover: () => void; onRemove?: () => void;
};

function Option({ active, current, children, removeLabel, onPick, onHover, onRemove }: OptionProps) {
  return (
    <div
      role="option" aria-selected={active} onClick={onPick} onMouseEnter={onHover}
      // Keep focus in the input so the keyboard keeps working.
      onMouseDown={(e) => e.preventDefault()}
      className={`flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${active ? "bg-amber-100 dark:bg-amber-500/15" : ""}`}
    >
      <span className="w-3 shrink-0 text-amber-600 dark:text-amber-400">
        {current && <span aria-label="Current pull request">✓</span>}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
      {onRemove && (
        <button type="button" aria-label={removeLabel} onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="rounded px-1.5 text-stone-400 hover:bg-stone-200 hover:text-stone-700 dark:hover:bg-stone-800 dark:hover:text-stone-200">
          ×
        </button>
      )}
    </div>
  );
}
