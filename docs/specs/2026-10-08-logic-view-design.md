# Logic view

**Status:** Draft, awaiting review.
**Builds on:** [Ask Claude](ask-claude.md)

## Goal

Reading a large code PR as a diff makes it hard to see what the change does as a whole.
The Logic view asks Claude to describe the PR's behaviour as a flowchart of pseudo-code
blocks. The reviewer starts from the big picture and expands any block into finer steps.
At the deepest level, the reviewer sees the real functions behind a block, with the
PR's changes marked.

Like Ask Claude, it is private. The map is generated locally, stored locally, and never
sent to GitHub.

## Decisions

| Question | Decision |
|---|---|
| Scope | One map per PR, describing the whole change end to end. It is not per file. |
| Where | A **Logic view** tab next to **Code view** in the top bar's page tabs, shown only when Ask Claude is available. |
| Shape | A tree of blocks, at most 3 levels deep and at most 12 blocks per level. Each level is a flowchart with edges between siblings. |
| Expanding | Clicking any block opens a side panel with its code: a leaf's functions, or for a block with steps inside, the functions of every step under it, each labelled with its step. Ctrl-click (⌘-click on Mac) expands or collapses a block with children in place as a group box. |
| Leaf code | Each function's full source from the checkout at the map's commit, with the PR's added or changed lines highlighted. |
| Rendering | React Flow (`@xyflow/react`), laid out top-down by ELK (`elkjs`), which handles expanded blocks as nested groups. Both load lazily with the map. Mermaid stays in the project for diagrams in markdown, but isn't used here. A Mermaid version was built first and replaced after a prototype comparison (clipped group titles, no pan or zoom, and click handling patched onto generated SVG). |
| How Claude is called | The same as Ask Claude: Agent SDK, read-only Read/Grep/Glob on the checkout, the same file guard, and no MCP servers. |
| Output format | JSON in a fenced block, validated on the server. One repair turn is allowed on invalid output. |
| When it's generated | On demand, from a **Generate** button. |
| Caching | Stored in SQLite per login, PR and head SHA, and reused until the PR has new commits. A stale map stays visible, with an offer to regenerate. |
| Long runs | Run in the background through `TurnRunner`, keyed per PR and head SHA. A reload or a second tab rejoins the run. |

## Data model

```
LogicMap {
  id: str                    # stored map id
  headSha: str               # the commit it describes
  summary: str               # one or two sentences about what the PR does
  root: Block[]              # the top level
  createdAt: str
}

Block {
  id: str                    # unique within the map, e.g. "b3"
  label: str                 # short pseudo-code, 1-80 characters
  kind: "entry" | "step" | "decision" | "loop" | "async" | "exit"
  change: "added" | "changed" | "unchanged"
  next: [{ to: str, label?: str }]   # edges to siblings (blocks in the same list)
  children?: Block[]         # finer steps; non-empty when present
  functions?: FunctionRef[]  # only on leaves (blocks without children)
}

FunctionRef {
  path: str                  # repo-relative file path
  symbol: str                # e.g. "VisitService.save"
  start: int                 # 1-based first line
  end: int                   # 1-based last line, >= start
}
```

### Validation

The server rejects a map, and lists every problem it finds, when:

- the answer has no fenced JSON block, or the JSON doesn't parse;
- a required field is missing, or a value has the wrong type or isn't one of the allowed values;
- `label` is empty or longer than 80 characters;
- block ids aren't unique across the whole map;
- an edge's `to` isn't the id of a sibling, or a block has an edge to itself;
- the tree is more than 3 levels deep, or a level has more than 12 blocks or none;
- `children` is present but empty, or a block has both `children` and `functions`;
- a `FunctionRef` path is absolute, leaves the checkout (including through `..` or a symlink), names a file that doesn't exist, or has a line range outside the file.

Leaves without `functions` are allowed. They describe logic that has no single function
behind it, such as a configuration change.

## Generation

1. **Generate** sends `POST /api/pr/{owner}/{repo}/{number}/logic`.
   - The server reads the PR's current head SHA.
   - If a run for that PR and SHA is already going, it returns that run.
   - Otherwise it starts one through `TurnRunner`, keyed internally as `logic:{owner}/{repo}#{number}@{sha}`.
