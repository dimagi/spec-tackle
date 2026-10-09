# Logic View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A private, Claude-generated **Logic** tab that shows a PR's behaviour as an
expandable flowchart of pseudo-code blocks. Leaf blocks open the real functions, with the
PR's changes marked.

**Architecture:**
- **Backend:** a new `logic.py` (prompt, answer parsing and validation, function source) and `logic_api.py` (routes plus the generation run). Generation reuses `claude.ask` (which gains a `system` parameter), `TurnRunner`, `Checkouts` and `build_context`. Maps go in a new `logic_maps` table.
- **Frontend:** a pure `toMermaid` (in `lib/logicMermaid.ts`), a `LogicView` (states, chart, function panel), and wiring in `ReviewPage` (the `PageTabs` Logic tab, `?view=logic`, Review kept mounted while hidden, Show in Review).

**Tech Stack:**
- FastAPI, `claude-agent-sdk` (optional), SQLite, pygments.
- React 19 and TypeScript, React Query, Mermaid 11 (already a lazily loaded dependency).
- Tests: vitest, Playwright.

**Spec:** `docs/specs/2026-10-08-logic-view-design.md`

## Global Constraints

- Limits: at most 3 levels; 1–12 blocks per level; labels 1–80 characters; block ids match `^[A-Za-z0-9_-]{1,40}$`; at most 8 functions per leaf.
- `kind` ∈ `entry step decision loop async exit`; `change` ∈ `added changed unchanged`.
- Exactly one repair turn on invalid output. After that, the run ends with an `error` event and nothing is stored.
- Nothing is sent to GitHub. Claude gets Read/Grep/Glob with the existing guard and no MCP servers. The SDK is imported only inside `claude.ask`.
- **Rebuild after any frontend change**, and commit `dist/` with the source change.
- Conventional Commits, each ending with the session's `Co-Authored-By` trailer.

## Review Focus

1. **Claude's answer has prose around the JSON, or more than one fenced block.** Parse the last ```` ```json ```` block; if there is none, try the whole text.
2. **A `FunctionRef` pointing outside the checkout** through `..`, an absolute path or a symlink. It must be rejected during validation, and the functions endpoint must refuse it again at read time.
3. **Labels containing Mermaid syntax** (`"`, `]`, `}`, `#`, `|`, `<`, a backtick, the word `end`). The chart must still render and must not let the label inject anything. Node ids are generated (`n0…`), never Claude's ids.
4. **Switching to Logic and back to Review** must keep the composer text and put the margin threads back in place (by dispatching `spec-tackle:layout` on return).
5. **A stale map, followed by Regenerate** for the new head: the old map stays visible while the new one generates.

## Rulings made while planning (deviations from the spec)

- **Functions endpoint addressing:** the endpoint is `GET /api/logic/{map_id}/blocks/{block_id}/functions` rather than a depth-first leaf index. Block ids are validated to be unique and URL-safe, so they are simpler and sturdier than an index the client and server must compute the same way.
- **Head for `GET …/logic` and `…/logic/events`:** the client passes `?head=<sha>` (the head of the page it rendered). This works out staleness and finds the run without a GitHub call on every poll. `POST …/logic` still reads the real head from GitHub, because it needs the overview for the snapshot anyway.
- **Changed lines:** the map stores, at generation time, which right-hand-side lines the PR added in each file (`changed_lines` JSON). The panel then marks changes against the map's own commit, even after the PR moves on.
- **Show in Review for files outside the PR:** these get a "View on GitHub" link (`blob/<sha>/path#Lstart-Lend`), because the Review page has no section for them.
- **Plan detail:** tasks list interfaces and test cases rather than full code, because the plan's author is executing it in the same session.

---

### Task 1: `logic.py`: prompt, parsing and validation, function source

**Files:** create `src/spec_tackle/logic.py` and `tests/test_logic.py`.

