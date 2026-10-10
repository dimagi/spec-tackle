import type { LogicBlock } from "../api/types";
import { allParentIds, cardSize, isTestBlock, isTestPath, layoutFlow, toElkGraph, withoutTests } from "./logicFlow";

const block = (id: string, over: Partial<LogicBlock> = {}): LogicBlock => ({
  id, label: id, kind: "step", change: "unchanged", next: [], ...over,
});

const MAP: LogicBlock[] = [
  block("start", { label: "Form is submitted", kind: "entry", next: [{ to: "save" }] }),
  block("save", {
    label: "Save and sync", change: "added", next: [{ to: "stop", label: "done" }],
    children: [block("store", { label: "Store it", next: [{ to: "sync" }] }), block("sync", { label: "Sync", kind: "async" })],
  }),
  block("stop", { label: "Done", kind: "exit" }),
];

test("cards are wide enough for short labels and grow taller as long ones wrap", () => {
  expect(cardSize("Done")).toEqual({ width: 190, height: 64 });
  const long = cardSize("x".repeat(120));
  expect(long.width).toBe(300);
  expect(long.height).toBeGreaterThan(64);
});

test("collapsed blocks are plain nodes; edges link siblings", () => {
  const graph = toElkGraph(MAP, new Set(), "DOWN");
  expect(graph.layoutOptions?.["elk.direction"]).toBe("DOWN");
  expect(graph.children!.map((n) => [n.id, !!n.children?.length])).toEqual([["start", false], ["save", false], ["stop", false]]);
  expect(graph.edges!.map((e) => [e.sources[0], e.targets[0]])).toEqual([["start", "save"], ["save", "stop"]]);
});

test("an expanded block becomes a compound node holding its steps and their edges", () => {
  const graph = toElkGraph(MAP, new Set(["save"]), "DOWN");
  const save = graph.children!.find((n) => n.id === "save")!;
  expect(save.children!.map((n) => n.id)).toEqual(["store", "sync"]);
  expect(save.edges!.map((e) => [e.sources[0], e.targets[0]])).toEqual([["store", "sync"]]);
  expect(save.width).toBeUndefined();
});

test("layout gives React Flow parents before children, with positions relative to the parent", async () => {
  const { nodes, edges } = await layoutFlow(MAP, new Set(["save"]), "DOWN");
  expect(nodes.map((n) => [n.id, n.type, n.parentId ?? null])).toEqual([
    ["start", "card", null], ["save", "box", null], ["store", "card", "save"], ["sync", "card", "save"], ["stop", "card", null],
  ]);
  const store = nodes.find((n) => n.id === "store")!;
  expect(store.position.x).toBeGreaterThanOrEqual(0);
  expect(store.position.y).toBeGreaterThan(0);  // below the group's title
  expect(nodes.find((n) => n.id === "save")!.style).toMatchObject({ width: expect.any(Number), height: expect.any(Number) });
  expect(edges.map((e) => [e.source, e.target, e.label ?? null])).toEqual([
    ["start", "save", null], ["save", "stop", "done"], ["store", "sync", null],
  ]);
});

test("Claude's ids are only React Flow ids, never markup", async () => {
  const { nodes } = await layoutFlow([block('a"><img src=x>', { label: "<b>hi</b>" })], new Set(), "DOWN");
  expect(nodes[0].id).toBe('a"><img src=x>');
  expect(nodes[0].data.block.label).toBe("<b>hi</b>");  // rendered as React text, never as HTML
});

test("allParentIds lists every block that has children", () => {
  const nested = [block("a", { children: [block("b", { children: [block("c")] })] }), block("d")];
  expect(allParentIds(nested)).toEqual(["a", "b"]);
});


test.each([
  "tests/test_views.py", "app/tests/helpers.py", "commcare_connect/program/test_views.py", "app/views_test.py",
  "conftest.py", "src/lib/a.test.ts", "src/Card.spec.tsx", "src/__tests__/x.js", "frontend/e2e/logic.spec.ts",
])("%s is a test file", (path) => {
  expect(isTestPath(path)).toBe(true);
});

test.each(["app/views.py", "app/testing_utils_live.py", "docs/testing.md", "src/latest.ts", "contest/rules.py"])(
  "%s is not a test file", (path) => {
    expect(isTestPath(path)).toBe(false);
  },
);

const fn = (path: string) => ({ path, symbol: "f", start: 1, end: 2 });

test("a block is a test when all its functions, or all its steps, are tests, or its label says so", () => {
  expect(isTestBlock(block("t", { functions: [fn("tests/test_a.py"), fn("app/test_b.py")] }))).toBe(true);
  expect(isTestBlock(block("m", { functions: [fn("tests/test_a.py"), fn("app/views.py")] }))).toBe(false);
  expect(isTestBlock(block("p", { children: [block("a", { functions: [fn("tests/test_a.py")] }), block("b", { label: "Tests: edge cases" })] }))).toBe(true);
  expect(isTestBlock(block("q", { children: [block("a", { functions: [fn("tests/test_a.py")] }), block("b", { functions: [fn("app/x.py")] })] }))).toBe(false);
  expect(isTestBlock(block("l", { label: "Test: admins land on the PM page" }))).toBe(true);
  expect(isTestBlock(block("n", { label: "Testing mode toggles", functions: [fn("app/flags.py")] }))).toBe(false);
  expect(isTestBlock(block("e", { label: "Render the page" }))).toBe(false);
});

test("withoutTests drops test blocks at every level, and the edges to and from them", () => {
  const tree = [
    block("t", { label: "Test: it works", next: [{ to: "a" }] }),
    block("a", { next: [{ to: "b" }, { to: "t2" }], children: [block("c", { functions: [fn("app/x.py")] }), block("ct", { functions: [fn("tests/test_x.py")] })] }),
    block("b"),
    block("t2", { functions: [fn("tests/test_b.py")] }),
  ];
  const { blocks, hidden } = withoutTests(tree);
  expect(hidden).toBe(3);
  expect(blocks.map((b) => b.id)).toEqual(["a", "b"]);
  expect(blocks[0].next).toEqual([{ to: "b" }]);
  expect(blocks[0].children!.map((b) => b.id)).toEqual(["c"]);
});

test("a block whose steps are all tests goes entirely", () => {
  const tree = [block("a"), block("p", { children: [block("x", { functions: [fn("tests/test_x.py")] })] })];
  expect(withoutTests(tree).blocks.map((b) => b.id)).toEqual(["a"]);
});

test("withoutTests keeps test blocks that are in the keep set", () => {
  const blocks: LogicBlock[] = [
    { id: "a", label: "A", kind: "entry", change: "added", next: [{ to: "t" }] },
    { id: "t", label: "Test: it works", kind: "step", change: "added", next: [] },
  ];
  expect(withoutTests(blocks).blocks.map((x) => x.id)).toEqual(["a"]);
  const kept = withoutTests(blocks, new Set(["t"]));
  expect(kept.blocks.map((x) => x.id)).toEqual(["a", "t"]);
  expect(kept.blocks[0].next).toEqual([{ to: "t" }]);
});
