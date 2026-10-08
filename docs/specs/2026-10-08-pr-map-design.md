# PR Map — design

Date: 2026-10-08
Status: Draft, awaiting review
Depends on: [React migration](2026-10-08-react-migration-design.md) (built first)

## Goal

Give reviewers of code PRs a mental model of the change before they read the diff:
what changed, how the pieces fit together, what to read first, and what code outside
the diff might be affected.

The Map is a page-level tab next to **Review**, in the tab strip the React migration adds. The per-file Document/Changes toggle is unchanged.

## Decisions

| Topic | Decision |
|---|---|
| Target PRs | Code PRs, Python first. Other files appear in the reading path without edges. |
| Placement | A page-level **Map** tab next to **Review**. |
| Form | Layered dependency graph (left) and reading path (right), linked. |
| Graph nodes | Files, expandable into their changed functions and classes. |
| Blast radius | Hop 1 (unchanged direct importers) as dashed nodes. Hop 2+ as an expandable "+N indirect" count. |
| Reading order | Computed (import order + path rules). Optional "Narrate with Claude" adds a one-line note per file. |
| Analysis engine | `grimp` for the module import graph, stdlib `ast` for symbols and references. |
| Frontend | React (after the migration), React Flow for the graph. |

## Backend

### `analysis.py` (new, pure functions)

- `module_graph(worktree, packages) -> grimp.ImportGraph`
  Builds the import graph at head. Packages are detected as top-level directories
  containing `__init__.py`, at the repo root or under `src/`.
- `changed_symbols(base_src, head_src, hunks) -> list[Symbol]`
  Parses both versions with `ast` and maps hunk line ranges to the enclosing top-level
  functions, classes and methods. Each symbol gets `change: added | modified | removed`
  and `signature_changed: bool`, where the signature is the argument list plus the
  decorators.
- `hop1(graph, changed_modules, worktree) -> list[Dependent]`
  Lists the unchanged modules that import a changed module. For each one, `ast` finds the
  `Name`/`Attribute`/`ImportFrom` references to changed symbols.
- `hop2_count(graph, hop1_modules, changed_modules) -> dict[module, int]`
  Counts the downstream importers of each hop-1 module, excluding hop 0 and hop 1. The
  list of those modules is returned too, so the badge can expand into it.
- `reading_order(changed_files, graph) -> list[Phase]`
  Topologically sorts the changed modules, dependencies first, with cycles collapsed into
  one step. Files are then bucketed by path rules, applied in this order:
  1. **tests**: `tests/`, `test_*.py`, `*_test.py`, `conftest.py`
  2. **data**: `models.py`, `models/`, `migrations/`, `schemas.py`, `serializers.py`
  3. **edges**: `views.py`, `api/`, `urls.py`, `tasks.py`, `management/`, `signals.py`
  4. **core**: any other `.py`
  5. **other**: non-Python files (docs, config, templates, JS)

  Phases appear in the order data → core → edges → tests → other. Inside a phase, files
  keep the topological order; ties are broken by path.

File tags (one per file, first match wins): `contract` (data phase, or any symbol with
`signature_changed` / `removed`), `new` (file added), `test`, `small` (≤ 5 changed lines),
otherwise none.

### Job and cache

- `GET /api/pr/{owner}/{repo}/{number}/map`
  - Looks up the cache by `(owner, repo, base_sha, head_sha)`. On a hit, it returns
    `{status: "ready", ...}`.
  - On a miss, it starts a background `asyncio` task (base and head worktrees via
    `checkout.py`, then the analysis) and returns `{status: "pending"}`. It never starts
    the same key twice.
  - On failure, it returns `{status: "error", message}`. A later request retries.
- Results are stored as JSON under `store.data_dir()/maps/`.
- The frontend polls every 2s while the status is pending.

### Payload

