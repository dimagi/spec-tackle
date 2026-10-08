import { timeAgo } from "./time";

const NOW = Date.parse("2026-10-08T12:00:00Z");
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

test.each([
  [44, "just now"],
  [60, "1m ago"],
  [59 * 60, "59m ago"],
  [60 * 60, "1h ago"],
  [25 * 3600, "1d ago"],
  [8 * 86400, "1w ago"],
  [40 * 86400, "1mo ago"],
  [400 * 86400, "1y ago"],
])("%i seconds ago reads %s", (seconds, label) => {
  expect(timeAgo(ago(seconds), NOW)).toBe(label);
});

test("no timestamp reads as empty", () => {
  expect(timeAgo(null, NOW)).toBe("");
});
