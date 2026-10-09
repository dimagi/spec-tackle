import type { Activity, Comment } from "../api/types";
import { applyActivity, initialSeen } from "./activity";

const comment = (id: number, login = "ann"): Comment => ({
  id, author: { login, avatarUrl: "", isBot: false }, body: "", bodyHTML: "", createdAt: "", url: "", canEdit: false,
});
const activity = (comments: Comment[], { head = "abc", convo = [] as Comment[] } = {}): Activity => ({
  headSha: head, state: "OPEN", isDraft: false, viewer: { login: "me" },
  threads: [{
    id: "T1", path: "a.md", line: 1, startLine: null, originalLine: null, originalStartLine: null,
    isResolved: false, isOutdated: false, isFileLevel: false, side: "RIGHT", resolvedBy: null, comments,
  }],
  conversation: convo.map((c) => ({ ...c, kind: "comment" as const })),
});

test("on a first visit nothing is new", () => {
  const { seen, fresh } = initialSeen(null, activity([comment(1), comment(2)]));
  expect([...seen]).toEqual([1, 2]);
  expect(fresh.size).toBe(0);
});

test("on a later visit, comments since last time are new", () => {
  const { fresh } = initialSeen([1], activity([comment(1), comment(2)]));
  expect([...fresh]).toEqual([2]);
});

test("a new comment from someone else arrives fresh", () => {
  const prev = initialSeen(null, activity([comment(1)]));

  const next = applyActivity(prev, activity([comment(1), comment(2, "bob")]), "abc");

  expect(next.fresh.has(2)).toBe(true);
  expect(next.arrivals).toEqual([{ comment: expect.objectContaining({ id: 2 }), threadId: "T1" }]);
});

test("your own new comment is seen but not announced", () => {
  const prev = initialSeen(null, activity([comment(1)]));

  const next = applyActivity(prev, activity([comment(1), comment(3, "me")]), "abc");

  expect(next.seen.has(3)).toBe(true);
  expect(next.fresh.has(3)).toBe(false);
  expect(next.arrivals).toEqual([]);
});

test("conversation comments arrive without a thread", () => {
  const prev = initialSeen(null, activity([]));

  const next = applyActivity(prev, activity([], { convo: [comment(9, "bob")] }), "abc");

  expect(next.arrivals).toEqual([{ comment: expect.objectContaining({ id: 9 }), threadId: null }]);
});

test("a different head commit means new commits were pushed", () => {
  const prev = initialSeen(null, activity([]));
  expect(applyActivity(prev, activity([]), "abc").newCommits).toBe(false);
  expect(applyActivity(prev, activity([], { head: "def" }), "abc").newCommits).toBe(true);
});
