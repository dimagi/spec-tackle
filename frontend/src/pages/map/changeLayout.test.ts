import type { ChangeEdge, ChangeNode, Changes } from "../../api/map";
import { collapse, layoutChanges, visibleChanges } from "./changeLayout";

const node = (id: string, over: Partial<ChangeNode> = {}): ChangeNode => ({
  id, file: id.split("::")[0], label: id.split("::")[1] + "()", kind: "function", change: "modified",
  signatureChanged: false, additions: 1, deletions: 0, lines: [1, 2], baseLines: [1, 2], ...over,
});
const edge = (from: string, to: string, type: ChangeEdge["type"]): ChangeEdge => ({ from, to, type, line: 1 });

const changes: Changes = {
  nodes: [
    node("a.py::send", { signatureChanged: true }), node("a.py::helper"), node("b.py::with_retry", { change: "added" }),
    node("c.py::run", { change: "caller", kind: "caller" }), node("tests/t.py::test_send"), node("d.py::other"),
  ],
  edges: [
    edge("a.py::send", "b.py::with_retry", "uses"),
    edge("a.py::helper", "a.py::send", "uses"),
    edge("c.py::run", "a.py::send", "breaks-signature"),
    edge("tests/t.py::test_send", "a.py::send", "tests"),
    edge("d.py::other", "a.py::helper", "probable"),
  ],
  readingPath: [],
};
const phaseOf = (file: string) => (file.startsWith("tests/") ? "tests" : "core");

test("hide tests drops test files and test edges", () => {
  const v = visibleChanges(changes, { hideTests: true, hideProbable: false, onlyRisky: false }, phaseOf);
  expect(v.nodes.map((n) => n.id)).not.toContain("tests/t.py::test_send");
  expect(v.edges.some((e) => e.type === "tests")).toBe(false);
});

test("hide probable drops guessed edges only", () => {
  const v = visibleChanges(changes, { hideTests: false, hideProbable: true, onlyRisky: false }, phaseOf);
  expect(v.edges.some((e) => e.type === "probable")).toBe(false);
  expect(v.nodes).toHaveLength(6);
});

test("only risky keeps breakage, its ends, and what the broken change uses", () => {
  const v = visibleChanges(changes, { hideTests: false, hideProbable: false, onlyRisky: true }, phaseOf);
  expect(v.nodes.map((n) => n.id).sort()).toEqual(["a.py::send", "b.py::with_retry", "c.py::run"]);
  expect(v.edges.map((e) => e.type).sort()).toEqual(["breaks-signature", "uses"]);
});

test("collapsed boxes merge edges", () => {
  const merged = collapse(changes.edges, new Set(["a.py"]));
  const keys = merged.map((e) => `${e.from}>${e.to}:${e.type}`).sort();
  expect(keys).toEqual([
    "box:a.py>b.py::with_retry:uses",
    "c.py::run>box:a.py:breaks-signature",
    "d.py::other>box:a.py:probable",
    "tests/t.py::test_send>box:a.py:tests",
  ]); // helper → send is inside the box and disappears
});

test("collapsing keeps the most severe of merged edges", () => {
  const merged = collapse([edge("x.py::a", "a.py::send", "uses"), edge("x.py::a", "a.py::helper", "breaks-removed")], new Set(["a.py"]));
  expect(merged).toEqual([expect.objectContaining({ from: "x.py::a", to: "box:a.py", type: "breaks-removed" })]);
});

test("layout puts each change inside its file's box", async () => {
  const v = visibleChanges(changes, { hideTests: false, hideProbable: false, onlyRisky: false }, phaseOf);
  const { boxes, nodes } = await layoutChanges(v.nodes, v.edges, new Set());

  const a = boxes.find((b) => b.file === "a.py")!;
  expect(a.w).toBeGreaterThan(0);
  const send = nodes.find((n) => n.id === "a.py::send")!;
  expect(send.parent).toBe("box:a.py");
  expect(send.x).toBeGreaterThanOrEqual(0);
  expect(send.y).toBeGreaterThan(0); // below the box's header
});

test("a collapsed box has no children laid out", async () => {
  const { boxes, nodes } = await layoutChanges(changes.nodes, changes.edges, new Set(["a.py"]));
  expect(nodes.some((n) => n.parent === "box:a.py")).toBe(false);
  expect(boxes.find((b) => b.file === "a.py")!.collapsed).toBe(true);
});
