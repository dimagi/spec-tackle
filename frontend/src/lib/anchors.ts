/** Innermost elements of a view overlapping source lines [start, end] — e.g. table rows, not the table. */
export function elementsInRange(view: Element, start: number, end: number): Element[] {
  const hits = [...view.querySelectorAll<HTMLElement>("[data-ls]")].filter(
    (el) => +el.dataset.ls! <= end && +el.dataset.le! >= start,
  );
  return hits.filter((el) => !hits.some((other) => other !== el && el.contains(other)));
}

export type SelectedRange = { path: string; start: number; end: number; quote: string | null; rect: DOMRect };

/** The document blocks a text selection covers, if they're all in one file. */
export function selectionToRange(sel: Selection | null): SelectedRange | null {
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const quote = sel.toString().trim();
  if (!quote) return null;
  const range = sel.getRangeAt(0);
  const elementOf = (node: Node) => (node.nodeType === 1 ? (node as Element) : node.parentElement);
  const a = elementOf(range.startContainer)?.closest<HTMLElement>(".view [data-ls]");
  let b = elementOf(range.endContainer)?.closest<HTMLElement>(".view [data-ls]");
  // Triple-click selections end at offset 0 of the following block.
  if (b && b !== a && range.endOffset === 0) b = a;
  if (!a || !b) return null;
  const section = a.closest<HTMLElement>("section.file");
  if (!section || section !== b.closest("section.file")) return null;
  const start = Math.min(+a.dataset.ls!, +b.dataset.ls!);
  const end = Math.max(+a.dataset.le!, +b.dataset.le!);
  // Only quote when the selection is a fragment; whole blocks are already obvious on GitHub.
  const whole = a === b && a.textContent!.replace(/\s+/g, " ").trim() === quote.replace(/\s+/g, " ");
  return {
    path: section.dataset.path!,
    start,
    end,
    quote: whole ? null : quote.slice(0, 400),
    rect: range.getBoundingClientRect(),
  };
}