2. The run gets the head commit's worktree from `Checkouts` and builds the PR snapshot with `build_context`, exactly as Ask Claude does.
3. Claude gets the snapshot plus a Logic-specific instruction:
   - describe the end-to-end behaviour the PR adds or changes, as the tree above;
   - read the code to find the real functions;
   - mark each block's `change`;
   - answer with a single fenced `json` block.

   The system prompt adds the schema and the limits. Tools are Read, Grep and Glob, with the same guard as Ask Claude.
4. Progress events (`tool`, for example "Reading app/visits.py") stream to subscribers over `GET /api/pr/{owner}/{repo}/{number}/logic/events` (SSE), in the same event format Ask Claude uses. That endpoint joins the run for the PR's current head; if no run is going, it ends at once.
5. When Claude finishes, the server validates the answer.
   - If it's invalid, the server resumes the same session **once** with the list of problems and asks for a corrected answer.
   - If that is also invalid, the run ends with an `error` event ("Claude's map didn't pass validation: …") and nothing is stored.
6. A valid map is stored in a new `logic_maps` table, and the run ends with a `done` event that carries the map id.

`GET /api/pr/{owner}/{repo}/{number}/logic` returns:

- the newest stored map for this login and PR, plus `stale: true` when its `headSha` is not the PR's current head;
- `running: true` while a run for the current head is in progress;
- `available: false` when Ask Claude isn't available (no CLI, no SDK, or no store).

### Source for the function panel

`GET /api/logic/{map_id}/blocks/{block_id}/functions` returns the functions behind a block: a leaf's own, or, for a block with steps inside, every step's at any depth (each function once, tagged with its step's label). Only the map's owner can read it.

The response, for each `FunctionRef`:

```
{ path, symbol, start, end, step,
  lines: [{ n: int, text: str, changed: bool }],   # start..end from the map's worktree
  inDiff: bool,                                     # the file is part of the PR's diff
  missing?: "File not found in the checkout" }
```

`changed` is true for lines that the PR's diff for that file adds or modifies at the
right-hand side. The server reads the file inside the worktree with the same `inside()`
check the guard uses.

## The Logic view

### Tab

- The **Logic** tab is shown only when the page's `claude` flag is true.
- The chosen tab is kept in `?view=logic`.
- The Review page stays mounted while Logic is showing, but hidden, so its scroll position, composer and drafts survive.

### States

| State | Shows |
|---|---|
| No map for this PR | A short description, the **Generate logic map** button, and "Private: runs on your machine with your Claude Code. Takes a minute or two." |
| Generating | A progress card with Claude's latest activity. Leaving and returning to the tab, or reloading, rejoins the run. |
| Ready | The summary, a legend, **Expand all** and **Collapse all**, and the flowchart. |
| Stale | The map, plus a banner: "Generated for `abc1234`; the PR is now at `def5678`." with a **Regenerate** button. |
| Failed | The error and **Try again**. A stale map, if there is one, stays visible below. |

### Flowchart

- `layoutFlow(tree, expanded)` (in `lib/logicFlow.ts`) builds an ELK graph from the tree, where an expanded block is a compound node holding its steps. It lays the graph out and returns React Flow nodes (parents before children, positions relative to the parent) and edges.
- Each block is a card. The card shows:
  - its kind (▶ entry, ▸ step, ◇ decision, ↻ loop, ⚡ async, ■ exit);
  - its label;
  - a "⊕ N steps" badge when it has steps inside;
  - how many functions sit behind it.
- Card fill comes from `change`: green for added, amber for changed, neutral for unchanged. An exit has a red outline. A legend explains the colours, icons and the red outline.
- Card heights follow the number of lines the label wraps to, so nothing overflows.
- An expanded block is a dashed group box titled "⊖ label", with its steps and their edges inside. Its title wraps onto a second line when long.
- Edges come from `next` and keep their labels. Edges to an expanded block go to its group box.
- Labels are plain React text, never HTML. Claude's block ids are used only as React Flow node ids.
- Every card and group box is focusable (`role=button`, `tabindex=0`), with an `aria-label` that names the kind and the label and says whether the block expands. The same text is the hover tooltip.
- Clicking a block opens the function panel; Enter does the same. Ctrl-click or ⌘-click (Ctrl/⌘+Enter on the keyboard) expands or collapses a block with children. The legend says so.
- After a relayout, focus returns to the block last activated.
- The chart pans and zooms, and has zoom controls. It fits itself to view after each layout and whenever its box changes width, for example when the function panel opens.
- Cards don't start a pan when pressed (React Flow's `nopan` class); drag the background to pan.
- The expanded set is saved per PR with `savePref(pr, "logicExpanded", ids)`.
- If ELK can't lay the map out, the view shows it as a nested list instead, with the same open and expand actions and a separate ⊕/⊖ button per block.
- Theme: React Flow's colour mode follows the app's dark mode.

