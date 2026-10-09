import { useMemo, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useOpenPulls, useRepos } from "../../api/queries";
import type { Repo } from "../../api/types";
import { Option, PrRow, Status, useHighlight } from "../../components/Picker";
import { prPath } from "../../lib/prRef";
import { useDebounced } from "../../lib/useDebounced";
import { recentRepos } from "../../state/recents";

type RepoRef = { owner: string; repo: string };
/** A repo row; ones known only from recents have no GitHub details. */
type RepoRow = RepoRef & Partial<Repo>;

const repoKey = (r: RepoRef) => `${r.owner}/${r.repo}`;

function parseRepo(value: string | null): RepoRef | null {
  const [owner, repo, ...rest] = (value ?? "").split("/");
  return owner && repo && !rest.length ? { owner, repo } : null;
}

/** Pick a repo, then one of its open PRs. The chosen repo lives in `?repo=` so Back works. */
export function BrowsePrs() {
  const [params, setParams] = useSearchParams();
  const picked = parseRepo(params.get("repo"));
  const setRepo = (repo: RepoRef | null) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (repo) next.set("repo", repoKey(repo));
      else next.delete("repo");
      return next;
    });

  return (
    <div className="rounded-xl border border-stone-200 bg-white p-2 shadow-sm dark:border-stone-800 dark:bg-stone-900">
      {picked
        ? <PullList key={repoKey(picked)} repo={picked} onBack={() => setRepo(null)} />
        : <RepoList onPick={setRepo} />}
    </div>
  );
}

/** Does `text` match this repo? `owner/partial` matches within that owner. */
function matchesRepo(text: string, r: RepoRow) {
  const needle = text.trim().toLowerCase();
  if (!needle) return true;
  const slash = needle.indexOf("/");
  if (slash >= 0) {
    return r.owner.toLowerCase().startsWith(needle.slice(0, slash)) && r.repo.toLowerCase().includes(needle.slice(slash + 1));
  }
  return `${repoKey(r)} ${r.description ?? ""}`.toLowerCase().includes(needle);
}

function RepoList({ onPick }: { onPick: (repo: RepoRef) => void }) {
  const [text, setText] = useState("");
  const query = useDebounced(text.trim(), 300);
  const mine = useRepos("");
  const search = useRepos(query, !!query);
  const recents = useMemo(recentRepos, []);

  // Recents first, filled in with GitHub's details where it has them; then your repos; then search hits.
  const known = new Map((mine.data ?? []).map((r) => [repoKey(r), r as RepoRow]));
  const local = [
    ...recents.map((r) => known.get(repoKey(r)) ?? r),
    ...(mine.data ?? []).filter((r) => !recents.some((x) => repoKey(x) === repoKey(r))),
  ].filter((r) => matchesRepo(text, r));
  // GitHub already matched the search hits, so they aren't filtered again.
  const hits = query && query === text.trim()
    ? (search.data ?? []).filter((r) => !local.some((x) => repoKey(x) === repoKey(r)))
    : [];
  const rows: RepoRow[] = [...local, ...hits];
  const { highlight, setHighlight, move } = useHighlight(rows.length);

  const searching = !!text.trim() && (query !== text.trim() || search.isFetching);
  let status: ReactNode = null;
  if (mine.error) status = (
    <Status>
      Couldn't load your repositories{" "}
      <button type="button" className="font-semibold underline" onClick={() => mine.refetch()}>Retry</button>
    </Status>
  );
  else if (searching) status = <Status>Searching GitHub…</Status>;
  else if (mine.isPending && !rows.length) status = <Status>Loading your repositories…</Status>;
  else if (!rows.length) status = <Status>No repositories found</Status>;

  return (
    <>
      <FilterBox
        label="Find a repository" placeholder="Find a repository: name or owner/name" value={text}
        onChange={(v) => { setText(v); setHighlight(0); }}
        onKeyDown={(e) => {
          if (move(e)) return;
          if (e.key === "Enter" && rows[highlight]) { e.preventDefault(); onPick(rows[highlight]); }
        }}
      />
      <div role="listbox" aria-label="Repositories" className="mt-2 max-h-80 overflow-y-auto">
        {rows.map((r, i) => (
          <Option key={repoKey(r)} active={i === highlight} onPick={() => onPick(r)} onHover={() => setHighlight(i)}>
            <div className="flex items-center gap-2">
              <span className="truncate font-mono text-xs font-semibold">{repoKey(r)}</span>
              {r.isPrivate && <span className="rounded bg-stone-200 px-1.5 text-[10px] font-semibold uppercase dark:bg-stone-700">private</span>}
              {r.openPrs !== undefined && <span className="ml-auto shrink-0 text-xs text-stone-500">{r.openPrs} open</span>}
            </div>
            {r.description && <div className="truncate text-xs text-stone-500">{r.description}</div>}
          </Option>
        ))}
        {status}
      </div>
    </>
  );
}

function PullList({ repo, onBack }: { repo: RepoRef; onBack: () => void }) {
  const navigate = useNavigate();
  const pulls = useOpenPulls(repo.owner, repo.repo);
  const [text, setText] = useState("");
  const needle = text.trim().toLowerCase();
  const rows = (pulls.data ?? []).filter((p) =>
    !needle || `#${p.number} ${p.title} ${p.author ?? ""}`.toLowerCase().includes(needle));
  const { highlight, setHighlight, move } = useHighlight(rows.length);

  let status: ReactNode = null;
  if (pulls.isPending) status = <Status>Loading pull requests…</Status>;
  else if (pulls.error) status = (
    <Status>
      Couldn't load pull requests: {(pulls.error as Error).message}{" "}
      <button type="button" className="font-semibold underline" onClick={() => pulls.refetch()}>Retry</button>
    </Status>
  );
  else if (!pulls.data.length) status = <Status>No open pull requests</Status>;
  else if (!rows.length) status = <Status>No matches</Status>;

  return (
    <>
      <div className="mb-2 flex items-center gap-3 px-1 text-sm">
        <button type="button" onClick={onBack} className="rounded px-1.5 py-0.5 text-stone-500 hover:bg-stone-200/70 hover:text-stone-800 dark:hover:bg-stone-800 dark:hover:text-stone-200">
          ← Change repo
        </button>
        <span className="truncate font-mono text-xs font-semibold">{repoKey(repo)}</span>
      </div>
      <FilterBox
        label="Filter pull requests" placeholder="Filter by title, #number or author" value={text}
        onChange={(v) => { setText(v); setHighlight(0); }}
        onKeyDown={(e) => {
          if (move(e)) return;
          if (e.key === "Enter" && rows[highlight]) { e.preventDefault(); navigate(prPath(rows[highlight])); }
        }}
      />
      <div role="listbox" aria-label="Open pull requests" className="mt-2 max-h-80 overflow-y-auto">
        {rows.map((p, i) => (
          <Option key={p.number} active={i === highlight} onPick={() => navigate(prPath(p))} onHover={() => setHighlight(i)}>
            <PrRow pr={p} />
          </Option>
        ))}
        {status}
      </div>
    </>
  );
}

type FilterBoxProps = {
  label: string; placeholder: string; value: string;
  onChange: (value: string) => void; onKeyDown: (e: React.KeyboardEvent) => void;
};

function FilterBox({ label, placeholder, value, onChange, onKeyDown }: FilterBoxProps) {
  return (
    <input
      value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown}
      aria-label={label} placeholder={placeholder}
      className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm outline-none ring-amber-400/40 placeholder:text-stone-400 focus:border-amber-500 focus:ring-4 dark:border-stone-700 dark:bg-stone-950"
    />
  );
}
