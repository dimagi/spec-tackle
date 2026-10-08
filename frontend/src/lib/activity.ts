import type { Activity, Comment } from "../api/types";

export type SeenState = { seen: Set<number>; fresh: Set<number> };
export type Arrival = { comment: Comment; threadId: string | null };

const commentIds = (a: Activity) => [
  ...a.threads.flatMap((t) => t.comments.map((c) => c.id)),
  ...a.conversation.map((c) => c.id),
];

/** First visit: nothing is "new". Later visits: badge what arrived since `stored`. */
export function initialSeen(stored: number[] | null, activity: Activity): SeenState {
  const seen = new Set(stored ?? commentIds(activity));
  const fresh = new Set<number>();
  for (const id of commentIds(activity)) {
    if (!seen.has(id)) fresh.add(id);
    seen.add(id);
  }
  return { seen, fresh };
}

/** Fold a freshly polled activity into the seen/fresh sets and list what's new from others. */
export function applyActivity(prev: SeenState, next: Activity, renderedSha: string) {
  const seen = new Set(prev.seen);
  const fresh = new Set(prev.fresh);
  const arrivals: Arrival[] = [];
  const collect = (comment: Comment, threadId: string | null) => {
    if (seen.has(comment.id)) return;
    seen.add(comment.id);
    if (comment.author.login === next.viewer.login) return;
    fresh.add(comment.id);
    arrivals.push({ comment, threadId });
  };
  next.threads.forEach((t) => t.comments.forEach((c) => collect(c, t.id)));
  next.conversation.forEach((c) => collect(c, null));
  return { seen, fresh, arrivals, newCommits: next.headSha !== renderedSha };
}
