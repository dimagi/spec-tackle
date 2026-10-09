import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeFile } from "../../test/fixtures";
import { FileSection, showsLine, viewForLine } from "./FileSection";

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

test("a view chosen from outside wins", () => {
  const { container, rerender } = render(<FileSection file={makeFile()} index={1} />);
  expect(container.querySelector('.view[data-view="diff"]')).toBeVisible();
  rerender(<FileSection file={makeFile()} index={1} view="rendered" />);
  expect(container.querySelector('.view[data-view="rendered"]')).toBeVisible();
  expect(container.querySelector('.view[data-view="diff"]')).not.toBeVisible();
});

test("viewForLine picks Changes for a line in the diff, else the document; files without a toggle keep their view", () => {
  const modified = makeFile({ hunks: [[3, 5]] });
  expect(viewForLine(modified, 4)).toBe("diff");
  expect(viewForLine(modified, 9)).toBe("rendered");
  expect(viewForLine(makeFile({ wholeFile: true, status: "added", hunks: [[1, 9]] }), 4)).toBe("rendered");
  expect(viewForLine(makeFile({ path: "a.py", markdown: false, rendered: null }), 4)).toBe("diff");
});

test("showsLine: a document shows every line, a code file's changes only their hunks", () => {
  expect(showsLine(makeFile({ hunks: [[3, 5]] }), 9)).toBe(true);
  const code = makeFile({ path: "a.py", markdown: false, rendered: null, hunks: [[3, 5]] });
  expect(showsLine(code, 4)).toBe(true);
  expect(showsLine(code, 9)).toBe(false);
});
