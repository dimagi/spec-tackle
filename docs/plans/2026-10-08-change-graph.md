# Change Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a **Changes** mode to the Map tab. It shows one node per changed symbol
inside a box per file (layout B), with uses / probable / breakage / replaced / tests
edges, unchanged callers, focus mode, filters, and a change-level reading path.

**Architecture:**
- **Analysis:** `analysis/changes.py` extends the Map analysis (same worker, same cache,
  same `/map` payload under `changes`). It resolves names in each changed symbol's body
  with `ast`, using the grimp graph for module lookups and the patch-rebuilt base for
  removed/renamed symbols.
- **Frontend:** `pages/map/ChangeGraph.tsx` renders React Flow group nodes (file boxes)
  with child nodes (changes), positioned by elkjs (layered, `INCLUDE_CHILDREN`). A
  Files | Changes switch sits in the Map toolbar.

**Tech Stack:** Python ast + grimp (already present); React Flow, elkjs, Vitest, Playwright.

**Spec:** `docs/specs/2026-10-08-change-graph-design.md`

## Global Constraints

- Colours: added green, modified blue (moved too), removed red. Unchanged callers are
  white with a dashed border.
- A move is merged when `difflib.SequenceMatcher` on the normalised bodies (def line
  dropped, whitespace collapsed) has a ratio ≥ 0.8.
- A probable edge needs exactly one changed method with that name across the PR.
- Duplicate edges between two nodes collapse to the most severe type: breaks-removed >
  breaks-signature > uses > probable > tests.
- Boxes start collapsed above 60 change nodes. Changes mode is disabled above 400.
- Edge labels appear only on breakage and `replaced` edges.
- Keys in Changes mode: `j`/`k` along the change reading path, `x` reviewed, Esc clears
  the focus.

## Review Focus

1. **A changed method that two classes share by name** (`save`). `obj.save()` must not
   produce a probable edge. → Task 2 test `test_probable_needs_a_unique_name`.
2. **A removed function still imported by an unchanged module.** This must produce a red
   breaks-removed edge from that module's caller. → Task 2 test
   `test_import_of_removed_symbol_breaks`.
3. **A renamed function** (body unchanged, name changed). It's one moved node, and old
   callers become breaks-removed. → Task 1 test `test_rename_is_one_moved_node`.
4. **Collapsing a box.** Edges re-attach to the box and duplicates merge. → Task 4 test
   `collapsed boxes merge edges`.
5. **Focus mode with a cycle** (a ↔ b). Up/down traversal must terminate. → Task 4 test
   `focus terminates on cycles`.

---

### Task 1: Change nodes (attributes, module-level, moves)

**Files:** create `analysis/changes.py` (nodes part); test `tests/test_analysis_changes.py`.

**Interfaces:**
- `change_nodes(files: list[{path, module, status, head_src, base_src, symbols}]) -> list[ChangeNode]`
- `ChangeNode = {"id": "module:qualname" or "path:<module>", "file": path, "label": str, "kind", "change": "added"|"modified"|"removed"|"moved", "signatureChanged": bool, "additions": int, "deletions": int, "hunks": [[start, end]], "from"?: {"file", "name"}}`
- Move detection runs across all files: an added symbol and a removed symbol whose
  normalised bodies have a ratio ≥ 0.8 become one `moved` node in the new file.

- [ ] Write failing tests:
  - nodes for functions, methods, `Class.attr` and `<module>`
  - +/− counts per node come from the patch lines in its span
  - `test_rename_is_one_moved_node`
  - a moved node across files keeps `from`
  - a body that's only 50% similar stays as removed + added
- [ ] Implement them.
- [ ] Run `uv run pytest tests/test_analysis_changes.py -q`. It should pass.
- [ ] Commit: `feat(analysis): change nodes with move detection`

### Task 2: Change edges and callers

**Files:** extend `analysis/changes.py`, wire into `analysis/build.py` (`result["changes"]`);
tests.

**Interfaces:**
- `change_edges(nodes, sources, graph, import_root, worktree) -> (edges, callers)`
- `edges: [{"from", "to", "type", "line"}]`
- `callers: [{"id", "file", "label", "change": "caller"}]` are unchanged functions in
  hop-1 modules that reference a changed symbol.
