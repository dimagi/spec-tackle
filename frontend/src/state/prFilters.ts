import { create } from "zustand";
import type { PrSummary } from "../api/types";

export type StatusFilter = "open" | "draft";

type PrFilters = {
  status: ReadonlySet<StatusFilter>;
  toggleStatus: (s: StatusFilter) => void;
};

/**
 * Which PRs the PR lists show; shared by the switcher and the repo browser for the
 * session. By default: open (not draft) PRs.
 */
export const usePrFilters = create<PrFilters>((set, get) => ({
  status: new Set(["open"]),
  toggleStatus: (s) => {
    const next = new Set(get().status);
    if (!next.delete(s)) next.add(s);
    // Never turn both off: that would hide every PR.
    if (next.size) set({ status: next });
  },
}));

export function matchesPrFilters(pr: PrSummary, f: Pick<PrFilters, "status">): boolean {
  return f.status.has(pr.isDraft ? "draft" : "open");
}
