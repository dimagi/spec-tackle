import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { useReviewRequests } from "../../api/queries";
import { Option, PrRow, Section, Status, useHighlight } from "../../components/Picker";
import { HiddenByFilters, PrFilters } from "../../components/PrFilters";
import { parsePrRef, prPath, samePr } from "../../lib/prRef";
import { matchesPrFilters, usePrFilters } from "../../state/prFilters";
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
  const [recents, setRecents] = useState<RecentPr[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);

  const pasted = parsePrRef(text);
  const query = pasted ? "" : text.trim().toLowerCase();
  const matches = (pr: PRRef, title: string) =>
    !query || `${pr.owner}/${pr.repo} #${pr.number} ${title}`.toLowerCase().includes(query);
  const queue = requests.data ?? [];
  const filters = usePrFilters();
  const found = queue.filter((r) => matches(r, r.title));
  const requested = found.filter((r) => matchesPrFilters(r, filters));
  const hidden = found.length - requested.length;
  const recent = recents.filter((r) => !queue.some((q) => samePr(q, r)) && matches(r, r.title));
  const rows: PRRef[] = [...requested, ...recent];
  const { highlight, setHighlight, move } = useHighlight(rows.length);

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

  const go = (pr: PRRef) => {
    if (samePr(pr, current)) return onOpenChange(false);
    if (!beforeLeave()) return;
    onOpenChange(false);
    navigate(prPath(pr));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (move(e)) return;
    if (e.key === "Escape") { e.preventDefault(); onOpenChange(false); }
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
  else if (!found.length) queueBody = <Status>No matches</Status>;
  else queueBody = (
    <>
      {requested.map((r, i) => option(r, i, <PrRow pr={r} />))}
      <HiddenByFilters count={hidden} shown={requested.length} />
    </>
  );

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
          <PrFilters />
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
