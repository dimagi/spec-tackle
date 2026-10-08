import type { Overview } from "../../api/types";
import { Html } from "../../components/Html";
import { RelativeTime } from "../../components/RelativeTime";

export function Description({ overview }: { overview: Overview }) {
  return (
    <section id="description" className="paper mb-6 px-8 py-6 sm:px-12">
      <div className="flex items-center gap-3">
        <img src={overview.author.avatarUrl} className="h-8 w-8 rounded-full" alt="" />
        <div className="text-sm">
          <span className="font-semibold">{overview.author.login}</span>
          <span className="text-stone-500"> opened this PR </span>
          <RelativeTime className="text-stone-400" iso={overview.createdAt} />
        </div>
        <div className="ml-auto flex items-center gap-3 font-mono text-xs">
          <span className="text-emerald-600">+{overview.additions}</span>
          <span className="text-rose-600">−{overview.deletions}</span>
          <span className="text-stone-400">{overview.changedFiles} file{overview.changedFiles === 1 ? "" : "s"}</span>
        </div>
      </div>
      {overview.bodyHTML && (
        <details className="group mt-4">
          <summary className="cursor-pointer select-none text-xs font-semibold uppercase tracking-wider text-stone-500 hover:text-stone-800 dark:hover:text-stone-200">
            <span className="group-open:hidden">Show PR description</span><span className="hidden group-open:inline">Hide PR description</span>
          </summary>
          <Html html={overview.bodyHTML} className="gh-body prose prose-stone prose-sm mt-3 max-w-none dark:prose-invert" />
        </details>
      )}
    </section>
  );
}
