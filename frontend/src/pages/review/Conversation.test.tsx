import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ConversationItem } from "../../api/types";
import { Conversation } from "./Conversation";

const item = (over: Partial<ConversationItem> = {}): ConversationItem => ({
  kind: "comment", id: 1, author: { login: "ann", avatarUrl: "", isBot: false }, body: "", bodyHTML: "<p>Looks good</p>",
  createdAt: "2026-10-08T10:00:00Z", url: "https://github.com/c/1", ...over,
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
