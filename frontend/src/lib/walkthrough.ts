/** The Logic walkthrough's path through the map: what to expand, ring, dim and highlight. Pure; no React. */
import type { DangerKind, LogicBlock, WalkStep } from "../api/types";
import { edgeId } from "./logicFlow";

export const DANGER_LABEL: Record<DangerKind, string> = {
  destructive: "Destructive", external: "External effect", unsafe: "Unsafe", irreversible: "Irreversible",
};

/** Every entry block, top level first, then each deeper level. */
export function entries(blocks: LogicBlock[]): LogicBlock[] {
  const found: LogicBlock[] = [];
  for (let level = blocks; level.length; level = level.flatMap((b) => b.children ?? [])) {
    found.push(...level.filter((b) => b.kind === "entry"));
  }
  return found;
}

/** Each block's parent id (top-level blocks map to null), and each block by id. */
function index(blocks: LogicBlock[]) {
  const parent = new Map<string, string | null>();
  const byId = new Map<string, LogicBlock>();
  const walk = (list: LogicBlock[], up: string | null) => list.forEach((b) => {
    parent.set(b.id, up);
    byId.set(b.id, b);
    walk(b.children ?? [], b.id);
  });
  walk(blocks, null);
  return { parent, byId };
}

/** `id` and every block above it, innermost first. */
function chain(parent: Map<string, string | null>, id: string): string[] {
  const out: string[] = [];
  for (let at: string | null | undefined = id; at; at = parent.get(at)) out.push(at);
  return out;
}

export function pathBlocks(blocks: LogicBlock[], steps: WalkStep[]): Set<string> {
  const { parent } = index(blocks);
  return new Set(steps.flatMap((s) => (parent.has(s.blockId) ? chain(parent, s.blockId) : [])));
}

export function containing(blocks: LogicBlock[], steps: WalkStep[]): Set<string> {
  const leaves = new Set(steps.map((s) => s.blockId));
  return new Set([...pathBlocks(blocks, steps)].filter((id) => !leaves.has(id)));
}

/**
 * The edges walked between consecutive steps up to `upTo`: for steps a then b, the edge from a's
 * ancestor to b's ancestor in the lowest list holding both (an ancestor includes the block itself).
 */
export function takenEdges(blocks: LogicBlock[], steps: WalkStep[], upTo: number): Set<string> {
  const { parent, byId } = index(blocks);
  const taken = new Set<string>();
  for (let i = 1; i <= Math.min(upTo, steps.length - 1); i++) {
    const a = steps[i - 1].blockId;
    const b = steps[i].blockId;
    if (a === b || !parent.has(a) || !parent.has(b)) continue;
    const chainB = chain(parent, b);
    for (const x of chain(parent, a)) {
      const y = chainB.find((id) => parent.get(id) === parent.get(x));
      if (y === undefined) continue;
      if (y !== x) {
        const at = byId.get(x)!.next.findIndex((e) => e.to === y);
        if (at >= 0) taken.add(edgeId(x, y, at));
      }
      break;
    }
  }
  return taken;
}

export function edgeWalkClass(id: string, taken: Set<string>, path: Set<string>): string {
  if (taken.has(id)) return "walk-taken";
  return path.has(id) ? "" : "walk-dim";
}

export type Highlight = Set<string> | "all" | null;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** JSON with object keys sorted, so key order never counts as a change. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (isObject(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

/** Output keys that are new or differ from the input; "all" when either isn't an object and they differ. */
export function changedKeys(input: unknown, output: unknown): Highlight {
  if (isObject(input) && isObject(output)) {
    return new Set(Object.keys(output).filter((k) => !(k in input) || stable(input[k]) !== stable(output[k])));
  }
  return stable(input) === stable(output) ? null : "all";
}

/** The latest step on `blockId` at or before `reached`, or null if it hasn't been visited yet. */
export function stepForBlock(steps: WalkStep[], blockId: string, reached: number): number | null {
  for (let i = Math.min(reached, steps.length - 1); i >= 0; i--) if (steps[i].blockId === blockId) return i;
  return null;
}

export function dangerSteps(steps: WalkStep[]): { index: number; kinds: DangerKind[] }[] {
  return steps.flatMap((s, index) =>
    s.danger?.length ? [{ index, kinds: [...new Set(s.danger.map((d) => d.kind))] }] : []);
}

export type WalkMark = { current: boolean; visited: boolean; step: number | null; dim: boolean; danger: DangerKind[] };

/** How each block of the map is drawn while the walkthrough is at step `current`. */
export function walkMarks(blocks: LogicBlock[], steps: WalkStep[], current: number): Map<string, WalkMark> {
  const { byId } = index(blocks);
  const path = pathBlocks(blocks, steps);
  const marks = new Map<string, WalkMark>();
  for (const id of byId.keys()) {
    const step = stepForBlock(steps, id, current);
    const danger = [...new Set(steps.filter((s) => s.blockId === id).flatMap((s) => (s.danger ?? []).map((d) => d.kind)))];
    marks.set(id, {
      current: steps[current]?.blockId === id,
      visited: step !== null,
      step: step === null ? null : step + 1,
      dim: !path.has(id),
      danger,
    });
  }
  return marks;
}
