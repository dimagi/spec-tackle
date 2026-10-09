import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { elementsInRange } from "../../../lib/anchors";
import { layoutCards } from "../../../lib/layout";

/** Something in the margin that sits beside lines of a file. */
export type MarginItem = {
  id: string;
  kind: "thread" | "claude" | "composer";
  path: string;
  range: [number, number] | null;
  resolved?: boolean;
  hidden: boolean;
};

export type MarginEngine = {
  /** Page Y of the item's anchor (or its fallback), or null if it isn't laid out. */
  anchorTop: (id: string) => number | null;
  /** Thread ids anchored on (or inside) an element of the document. */
  threadsAt: (el: Element) => string[];
  scheduleLayout: () => void;
};

const ANCHOR_CLASSES = ["has-thread", "has-claude", "is-active-anchor", "is-drafting"];

const sectionFor = (doc: HTMLElement, path: string) =>
  doc.querySelector<HTMLElement>(`section.file[data-path="${CSS.escape(path)}"]`);
const visibleView = (section: HTMLElement | null) =>
  section ? [...section.querySelectorAll<HTMLElement>(".view")].find((v) => !v.hidden) ?? null : null;

/**
 * Anchors margin cards to the document: highlights the passages they discuss and places
 * each card level with its passage without overlaps. The server-rendered document is
 * plain DOM, so this works on elements directly, after every render and on resizes.
 */
export function useMarginEngine(
  docRef: RefObject<HTMLElement | null>,
  marginRef: RefObject<HTMLElement | null>,
  items: MarginItem[],
  active: string | null,
  scrollSeq: number,
): RefObject<MarginEngine> {
  const anchors = useRef(new Map<string, { anchors: Element[]; fallback: Element | null }>());
  const threadsByEl = useRef(new Map<Element, string[]>());
  const state = useRef({ items, active });
  state.current = { items, active };
  const queued = useRef(false);

  const markAnchors = useCallback(() => {
    const doc = docRef.current;
    if (!doc) return;
    doc.querySelectorAll(ANCHOR_CLASSES.map((c) => `.${c}`).join(",")).forEach((el) => el.classList.remove(...ANCHOR_CLASSES));
    anchors.current.clear();
    threadsByEl.current.clear();
    const { items, active } = state.current;
    for (const item of items) {
      const section = sectionFor(doc, item.path);
      const view = visibleView(section);
      const found = item.range && view ? elementsInRange(view, ...item.range) : [];
      const fallback = section ? section.querySelector(".file-header") : doc.querySelector("#description");
      anchors.current.set(item.id, { anchors: found, fallback: item.kind === "composer" ? section : fallback });
      if (item.hidden) continue;
      const isActive = active === item.id;
      for (const el of found) {
        if (item.kind === "composer") el.classList.add("is-drafting");
        else if (item.kind === "claude") el.classList.add("has-claude");
        else if (!item.resolved || isActive) el.classList.add("has-thread");
        if (isActive && item.kind !== "composer") el.classList.add("is-active-anchor");
        if (item.kind !== "composer") threadsByEl.current.set(el, [...(threadsByEl.current.get(el) ?? []), item.id]);
      }
    }
  }, [docRef]);

  const anchorRect = (id: string) => {
    const a = anchors.current.get(id);
    if (!a) return null;
    const els = a.anchors.length ? a.anchors : [a.fallback];
    const tops = els.filter(Boolean).map((el) => el!.getBoundingClientRect().top);
    return tops.length ? Math.min(...tops) : null;
  };

  const layout = useCallback(() => {
    const margin = marginRef.current;
    if (!margin || !margin.offsetParent) return;
    const base = margin.getBoundingClientRect().top;
    // An enlarged card sits over the page, out of the margin's flow.
    const cards = [...margin.querySelectorAll<HTMLElement>(":scope > [data-card]")]
      .filter((el) => !el.hidden && !el.classList.contains("is-enlarged"));
    const placed = cards
      .map((el) => ({ el, id: el.dataset.card!, top: anchorRect(el.dataset.card!) }))
      .filter((c): c is { el: HTMLElement; id: string; top: number } => c.top !== null)
      .map((c) => ({ ...c, top: c.top - base, height: c.el.offsetHeight }));
    const pos = layoutCards(placed, state.current.active);
    let bottom = 0;
    for (const c of placed) {
      const top = pos.get(c.id)!;
      c.el.style.top = `${top}px`;
      c.el.classList.toggle("is-active", c.id === state.current.active);
      bottom = Math.max(bottom, top + c.height);
    }
    margin.style.minHeight = `${bottom + 40}px`;
  }, [marginRef]);

  const scheduleLayout = useCallback(() => {
    if (queued.current) return;
    queued.current = true;
    requestAnimationFrame(() => { queued.current = false; layout(); });
  }, [layout]);

  // Created on first use, so cards are observed from the first render on.
  const observer = useRef<ResizeObserver | null>(null);
  const getObserver = () => (observer.current ??= new ResizeObserver(() => scheduleLayout()));

  // After every render: re-mark anchors and re-place cards.
  useLayoutEffect(() => {
    markAnchors();
    layout();
    const margin = marginRef.current;
    if (margin) for (const card of margin.querySelectorAll(":scope > [data-card]")) getObserver().observe(card);
  });

  useEffect(() => {
    if (docRef.current) getObserver().observe(docRef.current);
    const doc = docRef.current;
    const onLoad = (e: Event) => { if ((e.target as Element).tagName === "IMG") scheduleLayout(); };
    doc?.addEventListener("load", onLoad, true);
    window.addEventListener("resize", scheduleLayout);
    window.addEventListener("spec-tackle:layout", scheduleLayout);
    document.fonts?.ready.then(scheduleLayout);
    return () => {
      observer.current?.disconnect();
      observer.current = null;
      doc?.removeEventListener("load", onLoad, true);
      window.removeEventListener("resize", scheduleLayout);
      window.removeEventListener("spec-tackle:layout", scheduleLayout);
    };
  }, [docRef, scheduleLayout]);

  // Scroll the active item's passage into view when asked to.
  useEffect(() => {
    if (!scrollSeq || !state.current.active) return;
    const a = anchors.current.get(state.current.active);
    (a?.anchors[0] ?? a?.fallback)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [scrollSeq]);

  const engine = useRef<MarginEngine>({
    anchorTop: (id) => {
      const top = anchorRect(id);
      return top === null ? null : top + scrollY;
    },
    threadsAt: (el) => threadsByEl.current.get(el) ?? [],
    scheduleLayout,
  });
  engine.current.scheduleLayout = scheduleLayout;
  return engine;
}
