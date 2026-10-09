import { useEffect, useMemo, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { PageFile } from "../../api/types";
import { fileTree, type TreeNode } from "../../lib/fileTree";
import { clampRailWidth, loadRailWidth, RAIL_DEFAULT, RAIL_MAX, RAIL_MIN, saveRailWidth } from "../../lib/railWidth";
import { useReview } from "../../state/review";
import type { FileView } from "./FileSection";
import { useScrollSpy } from "./hooks/useScrollSpy";

type Props = {
  files: PageFile[];
  /** Each file's current view, by path. Its sections are listed only while it shows the document. */
  views: Record<string, FileView>;
  claude: boolean;
  stats: { open: number; resolved: number };
  headingCounts: Map<string, number>;
  conversationCount: number;
  onStep: (direction: 1 | -1) => void;
};

export function Rail({ files, views, claude, stats, headingCounts, conversationCount, onStep }: Props) {
  const { filter, hideBots, showClaude, setFilter, setHideBots, setShowClaude } = useReview((s) => s);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const tree = useMemo(() => fileTree(files), [files]);
  const folders = useMemo(() => folderPaths(tree), [tree]);
  const allCollapsed = folders.length > 0 && folders.every((p) => collapsed.has(p));
  const sections = (file: PageFile) => (views[file.path] === "rendered" ? file.outline : []);
  const targets = [
    "description",
    ...files.flatMap((f, i) => [`file-${i + 1}`, ...sections(f).map((h) => h.id)]),
    "conversation",
  ];
  const current = targets[useScrollSpy(targets)];
  const [width, setWidth] = useState(loadRailWidth);
  useEffect(() => {
    saveRailWidth(width);
    // The document column changed width, so the margin cards need to line up again.
    window.dispatchEvent(new Event("spec-tackle:layout"));
  }, [width]);

  const startResize = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX, startWidth = width;
    const move = (ev: globalThis.PointerEvent) => setWidth(clampRailWidth(startWidth + ev.clientX - startX));
    const stop = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", stop);
      document.body.classList.remove("resizing-rail");
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", stop);
    document.body.classList.add("resizing-rail");
  };
  const resizeByKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const steps: Record<string, number> = { ArrowLeft: -16, ArrowRight: 16 };
    if (e.key in steps) setWidth((w) => clampRailWidth(w + steps[e.key]));
    else if (e.key === "Home") setWidth(RAIL_MIN);
    else if (e.key === "End") setWidth(RAIL_MAX);
    else return;
    e.preventDefault();
  };

  const toggle = (path: string) => setCollapsed((c) => {
    const next = new Set(c);
    if (!next.delete(path)) next.add(path);
    return next;
  });

  // Each level steps in by one chevron; a file leaves the chevron's space empty so its icon lines up with a folder's.
  const indent = (depth: number, extra = 0) => ({ paddingLeft: `${depth * 0.75 + 0.5 + extra}rem` });
  const link = (target: string, className: string) => `outline-link ${className} ${target === current ? "on" : ""}`;

  const renderNode = (node: TreeNode, depth: number): React.ReactNode => {
    if (node.kind === "dir") {
      const open = !collapsed.has(node.path);
      return (
        <div key={`dir:${node.path}`} role="treeitem" aria-expanded={open}>
          <button className="outline-link tree-dir w-full" style={indent(depth)} title={node.path} onClick={() => toggle(node.path)}>
            <span className="flex min-w-0 items-center gap-1.5">
              <Chevron open={open} />
              <FolderIcon />
              <span className="truncate font-mono text-[11.5px]">{node.name}</span>
            </span>
          </button>
          {open && <div role="group">{node.children.map((c) => renderNode(c, depth + 1))}</div>}
        </div>
      );
    }
    const target = `file-${node.index}`;
    return (
      <div key={`file:${node.file.path}`} role="treeitem">
        <a href={`#${target}`} className={link(target, "tree-file")} style={indent(depth, CHEVRON)} title={node.file.path}>
          <span className="flex min-w-0 items-center gap-1.5">
            <span className={`file-status file-status-${node.file.status}`} title={node.file.status}>{STATUS_MARK[node.file.status] ?? "•"}</span>
            <span className="truncate font-mono text-[11.5px]">{node.name}</span>
          </span>
        </a>
        {sections(node.file).map((h) => {
          const count = headingCounts.get(`${node.file.path}#${h.id}`) ?? 0;
          return (
            <a key={h.id} href={`#${h.id}`} className={link(h.id, "")} style={indent(depth + h.level - 1, CHEVRON + 1.25)}>
              <span className="truncate" title={h.text}>{h.text}</span>
              <span className="count" hidden={!count}>{count}</span>
            </a>
          );
        })}
      </div>
    );
  };

  return (
    <div className="sticky top-14 hidden h-[calc(100vh-3.5rem)] shrink-0 lg:block" style={{ width }}>
    <aside className="flex h-full flex-col overflow-y-auto border-r border-stone-200 px-4 py-6 text-sm dark:border-stone-800">
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
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="rail-heading">Contents</h2>
          {folders.length > 0 && (
            <button type="button" className="rail-action" onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(folders))}>
              {allCollapsed ? "Expand all" : "Collapse all"}
            </button>
          )}
        </div>
        <nav className="space-y-0.5">
          <a href="#description" className={link("description", "")}><span className="truncate">Description</span></a>
          <div role="tree" aria-label="Changed files" className="mt-2 space-y-0.5">
            {tree.map((n) => renderNode(n, 0))}
          </div>
          <a href="#conversation" className={link("conversation", "mt-2")}>
            <span className="truncate">Conversation</span>
            <span className="count" hidden={!conversationCount}>{conversationCount}</span>
          </a>
        </nav>
      </section>

      <section className="mt-auto pt-4 text-[11px] leading-relaxed text-stone-400">
        <div><kbd>j</kbd> <kbd>k</kbd> next / prev thread</div>
        <div>Select text, then <kbd>c</kbd> to comment</div>
        <div><kbd>Esc</kbd> close</div>
      </section>
    </aside>
      <div
        role="separator" aria-orientation="vertical" aria-label="Resize sidebar" tabIndex={0}
        aria-valuenow={width} aria-valuemin={RAIL_MIN} aria-valuemax={RAIL_MAX}
        title="Drag to resize · double-click to reset" className="rail-resizer"
        onPointerDown={startResize} onDoubleClick={() => setWidth(RAIL_DEFAULT)} onKeyDown={resizeByKey}
      />
    </div>
  );
}

/** Every folder in the tree, at any depth. */
function folderPaths(nodes: TreeNode[]): string[] {
  return nodes.flatMap((n) => (n.kind === "dir" ? [n.path, ...folderPaths(n.children)] : []));
}

/** Width of a folder's chevron plus the gap after it, in rem. */
const CHEVRON = 1.125;

const STATUS_MARK: Record<string, string> = { added: "+", removed: "−", modified: "•", changed: "•", renamed: "→", copied: "+" };

function Chevron({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 16 16" className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} aria-hidden="true">
      <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 text-stone-400" aria-hidden="true">
      <path d="M1.75 3h4.1l1.5 1.5h6.9c.41 0 .75.34.75.75v7c0 .41-.34.75-.75.75H1.75A.75.75 0 0 1 1 12.25v-8.5C1 3.34 1.34 3 1.75 3z" fill="currentColor" />
    </svg>
  );
}
