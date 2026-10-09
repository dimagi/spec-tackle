import { create } from "zustand";
import type { PrSummary } from "../api/types";

export type StatusFilter = "open" | "draft";
export type ReviewFilter = "unapproved" | "approved";

type PrFilters = {
  status: ReadonlySet<StatusFilter>;
  review: ReadonlySet<ReviewFilter>;
  toggleStatus: (s: StatusFilter) => void;
  toggleReview: (r: ReviewFilter) => void;
};

/** Flip `value` in `set`, but never empty it: a group with nothing on would hide every PR. */
function flip<T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> {
  const next = new Set(set);
  if (!next.delete(value)) next.add(value);
  return next.size ? next : set;
}

/**
 * Which PRs the PR lists show; shared by the switcher and the repo browser for the
 * session. By default: open (not draft) PRs that aren't approved yet.
 */
export const usePrFilters = create<PrFilters>((set, get) => ({
  status: new Set(["open"]),
  review: new Set(["unapproved"]),
  toggleStatus: (s) => set({ status: flip(get().status, s) }),
  toggleReview: (r) => set({ review: flip(get().review, r) }),
}));

export function matchesPrFilters(pr: PrSummary, f: Pick<PrFilters, "status" | "review">): boolean {
  return f.status.has(pr.isDraft ? "draft" : "open") && f.review.has(pr.review === "approved" ? "approved" : "unapproved");
}
