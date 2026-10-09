import type { LogicBlock } from "../api/types";
import { allParentIds, cardSize, layoutFlow, toElkGraph } from "./logicFlow";

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
