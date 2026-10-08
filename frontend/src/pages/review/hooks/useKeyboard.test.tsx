import { renderHook } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useKeyboard } from "./useKeyboard";

test("j and k step through threads; typing in a textarea doesn't", async () => {
  const step = vi.fn();
  renderHook(() => useKeyboard({ step, escape: vi.fn(), reply: vi.fn() }));

  await userEvent.keyboard("j");
  await userEvent.keyboard("k");
  expect(step.mock.calls).toEqual([[1], [-1]]);

  const textarea = document.body.appendChild(document.createElement("textarea"));
  textarea.focus();
  await userEvent.keyboard("j");
  expect(step).toHaveBeenCalledTimes(2);
});
