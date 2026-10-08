export type LayoutItem = { id: string; top: number; height: number };

/**
 * Place cards beside their anchors without overlapping. The active card (or the first)
 * sits exactly level with its anchor; later cards are pushed down, earlier ones up.
 * Returns each card's top, relative to the margin.
 */
export function layoutCards(items: LayoutItem[], activeId: string | null, gap = 10): Map<string, number> {
  const sorted = [...items].sort((a, b) => a.top - b.top);
  const pos = new Array<number>(sorted.length);
  const pinned = Math.max(0, sorted.findIndex((it) => it.id === activeId));
  if (sorted.length) {
    pos[pinned] = Math.max(0, sorted[pinned].top);
    for (let i = pinned + 1, y = pos[pinned] + sorted[pinned].height + gap; i < sorted.length; i++) {
      pos[i] = Math.max(sorted[i].top, y);
      y = pos[i] + sorted[i].height + gap;
    }
    for (let i = pinned - 1, y = pos[pinned]; i >= 0; i--) {
      pos[i] = Math.min(sorted[i].top, y - sorted[i].height - gap);
      y = pos[i];
    }
  }
  const shift = pos.length && pos[0] < 0 ? -pos[0] : 0;
  return new Map(sorted.map((it, i) => [it.id, pos[i] + shift]));
}
