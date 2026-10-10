# Call tree

**Status:** Draft, awaiting review.
**Builds on:** [Logic view](2026-10-08-logic-view-design.md)

## Goal

The Logic view's flowchart says what a PR *does*, but Claude writes it, and the reviewer
can't tell where it's wrong. The call tree shows how the changed Python functions are
*wired*: who calls them and what they call. It's built from the code by static
analysis, so it's exact where it draws an edge and needs no Claude.

It answers two review questions the flowchart can't:

- **What could this break?** Unchanged code that calls a changed function, and
  especially callers that weren't updated when the function's signature changed.
- **Is the story true?** The flowchart's leaves name real functions. The call tree
  shows how those functions actually connect.

## Decisions

| Question | Decision |
|---|---|
| Where | A **Flow \| Calls** switch at the top of the Logic view. Flow is the existing flowchart; Calls is this view. |
| Tab visibility | The Logic tab shows when Ask Claude is available **or** the PR changes a `.py` file. Without Claude, Flow explains that it needs Claude Code, and Calls works. |
| Language | Python only. Other languages are out of scope; the view lists changed non-Python files as not analysed. |
| Analysis | Python's `ast`, no new dependency. It runs on the head commit's worktree from `Checkouts`, the same one the Logic view uses. |
| Roots | Functions, methods and classes the PR adds or changes: their span at head contains a line the diff adds or modifies. A class counts only for changes in its own body, outside its methods (see [Pick the roots](#3-pick-the-roots)). Roots are always shown, whatever the depth. |
| Neighbourhood | Callers up to 3 hops above the roots, callees up to 3 hops below. The view shows 2 caller hops and 1 callee hop by default, and the reviewer can change both. |
| What counts as a call | A call (`f()`, `mod.f()`, `self.f()`, `cls.f()`, `super().f()`, `Class()` → `Class.__init__`) or a reference to a function as a value (`Depends(get_user)`, `callbacks.append(on_save)`). Only calls into the repo's own code; stdlib and third-party calls are dropped. |
| Uncertain calls | `obj.f()` where `obj`'s type is unknown is a **probable** edge when exactly one method named `f` exists in the repo's code. Otherwise there's no edge. Probable edges are dotted and can be hidden. |
| Breakage | A changed function whose `def` header lines are in the diff is marked **signature changed**. Its unchanged callers get an amber edge: "caller not updated". |
| Rendering | React Flow + ELK, as in Flow: layered top-down, callers above callees. Cards, colours, legend, pan/zoom and theme follow Flow. |
| Clicking a node | Opens the function panel: the source with changed lines highlighted, **Called by** and **Calls** lists, and **Show in Code view**. |
| Storage | None. The result is deterministic per commit, so it's cached in memory per repo and head SHA, and recomputed after a restart. |
| Privacy | Everything runs locally. Nothing is sent to Claude or to GitHub, except the clone's own git fetch. |

## Prior art

The unmerged `change-graph` branch has a static change graph (`src/spec_tackle/analysis/`)
with name resolution through imports, `self.`/`cls.`, and a "probable" rule for
unresolved methods (`symbols.py`, `changes.py`). Use it as a starting point for the
resolver. This spec drops its base-file reconstruction, move detection and file-level
map: the call tree only needs the head worktree and the diff's changed lines.

## Analysis

New module `src/spec_tackle/calls.py`, run off the event loop with `asyncio.to_thread`.

### 1. Index the repo

Walk the worktree for `*.py` files, skipping `.git`, `node_modules`, `.venv`, `venv`,
`__pycache__`, `build`, `dist`, `site-packages`, and any file over 1 MB. Stop after
5,000 files and report `truncated: "files"`. A file that doesn't parse goes in
`skipped` with its error.

For every file:

- **Module name** from its path (`a/b/c.py` → `a.b.c`, `a/b/__init__.py` → `a.b`).
- **Definitions:** every function, method, async function and class, with its qualified
  name (`VisitService.save`), its span (decorators through the last line), its header
  span (`def` through the `:`), and its decorators as source text.
  Nested functions are indexed under their parent (`outer.<locals>.inner`) so calls
  inside them resolve, but they're shown as part of the parent.
- **Imports:** `import x`, `import x as y`, `from x import y [as z]`, and relative
  imports, resolved against the file's package.

An import is resolved to a repo file by **suffix match** on the module path, so
`from spec_tackle.render import x` finds `src/spec_tackle/render.py` without knowing
the source root. The part of the path left over must not be a package (have no
`__init__.py`), so `import logging` never means `core/logging.py`. An import that
matches more than one file is dropped, unless exactly one of them matches the whole
path from the repo root. A file too deeply nested to parse is skipped like a syntax error.

### 2. Resolve calls

For each definition, visit its body (not nested defs or classes, which are visited on
their own) and resolve every `Call` target and every `Name`/`Attribute` load passed as an
argument or assigned:

| Expression | Resolves to |
|---|---|
| `f` | A definition in the same module, or what `f` was imported as. |
| `mod.f`, `pkg.mod.f` | `f` in the module the name was imported as. |
| `self.f`, `cls.f` | `f` on the enclosing class, then on its bases in order, where a base resolves to a repo class. |
| `super().f` | `f` on the enclosing class's bases. |
| `Class(...)` | `Class.__init__`, or the class itself if it defines none. |
| `obj.f` | **Probable**, if exactly one method named `f` exists in the repo, ignoring dunder names. Otherwise nothing. |

Star imports, `getattr`, and attributes of locals don't resolve. That's the price of
being exact; the view says so in its legend ("Only calls the code makes directly are
shown").

The result is a call graph over the repo's definitions: `{caller, callee, kind, lines}`,
where `kind` is `call`, `ref` or `probable`, and `lines` are the call sites in the
caller.

### 3. Pick the roots

Changed lines come from the PR's diff, right-hand side. Deleted lines count too, at the
line they sat before, for the definition they came out of: inside its span; at its first
line only if they were its decorator or its old `def` line; just past its last line only
if they were indented as its body. So deleting a whole function doesn't mark the next one
changed. A definition is:

- **added** when its whole span is added lines, or its file is new;
- **changed** when any line in its span is added or modified;
- **signature changed** when it's changed and a line in its header span is.

For a class, only its own body counts: the lines in its span minus its methods' spans
(class attributes, base classes, the class decorator, the docstring). So:

- a class whose only change is inside one of its methods isn't a root; the method is;
- a class with a changed attribute or base is a root, alongside any changed methods;
- a new class is a root, and so is each of its methods;
- a class's **signature** is its header (bases and decorators); a changed header
  marks it signature changed, so unchanged code that instantiates or subclasses it
  gets a "caller not updated" edge.

Calls to a class (`Class(...)`) go to `Class.__init__` when it's defined, so a class
node's callers are the code that uses it in other ways: subclassing, `isinstance`,
and references passed as values. A class with no such callers still shows, like any
root.

Module-level changes outside any definition are listed under "Other changes" in the
view, not as nodes.

Functions the PR removes don't exist at head. Showing who still calls them needs the
base commit, which is out of scope here (the `change-graph` branch has it).

### 4. Cut the neighbourhood

Breadth-first from the roots: up to 3 hops along callers, and up to 3 hops along
callees. Each node gets `up` and `down` (its hop distances; a root has 0 for both).
Edges are every graph edge between two included nodes.

If that's more than 400 nodes, drop the farthest hops first (callees before callers at
the same distance) until it fits, and report `truncated: "nodes"` with the depths kept.

### Caching

`calls.analyse(root, changed) -> dict` is cached in memory per `(owner, repo, sha)`,
for the 8 most recent. Concurrent requests for the same key share one computation.

## API

`GET /api/pr/{owner}/{repo}/{number}/calls?head={sha}`

Reads the PR's files from GitHub for the changed lines, gets the worktree, and returns:

```
{
  headSha: str,
  nodes: [{
    id: str,                  # "path::Qual.name"
    path: str, symbol: str, start: int, end: int,
    kind: "function" | "method" | "class",
    change: "added" | "changed" | "unchanged",
    signatureChanged: bool,
    decorators: [str],        # source text, e.g. "router.get(\"/visits\")"
    test: bool,               # same test-path rule as the Logic view
    up: int, down: int        # hop distance from the nearest root
  }],
  edges: [{ from: str, to: str, kind: "call" | "ref" | "probable",
            lines: [int], notUpdated: bool }],
  other: [{ path: str, reason: "not Python" | "module level" | "syntax error" | "too large" }],
  truncated: null | "files" | "nodes",
  depth: { up: int, down: int }   # the depths actually included
}
```

`notUpdated` is true when the callee's signature changed and the caller is unchanged.

Errors follow the Logic view: a `CheckoutError` is 502 "Couldn't fetch the repository: …",
a gone commit is 409 with the `CommitGone` message. A PR with no Python changes returns
empty `nodes` and the non-Python files in `other`.

`GET /api/pr/{owner}/{repo}/{number}/calls/source?head={sha}&node={id}`

Returns one node's source for the panel, in the same shape as a Logic function
(`path, symbol, start, end, lines: [{n, html, changed}], inDiff`), via
`logic.function_source`. The node id must be in the cached analysis for that SHA; the
server never reads a path taken from the query string directly, and the read goes
through the same `inside()` check.

Both routes need the access cookie and a signed-in session, like every other API route.

## The Calls view

### Switch

- **Flow | Calls** sits above the chart. The choice is kept in `?mode=calls` alongside
  `?view=logic`, and saved per PR (`logicMode`).
- The default is Flow when Ask Claude is available, otherwise Calls.
- Calls is disabled, with the reason as a tooltip, when the PR changes no `.py` files.
- Switching keeps each mode's state (expanded blocks, focus, open panel).

### States

| State | Shows |
|---|---|
| Loading | "Reading the code…", with "Cloning {owner}/{repo}…" while the first clone runs. |
| Ready | A one-line summary ("7 changed functions, 12 callers, 9 callees · 2 callers not updated"), the controls, the legend and the chart. |
| No Python changes | "This PR changes no Python functions." and the `other` list. |
| Truncated | The chart, with a note: "Showing 2 caller hops and 1 callee hop; the full tree is too large." |
| Failed | The error and **Try again**. |

### Controls

- **Callers** 0–3 and **Callees** 0–3 steppers, filtering on `up`/`down` client side.
  Defaults 2 and 1, saved per PR. A stepper can't go past `depth`.
- **Show tests (N)**, as in Flow; tests are hidden at first. Hidden test callers are
  counted on the node they call instead ("3 tests").
- **Show probable calls**, on by default.
- **Only breakage**: shows just signature-changed roots and their not-updated callers.

### Chart

- Each node is a card with:
  - the symbol (`VisitService.save()`);
  - `path:start` in small type;
  - a fill for `change`: green added, amber changed, neutral unchanged; roots have a
    heavier border;
  - a **✎ signature** badge when the signature changed;
  - an **entry** badge when a decorator looks like a route, task, command or signal
    handler (`*.get/post/put/patch/delete/route`, `*.task`, `*.command`, `receiver`),
    with the decorator as the tooltip;
  - the test count, when tests are hidden.
- Edges point from caller to callee. `call` is solid, `ref` is dashed and labelled
  "passes", `probable` is dotted and faint, and `notUpdated` is amber and labelled
  "caller not updated".
- A cycle (recursion, mutual calls) is drawn as is; ELK breaks it for layering.
- Clicking a node focuses it: everything upstream and downstream of it stays, the rest
  fades. Clicking the background or pressing Esc clears the focus.
- Clicking a node also opens the function panel. Enter does the same from the keyboard.
- Cards are focusable buttons with an `aria-label` like "changed method
  VisitService.save, signature changed, called by 3, calls 2".
- If ELK fails, the view falls back to an indented list: the roots, with their callers
  and callees nested under each.

### Function panel

The same panel as Flow, for one node:

- the symbol, `path:start–end`, "unchanged by this PR" when it is;
- the decorators;
- **Called by** and **Calls**, each item showing its symbol, path, and the call line,
  clickable to focus that node (and open it);
- the source, with changed lines and the call sites of the selected edge highlighted;
- **Show in Code view**, or **View on GitHub** when the file isn't in the diff.

### In Flow

The function panel in Flow gets a **Calls** link per function, when that function is a
node in the call tree. It switches to Calls with that node focused. Flow doesn't load
the call tree until the panel opens.

## Edge cases

- **Huge repos:** the 5,000-file cap; the view says the callers may be incomplete.
- **Same name in two modules:** resolution is by import, so both are separate nodes.
  A suffix match that's ambiguous drops the import rather than guessing.
- **Generated or vendored code** in the repo is indexed like the rest. It only
  appears if it calls, or is called by, a changed function.
- **Conditional definitions** (`if TYPE_CHECKING:`, `try: ... except ImportError:`)
  count as definitions; the first one wins.
- **Methods called only through a framework** (a route handler, a Django `save()`
  override) have no callers. The entry badge is the hint.
- **A PR that touches only tests:** the roots are tests; Show tests is turned on.

## Out of scope

- Languages other than Python.
- Removed functions and their remaining callers (needs the base commit).
- Type inference beyond the rules above.
- Feeding the call tree into Claude's Logic prompt, or checking the flowchart's
  edges against real calls. A good follow-up once this exists.
- Grouping nodes by file.

## Testing

**pytest** (fixture repos written to `tmp_path`):

- Module names and suffix-matched imports, including a `src/` layout, relative imports,
  aliases, and an ambiguous suffix that resolves to nothing.
- Every row of the resolution table, plus: star imports and `getattr` give no edge;
  `probable` only when the method name is unique.
- Roots: added, changed, signature changed (header vs body edits); a class whose
  only change is in a method isn't a root; a class with a changed attribute or base is;
  a new class and its methods are all roots; module-level changes go in `other`.
- Neighbourhood: hop distances, a cycle, the 400-node cut dropping the farthest
  callees first, `truncated` and `depth`.
- `notUpdated` on an unchanged caller of a signature-changed function, and not on a
  changed caller.
- Skipped: syntax errors, files over 1 MB, ignored directories, the file cap.
- The routes: the access cookie and sign-in are required; `/calls/source` rejects a node
  id not in the analysis and never reads outside the worktree; the cache is reused for
  the same SHA; it works without the `claude` extra.

**vitest:**

- The layout puts callers above callees, and edge styles follow `kind` and `notUpdated`.
- The depth steppers, Show tests (with counts on the called node), Show probable,
  Only breakage.
- Focus fades unrelated nodes; Esc clears it.
- The panel lists callers and callees, and clicking one focuses that node.
- The Flow | Calls switch: the default with and without Claude, `?mode=calls` survives
  a reload, and Calls is disabled without Python changes.
- The Calls link in Flow's panel.
- The list fallback when ELK fails.

**Playwright** (the fake GitHub serves a PR against a small fixture repo):

- open Logic → Calls, and see the changed function with its caller;
- see the amber "caller not updated" edge;
- click a node, see its source and Called by list, and Show in Code view.

**Manual:** run it on a real Python PR and compare the tree with what Grep finds.
