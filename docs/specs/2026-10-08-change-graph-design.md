# Change graph

**Status:** Draft, awaiting review.
**Depends on:** [React migration](2026-10-08-react-migration-design.md), [PR Map](2026-10-08-pr-map-design.md)

## Goal

Show how the individual changes in a PR relate to each other, and to code the PR didn't
touch. A reviewer should be able to see which changes depend on which, follow a chain of
calls, and spot unchanged code that the PR is likely to break.

The PR Map's graph is file-level. This view goes one level down: one node per changed
function, class or field.

## Decisions

| Question | Decision |
|---|---|
| Placement | A **Files \| Changes** switch inside the Map tab. Files is the existing Map graph; Changes is this view. |
| Node | One per changed symbol: function, method, class, or class attribute. One "module-level" node per file for changes outside any def. |
| Colour | Green for added, blue for modified (including moved/renamed), red for removed. Unchanged callers are white with a dashed border. |
| Layout | Layout B: a box per file containing its change nodes, with edges crossing between boxes. |
| Layout engine | elkjs (layered, with nested boxes), rendered with React Flow. |
| Edges | uses, uses (probable), breaks (signature), breaks (removed), replaced by?, tests. |
| Callers | Unchanged direct callers (hop 1) appear as dashed nodes inside dashed file boxes. |
| Analysis | Extends the Map's `analysis.py` (grimp + `ast`). Same job, same cache, same `/map` endpoint. |
| Language | Python. Other files appear as a single "file changed" node in their box. |
| Test coverage | Not part of this spec. Test *edges* (a test references a change) are included because they're static. |

## User stories

**1. See how the changes connect.**
As a reviewer, I want to see each change and what it uses, so I can understand the PR as
a set of connected pieces rather than a list of files.

- Each changed function, method, class or class attribute is a node, inside a box for
  its file.
- An arrow goes from a change to each other change it calls or references.
- Each node shows its name, its +/− line counts, and a `✎sig` badge when its signature
  changed.

**2. Spot what the PR breaks outside the diff.**
As a reviewer, I want unchanged code that's likely to break to stand out, so I check it
even though it isn't in the diff.

- Unchanged code that calls a changed symbol appears as a dashed node, inside a dashed
  box for its file.
- An **amber** arrow means the caller wasn't updated, but the callee's signature changed.
- A **red** arrow means unchanged code still references a symbol the PR removed or
  renamed.
