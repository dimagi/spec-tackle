import { loadPref, savePref } from "./storage";

const pr = { owner: "o", repo: "r", number: 7 };

beforeEach(() => localStorage.clear());

test("prefs use the same keys and JSON values as the old UI", () => {
  savePref(pr, "filter", "all");

  expect(localStorage.getItem("spec-tackle:o/r#7:filter")).toBe('"all"');
  expect(loadPref(pr, "filter", "open")).toBe("all");
});

test("reads values the old UI wrote", () => {
  localStorage.setItem("spec-tackle:o/r#7:seen", "[1,2]");
  expect(loadPref(pr, "seen", [])).toEqual([1, 2]);
});

test("missing or broken values fall back", () => {
  localStorage.setItem("spec-tackle:o/r#7:hideBots", "{nope");
  expect(loadPref(pr, "hideBots", false)).toBe(false);
  expect(loadPref(pr, "missing", 3)).toBe(3);
});

test("saving null removes the key", () => {
  savePref(pr, "draft:T1", "hi");
  savePref(pr, "draft:T1", null);
  expect(localStorage.getItem("spec-tackle:o/r#7:draft:T1")).toBeNull();
});
