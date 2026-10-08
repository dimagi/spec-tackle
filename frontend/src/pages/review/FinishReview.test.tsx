import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useToasts } from "../../state/toasts";
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
