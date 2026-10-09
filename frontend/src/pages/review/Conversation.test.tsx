import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ConversationItem } from "../../api/types";
import { Conversation } from "./Conversation";

const item = (over: Partial<ConversationItem> = {}): ConversationItem => ({
  kind: "comment", id: 1, author: { login: "ann", avatarUrl: "", isBot: false }, body: "", bodyHTML: "<p>Looks good</p>",
  createdAt: "2026-10-08T10:00:00Z", url: "https://github.com/c/1", canEdit: false, ...over,
});

test("lists comments and reviews with their verdicts", () => {
  render(<Conversation items={[item(), item({ id: 2, kind: "review", state: "CHANGES_REQUESTED" })]} fresh={new Set([2])} hideBots={false} onPost={vi.fn()} />);
  expect(screen.getAllByText("Looks good")).toHaveLength(2);
  expect(screen.getByText("requested changes")).toBeInTheDocument();
  expect(screen.getByText("new")).toBeInTheDocument();
});

test("bot comments hide with the filter", () => {
  render(<Conversation items={[item({ author: { login: "ci[bot]", avatarUrl: "", isBot: true } })]} fresh={new Set()} hideBots onPost={vi.fn()} />);
  expect(screen.getByText("No general comments yet.")).toBeInTheDocument();
});

test("posting a general comment clears the form", async () => {
  const onPost = vi.fn().mockResolvedValue(undefined);
  render(<Conversation items={[]} fresh={new Set()} hideBots={false} onPost={onPost} />);
  await userEvent.type(screen.getByRole("textbox"), "Thanks!");
  await userEvent.click(screen.getByRole("button", { name: "Comment" }));
  expect(onPost).toHaveBeenCalledWith("Thanks!");
  expect(screen.getByRole("textbox")).toHaveValue("");
});

test("links in comments open in a new tab", () => {
  render(<Conversation items={[item({ bodyHTML: '<p>See <a href="https://example.com">this</a></p>' })]} fresh={new Set()} hideBots={false} onPost={vi.fn()} />);
  const link = screen.getByRole("link", { name: "this" });
  expect(link).toHaveAttribute("target", "_blank");
  expect(link).toHaveAttribute("rel", "noopener");
});

test("your own comments and reviews can be edited", async () => {
  const onEdit = vi.fn(async () => {});
  const review = item({ id: 2, kind: "review", state: "APPROVED", body: "Ship it", canEdit: true });
  render(<Conversation items={[item(), review]} fresh={new Set()} hideBots={false} onPost={vi.fn()} onEdit={onEdit} />);

  const menus = screen.getAllByRole("button", { name: "Comment options" });
  await userEvent.click(menus[0]);
  expect(screen.queryByRole("menuitem", { name: "Edit" })).not.toBeInTheDocument();
  await userEvent.click(menus[1]);
  await userEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
  await userEvent.type(screen.getByRole("textbox", { name: "Edit comment" }), "!");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));

  expect(onEdit).toHaveBeenCalledWith(review, "Ship it!");
});
