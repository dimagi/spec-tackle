import type { MapNode } from "../../api/map";
import { LANE_HEIGHT, layoutLanes, NODE_GAP, NODE_WIDTH } from "./layout";

const n = (id: string, phase: MapNode["phase"], hop: 0 | 1 = 0): MapNode => ({ id, phase, hop, inGraph: true });

test("lanes follow phase order, and empty phases leave no gap", () => {
  const nodes = [n("t.py", "tests"), n("m.py", "data"), n("s.py", "core")];
  const path = [{ phase: "data" as const, files: ["m.py"] }, { phase: "core" as const, files: ["s.py"] }, { phase: "tests" as const, files: ["t.py"] }];

  const { positions, lanes } = layoutLanes(nodes, path);

  expect(lanes.map((l) => l.phase)).toEqual(["data", "core", "tests"]);
  expect(positions.get("m.py")!.y).toBe(lanes[0].y);
  expect(positions.get("s.py")!.y).toBe(lanes[0].y + LANE_HEIGHT);
  expect(positions.get("t.py")!.y).toBe(lanes[0].y + 2 * LANE_HEIGHT);
});

test("within a lane, changed files follow the reading order and dependents come after", () => {
  const nodes = [n("b.py", "core"), n("dep.py", "core", 1), n("a.py", "core")];
  const path = [{ phase: "core" as const, files: ["a.py", "b.py"] }];

  const { positions } = layoutLanes(nodes, path);

  expect(positions.get("a.py")!.x).toBeLessThan(positions.get("b.py")!.x);
  expect(positions.get("b.py")!.x).toBeLessThan(positions.get("dep.py")!.x);
  expect(positions.get("b.py")!.x - positions.get("a.py")!.x).toBe(NODE_WIDTH + NODE_GAP);
});

test("nodes left out of the graph aren't placed", () => {
  const { positions } = layoutLanes([{ ...n("x.py", "core"), inGraph: false }], [{ phase: "core", files: ["x.py"] }]);
  expect(positions.has("x.py")).toBe(false);
});
