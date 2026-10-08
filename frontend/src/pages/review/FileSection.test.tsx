import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeFile } from "../../test/fixtures";
import { FileSection } from "./FileSection";

test("a modified markdown file shows the document, and can switch to changes", async () => {
  const onViewChange = vi.fn();
  const { container } = render(<FileSection file={makeFile()} index={1} onViewChange={onViewChange} />);
  const rendered = container.querySelector('.view[data-view="rendered"]')!;
  const diff = container.querySelector('.view[data-view="diff"]')!;
  expect(rendered).toBeVisible();
  expect(diff).not.toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: "Changes" }));

  expect(rendered).not.toBeVisible();
  expect(diff).toBeVisible();
  expect(onViewChange).toHaveBeenCalledWith("docs/a.md", "diff");
});

test("a new markdown file has no toggle", () => {
  render(<FileSection file={makeFile({ wholeFile: true, status: "added" })} index={1} />);
  expect(screen.queryByRole("button", { name: "Changes" })).toBeNull();
});

test("a code file shows its diff", () => {
  const { container } = render(<FileSection file={makeFile({ path: "a.py", markdown: false, rendered: null })} index={2} />);
  expect(container.querySelector('.view[data-view="diff"]')).toBeVisible();
  expect(container.querySelector("section")).toHaveAttribute("id", "file-2");
});

test("a binary file links to GitHub", () => {
  render(<FileSection file={makeFile({ rendered: null, diff: null })} index={1} />);
  expect(screen.getByText(/No preview available/)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "View on GitHub" })).toBeInTheDocument();
});

test("a request from the Map shows the changes", () => {
  const { container, rerender } = render(<FileSection file={makeFile()} index={1} />);
  rerender(<FileSection file={makeFile()} index={1} showChanges={1} />);
  expect(container.querySelector('.view[data-view="diff"]')).toBeVisible();
});
