import type { CallEdge, CallNode, CallTree, PageFile } from "../api/types";
import { callCardSize, connected, hasPython, layoutCalls, matchCallNode, visibleTree, type CallFilters } from "./callTree";

const node = (id: string, over: Partial<CallNode> = {}): CallNode => ({
  id, path: id.split("::")[0], symbol: id.split("::")[1], start: 1, end: 5, kind: "function",
  change: "unchanged", signatureChanged: false, decorators: [], test: false, up: null, down: null, ...over,
});
const edge = (from: string, to: string, over: Partial<CallEdge> = {}): CallEdge => ({
  from, to, kind: "call", lines: [1], notUpdated: false, ...over,
});

// up2 → up1 → root → dn1 → dn2, a test calling root, and a probable call from a helper.
const TREE: CallTree = {
  headSha: "abc",
  nodes: [
    node("a.py::root", { change: "changed", signatureChanged: true, up: 0, down: 0 }),
    node("a.py::up1", { up: 1 }),
    node("a.py::up2", { up: 2 }),
    node("a.py::dn1", { down: 1 }),
    node("a.py::dn2", { down: 2 }),
    node("tests/test_a.py::test_root", { up: 1, test: true }),
    node("a.py::helper", { up: 1 }),
  ],
  edges: [
    edge("a.py::up2", "a.py::up1"),
    edge("a.py::up1", "a.py::root", { notUpdated: true }),
    edge("a.py::root", "a.py::dn1"),
    edge("a.py::dn1", "a.py::dn2"),
    edge("tests/test_a.py::test_root", "a.py::root", { notUpdated: true }),
    edge("a.py::helper", "a.py::root", { kind: "probable" }),
  ],
  other: [], truncated: null, depth: { up: 3, down: 3 },
};
const ALL: CallFilters = { up: 3, down: 3, tests: true, probable: true, breakage: false };
const ids = (r: { nodes: CallNode[] }) => r.nodes.map((n) => n.id.split("::")[1]).sort();

test("depth filters keep nodes within reach, and the roots always", () => {
  expect(ids(visibleTree(TREE, { ...ALL, up: 1, down: 1 }))).toEqual(["dn1", "helper", "root", "test_root", "up1"]);
  const none = visibleTree(TREE, { ...ALL, up: 0, down: 0 });
  expect(ids(none)).toEqual(["root"]);
  expect(none.edges).toEqual([]);
});

test("hidden tests are counted on the node they call", () => {
  const r = visibleTree(TREE, { ...ALL, tests: false });
  expect(ids(r)).not.toContain("test_root");
  expect(r.hiddenTests.get("a.py::root")).toBe(1);
  expect(r.edges.some((e) => e.from.startsWith("tests/"))).toBe(false);
});

test("probable calls can be hidden, and their callers go with them when nothing else connects them", () => {
  const r = visibleTree(TREE, { ...ALL, probable: false });
  expect(r.edges.some((e) => e.kind === "probable")).toBe(false);
  expect(ids(r)).not.toContain("helper");
});

test("only breakage keeps signature-changed roots and their callers that weren't updated", () => {
  const r = visibleTree(TREE, { ...ALL, tests: false, breakage: true });
  expect(ids(r)).toEqual(["root", "up1"]);
  expect(r.edges.map((e) => [e.from, e.to])).toEqual([["a.py::up1", "a.py::root"]]);
});

test("connected finds everything upstream and downstream, across a cycle", () => {
  const edges = [edge("a", "b"), edge("b", "c"), edge("c", "b"), edge("x", "y")];
  expect([...connected(edges, "b")].sort()).toEqual(["a", "b", "c"]);
});

test("cards grow with the symbol's length", () => {
  const short = callCardSize(node("a.py::f"));
  const long = callCardSize(node(`a.py::${"x".repeat(80)}`));
  expect(long.width).toBeGreaterThan(short.width);
  expect(short.height).toBeGreaterThan(40);
});

test("the layout returns every node and edge, callers above callees, even with a cycle", async () => {
  const nodes = [node("a.py::a"), node("a.py::b"), node("a.py::c")];
  const edges = [edge("a.py::a", "a.py::b"), edge("a.py::b", "a.py::c"), edge("a.py::c", "a.py::b")];
  const laid = await layoutCalls(nodes, edges, new Map([["a.py::b", 2]]));
  expect(laid.nodes.map((n) => n.id).sort()).toEqual(["a.py::a", "a.py::b", "a.py::c"]);
  expect(laid.edges).toHaveLength(3);
  const y = (id: string) => laid.nodes.find((n) => n.id === id)!.position.y;
  expect(y("a.py::a")).toBeLessThan(y("a.py::b"));
  expect(laid.nodes.find((n) => n.id === "a.py::b")!.data.tests).toBe(2);
});

test("matchCallNode picks the innermost node on the same path that holds the line", () => {
  const tree = { ...TREE, nodes: [
    node("m.py::Visit", { kind: "class", start: 1, end: 30 }),
    node("m.py::Visit.save", { kind: "method", start: 10, end: 20 }),
    node("n.py::other", { start: 10, end: 20 }),
  ] };
  expect(matchCallNode(tree, "m.py", 12)?.id).toBe("m.py::Visit.save");
  expect(matchCallNode(tree, "m.py", 25)?.id).toBe("m.py::Visit");
  expect(matchCallNode(tree, "m.py", 40)).toBeNull();
});

test("hasPython looks for a changed .py file that wasn't removed", () => {
  const f = (path: string, status = "modified") => ({ path, status }) as PageFile;
  expect(hasPython([f("docs/a.md"), f("app/x.py")])).toBe(true);
  expect(hasPython([f("docs/a.md"), f("app/x.py", "removed")])).toBe(false);
});