- Name resolution, per changed symbol body at head:
  - imported names (absolute and relative)
  - `module.attr` through import aliases
  - same-module names
  - `self.`/`cls.` methods of the enclosing class
- Probable edges: `x.name()` with an unresolved receiver, when exactly one changed
  method in the PR is called `name`.
- Breakage:
  - breaks-signature: an unchanged caller references a symbol whose signature changed
  - breaks-removed: the head source still references a removed symbol, or the old name
    of a moved one
- Replaced: a removed symbol's base callers now (at head) call an added symbol, and the
  pair isn't a move.
- Tests: test functions (by the Map's phase rules) that reference a change.
- Duplicate edges are collapsed by severity.
- `changes.readingPath` holds the change ids in dependency order, grouped by phase plus a
  "check" group for callers.

- [ ] Write failing tests on fixture repos:
  - one positive and one negative case for each edge type
  - `test_probable_needs_a_unique_name`
  - `test_import_of_removed_symbol_breaks`
  - severity collapsing
  - `self.method` resolution
  - the reading order of changes
  - `build_map` includes `changes`
- [ ] Implement them.
- [ ] Run the tests. They should pass.
- [ ] Commit: `feat(analysis): change edges, callers and breakage`

### Task 3: Frontend data and layout

**Files:** create `pages/map/changeLayout.ts` (elk graph build + result mapping); add
`elkjs`; extend `api/map.ts` types; tests.

**Interfaces:**
- `toElk(changes, collapsed: Set<string>, filters) -> ElkNode` builds one parent node
  per file box with children, and edges re-targeted to the box when it's collapsed.
- `fromElk(result) -> {boxes: {id, x, y, w, h}[], nodes: {id, x, y}[]}`
- `visibleChanges(changes, filters: {hideTests, hideProbable, onlyRisky})`

- [ ] Write failing tests:
  - collapsing re-targets edges and merges duplicates
  - Only risky keeps breakage edges, their endpoints and what the broken callees use
  - Hide tests removes test boxes and test edges
  - the `fromElk` mapping (elk run in Vitest; it's pure JS)
- [ ] Implement them.
- [ ] Run the tests. They should pass.
- [ ] Commit: `feat(frontend): change graph layout`

### Task 4: Change graph view

**Files:** create `pages/map/ChangeGraph.tsx`, `pages/map/ChangeDetail.tsx`,
`pages/map/focus.ts`; modify `MapView.tsx` (Files | Changes switch, filter chips, change
reading path); tests.

**Interfaces:**
- `focusSet(edges, id) -> Set<string>` is the upstream ∪ downstream closure, not
  following `replaced` edges.
- `ChangeGraph`:
  - React Flow with group nodes for boxes and change nodes inside
  - colours per change type; `✎sig` and `⇄moved` badges
  - edge styles per type, with labels on breakage and `replaced` edges
  - clicking a node sets focus (others fade); clicking a box header collapses it
- `ChangeDetail` is the side panel:
  - the node's diff, sliced from `page.files[path].diff` rows inside its hunks
  - Uses / Used by links
  - "Open in Review →"
- Above 60 change nodes, boxes start collapsed. Above 400, the Changes switch is disabled
  with a note.

- [ ] Write failing tests:
  - `focus terminates on cycles`
  - `collapsed boxes merge edges` (reusing the Task 3 helper, through the component's
    props)
  - the detail panel's uses / used-by lists
  - the diff slice shows only the node's rows
  - the switch is disabled above 400
- [ ] Implement them.
- [ ] Run the tests, then build.
- [ ] Commit: `feat(frontend): change graph view`

### Task 5: End-to-end

**Files:** extend the `tests/e2e_server.py` fixture with an unchanged caller of the
re-signed `send()` (it already exists: `shop/tasks.py`); add
`frontend/e2e/changes.spec.ts`.

- [ ] Write the e2e specs:
  - the Changes switch shows a `send()` node with `✎sig` inside the sync.py box
  - `run()` from tasks.py is a dashed caller with an amber edge labelled "signature
    changed, caller not updated"
  - clicking `send()` fades the unrelated nodes and opens its diff
  - collapsing the sync.py box shows "N changes"
- [ ] Run `npx playwright test`. Everything should pass.
- [ ] Commit: `test: change graph end-to-end`