### Function panel

- A panel on the right, about 40% of the width, opens beside the chart, which stays visible.
- The heading is the leaf's label. Below it is one section per function:
  - the symbol;
  - `path:start–end`;
  - "unchanged by this PR" when the file isn't in the diff, or no lines in the range changed;
  - the source with line numbers, with changed lines highlighted;
  - **Show in Code view**.
- **Show in Code view** switches to the Code view tab and scrolls to that file and line, and switches the file to its Changes view when the line is in the diff. It uses the same scrolling as the outline in the left rail.
- Esc or × closes the panel.
- A function whose file is missing shows the `missing` message in place of its source.

## Storage

```sql
CREATE TABLE logic_maps (
  id TEXT PRIMARY KEY,
  login TEXT NOT NULL,
  owner TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  summary TEXT NOT NULL,
  tree TEXT NOT NULL,            -- JSON of root: Block[]
  created_at TEXT NOT NULL,
  UNIQUE (login, owner, repo, number, head_sha)
);
```

Regenerating for the same SHA replaces the row. Maps for older SHAs are kept, but only the
newest is shown.

## Privacy and safety

These are the same guarantees Ask Claude gives:

- nothing is sent to GitHub;
- Claude gets read-only file tools confined to the checkout, and no MCP servers;
- prompts are passed verbatim;
- the GitHub token reaches git only through `GIT_CONFIG_*`.

The source endpoint never reads outside the worktree, and only the map's owner can use it.

## Out of scope

- More than 3 levels, and edges between levels.
- Per-file maps, and editing or annotating a map.
- Sharing maps, or posting them to the PR.
- Linking Ask Claude threads to blocks.

## Testing

**pytest** (uses the existing fake ask, so no real Claude runs):

- Validation accepts a good map and rejects every case listed under Validation, with a readable list of problems.
- Generation:
  - a good answer is stored, and the events end with `done`;
  - an invalid first answer causes exactly one repair turn, which receives the problem list, then succeeds;
  - a second invalid answer ends with `error` and stores nothing;
  - a second Generate during a run returns the same run.
- `GET …/logic`:
  - returns no map, a fresh map, or a stale map;
  - reports `running` during a run;
  - another login sees nothing.
- The functions endpoint:
  - returns the lines, with `changed` worked out from the diff hunks;
  - handles a missing file;
  - rejects a bad index and another login's map.
- Without the `claude` extra, `available` is false and the SDK is never imported.

**vitest:**

- `logicFlow`:
  - card sizes grow with wrapped labels;
  - collapsed blocks are plain nodes, and expanded ones are compound nodes holding their steps and edges;
  - the layout returns parents before children, with relative positions;
  - edges keep their labels;
  - ids and labels pass through as data, never as markup.
- `LogicView`:
  - each state in the States table;
  - expand and collapse, with persistence;
  - Expand all and Collapse all;
  - a leaf opens the panel, with changed lines highlighted;
  - Show in Code view switches tabs;
  - Esc closes the panel;
  - a layout failure shows the list fallback;
  - the legend explains the red outline.
- The `?view=logic` tab survives a reload, and switching tabs keeps unsent composer text.

**Playwright** (the fake ask returns a canned map):

- generate, and see the chart;
- expand a block, and see its children;
- click a leaf, and see the source with a highlighted line;
- Show in Code view, and land on that line.

**Manual:** one run on a real PR on the reviewer's own server, to judge whether the map
is useful.
