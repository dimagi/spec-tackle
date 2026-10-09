import type { PageFile, Thread } from "../api/types";
import { commentableRange, headingCounts, isCollapsible, isShown, quoteFor, rangeLabel, stepThread, threadRange } from "./threads";

const person = (isBot = false) => ({ login: isBot ? "ci[bot]" : "ann", avatarUrl: "", isBot });
const thread = (over: Partial<Thread> = {}): Thread => ({
  id: "T1", path: "a.md", line: 5, startLine: 3, originalLine: null, originalStartLine: null,
  isResolved: false, isOutdated: false, isFileLevel: false, side: "RIGHT", resolvedBy: null,
  comments: [{ id: 1, author: person(), body: "", bodyHTML: "", createdAt: "", url: "", canEdit: false }],
  ...over,
});
const file = (over: Partial<PageFile> = {}): PageFile => ({
  path: "a.md", status: "modified", additions: 1, deletions: 0, hunks: [[10, 14], [30, 31]],
  wholeFile: false, markdown: true, rendered: null, diff: null, outline: [], githubUrl: "", ...over,
});

test("rangeLabel shows one line or a range", () => {
  expect(rangeLabel(4, 4)).toBe("L4");
  expect(rangeLabel(3, 5)).toBe("L3–5");
});

test("threadRange uses current lines, then original lines", () => {
  expect(threadRange(thread())).toEqual([3, 5]);
  expect(threadRange(thread({ startLine: null }))).toEqual([5, 5]);
  expect(threadRange(thread({ line: null, startLine: null, originalLine: 8, originalStartLine: 7 }))).toEqual([7, 8]);
});

test("threadRange has nothing to anchor for file-level or removed-line threads", () => {
  expect(threadRange(thread({ isFileLevel: true }))).toBeNull();
  expect(threadRange(thread({ side: "LEFT" }))).toBeNull();
});

test("commentableRange mirrors render.resolve_anchor", () => {
  expect(commentableRange(file({ wholeFile: true }), 1, 3)).toEqual({ start: 1, end: 3 });
  expect(commentableRange(file(), 12, 13)).toEqual({ start: 12, end: 13 });
  expect(commentableRange(file(), 8, 11)).toEqual({ start: 10, end: 11 });
  expect(commentableRange(file(), 20, 25)).toBeNull();
});

test("resolved, outdated and bot threads collapse", () => {
  expect(isCollapsible(thread())).toBe(false);
  expect(isCollapsible(thread({ isResolved: true }))).toBe(true);
  expect(isCollapsible(thread({ isOutdated: true }))).toBe(true);
  expect(isCollapsible(thread({ comments: [{ ...thread().comments[0], author: person(true) }] }))).toBe(true);
});

test("filters hide resolved threads and bots", () => {
  const bot = thread({ comments: [{ ...thread().comments[0], author: person(true) }] });
  expect(isShown(thread({ isResolved: true }), { filter: "open", hideBots: false })).toBe(false);
  expect(isShown(thread({ isResolved: true }), { filter: "all", hideBots: false })).toBe(true);
  expect(isShown(bot, { filter: "all", hideBots: true })).toBe(false);
});

test("quoteFor turns a selection into a markdown quote", () => {
  expect(quoteFor("one\n\ntwo")).toBe("> one\n> two\n\n");
  expect(quoteFor(null)).toBe("");
});

test("headingCounts counts open, shown threads under each heading until the next", () => {
  const f = file({
    outline: [
      { level: 1, line: 1, id: "a", text: "A" },
      { level: 2, line: 10, id: "b", text: "B" },
    ],
  });
  const threads = [
    thread({ id: "1", line: 5, startLine: null }),
    thread({ id: "2", line: 12, startLine: null }),
    thread({ id: "3", line: 15, startLine: null, isResolved: true }),
    thread({ id: "4", line: 20, startLine: null, path: "other.md" }),
  ];

  const counts = headingCounts([f], threads, { filter: "all", hideBots: false });

  expect(counts.get("a.md#a")).toBe(1);
  expect(counts.get("a.md#b")).toBe(1);
});

describe("stepThread", () => {
  const list = [{ id: "a", top: 100 }, { id: "b", top: 500 }, { id: "c", top: 900 }];

  test("moves from the active thread and wraps around", () => {
    expect(stepThread(list, "a", 1, 0)).toBe("b");
    expect(stepThread(list, "c", 1, 0)).toBe("a");
    expect(stepThread(list, "a", -1, 0)).toBe("c");
  });

  test("without an active thread it starts from what's on screen", () => {
    expect(stepThread(list, null, 1, 300)).toBe("b");
    expect(stepThread(list, null, -1, 600)).toBe("b");
    expect(stepThread(list, null, 1, 2000)).toBe("a");
  });

  test("no open threads gives nothing", () => {
    expect(stepThread([], null, 1, 0)).toBeNull();
  });
});
