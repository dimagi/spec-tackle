import type { LogicBlock, WalkStep } from "../api/types";
import { changedKeys, containing, dangerSteps, edgeWalkClass, effectSteps, entries, pathBlocks, stepForBlock, takenEdges, walkMarks } from "./walkthrough";

const b = (id: string, over: Partial<LogicBlock> = {}): LogicBlock => ({ id, label: id, kind: "step", change: "added", next: [], ...over });
// send -> retry[ job(entry) -> backoff ] -> give-up ; retry also -> alt
const BLOCKS: LogicBlock[] = [
  b("send", { kind: "entry", next: [{ to: "retry" }] }),
  b("retry", { kind: "loop", next: [{ to: "give-up", label: "5 tries" }, { to: "alt" }], children: [
    b("job", { kind: "entry", next: [{ to: "backoff" }] }),
    b("backoff"),
  ] }),
  b("give-up", { kind: "exit" }),
  b("alt"),
];
const s = (blockId: string, over: Partial<WalkStep> = {}): WalkStep => ({ blockId, input: {}, output: {}, note: "n", ...over });
const STEPS = [s("send"), s("job"), s("backoff"), s("backoff"), s("give-up", { danger: [{ note: "d" }], effects: [{ kind: "destructive", note: "x" }, { kind: "external", note: "y" }] })];

test("entries are listed top level first", () => {
  expect(entries(BLOCKS).map((e) => e.id)).toEqual(["send", "job"]);
});

test("path blocks include ancestors; containing is only the ancestors", () => {
  expect([...pathBlocks(BLOCKS, STEPS)].sort()).toEqual(["backoff", "give-up", "job", "retry", "send"]);
  expect([...containing(BLOCKS, STEPS)]).toEqual(["retry"]);
});

test("taken edges join steps across levels, skip repeats and missing edges", () => {
  expect([...takenEdges(BLOCKS, STEPS, 4)].sort()).toEqual(["job>backoff#0", "retry>give-up#0", "send>retry#0"]);
  expect([...takenEdges(BLOCKS, STEPS, 1)]).toEqual(["send>retry#0"]);
  expect([...takenEdges(BLOCKS, [s("give-up"), s("send")], 1)]).toEqual([]); // no such edge
});

test("edge classes", () => {
  const taken = new Set(["a"]);
  const path = new Set(["a", "b"]);
  expect(edgeWalkClass("a", taken, path)).toBe("walk-taken");
  expect(edgeWalkClass("b", taken, path)).toBe("");
  expect(edgeWalkClass("c", taken, path)).toBe("walk-dim");
});

test("changed keys", () => {
  expect(changedKeys({ a: 1, b: { x: 1, y: 2 } }, { a: 1, b: { y: 2, x: 1 }, c: 3 })).toEqual(new Set(["c"]));
  expect(changedKeys({ a: 1 }, { a: 2 })).toEqual(new Set(["a"]));
  expect(changedKeys("x", "y")).toBe("all");
  expect(changedKeys([1], [1])).toBeNull();
  expect(changedKeys({ a: 1 }, [1])).toBe("all");
});

test("a block's step is its latest visit up to the furthest step reached", () => {
  expect(stepForBlock(STEPS, "backoff", 4)).toBe(3);
  expect(stepForBlock(STEPS, "backoff", 2)).toBe(2);
  expect(stepForBlock(STEPS, "give-up", 3)).toBeNull();
  expect(stepForBlock(STEPS, "alt", 4)).toBeNull();
});

test("danger steps", () => {
  expect(dangerSteps(STEPS)).toEqual([4]);
  expect(dangerSteps(STEPS.slice(0, 4))).toEqual([]);
});

test("effect steps are grouped by kind in kind order, each step once", () => {
  const steps = [
    s("send", { effects: [{ kind: "destructive", note: "a" }, { kind: "destructive", note: "b" }] }),
    s("job"),
    s("backoff", { effects: [{ kind: "external", note: "c" }, { kind: "destructive", note: "d" }] }),
  ];
  expect(effectSteps(steps)).toEqual([
    { kind: "external", steps: [2] },
    { kind: "destructive", steps: [0, 2] },
  ]);
  expect(effectSteps([s("send")])).toEqual([]);
});

test("walk marks", () => {
  const marks = walkMarks(BLOCKS, STEPS, 3);
  expect(marks.get("backoff")).toEqual({ current: true, visited: true, step: 4, dim: false, danger: false, effects: [] });
  expect(marks.get("send")).toMatchObject({ current: false, visited: true, step: 1 });
  expect(marks.get("give-up")).toEqual({ current: false, visited: false, step: null, dim: false, danger: true, effects: ["external", "destructive"] });
  expect(marks.get("alt")).toMatchObject({ dim: true, visited: false });
  expect(marks.get("retry")).toMatchObject({ dim: false, visited: false });
});
