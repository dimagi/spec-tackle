import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useToasts } from "../../state/toasts";
import { makeReplyDraft } from "../../test/fixtures";
import { FinishReview } from "./FinishReview";

beforeAll(() => {
  // jsdom has no <dialog> methods.
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
beforeEach(() => useToasts.setState({ toasts: [] }));

test("a comment review needs a summary", async () => {
  const onSubmit = vi.fn();
  render(<FinishReview open onClose={vi.fn()} onSubmit={onSubmit} />);
  await userEvent.click(screen.getByRole("button", { name: "Submit review" }));
  expect(onSubmit).not.toHaveBeenCalled();
  expect(useToasts.getState().toasts[0].message).toBe("Add a summary for this kind of review");
});

test("an approval can be submitted without a summary", async () => {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  render(<FinishReview open onClose={onClose} onSubmit={onSubmit} />);
  await userEvent.click(screen.getByLabelText(/Approve/));
  await userEvent.click(screen.getByRole("button", { name: "Submit review" }));
  expect(onSubmit).toHaveBeenCalledWith("APPROVE", "");
  expect(onClose).toHaveBeenCalled();
});

test("request changes sends the summary", async () => {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  render(<FinishReview open onClose={vi.fn()} onSubmit={onSubmit} />);
  await userEvent.type(screen.getByPlaceholderText("Summary (optional for approvals)"), "Please split this");
  await userEvent.click(screen.getByLabelText(/Request changes/));
  await userEvent.click(screen.getByRole("button", { name: "Submit review" }));
  expect(onSubmit).toHaveBeenCalledWith("REQUEST_CHANGES", "Please split this");
});

const noDrafts = { sending: 0, outdated: 0, orphans: [], githubPending: 0, onDelete: vi.fn() };

test("without drafts the dialog says comments are already posted", () => {
  render(<FinishReview open onClose={vi.fn()} onSubmit={vi.fn()} />);
  expect(screen.getByText(/Your margin comments are already on the PR/)).toBeInTheDocument();
});

test("says what happens to drafts", () => {
  render(<FinishReview open onClose={vi.fn()} onSubmit={vi.fn()}
    drafts={{ ...noDrafts, sending: 3, outdated: 1, githubPending: 2 }} />);
  expect(screen.getByText("3 drafts will be posted with this review.")).toBeInTheDocument();
  expect(screen.getByText("1 outdated draft stays behind.")).toBeInTheDocument();
  expect(screen.getByText("You also have 2 pending comments on GitHub; they'll be submitted too.")).toBeInTheDocument();
});

test("one draft is singular, and outdated ones alone are mentioned", () => {
  const { rerender } = render(<FinishReview open onClose={vi.fn()} onSubmit={vi.fn()} drafts={{ ...noDrafts, sending: 1 }} />);
  expect(screen.getByText("1 draft will be posted with this review.")).toBeInTheDocument();
  expect(screen.queryByText(/stays? behind/)).toBeNull();

  rerender(<FinishReview open onClose={vi.fn()} onSubmit={vi.fn()} drafts={{ ...noDrafts, outdated: 2 }} />);
  expect(screen.getByText("2 outdated drafts stay behind.")).toBeInTheDocument();
  expect(screen.queryByText(/will be posted/)).toBeNull();
});

test("a comment review that carries drafts needs no summary", async () => {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  render(<FinishReview open onClose={vi.fn()} onSubmit={onSubmit} drafts={{ ...noDrafts, sending: 2 }} />);
  await userEvent.click(screen.getByRole("button", { name: "Submit review" }));
  expect(onSubmit).toHaveBeenCalledWith("COMMENT", "");
});

test("request changes needs a summary even with drafts", async () => {
  const onSubmit = vi.fn();
  render(<FinishReview open onClose={vi.fn()} onSubmit={onSubmit} drafts={{ ...noDrafts, sending: 2 }} />);
  await userEvent.click(screen.getByLabelText(/Request changes/));
  await userEvent.click(screen.getByRole("button", { name: "Submit review" }));
  expect(onSubmit).not.toHaveBeenCalled();
});

test("a reply to a deleted thread is listed and can be deleted", async () => {
  const onDelete = vi.fn();
  const orphan = makeReplyDraft({ body: "Agreed, but why?" });
  render(<FinishReview open onClose={vi.fn()} onSubmit={vi.fn()} drafts={{ ...noDrafts, orphans: [orphan], onDelete }} />);
  expect(screen.getByText("1 reply to a deleted thread won't be sent:")).toBeInTheDocument();
  expect(screen.getByText("Agreed, but why?")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Delete" }));

  expect(onDelete).toHaveBeenCalledWith(orphan);
});
