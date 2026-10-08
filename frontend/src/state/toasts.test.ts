import { toast, useToasts } from "./toasts";

beforeEach(() => useToasts.setState({ toasts: [] }));

test("toasts queue and expire", () => {
  vi.useFakeTimers();
  toast("Thread resolved");
  expect(useToasts.getState().toasts.map((t) => t.message)).toEqual(["Thread resolved"]);
  vi.advanceTimersByTime(5000);
  expect(useToasts.getState().toasts).toEqual([]);
  vi.useRealTimers();
});

test("a timeout of 0 keeps the toast until dismissed", () => {
  vi.useFakeTimers();
  const id = toast("Signed out", { kind: "error", timeout: 0 });
  vi.advanceTimersByTime(60_000);
  expect(useToasts.getState().toasts).toHaveLength(1);
  useToasts.getState().dismiss(id);
  expect(useToasts.getState().toasts).toHaveLength(0);
  vi.useRealTimers();
});