- The arrows are labelled ("signature changed, caller not updated", "still uses old name
  send_bulk").

**3. Follow one chain.**
As a reviewer, I want to focus on one change and everything connected to it, so a large
graph stays readable.

- Clicking a node highlights everything it uses (downstream) and everything that uses it
  (upstream), and fades the rest. Esc clears the focus.
- Clicking a node also opens a side panel with its diff, its "Uses" and "Used by" lists
  (each item clickable), and a link to the file in the Review tab.

**4. Read the changes in a sensible order.**
As a reviewer, I want the reading path to list individual changes, dependencies first.

- In Changes mode, the reading path lists changes rather than files, grouped in the same
  phases as the Map (Data, Core, Edges, Tests). Unchanged callers are listed under
  "Check, not in PR".
- Hovering an entry highlights its node; clicking selects it. Reviewed checkboxes work as
  in the Map.

**5. Cut the noise.**
- Filter chips: **Hide tests**, **Hide probable edges**, **Only risky**. Only risky shows
  just the breakage edges, their endpoints, and what the broken callees use.
- Clicking a file box header collapses it into a single "N changes" node. Edges then
  connect to the collapsed box.
- Above 60 change nodes, boxes start collapsed.

## Nodes

`changed_symbols()` from the Map spec gives the symbols. This view adds:

- **Class attributes:** assignments in a class body become `Class.attr` nodes, for
  example a Django model field.
- **Module-level node:** hunks outside any def or class body become one
  `module-level` node per file.
- **Moved/renamed:** a removed symbol and an added symbol are merged into one blue
  "moved" node when their bodies are near-identical (`difflib` ratio ≥ 0.8 on the
  normalised body, with the def line excluded). The node shows both the old and the new
  location. It stays in the new file's box.
- **Unchanged callers:** for each hop-1 module from the Map analysis, the functions and
  methods that reference a changed symbol become caller nodes. Only those functions are
  shown, not the whole file.

## Edges

| Type | Rule | Style |
|---|---|---|
| `uses` | A name or attribute in a changed symbol's body (head version) resolves to another changed symbol, through module imports, `from x import y`, same-module names, or `self.`/`cls.` on the enclosing class. | solid grey |
| `probable` | `obj.name(...)`, where `obj` can't be resolved, but `name` matches exactly one changed method across the PR. | faint, dotted |
| `breaks-signature` | An unchanged caller calls a symbol whose signature changed (the parameters or the decorators). | amber, labelled |
| `breaks-removed` | Unchanged code (at head) still references a symbol that was removed, or the old name of a moved symbol. | red, labelled |
| `replaced` | A removed symbol's former callers (at base) now call a newly added symbol (at head), and the pair didn't qualify as "moved". | purple, dotted, labelled "replaced by?" |
| `tests` | A test function (by the Map's test path rules) references a changed symbol. | dashed |

Edges go from the user to the thing used. Duplicate edges between two nodes collapse
into one, keeping the most severe type: breaks-removed, then breaks-signature, then
uses, then probable, then tests.

## Backend

### `analysis.py` additions

- `change_graph(base_tree, head_tree, files, module_graph, symbols) -> ChangeGraph`
  builds the nodes and edges above. It reuses the Map's grimp graph, symbol extraction
  and hop-1 modules.
- `resolve_names(module_ast, module_name, module_graph) -> dict[name, qualified]` maps
  local names to qualified symbol names, from imports and module-level definitions.
- `similar(a_src, b_src) -> float` gives the body similarity used for moves.

### Payload

A `changes` section is added to the existing `/map` response:

```json
"changes": {
  "nodes": [
    {"id": "messaging.send.send_sms", "file": "messaging/send.py", "label": "send_sms()",
     "kind": "function", "change": "modified", "signatureChanged": true,
     "additions": 11, "deletions": 4, "hunks": [[12, 30]]},
    {"id": "messaging.bulk.send_batch", "file": "messaging/bulk.py", "change": "moved",
     "from": {"file": "messaging/send.py", "name": "send_bulk"}},
    {"id": "alerts.tasks.notify_overdue", "file": "alerts/tasks.py", "change": "caller"}
  ],
  "edges": [
    {"from": "alerts.tasks.notify_overdue", "to": "messaging.send.send_sms",
     "type": "breaks-signature", "line": 41}
  ],
  "readingPath": [{"phase": "data", "nodes": ["…"]}, {"phase": "check", "nodes": ["…"]}]
}
```

Each edge's `line` is the line of the reference in the source file, so the side panel
can show the call site of an unchanged caller.

The side panel's diff is taken from the PR patch, sliced to the node's `hunks` on the
client. No extra request is needed.

## Frontend

- `ChangeGraph` uses React Flow with group nodes for the file boxes. Positions come from
  elkjs (`elk.algorithm: layered`, `elk.direction: DOWN`, hierarchy handling
  `INCLUDE_CHILDREN`). The layout is recomputed when boxes collapse or filters change,
  and animated.
- Shared Map state (selection, hover, reviewed) lives in the Zustand store from the
  migration. Switching between Files and Changes keeps the selection when the selected
  file contains the selected change.
- Edge labels are only shown for breakage and `replaced` edges.
- Keyboard: `j`/`k` move through the reading path, `x` toggles reviewed, Esc clears the
  focus.

## Edge cases

- **Base missing** (`CommitGone`): no removed nodes, moves, signature changes,
  breaks-removed or replaced edges. A note says so.
- **Name resolution fails** (star imports, dynamic attributes): no edge. Unresolved
  references are not counted as probable unless they meet the uniqueness rule.
- **Very large PRs:** boxes start collapsed above 60 change nodes. Above 400 change
  nodes, Changes mode is disabled with a note, and the Files view is still available.
- **Syntax errors:** the file is listed in `skipped` and shown as a single "file
  changed" node.

## Testing

- **`analysis.py`:** fixture repos with base and head commits and a known call
  structure. Each edge type has a positive and a negative case:
  - `uses` through each resolution path
  - `probable` only when the name is unique
  - `breaks-signature` for a parameter change and for a decorator change
  - `breaks-removed` for a removal and for a rename
  - `replaced`
  - `tests`

  Also covered: the moved/renamed merge at the 0.8 threshold, class attribute and
  module-level nodes, collapsing duplicate edges by severity, the base-missing
  degradation, and the reading order of changes.
- **Frontend (Vitest + RTL):** focus sets (upstream and downstream), filter behaviour
  (Only risky), box collapse with edge aggregation, the side panel's uses / used-by
  lists, and the hunk slicing.
- **Playwright:** a screenshot of a fixture PR in Changes mode, and click-to-focus.

## Out of scope

- The test view (coverage overlay and diff shading). It's deferred until target repos
  publish coverage from CI.
- Callers more than one hop away.
- Languages other than Python.
- Runtime or type-inferred call resolution.

## New dependencies

- Frontend: `elkjs`.
