import { createContext, useContext } from "react";
import { createStore, useStore, type StoreApi } from "zustand";
import { loadPref, savePref, type PRRef } from "./storage";

export type ComposerMode = "comment" | "claude";
export type ComposerTarget = { path: string; start: number; end: number; quote: string | null; mode: ComposerMode };

export type ReviewState = {
  filter: "open" | "all";
  hideBots: boolean;
  showClaude: boolean;
  /** Thread id (GitHub or Claude), "composer", or null. */
  active: string | null;
  /** Bumped whenever something asks to scroll the active item into view. */
  scrollSeq: number;
  composer: ComposerTarget | null;
  expanded: Set<string>;
  expandedBodies: Set<number>;
  setFilter: (f: "open" | "all") => void;
  setHideBots: (v: boolean) => void;
  setShowClaude: (v: boolean) => void;
  activate: (id: string | null, opts?: { scroll?: boolean }) => void;
  expand: (id: string) => void;
  collapse: (id: string) => void;
  expandBody: (commentId: number) => void;
  openComposer: (target: ComposerTarget) => void;
  setComposerMode: (mode: ComposerMode) => void;
  closeComposer: () => void;
};

export function createReviewStore(pr: PRRef): StoreApi<ReviewState> {
  return createStore<ReviewState>((set, get) => ({
    filter: loadPref(pr, "filter", "open"),
    hideBots: loadPref(pr, "hideBots", false),
    showClaude: loadPref(pr, "showClaude", true),
    active: null,
    scrollSeq: 0,
    composer: null,
    expanded: new Set(),
    expandedBodies: new Set(),
    setFilter: (filter) => { savePref(pr, "filter", filter); set({ filter }); },
    setHideBots: (hideBots) => { savePref(pr, "hideBots", hideBots); set({ hideBots }); },
    setShowClaude: (showClaude) => { savePref(pr, "showClaude", showClaude); set({ showClaude }); },
    activate: (active, opts) => set({ active, scrollSeq: opts?.scroll ? get().scrollSeq + 1 : get().scrollSeq }),
    expand: (id) => set({ expanded: new Set(get().expanded).add(id), active: id }),
    collapse: (id) => {
      const expanded = new Set(get().expanded);
      expanded.delete(id);
      set({ expanded, active: get().active === id ? null : get().active });
    },
    expandBody: (commentId) => set({ expandedBodies: new Set(get().expandedBodies).add(commentId) }),
    openComposer: (composer) => set({ composer, active: "composer" }),
    setComposerMode: (mode) => {
      const c = get().composer;
      if (c) set({ composer: { ...c, mode } });
    },
    closeComposer: () => set({ composer: null, active: get().active === "composer" ? null : get().active }),
  }));
}

export const ReviewStoreContext = createContext<StoreApi<ReviewState> | null>(null);

export function useReview<T>(selector: (s: ReviewState) => T): T {
  const store = useContext(ReviewStoreContext);
  if (!store) throw new Error("useReview outside ReviewStoreContext");
  return useStore(store, selector);
}

export function useReviewStore(): StoreApi<ReviewState> {
  const store = useContext(ReviewStoreContext);
  if (!store) throw new Error("useReviewStore outside ReviewStoreContext");
  return store;
}
