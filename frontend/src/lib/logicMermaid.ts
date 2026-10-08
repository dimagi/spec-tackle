/** The Logic view's tree as Mermaid flowchart source. Node ids are generated, never Claude's. */

import type { LogicBlock, LogicKind } from "../api/types";

const SHAPES: Record<LogicKind, [string, string, string]> = {
  entry: ['(["', "", '"])'],
  step: ['["', "", '"]'],
  decision: ['{"', "", '"}'],
  loop: ['{{"', "↻ ", '"}}'],
  async: ['[/"', "⚡ ", '"/]'],
  exit: ['(["', "", '"])'],
};

const CLASSES = [
  "classDef added fill:#d1fae5,stroke:#059669,color:#064e3b",
  "classDef changed fill:#fef3c7,stroke:#d97706,color:#78350f",
  "classDef unchanged fill:#f5f5f4,stroke:#a8a29e,color:#292524",
  "classDef exit stroke:#e11d48,stroke-width:2px",
];

/** Text that is safe inside a quoted Mermaid label. */
export function escapeLabel(text: string): string {
  return text
    .replace(/#/g, "#35;")
    .replace(/"/g, "#quot;")
    .replace(/</g, "#lt;")
    .replace(/>/g, "#gt;")
    .replace(/\|/g, "#124;")
    .replace(/`/g, "#96;")
    .replace(/\s*\n\s*/g, " ");
}

const TITLE_MAX = 44;

/** Mermaid clips long subgraph titles, so shorten them at a word boundary. */
function title(label: string): string {
  if (label.length <= TITLE_MAX) return label;
  const cut = label.slice(0, TITLE_MAX);
  const space = cut.lastIndexOf(" ");
  return `${(space > TITLE_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export type MermaidChart = { source: string; nodes: Map<string, LogicBlock>; clusters: Map<string, LogicBlock> };

export function toMermaid(blocks: LogicBlock[], expanded: Set<string>): MermaidChart {
  const nodes = new Map<string, LogicBlock>();
  const clusters = new Map<string, LogicBlock>();
  const body: string[] = [];
  const edges: string[] = [];
  const classes: string[] = [];
  // Number every block up front so a block keeps its id whatever is expanded.
  const index = new Map<LogicBlock, number>();
  const number = (list: LogicBlock[]) => list.forEach((b) => { index.set(b, index.size); number(b.children ?? []); });
  number(blocks);

  const level = (list: LogicBlock[], indent: string) => {
    const ids = new Map<string, string>();
    for (const b of list) {
      const i = index.get(b)!;
      const open = !!b.children?.length && expanded.has(b.id);
      const id = open ? `c${i}` : `n${i}`;
      ids.set(b.id, id);
      if (open) {
        clusters.set(id, b);
        // Non-breaking spaces keep the title on one line; Mermaid wraps subgraph titles but doesn't make room.
        body.push(`${indent}subgraph ${id}["${`⊖ ${escapeLabel(title(b.label))}`.replace(/ /g, "\u00a0")}"]`, `${indent}  direction TB`);
        level(b.children!, indent + "  ");
        body.push(`${indent}end`);
      } else {
        nodes.set(id, b);
        const [before, prefix, after] = SHAPES[b.kind];
        const more = b.children?.length ? " ⊕" : "";
        body.push(`${indent}${id}${before}${prefix}${escapeLabel(b.label)}${more}${after}`);
      }
      classes.push(`class ${id} ${b.change}`);
      if (b.kind === "exit") classes.push(`class ${id} exit`);
    }
    for (const b of list) {
      for (const e of b.next) {
        const to = ids.get(e.to);
        if (!to) continue;
        edges.push(e.label ? `${ids.get(b.id)} -->|"${escapeLabel(e.label)}"| ${to}` : `${ids.get(b.id)} --> ${to}`);
      }
    }
  };

  level(blocks, "  ");
  const source = ["flowchart TD", ...CLASSES.map((c) => `  ${c}`), ...body, ...edges.map((e) => `  ${e}`), ...classes.map((c) => `  ${c}`)].join("\n");
  return { source, nodes, clusters };
}

/** Every block that has children, for Expand all. */
export function allParentIds(blocks: LogicBlock[]): string[] {
  return blocks.flatMap((b) => (b.children?.length ? [b.id, ...allParentIds(b.children)] : []));
}
