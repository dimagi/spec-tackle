import type { PageFile, Thread } from "../api/types";

export type ThreadFilters = { filter: "open" | "all"; hideBots: boolean };

export function rangeLabel(start: number, end: number): string {
  return start === end ? `L${end}` : `L${start}–${end}`;
}

/** The source lines a thread is about, or null when it can't be anchored in the document. */
export function threadRange(t: Thread): [number, number] | null {
  if (t.isFileLevel || t.side === "LEFT") return null;
  if (t.line != null) return [t.startLine ?? t.line, t.line];
  if (t.originalLine != null) return [t.originalStartLine ?? t.originalLine, t.originalLine];
  return null;
}

/** Mirror of render.resolve_anchor: where GitHub will accept a line comment. */
export function commentableRange(file: Pick<PageFile, "wholeFile" | "hunks">, start: number, end: number) {
  if (file.wholeFile) return { start, end };
  for (const [hs, he] of file.hunks) {
    const lo = Math.max(start, hs);
    const hi = Math.min(end, he);
    if (lo <= hi) return { start: lo, end: hi };
  }
  return null;
}

export const isBotThread = (t: Thread) => t.comments[0].author.isBot;
export const isCollapsible = (t: Thread) => t.isResolved || t.isOutdated || isBotThread(t);
export const isShown = (t: Thread, f: ThreadFilters) =>
  !(f.hideBots && isBotThread(t)) && !(f.filter === "open" && t.isResolved);

/** A selection as a markdown quote to start a comment with. */
export function quoteFor(text: string | null | undefined): string {
  return text ? `> ${text.replace(/\n+/g, "\n> ")}\n\n` : "";
}

/** Open, shown threads per outline heading (keyed "path#id"): those ending before the next heading. */
export function headingCounts(files: PageFile[], threads: Thread[], filters: ThreadFilters): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of files) {
    file.outline.forEach((h, i) => {
      const next = file.outline[i + 1]?.line ?? Infinity;
      const n = threads.filter((t) => {
        const range = threadRange(t);
        return range && t.path === file.path && !t.isResolved && isShown(t, filters) && range[1] >= h.line && range[1] < next;
      }).length;
      counts.set(`${file.path}#${h.id}`, n);
    });
  }
  return counts;
}

/** j/k: the next or previous open thread, starting from what's on screen when none is active. */
export function stepThread(
  list: { id: string; top: number }[],
  activeId: string | null,
  direction: 1 | -1,
  viewportY: number,
): string | null {
  if (!list.length) return null;
  let index = list.findIndex((t) => t.id === activeId);
  if (index < 0) {
    index = direction > 0 ? list.findIndex((t) => t.top > viewportY) : list.findLastIndex((t) => t.top < viewportY);
    if (index < 0) index = direction > 0 ? 0 : list.length - 1;
  } else {
    index = (index + direction + list.length) % list.length;
  }
  return list[index].id;
}