**Produces:**
- `LOGIC_SYSTEM_PROMPT: str` and `LOGIC_REQUEST: str`, the user instruction for the first turn.
- `repair_request(problems: list[str]) -> str`.
- `parse_answer(text: str) -> tuple[dict | None, list[str]]`. It returns the decoded JSON object or problems such as `"No JSON block found"` and `"JSON doesn't parse: …"`.
- `validate_map(data: object, root: Path) -> tuple[dict | None, list[str]]`. It returns the normalised map `{"summary", "blocks"}` (unknown keys dropped) or every problem found, each prefixed with a path such as `blocks[2].children[0].label`.
- `find_block(blocks: list[dict], block_id: str) -> dict | None`.
- `function_source(root: Path, ref: dict, changed: set[int]) -> dict`, which returns `{path, symbol, start, end, lines: [{n, html, changed}], missing?}` using `render._highlight_lines` and `render._lexer_for`. It re-checks `claude.inside()` and reports a missing file through `missing`.

**Tests (`tests/test_logic.py`):**
- **`parse_answer`:**
  - prose before and after the block;
  - two blocks, where the last one wins;
  - no fence but the whole text is JSON;
  - no JSON at all;
  - broken JSON.
- **`validate_map` accepts** a 3-level good map. The result keeps `summary` and `blocks`, and unknown keys are dropped.
- **`validate_map` rejects**, with a matching problem for each:
  - not an object, or an empty or missing summary;
  - zero blocks, or more than 12;
  - a bad id pattern, or duplicate ids across levels;
  - an empty or too-long label;
  - an unknown `kind` or `change`;
  - `next.to` not a sibling, or pointing at itself;
  - an edge label longer than 40 characters;
  - `children: []`;
  - both `children` and `functions`;
  - a 4th level;
  - more than 8 functions;
  - a function path that is absolute, contains `..`, or is a symlink out of the root;
  - a missing file;
  - `start < 1`, `end < start`, or `end` past the end of the file.
- **`function_source`:** the lines come back highlighted with `changed` flags; a missing file sets `missing`; a path outside the root raises `ValueError`.

### Task 2: Store `logic_maps`

**Files:** modify `src/spec_tackle/store.py` (migration 3 plus methods); add tests to `tests/test_store.py`.

**Produces:**
- `save_logic_map(*, login, pr: PRRef, head_sha, summary, blocks: list, changed_lines: dict[str, list[int]]) -> str`, which returns the id and replaces any map for the same login, PR and SHA.
- `latest_logic_map(*, login, pr) -> dict | None`, the newest map by `created_at`.
- `logic_map(*, login, map_id) -> dict | None`.
- Each dict has the keys `{id, headSha, summary, blocks, changedLines, createdAt, owner, repo, number}`.

**Tests:**
- save then read back;
- a save for the same SHA replaces the earlier one;
- `latest` returns the newer SHA;
- another login gets `None`;
- the migration runs on an existing version-2 database.

### Task 3: Generation run and routes

**Files:**
- Modify `src/spec_tackle/claude.py`: `ask(…, system: str = SYSTEM_PROMPT)`, passed through to `_options`.
- Create `src/spec_tackle/logic_api.py` and include its router in `app.py`.
- Modify `tests/conftest.py`: `FakeAsk.answers`, a list of answers consumed one per call, falling back to `answer`.
- Create `tests/test_logic_api.py`.

**Produces:**
- `GET /api/pr/{o}/{r}/{n}/logic?head=SHA` returns `{available, map: Map|null, stale, running}`. When Claude isn't available it returns `{available: false, …}` with status 200, not 404, so the tab can hide itself.
- `POST /api/pr/{o}/{r}/{n}/logic` starts a run for the current head, or joins one already going, and returns the same shape as the GET with `running: true` and the head it started for.
- `GET /api/pr/{o}/{r}/{n}/logic/events?head=SHA` is an SSE stream of `tool`, `done {mapId}`, `error {text}` and `idle` events.
- `GET /api/logic/{map_id}/blocks/{block_id}/functions` returns `{label, headSha, functions: [function_source(...)+{inDiff}]}`. It gives 404 for an unknown map or block, or when the block isn't a leaf.
- Run key: `logic:{login}:{owner}/{repo}#{n}@{sha}`.

**Tests:**
- a GET with no map;
- a POST runs, the events end in `done`, and the GET then returns the map with `stale: false`;
- a GET with another head returns `stale: true`;
- the first answer is invalid and the second is valid: exactly 2 calls, and the second resumes `session_id="sess-1"` with a question that lists the problems;
- two invalid answers: an `error` event and nothing stored;
- a second POST during a run doesn't start another;
- the functions endpoint marks changed lines from the stored `changed_lines`; an unknown block gives 404; another login gives 404;
- Claude unavailable gives `available: false`;
- signed out gives 401.

