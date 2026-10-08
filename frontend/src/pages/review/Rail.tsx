import type { PageFile } from "../../api/types";
import { useReview } from "../../state/review";
import { useScrollSpy } from "./hooks/useScrollSpy";

type Props = {
  files: PageFile[];
  claude: boolean;
  stats: { open: number; resolved: number };
  headingCounts: Map<string, number>;
  conversationCount: number;
  onStep: (direction: 1 | -1) => void;
};

type Link = { target: string; label: string; className: string; style?: React.CSSProperties; count?: number };

export function Rail({ files, claude, stats, headingCounts, conversationCount, onStep }: Props) {
  const { filter, hideBots, showClaude, setFilter, setHideBots, setShowClaude } = useReview((s) => s);
  const links: Link[] = [{ target: "description", label: "Description", className: "outline-link" }];
  files.forEach((file, i) => {
    if (files.length > 1 || !file.outline.length) {
      links.push({ target: `file-${i + 1}`, label: file.path.split("/").pop()!, className: "outline-link mt-2 font-mono text-[11px] font-medium" });
    }
    for (const h of file.outline) {
      links.push({
        target: h.id, label: h.text, className: "outline-link",
        style: { paddingLeft: `${(h.level - 1) * 0.75 + 0.5}rem` },
        count: headingCounts.get(`${file.path}#${h.id}`) ?? 0,
      });
    }
  });
  links.push({ target: "conversation", label: "Conversation", className: "outline-link mt-2", count: conversationCount });
  const current = useScrollSpy(links.map((l) => l.target));

  return (
    <aside className="sticky top-14 hidden h-[calc(100vh-3.5rem)] w-64 shrink-0 flex-col overflow-y-auto border-r border-stone-200 px-4 py-6 text-sm lg:flex dark:border-stone-800">
      <section className="mb-6">
        <h2 className="rail-heading">Review</h2>
        <div className="grid grid-cols-2 gap-2">
          <div className="stat"><div className="stat-num" data-testid="stat-open">{stats.open}</div><div className="stat-label">open threads</div></div>
          <div className="stat"><div className="stat-num" data-testid="stat-resolved">{stats.resolved}</div><div className="stat-label">resolved</div></div>
        </div>
        <div className="mt-3 flex rounded-lg bg-stone-200/70 p-0.5 text-xs font-medium dark:bg-stone-800">
          <button className={`seg flex-1 ${filter === "open" ? "on" : ""}`} onClick={() => setFilter("open")}>Open</button>
          <button className={`seg flex-1 ${filter === "all" ? "on" : ""}`} onClick={() => setFilter("all")}>All</button>
        </div>
        <label className="mt-3 flex cursor-pointer items-center justify-between text-xs text-stone-600 dark:text-stone-400">
          Hide bot comments
          <input type="checkbox" className="peer sr-only" checked={hideBots} onChange={(e) => setHideBots(e.target.checked)} />
          <span className="toggle" />
        </label>
        {claude && (
          <label className="mt-3 flex cursor-pointer items-center justify-between text-xs text-stone-600 dark:text-stone-400">
            Show Claude threads
            <input type="checkbox" className="peer sr-only" checked={showClaude} onChange={(e) => setShowClaude(e.target.checked)} />
            <span className="toggle" />
          </label>
        )}
        <div className="mt-3 flex gap-2">
          <button className="nav-btn flex-1" title="Previous open thread (k)" onClick={() => onStep(-1)}>↑ Prev</button>
          <button className="nav-btn flex-1" title="Next open thread (j)" onClick={() => onStep(1)}>Next ↓</button>
        </div>
      </section>

      <section className="mb-6">
        <h2 className="rail-heading">Contents</h2>
        <nav className="space-y-0.5">
          {links.map((l, i) => (
            <a key={`${l.target}-${i}`} href={`#${l.target}`} className={`${l.className} ${i === current ? "on" : ""}`} style={l.style}>
              <span className="truncate">{l.label}</span>
              {l.count !== undefined && <span className="count" hidden={!l.count}>{l.count}</span>}
            </a>
          ))}
        </nav>
      </section>

      <section className="mt-auto pt-4 text-[11px] leading-relaxed text-stone-400">
        <div><kbd>j</kbd> <kbd>k</kbd> next / prev thread</div>
        <div>Select text, then <kbd>c</kbd> to comment</div>
        <div><kbd>Esc</kbd> close</div>
      </section>
    </aside>
  );
}
