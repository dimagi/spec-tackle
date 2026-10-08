import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeFile, makePage } from "../../test/fixtures";
import { MapView } from "./MapView";

afterEach(() => vi.unstubAllGlobals());

function renderMap(reply: unknown, onOpenFile = vi.fn()) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(reply))));
  const page = makePage({ files: [makeFile({ path: "shop/sync.py" }), makeFile({ path: "README.md" })] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MapView page={page} pr={{ owner: "o", repo: "r", number: 7 }} head="abc1234" onOpenFile={onOpenFile} />
    </QueryClientProvider>,
  );
  return { onOpenFile };
}

const ready = {
  status: "ready", headSha: "abc1234", edges: [], skipped: [],
  limits: { importGraph: false, graphTruncated: false, baseMissing: false },
  nodes: [
    { id: "shop/sync.py", hop: 0, phase: "core", inGraph: true, additions: 3, deletions: 1, status: "modified", tag: null, symbols: [] },
    { id: "README.md", hop: 0, phase: "other", inGraph: true, additions: 1, deletions: 0, status: "modified", tag: "small", symbols: [] },
  ],
  readingPath: [{ phase: "core", files: ["shop/sync.py"] }, { phase: "other", files: ["README.md"] }],
};

test("while analysing, the PR's files are listed in plain order", async () => {
  renderMap({ status: "pending", headSha: "abc1234" });
  expect(await screen.findByText(/Analysing the code/)).toBeInTheDocument();
  expect(screen.getByText("shop/sync.py")).toBeInTheDocument();
  expect(screen.getByText("README.md")).toBeInTheDocument();
});

test("a map without an import graph says so", async () => {
  renderMap(ready);
  expect(await screen.findByText(/without import connections/)).toBeInTheDocument();
  expect(screen.getAllByTestId("path-row")).toHaveLength(2);
});

test("an error offers a retry", async () => {
  renderMap({ status: "error", headSha: "abc1234", message: "Couldn't fetch the repository" });
  expect(await screen.findByText("Couldn't fetch the repository")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
});

test("j, k and x move through the path and tick files", async () => {
  localStorage.clear();
  renderMap(ready);
  await screen.findAllByTestId("path-row");
  await userEvent.keyboard("j");
  expect(screen.getAllByTestId("path-row")[0]).toHaveClass("sel");
  await userEvent.keyboard("j");
  expect(screen.getAllByTestId("path-row")[1]).toHaveClass("sel");
  await userEvent.keyboard("x");
  expect(screen.getAllByRole("checkbox")[1]).toBeChecked();
  await userEvent.keyboard("k");
  expect(screen.getAllByTestId("path-row")[0]).toHaveClass("sel");
});

test("Enter opens the selected file", async () => {
  const { onOpenFile } = renderMap(ready);
  await screen.findAllByTestId("path-row");
  await userEvent.keyboard("j{Enter}");
  expect(onOpenFile).toHaveBeenCalledWith("shop/sync.py");
});


const withDependent = {
  ...ready,
  nodes: [...ready.nodes, { id: "shop/tasks.py", hop: 1, phase: "core", inGraph: true, references: ["send"] }],
};

test("j follows the rows as shown: a phase's dependents come before the next phase", async () => {
  renderMap(withDependent);
  await screen.findAllByTestId("path-row");
  const order: string[] = [];
  for (let i = 0; i < 3; i++) {
    await userEvent.keyboard("j");
    order.push(document.querySelector(".map-row.sel")!.getAttribute("data-path")!);
  }
  expect(order).toEqual(["shop/sync.py", "shop/tasks.py", "README.md"]);
});

test("x does nothing on a file that isn't in the PR", async () => {
  localStorage.clear();
  renderMap(withDependent);
  await screen.findAllByTestId("path-row");
  await userEvent.keyboard("jjx");
  expect(screen.getByText("Reviewed 0 of 2 files")).toBeInTheDocument();
});

test("Enter on a focused button presses the button, not the selected file", async () => {
  const { onOpenFile } = renderMap({ status: "error", headSha: "abc1234", message: "Nope" });
  const retry = await screen.findByRole("button", { name: "Retry" });
  retry.focus();
  await userEvent.keyboard("{Enter}");
  expect(onOpenFile).not.toHaveBeenCalled();
});

test("a file that isn't in the PR links to GitHub", async () => {
  renderMap(withDependent);
  const link = await screen.findByRole("link", { name: /tasks\.py/ });
  expect(link).toHaveAttribute("href", "https://github.com/o/r/blob/abc1234/shop/tasks.py");
  expect(link).toHaveAttribute("target", "_blank");
});

test("Enter still opens the file when focus is on a control outside the Map (e.g. the Map tab)", async () => {
  const { onOpenFile } = renderMap(ready);
  await screen.findAllByTestId("path-row");
  const tab = document.body.appendChild(document.createElement("button"));
  tab.textContent = "Map";
  tab.focus();
  await userEvent.keyboard("j{Enter}");
  expect(onOpenFile).toHaveBeenCalledWith("shop/sync.py");
  tab.remove();
});

const withChanges = (n: number) => ({
  ...ready,
  changes: {
    nodes: Array.from({ length: n }, (_, i) => ({
      id: `shop/sync.py::f${i}`, file: "shop/sync.py", label: `f${i}()`, kind: "function", change: "modified",
      signatureChanged: false, additions: 1, deletions: 0, lines: [i + 1, i + 1], baseLines: [i + 1, i + 1],
    })),
    edges: [],
    readingPath: [{ phase: "core", ids: Array.from({ length: n }, (_, i) => `shop/sync.py::f${i}`) }],
  },
});

test("the Changes mode lists individual changes", async () => {
  renderMap(withChanges(2));
  await userEvent.click(await screen.findByRole("button", { name: "Changes" }));
  expect(await screen.findByText("f0()")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Only risky" })).toBeInTheDocument();
});

test("very large PRs can't switch to Changes", async () => {
  renderMap(withChanges(401));
  const changesButton = await screen.findByRole("button", { name: "Changes" });
  expect(changesButton).toBeDisabled();
  expect(changesButton).toHaveAttribute("title", expect.stringMatching(/too many changes/));
});
