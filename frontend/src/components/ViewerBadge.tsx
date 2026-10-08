import type { Viewer } from "../api/types";

export function ViewerBadge({ viewer }: { viewer: Viewer | null }) {
  if (!viewer) {
    return (
      <span className="flex shrink-0 items-center gap-2 rounded-full px-3 py-1 text-xs font-medium text-stone-500">
        <span className="h-2 w-2 rounded-full bg-stone-400" /> Not signed in
      </span>
    );
  }
  return (
    <a
      href={`https://github.com/${viewer.login}`} target="_blank" rel="noopener"
      className="flex shrink-0 items-center gap-2 rounded-full py-1 pl-1 pr-3 text-xs text-stone-600 hover:bg-stone-200/70 dark:text-stone-300 dark:hover:bg-stone-800"
      title={`Signed in to GitHub as ${viewer.login}${viewer.name ? ` (${viewer.name})` : ""}`}
    >
      <img src={viewer.avatarUrl} alt="" className="h-6 w-6 rounded-full" />
      <span className="hidden sm:inline"><span className="text-stone-400">Signed in as</span> <span className="font-semibold">{viewer.login}</span></span>
    </a>
  );
}
