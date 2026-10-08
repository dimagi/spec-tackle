import { renderHook } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useKeyboard } from "./useKeyboard";

// Tests type into textareas they append; drop them so focus starts on the page.
afterEach(() => document.querySelectorAll("textarea").forEach((t) => t.remove()));

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

test("p opens the PR switcher, but not while typing", async () => {
  const switcher = vi.fn();
  renderHook(() => useKeyboard({ step: vi.fn(), escape: vi.fn(), reply: vi.fn(), switcher }));

  await userEvent.keyboard("p");
  expect(switcher).toHaveBeenCalledTimes(1);

  const textarea = document.body.appendChild(document.createElement("textarea"));
  textarea.focus();
  await userEvent.keyboard("p");
  expect(switcher).toHaveBeenCalledTimes(1);
  expect(textarea.value).toBe("p");
});