### Task 4: `toMermaid`

**Files:** create `frontend/src/lib/logicMermaid.ts` and `logicMermaid.test.ts`; add the types to `api/types.ts`.

**Produces:**
- The types `LogicBlock`, `LogicMap`, `LogicState` (the GET shape), `LogicFunction` and `LogicFunctions`.
- `toMermaid(blocks: LogicBlock[], expanded: Set<string>): { source: string; nodes: Map<string, LogicBlock>; clusters: Map<string, LogicBlock> }`, where the keys are Mermaid ids (`n<i>` for nodes, `c<i>` for clusters).
- `escapeLabel(text: string): string`.
- `allParentIds(blocks): string[]`, used by Expand all.

**Tests:**
- the shape for each kind;
- the class for each change, plus `exit`;
- edges, with and without labels;
- a collapsible block gets the ⊕ suffix;
- an expanded block becomes `subgraph c… ["⊖ …"]` with its children inside, and sibling edges to it target the cluster id;
- escaping of `" # < > | \``;
- a label `end` stays inside quotes;
- ids are generated and never taken from Claude's ids.

### Task 5: `LogicView`

**Files:**
- Create `frontend/src/pages/logic/LogicView.tsx`, `FunctionPanel.tsx` and `LogicView.test.tsx`.
- Add `useLogic(pr, head)` to `api/queries.ts`.

**Produces:** `LogicView({ pr, head, onShowInReview(path, line) })`.

**Behaviour:** as in the spec's States, Flowchart and Function panel sections.
- Expanded ids are saved with `savePref(pr, "logicExpanded", [...])`.
- Rendering uses `mermaid.render`. Nodes are found through `g.node[id^="flowchart-n"]` and clusters through `g.cluster[id^="c"]`, with click and key handlers attached.
- On a render failure, the fallback list is shown.

**Tests:** these mock `mermaid` with a fake `render` that emits `g.node` and `g.cluster` elements from the source.
- **States:**
  - `available: false` renders nothing;
  - the Generate button;
  - progress text from a mocked EventSource;
  - ready, with the summary and the legend;
  - stale, with a working Regenerate;
  - an error event shows the message and Try again.
- **Interactions:**
  - clicking a node with children re-renders with a cluster, and the choice persists;
  - clicking the cluster label collapses it;
  - Expand all and Collapse all;
  - a leaf opens the panel, which fetches the functions and highlights changed lines;
  - Esc closes the panel;
  - Show in Review calls the callback;
  - a function outside the PR shows "View on GitHub";
  - a mermaid failure shows the list fallback, which still expands blocks and opens the panel.

### Task 6: Wiring into the review page

**Files:** modify `ReviewPage.tsx`, `FileSection.tsx` (a controlled `view`), `TopBar` usage (`tabs`), `useKeyboard` usage, and `styles/app.css` (`.line-flash` and the logic chart styles). Tests go in `ReviewPage.test.tsx` and `FileSection.test.tsx`.

**Behaviour:**
- The tabs show when `page.claude` is true; the choice lives in `?view=logic`.
- The Review subtree stays mounted inside a `hidden` wrapper.
- Coming back to Review dispatches `spec-tackle:layout`.
- Page shortcuts (j, k, r, c, a) are ignored while Logic is showing.
- `showInReview(path, line)`:
  1. switches to Review;
  2. sets that file's view to `diff` if the line is in a hunk, otherwise `rendered` when available;
  3. after the next frame, scrolls the `[data-ls]` element covering the line into view and adds `.line-flash`, or scrolls to the file section when no element covers it.

**Tests:**
- FileSection follows the `view` prop;
- for the tabs, the Logic tab appears only with `claude`;
- the composer text survives a switch to Logic and back (rendered with fixtures and a stubbed fetch).

### Task 7: End to end, build and a real-PR check

**Files:** `tests/e2e_server.py` (the fake ask returns a canned valid map for the logic system prompt) and `frontend/e2e/logic.spec.ts`.

**Test:** generate; see the chart; expand a block to see its children; click a leaf to see the source with a highlighted line; Show in Review lands on the line. Then rebuild, run the full suites, and do one manual run on a real PR on the user's server.
