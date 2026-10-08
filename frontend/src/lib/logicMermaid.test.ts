import type { LogicBlock } from "../api/types";
import { allParentIds, escapeLabel, toMermaid } from "./logicMermaid";

const block = (id: string, over: Partial<LogicBlock> = {}): LogicBlock => ({
  id, label: id, kind: "step", change: "unchanged", next: [], ...over,
});

const MAP: LogicBlock[] = [
  block("start", { label: "Form is submitted", kind: "entry", change: "unchanged", next: [{ to: "check" }] }),
  block("check", { label: "Valid?", kind: "decision", change: "changed", next: [{ to: "save", label: "valid" }, { to: "stop", label: "invalid" }] }),
  block("save", {
    label: "Save and sync", change: "added", next: [{ to: "stop" }],
    children: [block("store", { label: "Store it", next: [{ to: "sync" }] }), block("sync", { label: "Sync", kind: "async" })],
  }),
  block("stop", { label: "Done", kind: "exit" }),
];

const lines = (source: string) => source.split("\n").map((l) => l.trim());

test("each kind gets its shape and generated ids", () => {
  const { source, nodes } = toMermaid([
    block("a", { kind: "entry" }), block("b", { kind: "step" }), block("c", { kind: "decision" }),
    block("d", { kind: "loop" }), block("e", { kind: "async" }), block("f", { kind: "exit" }),
  ], new Set());
  expect(lines(source)).toEqual(expect.arrayContaining([
    'n0(["a"])', 'n1["b"]', 'n2{"c"}', 'n3{{"↻ d"}}', 'n4[/"⚡ e"/]', 'n5(["f"])',
  ]));
  expect([...nodes.keys()]).toEqual(["n0", "n1", "n2", "n3", "n4", "n5"]);
  expect(nodes.get("n3")!.id).toBe("d");
});

test("fill comes from change, and exits get a red border", () => {
  const { source } = toMermaid(MAP, new Set());
  const l = lines(source);
  expect(l[0]).toBe("flowchart TD");
  expect(l).toEqual(expect.arrayContaining([
    "class n0 unchanged", "class n1 changed", "class n2 added", "class n5 unchanged", "class n5 exit",
  ]));
  expect(l.some((x) => x.startsWith("classDef added "))).toBe(true);
});

test("edges between siblings, with labels", () => {
  const l = lines(toMermaid(MAP, new Set()).source);
  expect(l).toEqual(expect.arrayContaining([
    "n0 --> n1", 'n1 -->|"valid"| n2', 'n1 -->|"invalid"| n5', "n2 --> n5",
  ]));
});

test("a block with children shows ⊕ until it's expanded", () => {
  const { source, clusters } = toMermaid(MAP, new Set());
  expect(lines(source)).toContain('n2["Save and sync ⊕"]');
  expect(source).not.toContain("subgraph");
  expect(clusters.size).toBe(0);
});

test("an expanded block becomes a subgraph, and edges to it target the subgraph", () => {
  const { source, nodes, clusters } = toMermaid(MAP, new Set(["save"]));
  const l = lines(source);
  const open = l.indexOf('subgraph c2["⊖\u00a0Save\u00a0and\u00a0sync"]');
  const close = l.indexOf("end", open);
  expect(open).toBeGreaterThan(0);
  expect(l.slice(open, close)).toEqual(expect.arrayContaining(['n3["Store it"]', 'n4[/"⚡ Sync"/]']));
  expect(l).toEqual(expect.arrayContaining(['n1 -->|"valid"| c2', "c2 --> n5", "n3 --> n4", "class c2 added"]));
  expect(l).not.toContain('n2["Save and sync ⊕"]');
  expect(clusters.get("c2")!.id).toBe("save");
  expect(nodes.has("n2")).toBe(false);
  expect(nodes.get("n3")!.id).toBe("store");
});

test("labels can't break out of their quotes", () => {
  expect(escapeLabel('say "hi" <b> #1 | `x`')).toBe("say #quot;hi#quot; #lt;b#gt; #35;1 #124; #96;x#96;");
  expect(escapeLabel("a\nb")).toBe("a b");
  const { source } = toMermaid([block("x", { label: 'end"] --> evil["' })], new Set());
  expect(lines(source)).toContain('n0["end#quot;] --#gt; evil[#quot;"]');
});

test("Claude's ids never reach the chart", () => {
  const { source } = toMermaid([block("end", { label: "First", next: [{ to: "graph" }] }), block("graph", { label: "Second" })], new Set());
  expect(source).not.toMatch(/\b(end|graph)\b/);
  expect(lines(source)).toContain("n0 --> n1");
});

test("allParentIds lists every block that has children", () => {
  const nested = [block("a", { children: [block("b", { children: [block("c")] })] }), block("d")];
  expect(allParentIds(nested)).toEqual(["a", "b"]);
});

test("long subgraph titles are shortened so Mermaid doesn't clip them", () => {
  const long = "can_act_as_program_manager_user(user, org) checks every membership";
  const { source } = toMermaid([block("p", { label: long, children: [block("q")] })], new Set(["p"]));
  // Non-breaking spaces: Mermaid wraps subgraph titles onto a line the box doesn't make room for.
  expect(lines(source)).toContain('subgraph c0["⊖\u00a0can_act_as_program_manager_user(user,\u00a0org)…"]');
});
