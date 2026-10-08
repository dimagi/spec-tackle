import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeFile } from "../../test/fixtures";
import { FileSection } from "./FileSection";

test("a modified markdown file shows the changes, and can switch to the document", async () => {
  const onViewChange = vi.fn();
  const { container } = render(<FileSection file={makeFile()} index={1} onViewChange={onViewChange} />);
  const rendered = container.querySelector('.view[data-view="rendered"]')!;
  const diff = container.querySelector('.view[data-view="diff"]')!;
  expect(diff).toBeVisible();
  expect(rendered).not.toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: "Document" }));

  expect(diff).not.toBeVisible();
  expect(rendered).toBeVisible();
  expect(onViewChange).toHaveBeenCalledWith("docs/a.md", "rendered");
});

test("a new markdown file has no toggle and shows the document", () => {
  const { container } = render(<FileSection file={makeFile({ wholeFile: true, status: "added" })} index={1} />);
  expect(screen.queryByRole("button", { name: "Changes" })).toBeNull();
  expect(container.querySelector('.view[data-view="rendered"]')).toBeVisible();
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
