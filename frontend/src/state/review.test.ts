import { createReviewStore } from "./review";

const pr = { owner: "o", repo: "r", number: 7 };

beforeEach(() => localStorage.clear());

test("filters start from saved prefs and are saved when changed", () => {
  localStorage.setItem("spec-tackle:o/r#7:filter", '"all"');
  const store = createReviewStore(pr);

  expect(store.getState().filter).toBe("all");
  store.getState().setFilter("open");
  expect(localStorage.getItem("spec-tackle:o/r#7:filter")).toBe('"open"');
});

test("show Claude threads defaults to on", () => {
  expect(createReviewStore(pr).getState().showClaude).toBe(true);
});

test("expanding a thread is remembered until collapsed", () => {
  const store = createReviewStore(pr);
  store.getState().expand("T1");
  expect(store.getState().expanded.has("T1")).toBe(true);
  store.getState().collapse("T1");
  expect(store.getState().expanded.has("T1")).toBe(false);
});

test("closing the composer clears an active composer", () => {
  const store = createReviewStore(pr);
  store.getState().openComposer({ path: "a.md", start: 1, end: 2, quote: null, mode: "comment" });
  expect(store.getState().active).toBe("composer");
  store.getState().closeComposer();
  expect(store.getState().composer).toBeNull();
  expect(store.getState().active).toBeNull();
});
