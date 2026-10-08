import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MapNode } from "../../api/map";
import { ReadingPath, type ReadingPathProps } from "./ReadingPath";

const node = (over: Partial<MapNode>): MapNode => ({ id: "x.py", hop: 0, phase: "core", inGraph: true, additions: 10, deletions: 0, status: "modified", tag: null, symbols: [], ...over });
const nodes = [
  node({ id: "shop/models.py", phase: "data", tag: "contract" }),
  node({ id: "shop/sync.py", additions: 40 }),
  node({ id: "shop/tasks.py", hop: 1, phase: "edges", references: ["send"] }),
];

function renderPath(over: Partial<ReadingPathProps> = {}) {
  const props: ReadingPathProps = {
    phases: [{ phase: "data", files: ["shop/models.py"] }, { phase: "core", files: ["shop/sync.py"] }],
    nodes, reviewed: (p) => p === "shop/models.py", narration: { "shop/sync.py": "Adds retries." },
    selected: null, hover: null, onHover: vi.fn(), onSelect: vi.fn(), onOpen: vi.fn(), onToggleReviewed: vi.fn(), ...over,
  };
  return { props, ...render(<ReadingPath {...props} />) };
}

test("phases list files in order, with tags and notes", () => {
  renderPath();
  const rows = screen.getAllByTestId("path-row").map((r) => r.getAttribute("data-path"));
  expect(rows).toEqual(["shop/models.py", "shop/sync.py", "shop/tasks.py"]);
  expect(screen.getByText("contract")).toBeInTheDocument();
  expect(screen.getByText("Adds retries.")).toBeInTheDocument();
});

test("unchanged dependents are listed to check but don't count towards progress", () => {
  renderPath();
  expect(screen.getByText("Reviewed 1 of 2 files")).toBeInTheDocument();
  expect(screen.getByText(/not in PR · check/)).toBeInTheDocument();
});

test("opening a file", async () => {
  const { props } = renderPath();
  await userEvent.click(screen.getByText("sync.py"));
  expect(props.onOpen).toHaveBeenCalledWith("shop/sync.py");
});

test("ticking a file reviewed", async () => {
  const { props } = renderPath();
  await userEvent.click(screen.getAllByRole("checkbox")[1]);
  expect(props.onToggleReviewed).toHaveBeenCalledWith("shop/sync.py");
});