```json
{
  "status": "ready",
  "headSha": "…",
  "nodes": [
    {"id": "forms/sync/sync.py", "hop": 0, "status": "modified",
     "additions": 180, "deletions": 40, "phase": "core", "tag": "contract",
     "symbols": [{"name": "sync_form", "kind": "function",
                  "change": "modified", "signatureChanged": true}]},
    {"id": "forms/tasks.py", "hop": 1, "phase": "edges",
     "references": ["sync_form"], "indirectCount": 23,
     "indirect": ["forms/celery_schedule.py", "…"]}
  ],
  "edges": [{"from": "forms/tasks.py", "to": "forms/sync/sync.py", "symbols": ["sync_form"]}],
  "readingPath": [{"phase": "data", "files": ["forms/models.py"]}],
  "limits": {"graphTruncated": false, "baseMissing": false, "importGraph": true},
  "skipped": [{"path": "legacy/py2.py", "reason": "syntax error"}]
}
```

### Claude narration

- `POST /api/pr/{owner}/{repo}/{number}/map/narrate` uses the existing `claude.py` setup
  and returns `{path: "one-line why"}` for the hop-0 files.
- The result is cached next to the map for the same key.
- The button is only shown when Claude is configured (the existing `claude` boot flag).

## Frontend (Map tab)

### Graph (left)

- React Flow. Nodes sit in horizontal lanes by phase, in the same order as the reading
  path. Other-phase files are not drawn in the graph.
- Hop-0 nodes are solid amber, with border weight scaled to lines changed. Hop-1 nodes are
  dashed, labelled "unchanged · uses <symbol>".
- Clicking ▾ expands a node into its changed symbols. `signature changed` and `removed`
  are highlighted.
- The "+N indirect" badge on a hop-1 node expands into a list, not into graph nodes.
- Edges point from importer to imported. Hovering an edge shows the symbols it uses.

### Reading path (right)

- Phases, then files: a reviewed checkbox, the path, a change-size bar relative to the
  largest file, the tag, and an optional italic Claude note.
- Hop-1 files are listed in their phase as "not in PR · check". They are not counted in
  progress.
- Progress bar: "Reviewed X of Y files".
- Reviewed state is kept in localStorage, keyed by `owner/repo#number`, then path, then a
  hash of the file's patch. A changed patch unticks the file.

### Linking and navigation

- Hovering a file in either panel highlights it in both.
- Clicking a file switches to the **Review** tab, scrolls to that file and shows its Changes view.
- `j`/`k` move through the reading path. `x` toggles reviewed.

### States

- **Analysing**: skeleton graph. The reading path falls back to the GitHub file list in
  path order.
- **Partial**: no import graph (non-Python repo, grimp timeout) or skipped files. The
  reading path works and a note explains what's missing.
- **Updating**: a new head SHA was detected. The previous map stays visible with an
  "Updating…" pill.
- **Error**: the message, plus "Retry".

## Edge cases

- **Base commit gone** (`CommitGone`): head-only analysis. No `removed` or
  `signatureChanged` flags. `limits.baseMissing = true`, shown as a note.
- **Large PRs** (over 150 changed files): the graph is limited to the 40 largest hop-0
  files plus their hop-1 dependents (`limits.graphTruncated`). The reading path lists all
  files.
- **Slow import graph:** a 60s timeout on the grimp build. After that the result is
  partial, with path-rule ordering only.
- **Unparseable files:** listed in `skipped`. They still appear in the reading path.
- **Claude narration failure:** an inline error by the button. The map is unaffected.

## Testing

- **`analysis.py`**: pytest with fixture repos built in `tmp_path` (two or three packages,
  real git commits for base and head). Covers:
  - symbol mapping: added, modified, removed, signature changed
  - hop-1 detection and the indirect counts
  - reading order: dependencies first, cycles collapsed, the phase rules and their
    precedence
  - degraded paths: no packages, syntax error, missing base, grimp timeout
- **API**: FastAPI `TestClient` with the GitHub client mocked. Covers the
  pending → ready lifecycle, cache hits, no duplicate jobs, and the error then retry path.
- **Frontend**: Vitest + React Testing Library. Covers hover linking, click navigation,
  reviewed persistence and the reset on patch change. Graph rendering is checked with a
  Playwright screenshot.

## Out of scope

- React migration of the existing review page (its own spec, built first)
- "Show tested code" coverage toggle (later spec)
- Import analysis for languages other than Python
- Hop 2+ as graph nodes
- Per-hunk risk classification beyond the file tags

## New dependencies

- Python: `grimp`
- Frontend: `reactflow` (in the React app introduced by the migration)
