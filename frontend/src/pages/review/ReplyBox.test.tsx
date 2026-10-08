import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReplyBox } from "./ReplyBox";

const pr = { owner: "o", repo: "r", number: 7 };

beforeEach(() => localStorage.clear());

test("a reply draft is saved as you type and restored after a re-render", async () => {
  const { rerender, unmount } = render(<ReplyBox pr={pr} threadId="T1" onSubmit={vi.fn()} onFocus={vi.fn()} />);
  await userEvent.type(screen.getByRole("textbox"), "half a thought");
  expect(localStorage.getItem("spec-tackle:o/r#7:draft:T1")).toBe('"half a thought"');

  rerender(<ReplyBox pr={pr} threadId="T1" onSubmit={vi.fn()} onFocus={vi.fn()} />);
  expect(screen.getByRole("textbox")).toHaveValue("half a thought");

  unmount();
  render(<ReplyBox pr={pr} threadId="T1" onSubmit={vi.fn()} onFocus={vi.fn()} />);
  expect(screen.getByRole("textbox")).toHaveValue("half a thought");
});

test("sending clears the draft", async () => {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  render(<ReplyBox pr={pr} threadId="T1" onSubmit={onSubmit} onFocus={vi.fn()} />);
  await userEvent.type(screen.getByRole("textbox"), "Agreed");
  await userEvent.click(screen.getByRole("button", { name: "Reply" }));

  expect(onSubmit).toHaveBeenCalledWith("Agreed");
  expect(screen.getByRole("textbox")).toHaveValue("");
  expect(localStorage.getItem("spec-tackle:o/r#7:draft:T1")).toBeNull();
});

test("a failed send keeps the text", async () => {
  render(<ReplyBox pr={pr} threadId="T1" onSubmit={vi.fn().mockRejectedValue(new Error("nope"))} onFocus={vi.fn()} />);
  await userEvent.type(screen.getByRole("textbox"), "Agreed");
  await userEvent.click(screen.getByRole("button", { name: "Reply" }));
  expect(screen.getByRole("textbox")).toHaveValue("Agreed");
});
