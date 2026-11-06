import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeDraft, makeReplyDraft } from "../../test/fixtures";
import { DraftCard, DraftReply, type DraftCardProps } from "./DraftCard";

function renderCard(over: Partial<DraftCardProps> = {}) {
  const props: DraftCardProps = {
    draft: makeDraft(), reattaching: false,
    onSave: vi.fn().mockResolvedValue(undefined), onDelete: vi.fn(), onReattach: vi.fn(), ...over,
  };
  return { props, ...render(<DraftCard {...props} />) };
}

test("shows the lines, that it's private, and the body as plain text", () => {
  const { container } = renderCard({ draft: makeDraft({ body: "Why **three**?\n<b>really</b>" }) });
  expect(screen.getByText("L2–3")).toBeInTheDocument();
  expect(screen.getByText("Draft · only you")).toBeInTheDocument();
  expect(container.querySelector(".comment-body")).toHaveTextContent("Why **three**? <b>really</b>");
  expect(container.querySelector(".comment-body b")).toBeNull();
  expect(screen.queryByText("Outdated")).toBeNull();
});

test("Edit saves the new text", async () => {
  const { props } = renderCard();
  await userEvent.click(screen.getByRole("button", { name: "Edit" }));
  const box = screen.getByRole("textbox", { name: "Edit comment" });
  await userEvent.clear(box);
  await userEvent.type(box, "Why five?");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));

  expect(props.onSave).toHaveBeenCalledWith("Why five?");
  expect(screen.queryByRole("textbox")).toBeNull();
});

test("Delete asks the page to delete it", async () => {
  const { props } = renderCard();
  await userEvent.click(screen.getByRole("button", { name: "Delete" }));
  expect(props.onDelete).toHaveBeenCalled();
});

test("an outdated draft shows what it was about and offers to re-attach", async () => {
  const { props } = renderCard({ draft: makeDraft({ outdated: true, anchorText: "the old wording" }) });
  expect(screen.getByText("Outdated")).toBeInTheDocument();
  expect(screen.getByText("the old wording")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Re-attach" }));

  expect(props.onReattach).toHaveBeenCalledWith(true);
});

test("while re-attaching it says what to do and can be cancelled", async () => {
  const { props } = renderCard({ draft: makeDraft({ outdated: true }), reattaching: true });
  expect(screen.getByText(/Click a passage or select text/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Re-attach" })).toBeNull();

  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

  expect(props.onReattach).toHaveBeenCalledWith(false);
});

test("a draft that is already on GitHub can't be edited or deleted", () => {
  renderCard({ draft: makeDraft({ sent: true }) });
  expect(screen.getByText("Waiting to be submitted")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
});

test("shows why a draft couldn't be sent", () => {
  renderCard({ draft: makeDraft({ error: "GitHub refused this comment" }) });
  expect(screen.getByText("Couldn't be sent: GitHub refused this comment")).toBeInTheDocument();
});

test("a drafted reply is marked as a draft and can be edited or deleted", async () => {
  const onSave = vi.fn().mockResolvedValue(undefined);
  const onDelete = vi.fn();
  render(<DraftReply draft={makeReplyDraft()} onSave={onSave} onDelete={onDelete} />);
  expect(screen.getByText("Draft")).toBeInTheDocument();
  expect(screen.getByText("Agreed")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Edit" }));
  await userEvent.type(screen.getByRole("textbox", { name: "Edit comment" }), "!");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(onSave).toHaveBeenCalledWith("Agreed!");

  await userEvent.click(screen.getByRole("button", { name: "Delete" }));
  expect(onDelete).toHaveBeenCalled();
});

test("a drafted reply already on GitHub is locked", () => {
  render(<DraftReply draft={makeReplyDraft({ sent: true })} onSave={vi.fn()} onDelete={vi.fn()} />);
  expect(screen.getByText("Waiting to be submitted")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
});
