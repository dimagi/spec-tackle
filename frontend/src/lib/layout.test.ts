import { layoutCards } from "./layout";

const item = (id: string, top: number, height = 50) => ({ id, top, height });

test("the active card sits level with its anchor and the others move out of its way", () => {
  const pos = layoutCards([item("a", 100), item("b", 110), item("c", 120)], "b");

  expect(pos.get("b")).toBe(110);
  expect(pos.get("c")).toBe(170); // pushed below b
  expect(pos.get("a")).toBe(50); // pushed above b
});

test("without an active card the first card is pinned", () => {
  const pos = layoutCards([item("a", 0), item("b", 20)], null);

  expect(pos.get("a")).toBe(0);
  expect(pos.get("b")).toBe(60);
});

test("cards pushed above the top shift everything down", () => {
  const pos = layoutCards([item("a", 10), item("b", 20)], "b");

  expect(pos.get("a")).toBe(0);
  expect(pos.get("b")).toBe(60);
});

test("a card that grows pushes the next card further down", () => {
  const before = layoutCards([item("a", 0, 50), item("b", 30)], "a");
  const after = layoutCards([item("a", 0, 200), item("b", 30)], "a");

  expect(before.get("b")).toBe(60);
  expect(after.get("b")).toBe(210);
});

test("cards are placed in anchor order regardless of input order", () => {
  const pos = layoutCards([item("late", 300), item("early", 0)], null);

  expect(pos.get("early")).toBe(0);
  expect(pos.get("late")).toBe(300);
});
