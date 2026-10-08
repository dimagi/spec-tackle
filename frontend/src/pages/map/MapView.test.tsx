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
