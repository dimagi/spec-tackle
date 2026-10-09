import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeThread } from "../../test/fixtures";
import { ThreadCard, type ThreadCardProps } from "./ThreadCard";

const long = "word ".repeat(100);

function renderCard(over: Partial<ThreadCardProps> = {}) {
  const props: ThreadCardProps = {
    thread: makeThread(), collapsed: false, collapsible: false, active: false, fresh: new Set(),
    bodyExpanded: () => false, onExpand: vi.fn(), onCollapse: vi.fn(), onExpandBody: vi.fn(),
    onResolve: vi.fn(), ...over,
  };
  return { props, ...render(<ThreadCard {...props} />) };
}

test("shows comments with author, line chip and a link to GitHub", () => {
  renderCard();
  expect(screen.getByText("ann")).toBeInTheDocument();
  expect(screen.getByText("Why?")).toBeInTheDocument();
  expect(screen.getByText("L2")).toBeInTheDocument();
  expect(screen.getByTitle("Open on GitHub")).toHaveAttribute("href", "https://github.com/c/101");
});

test("a collapsed thread shows a one-line summary, cut at 160 characters", async () => {
  const thread = makeThread({ isResolved: true, resolvedBy: "bob" });
  thread.comments[0] = { ...thread.comments[0], bodyHTML: `<p>${long}</p>` };
  const { props } = renderCard({ thread, collapsed: true, collapsible: true });

  const summary = screen.getByTestId("collapsed-summary");
  expect(summary.querySelector(".text")!.textContent).toHaveLength(160);
  expect(screen.getByText("Resolved by bob")).toBeInTheDocument();
  await userEvent.click(summary);
  expect(props.onExpand).toHaveBeenCalled();
});

test("fresh comments are badged", () => {
  renderCard({ fresh: new Set([101]) });
  expect(screen.getByText("1 new")).toBeInTheDocument();
});

test("very long comments are clamped behind Show more", async () => {
  const height = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(400);
  const { props, container, rerender } = renderCard();

  expect(container.querySelector(".comment-body")).toHaveClass("clamped");
  await userEvent.click(screen.getByRole("button", { name: "Show more" }));
  expect(props.onExpandBody).toHaveBeenCalledWith(101);

  rerender(<ThreadCard {...props} bodyExpanded={() => true} />);
  expect(container.querySelector(".comment-body")).not.toHaveClass("clamped");
  height.mockRestore();
});

test("resolve and reopen", async () => {
  const { props, rerender } = renderCard();
  await userEvent.click(screen.getByRole("button", { name: "✓ Resolve" }));
  expect(props.onResolve).toHaveBeenCalledWith(true);

  rerender(<ThreadCard {...props} thread={makeThread({ isResolved: true })} />);
  await userEvent.click(screen.getByRole("button", { name: "Reopen" }));
  expect(props.onResolve).toHaveBeenCalledWith(false);
});

test("your own comments can be edited in place", async () => {
  const thread = makeThread();
  thread.comments[0] = { ...thread.comments[0], canEdit: true };
  const onEdit = vi.fn(async () => {});
  renderCard({ thread, onEdit });

  await userEvent.click(screen.getByRole("button", { name: "Comment options" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
  const box = screen.getByRole("textbox", { name: "Edit comment" });
  expect(box).toHaveValue("Why?");
  await userEvent.clear(box);
  await userEvent.type(box, "Why the backoff?{Control>}{Enter}{/Control}");

  expect(onEdit).toHaveBeenCalledWith(thread.comments[0], "Why the backoff?");
  expect(screen.queryByRole("textbox", { name: "Edit comment" })).not.toBeInTheDocument();
});

test("a failed edit keeps the editor open; Escape cancels it", async () => {
  const thread = makeThread();
  thread.comments[0] = { ...thread.comments[0], canEdit: true };
  const onEdit = vi.fn(async () => { throw new Error("nope"); });
  renderCard({ thread, onEdit });

  await userEvent.click(screen.getByRole("button", { name: "Comment options" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
  await userEvent.type(screen.getByRole("textbox", { name: "Edit comment" }), "!");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(screen.getByRole("textbox", { name: "Edit comment" })).toHaveValue("Why?!");

  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("textbox", { name: "Edit comment" })).not.toBeInTheDocument();
  expect(screen.getByText("Why?")).toBeInTheDocument();
});

test("other people's comments have no Edit", async () => {
  renderCard({ onEdit: vi.fn() });
  await userEvent.click(screen.getByRole("button", { name: "Comment options" }));
  expect(screen.queryByRole("menuitem", { name: "Edit" })).not.toBeInTheDocument();
});

test("the enlarge button says which way it goes", async () => {
  const onEnlarge = vi.fn();
  const { props, rerender } = renderCard({ onEnlarge });
  await userEvent.click(screen.getByRole("button", { name: "Enlarge thread" }));
  expect(onEnlarge).toHaveBeenCalledWith(true);

  rerender(<ThreadCard {...props} enlarged />);
  await userEvent.click(screen.getByRole("button", { name: "Shrink thread" }));
  expect(onEnlarge).toHaveBeenLastCalledWith(false);
});
