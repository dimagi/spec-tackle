import { fireEvent, render, screen, within } from "@testing-library/react";
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

describe("resizing", () => {
  afterEach(() => localStorage.clear());
  const handle = () => screen.getByRole("separator", { name: "Resize sidebar" });
  const railWidth = () => handle().parentElement!.style.width;
  // jsdom has no PointerEvent; a MouseEvent with a pointer event's name carries the coordinates.
  const pointer = (target: EventTarget, type: string, clientX = 0) =>
    fireEvent(target as Element, new MouseEvent(type, { bubbles: true, button: 0, clientX }));

  test("dragging the edge widens the sidebar, within limits, and the width is kept", () => {
    const { unmount } = renderRail();
    expect(railWidth()).toBe("256px");

    pointer(handle(), "pointerdown", 256);
    pointer(document, "pointermove", 400);
    expect(railWidth()).toBe("400px");
    pointer(document, "pointermove", 2000);
    expect(railWidth()).toBe("640px");
    pointer(document, "pointerup");
    pointer(document, "pointermove", 300);
    expect(railWidth()).toBe("640px");

    unmount();
    renderRail();
    expect(railWidth()).toBe("640px");
  });

  test("arrow keys resize; double-click resets", async () => {
    renderRail();
    handle().focus();
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    expect(railWidth()).toBe("288px");
    expect(handle()).toHaveAttribute("aria-valuenow", "288");
    await userEvent.keyboard("{Home}");
    expect(railWidth()).toBe("200px");

    await userEvent.dblClick(handle());
    expect(railWidth()).toBe("256px");
  });

  test("long section titles show in full on hover", () => {
    const text = "A very long section heading that does not fit in the sidebar";
    renderRail([makeFile({ outline: [{ level: 1, line: 1, id: "long", text }] })], { "docs/a.md": "rendered" });
    expect(screen.getByText(text)).toHaveAttribute("title", text);
  });
});
