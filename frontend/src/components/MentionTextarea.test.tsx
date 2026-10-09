import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { MentionUser } from "../api/types";
import { MentionsCtx, MentionTextarea, type Mentions } from "./MentionTextarea";

const user = (login: string, name: string | null = null): MentionUser => ({ login, name, avatarUrl: "" });

function Box({ mentions, enabled = true, onKeyDown }: { mentions: Mentions | null; enabled?: boolean; onKeyDown?: () => void }) {
  const [text, setText] = useState("");
  return (
    <MentionsCtx.Provider value={mentions}>
      <MentionTextarea aria-label="Comment" value={text} onValueChange={setText} mentions={enabled} onKeyDown={onKeyDown} />
    </MentionsCtx.Provider>
  );
}

const source = (others: MentionUser[] = []): Mentions => ({
  participants: [user("ann", "Ann Lee"), user("carl")],
  search: vi.fn(async () => others),
});

test("suggests the PR's people after an @ and inserts the chosen one", async () => {
  render(<Box mentions={source()} />);
  const box = screen.getByRole("combobox", { name: "Comment" });

  await userEvent.type(box, "cc @a");
  expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["annAnn Lee"]);
  await userEvent.keyboard("{Enter}");

  expect(box).toHaveValue("cc @ann ");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
});

test("adds the repo's people from a search, picked with the arrows or a click", async () => {
  const mentions = source([user("bob"), user("ann")]);
  render(<Box mentions={mentions} />);
  const box = screen.getByRole("combobox", { name: "Comment" });

  await userEvent.type(box, "@");
  expect(await screen.findByRole("option", { name: /bob/ })).toBeInTheDocument();
  expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["annAnn Lee", "carl", "bob"]);
  await userEvent.keyboard("{ArrowDown}{ArrowDown}{Tab}");
  expect(box).toHaveValue("@bob ");

  await userEvent.type(box, "and @c");
  await userEvent.click(screen.getByRole("option", { name: /carl/ }));
  expect(box).toHaveValue("@bob and @carl ");
  expect(mentions.search).toHaveBeenCalledWith("");
});

test("Escape closes the list without reaching the box's own handler", async () => {
  const onKeyDown = vi.fn();
  render(<Box mentions={source()} onKeyDown={onKeyDown} />);

  await userEvent.type(screen.getByRole("combobox"), "@");
  onKeyDown.mockClear();
  await userEvent.keyboard("{Escape}");

  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(onKeyDown).not.toHaveBeenCalled();
  await userEvent.keyboard("{Enter}");
  expect(screen.getByRole("combobox")).toHaveValue("@\n");
});

test("is a plain textarea when mentions are off or there's nowhere to look", async () => {
  const { unmount } = render(<Box mentions={source()} enabled={false} />);
  await userEvent.type(screen.getByRole("textbox"), "@a");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  unmount();

  render(<Box mentions={null} />);
  await userEvent.type(screen.getByRole("textbox"), "@a");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
});
