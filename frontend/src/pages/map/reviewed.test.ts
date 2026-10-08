import { isReviewed, loadReviewed, patchHash, toggleReviewed } from "./reviewed";

const pr = { owner: "o", repo: "r", number: 7 };

beforeEach(() => localStorage.clear());

test("patch hashes differ when the diff does", () => {
  expect(patchHash("a")).toBe(patchHash("a"));
  expect(patchHash("a")).not.toBe(patchHash("b"));
});

test("a reviewed file un-ticks itself when its diff changes", () => {
  toggleReviewed(pr, "a.py", "diff v1");
  const reviewed = loadReviewed(pr);
  expect(isReviewed(reviewed, "a.py", "diff v1")).toBe(true);
  expect(isReviewed(reviewed, "a.py", "diff v2")).toBe(false);
  expect(localStorage.getItem("spec-tackle:o/r#7:map-reviewed")).toContain("a.py");
});

test("toggling twice un-reviews", () => {
  toggleReviewed(pr, "a.py", "d");
  toggleReviewed(pr, "a.py", "d");
  expect(isReviewed(loadReviewed(pr), "a.py", "d")).toBe(false);
});
