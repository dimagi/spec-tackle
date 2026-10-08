import { createContext, useContext } from "react";
import type { Activity, Page } from "../../api/types";
import type { PRRef } from "../../state/storage";

export type ReviewPageContext = {
  page: Page;
  pr: PRRef;
  /** API prefix for this PR, e.g. /api/pr/o/r/7 */
  api: string;
  activity: Activity;
  /** Comment ids that arrived since the reviewer last looked. */
  fresh: Set<number>;
  /** Mark a comment the reviewer just posted as seen, so it isn't announced. */
  markSeen: (id: number) => void;
  refresh: () => Promise<Activity>;
};

export const ReviewPageCtx = createContext<ReviewPageContext | null>(null);

export function useReviewPage(): ReviewPageContext {
  const ctx = useContext(ReviewPageCtx);
  if (!ctx) throw new Error("useReviewPage outside ReviewPage");
  return ctx;
}
