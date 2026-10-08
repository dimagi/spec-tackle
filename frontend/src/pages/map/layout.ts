import type { MapNode, Phase } from "../../api/map";

export const NODE_WIDTH = 220;
export const NODE_GAP = 28;
export const LANE_HEIGHT = 150;
export const LANE_LABEL = 96; // room for the lane's name on the left
const PHASES: Phase[] = ["data", "core", "edges", "tests", "other"];

/**
 * One horizontal lane per phase, in reading order top to bottom. In a lane, changed files
 * follow the reading path; unchanged dependents come after them.
 */
export function layoutLanes(nodes: MapNode[], readingPath: { phase: Phase; files: string[] }[]) {
  const step = new Map(readingPath.flatMap((p) => p.files).map((path, i) => [path, i]));
  const drawn = nodes.filter((n) => n.inGraph);
  const positions = new Map<string, { x: number; y: number }>();
  const lanes: { phase: Phase; y: number }[] = [];
  for (const phase of PHASES) {
    const inLane = drawn.filter((n) => n.phase === phase).sort((a, b) =>
      a.hop - b.hop || (step.get(a.id) ?? Infinity) - (step.get(b.id) ?? Infinity) || a.id.localeCompare(b.id));
    if (!inLane.length) continue;
    const y = lanes.length * LANE_HEIGHT;
    lanes.push({ phase, y });
    inLane.forEach((n, i) => positions.set(n.id, { x: LANE_LABEL + i * (NODE_WIDTH + NODE_GAP), y }));
  }
  return { positions, lanes };
}
