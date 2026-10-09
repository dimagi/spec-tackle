import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useToasts } from "../state/toasts";
import { CommentMenu } from "./CommentMenu";

const URL = "https://github.com/o/r/pull/1#discussion_r101";

afterEach(() => useToasts.setState({ toasts: [] }));

test("copies the comment's link and closes", async () => {
  const user = userEvent.setup();
  render(<CommentMenu url={URL} />);

  await user.click(screen.getByRole("button", { name: "Comment options" }));
  expect(screen.getByRole("menuitem", { name: "Open on GitHub ↗" })).toHaveAttribute("href", URL);
  await user.click(screen.getByRole("menuitem", { name: "Copy link" }));

  expect(await navigator.clipboard.readText()).toBe(URL);
  expect(useToasts.getState().toasts.map((t) => t.message)).toEqual(["Link copied"]);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});

test("closes on Escape and on a click outside", async () => {
  const user = userEvent.setup();
  render(<><CommentMenu url={URL} /><p>elsewhere</p></>);
  const toggle = screen.getByRole("button", { name: "Comment options" });

  await user.click(toggle);
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();

  await user.click(toggle);
  await user.click(screen.getByText("elsewhere"));
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});
