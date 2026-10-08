import type { Activity, Overview, PRInfo, Viewer } from "../../api/types";
import { useTick } from "../../components/RelativeTime";
import { Logo } from "../../components/Logo";
import { ThemeSwitch } from "../../components/ThemeSwitch";
import { ViewerBadge } from "../../components/ViewerBadge";
import { timeAgo } from "../../lib/time";
import type { ReactNode } from "react";

export type SyncStatus = { fetching: boolean; error: string | null; lastSync: number; signedOut: boolean };

type Props = {
  pr: PRInfo;
  overview: Overview;
  activity: Activity;
  viewer: Viewer | null;
  sync: SyncStatus;
  newCommits: boolean;
  onRefresh: () => void;
  onFinishReview: () => void;
  tabs?: ReactNode;
};

function syncLabel(sync: SyncStatus) {
  if (sync.fetching) return "Checking…";
  if (sync.signedOut) return "Signed out";
  if (sync.error) return "Sync failed — retrying";
  return `Live · ${timeAgo(new Date(sync.lastSync).toISOString())}`;
}

export function TopBar({ pr, overview, activity, viewer, sync, newCommits, onRefresh, onFinishReview, tabs }: Props) {
  useTick();
  const label = activity.isDraft && activity.state === "OPEN" ? "DRAFT" : activity.state;
  const dot = sync.fetching ? "bg-amber-400 animate-pulse" : sync.error ? "bg-rose-500" : "bg-emerald-500";
  return (
    <header className="sticky top-0 z-40 border-b border-stone-200 bg-stone-50/90 backdrop-blur dark:border-stone-800 dark:bg-stone-950/90">
      <div className="flex h-14 items-center gap-4 px-5">
        <Logo />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs text-stone-500">
            <span className="font-mono">{pr.owner}/{pr.repo}</span>
            <span>·</span>
            <span data-testid="pr-state" className={`state-pill state-${label}`}>{label.toLowerCase()}</span>
            <span className="hidden truncate md:inline">
              <span className="font-mono">{overview.headRefName}</span> → <span className="font-mono">{overview.baseRefName}</span>
            </span>
          </div>
          <h1 className="truncate text-sm font-semibold">
            {overview.title} <span className="font-normal text-stone-400">#{pr.number}</span>
          </h1>
        </div>
        {tabs}
        {newCommits && (
          <div className="flex items-center gap-2 rounded-lg bg-sky-100 px-3 py-1.5 text-xs font-medium text-sky-900 dark:bg-sky-500/15 dark:text-sky-200">
            New commits pushed
            <button onClick={() => location.reload()} className="rounded bg-sky-600 px-2 py-0.5 font-semibold text-white hover:bg-sky-500">Reload</button>
          </div>
        )}
        <button
          onClick={onRefresh}
          className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-stone-500 hover:bg-stone-200/70 dark:hover:bg-stone-800"
          title={sync.error ?? "Checks GitHub for new comments every 30 seconds. Click to check now."}
        >
          <span className={`h-2 w-2 rounded-full ${dot}`} />
          <span data-testid="sync-label">{syncLabel(sync)}</span>
        </button>
        <a href={pr.url} target="_blank" rel="noopener" className="hidden rounded-lg px-2.5 py-1.5 text-xs font-medium text-stone-600 hover:bg-stone-200/70 sm:block dark:text-stone-300 dark:hover:bg-stone-800">Open on GitHub ↗</a>
        <ThemeSwitch />
        <ViewerBadge viewer={viewer} />
        <button onClick={onFinishReview} className="rounded-lg bg-stone-900 px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-stone-700 dark:bg-amber-400 dark:text-stone-950 dark:hover:bg-amber-300">Finish review</button>
      </div>
    </header>
  );
}
