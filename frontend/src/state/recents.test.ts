import { loadRecents, recentRepos, recordRecent, removeRecent } from "./recents";

const KEY = "spec-tackle:recent-prs";
const pr = (number: number, title = `PR ${number}`) => ({ owner: "o", repo: "r", number, title });

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

test("newest first, with the opening time", () => {
  recordRecent(pr(1), new Date("2026-10-08T09:00:00Z"));
  recordRecent(pr(2), new Date("2026-10-08T10:00:00Z"));
  expect(loadRecents()).toEqual([
    { owner: "o", repo: "r", number: 2, title: "PR 2", openedAt: "2026-10-08T10:00:00.000Z" },
    { owner: "o", repo: "r", number: 1, title: "PR 1", openedAt: "2026-10-08T09:00:00.000Z" },
  ]);
});

test("reopening a PR moves it to the top and refreshes its title", () => {
  recordRecent(pr(1));
  recordRecent(pr(2));
  recordRecent(pr(1, "Renamed"));
  expect(loadRecents().map((r) => [r.number, r.title])).toEqual([[1, "Renamed"], [2, "PR 2"]]);
});

test("keeps at most ten", () => {
  for (let n = 1; n <= 12; n++) recordRecent(pr(n));
  const list = loadRecents();
  expect(list).toHaveLength(10);
  expect(list[0].number).toBe(12);
  expect(list.at(-1)!.number).toBe(3);
});

test("remove drops one entry and returns the rest", () => {
  recordRecent(pr(1));
  recordRecent(pr(2));
  expect(removeRecent({ owner: "o", repo: "r", number: 2 }).map((r) => r.number)).toEqual([1]);
  expect(loadRecents().map((r) => r.number)).toEqual([1]);
});

test("ignores corrupt or foreign data", () => {
  localStorage.setItem(KEY, "{not json");
  expect(loadRecents()).toEqual([]);
  localStorage.setItem(KEY, JSON.stringify({ owner: "o" }));
  expect(loadRecents()).toEqual([]);
  localStorage.setItem(KEY, JSON.stringify([null, { owner: "o" }, { ...pr(3), openedAt: "" }]));
  expect(loadRecents().map((r) => r.number)).toEqual([3]);
});

test("works when storage throws", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
  expect(() => recordRecent(pr(1))).not.toThrow();
  expect(loadRecents()).toEqual([]);
});

test("recentRepos lists each repo once, most recent first", () => {
  recordRecent({ owner: "a", repo: "x", number: 1, title: "one" });
  recordRecent({ owner: "b", repo: "y", number: 2, title: "two" });
  recordRecent({ owner: "a", repo: "x", number: 3, title: "three" });
  expect(recentRepos()).toEqual([{ owner: "a", repo: "x" }, { owner: "b", repo: "y" }]);
});
