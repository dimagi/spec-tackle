import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createReviewStore, ReviewStoreContext } from "../../state/review";
import { makeFile, PR } from "../../test/fixtures";
import type { FileView } from "./FileSection";
import { Rail } from "./Rail";

function renderRail(files = [makeFile()], views: Record<string, FileView> = {}) {
  return render(
    <ReviewStoreContext.Provider value={createReviewStore(PR)}>
      <Rail files={files} views={views} claude={false} stats={{ open: 0, resolved: 0 }}
        headingCounts={new Map()} conversationCount={0} onStep={() => {}} />
    </ReviewStoreContext.Provider>,
  );
}

const tree = () => screen.getByRole("tree", { name: "Changed files" });
const entries = () => within(tree()).queryAllByRole("link").map((a) => a.textContent);

test("changed files sit in their folders", () => {
  renderRail([makeFile({ path: "docs/a.md" }), makeFile({ path: "src/app.py", status: "added" }), makeFile({ path: "README.md" })]);
  expect(within(tree()).getAllByRole("button").map((b) => b.textContent)).toEqual(["docs", "src"]);
  expect(entries()).toEqual(["•a.md", "+app.py", "•README.md"]);
  expect(screen.getByRole("link", { name: /app\.py/ })).toHaveAttribute("href", "#file-2");
});

test("a folder collapses and expands", async () => {
  renderRail([makeFile({ path: "docs/a.md" }), makeFile({ path: "README.md" })]);
  const docs = screen.getByRole("button", { name: "docs" });

  await userEvent.click(docs);
  expect(entries()).toEqual(["•README.md"]);
  expect(docs.closest('[role="treeitem"]')).toHaveAttribute("aria-expanded", "false");

  await userEvent.click(docs);
  expect(entries()).toEqual(["•a.md", "•README.md"]);
});

test("a file in Document view lists its sections under it", () => {
  renderRail(undefined, { "docs/a.md": "rendered" });
  expect(entries()).toEqual(["•a.md", "Title0"]);
});

test("a file in Changes view lists only its name", () => {
  renderRail(undefined, { "docs/a.md": "diff" });
  expect(entries()).toEqual(["•a.md"]);
});

test("Description and Conversation stay outside the tree", () => {
  renderRail();
  expect(screen.getByRole("link", { name: "Description" })).toHaveAttribute("href", "#description");
  expect(screen.getByRole("link", { name: /Conversation/ })).toHaveAttribute("href", "#conversation");
});

test("Collapse all folds every folder, then offers Expand all", async () => {
  renderRail([makeFile({ path: "docs/specs/a.md" }), makeFile({ path: "src/app.py" }), makeFile({ path: "README.md" })]);
  await userEvent.click(screen.getByRole("button", { name: "Collapse all" }));
  expect(entries()).toEqual(["•README.md"]);
  expect(within(tree()).getAllByRole("treeitem", { expanded: false })).toHaveLength(2);

  await userEvent.click(screen.getByRole("button", { name: "Expand all" }));
  expect(entries()).toEqual(["•a.md", "•app.py", "•README.md"]);
  expect(screen.getByRole("button", { name: "Collapse all" })).toBeInTheDocument();
});

test("no Collapse all when there are no folders", () => {
  renderRail([makeFile({ path: "README.md" })]);
  expect(screen.queryByRole("button", { name: "Collapse all" })).toBeNull();
});
