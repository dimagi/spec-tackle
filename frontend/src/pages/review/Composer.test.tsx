import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeFile } from "../../test/fixtures";
import { Composer, type ComposerProps } from "./Composer";

function renderComposer(over: Partial<ComposerProps> = {}) {
  const props: ComposerProps = {
    target: { path: "docs/a.md", start: 2, end: 3, quote: "two three", mode: "comment" },
    file: makeFile(), claude: true, api: "/api/pr/o/r/7",
    onModeChange: vi.fn(), onCancel: vi.fn(), onSubmit: vi.fn().mockResolvedValue(undefined),
    onDirtyChange: vi.fn(), ...over,
  };
  const utils = render(<Composer {...props} />);
  return { props, ...utils };
}

test("starts with the selection quoted and the line range", () => {
  renderComposer();
  expect(screen.getByRole("textbox")).toHaveValue("> two three\n\n");
  expect(screen.getByText("L2–3")).toBeInTheDocument();
  expect(screen.getByText("New comment")).toBeInTheDocument();
});

test("Ask Claude mode drops the quote and switching back restores it", async () => {
  const { props, rerender } = renderComposer();
  await userEvent.click(screen.getByRole("button", { name: "Ask Claude" }));
  expect(props.onModeChange).toHaveBeenCalledWith("claude");

  rerender(<Composer {...props} target={{ ...props.target, mode: "claude" }} />);
  expect(screen.getByRole("textbox")).toHaveValue("");
  expect(screen.queryByRole("button", { name: "Preview" })).toBeNull();
  expect(screen.getByText("Private, never posted · ⌘↵ to ask")).toBeInTheDocument();

  rerender(<Composer {...props} target={{ ...props.target, mode: "comment" }} />);
  expect(screen.getByRole("textbox")).toHaveValue("> two three\n\n");
});

test("text the reviewer typed survives a mode switch", async () => {
  const { props, rerender } = renderComposer({ target: { path: "docs/a.md", start: 2, end: 3, quote: null, mode: "comment" } });
  await userEvent.type(screen.getByRole("textbox"), "My question");
  rerender(<Composer {...props} target={{ ...props.target, mode: "claude" }} />);
  expect(screen.getByRole("textbox")).toHaveValue("My question");
});

test("unchanged lines get a file-comment hint", () => {
  renderComposer({ file: makeFile({ hunks: [[10, 12]] }) });
  expect(screen.getByText(/posted as a file comment that references L2–3/)).toBeInTheDocument();
});

test("a partly changed passage says which lines the comment attaches to", () => {
  renderComposer({ file: makeFile({ hunks: [[3, 8]] }) });
  expect(screen.getByText(/Only L3 of this passage changed/)).toBeInTheDocument();
});

test("⌘↵ submits the trimmed text; empty text doesn't", async () => {
  const { props } = renderComposer({ target: { path: "docs/a.md", start: 2, end: 3, quote: null, mode: "comment" } });
  const box = screen.getByRole("textbox");
  await userEvent.type(box, "{Meta>}{Enter}{/Meta}");
  expect(props.onSubmit).not.toHaveBeenCalled();
  await userEvent.type(box, "  Fix this  {Meta>}{Enter}{/Meta}");
  expect(props.onSubmit).toHaveBeenCalledWith("Fix this", "comment");
});

test("selecting a phrase in the block the composer is already open on quotes it", () => {
  const { props, rerender } = renderComposer({ target: { path: "docs/a.md", start: 2, end: 3, quote: null, mode: "comment" } });
  expect(screen.getByRole("textbox")).toHaveValue("");

  rerender(<Composer {...props} target={{ ...props.target, quote: "three" }} />);

  expect(screen.getByRole("textbox")).toHaveValue("> three\n\n");
});

test("a new selection doesn't overwrite text the reviewer wrote", async () => {
  const { props, rerender } = renderComposer({ target: { path: "docs/a.md", start: 2, end: 3, quote: null, mode: "comment" } });
  await userEvent.type(screen.getByRole("textbox"), "My point");

  rerender(<Composer {...props} target={{ ...props.target, quote: "three" }} />);

  expect(screen.getByRole("textbox")).toHaveValue("My point");
});

test("a preview error is shown as text, never as HTML", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "<img src=x onerror=alert(1)>" }), { status: 502 })));
  const { container } = renderComposer();

  await userEvent.click(screen.getByRole("button", { name: "Preview" }));

  expect(await screen.findByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
  expect(container.querySelector(".preview img")).toBeNull();
  vi.unstubAllGlobals();
});

const plain = { path: "docs/a.md", start: 2, end: 3, quote: null, mode: "comment" as const };

test("Add to review keeps the comment as a draft instead of posting it", async () => {
  const onDraft = vi.fn().mockResolvedValue(undefined);
  const { props } = renderComposer({ target: plain, onDraft });
  await userEvent.type(screen.getByRole("textbox"), "  Why three?  ");

  await userEvent.click(screen.getByRole("button", { name: "Add to review" }));

  expect(onDraft).toHaveBeenCalledWith("Why three?");
  expect(props.onSubmit).not.toHaveBeenCalled();
});

test("⌘⇧↵ adds to the review and ⌘↵ still posts", async () => {
  const onDraft = vi.fn().mockResolvedValue(undefined);
  const { props } = renderComposer({ target: plain, onDraft });
  const box = screen.getByRole("textbox");
  expect(screen.getByText("Markdown · ⌘↵ to post · ⌘⇧↵ to add to review")).toBeInTheDocument();

  await userEvent.type(box, "Later{Meta>}{Shift>}{Enter}{/Shift}{/Meta}");
  expect(onDraft).toHaveBeenCalledWith("Later");
  expect(props.onSubmit).not.toHaveBeenCalled();

  await userEvent.type(box, "{Meta>}{Enter}{/Meta}");
  expect(props.onSubmit).toHaveBeenCalledWith("Later", "comment");
});

test("there is no Add to review when drafts are off, or when asking Claude", () => {
  const { props, rerender } = renderComposer({ target: plain });
  expect(screen.queryByRole("button", { name: "Add to review" })).toBeNull();
  expect(screen.getByText("Markdown · ⌘↵ to post")).toBeInTheDocument();

  rerender(<Composer {...props} onDraft={vi.fn()} target={{ ...plain, mode: "claude" }} />);
  expect(screen.queryByRole("button", { name: "Add to review" })).toBeNull();
});
