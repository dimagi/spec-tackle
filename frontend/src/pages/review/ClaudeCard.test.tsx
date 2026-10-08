import { render, screen } from "@testing-library/react";
import type { ClaudeThread } from "../../api/types";
import { ClaudeCard } from "./ClaudeCard";

const thread = (over: Partial<ClaudeThread> = {}): ClaudeThread => ({
  id: "C1", path: "docs/a.md", startLine: 2, endLine: 3, anchorText: "two", commit: "abc1234def", createdAt: "",
  running: false,
  messages: [
    { role: "user", body: "Why two?", createdAt: "2026-10-08T10:00:00Z" },
    { role: "assistant", body: "Because.", bodyHTML: "<p>Because.</p>", createdAt: "2026-10-08T10:01:00Z" },
  ],
  ...over,
});
const props = { live: null, onFollowUp: vi.fn(), onDelete: vi.fn(), onFocus: vi.fn() };

test("shows the question and answer, privately", () => {
  render(<ClaudeCard thread={thread()} headSha="abc1234def" {...props} />);
  expect(screen.getByText("Claude · private")).toBeInTheDocument();
  expect(screen.getByText("Why two?")).toBeInTheDocument();
  expect(screen.getByText("Because.")).toBeInTheDocument();
  expect(screen.queryByText(/the PR is now at/)).toBeNull();
});

test("says when the PR has moved on since the question", () => {
  render(<ClaudeCard thread={thread()} headSha="def5678aaa" {...props} />);
  expect(screen.getByText(/the PR is now at/)).toHaveTextContent("Asked on abc1234; the PR is now at def5678.");
});

test("a live answer shows its progress and blocks follow-ups", () => {
  render(<ClaudeCard thread={thread({ running: true })} headSha="abc1234def" {...props} live={{ tool: "Reading app.py", text: "So far" }} />);
  expect(screen.getByText("Reading app.py")).toBeInTheDocument();
  expect(screen.getByText("So far")).toBeInTheDocument();
  expect(screen.getByRole("textbox")).toBeDisabled();
});

test("an answer cut short says so", () => {
  const t = thread({ messages: [{ role: "user", body: "Why?", createdAt: "" }] });
  render(<ClaudeCard thread={t} headSha="abc1234def" {...props} />);
  expect(screen.getByText("Interrupted. Ask again.")).toBeInTheDocument();
});
