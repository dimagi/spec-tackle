# References in documents

**Status:** Draft, awaiting review.
**Builds on:** [Ask Claude](ask-claude.md), [Logic view](2026-10-08-logic-view-design.md)

## Goal

Specs refer to other things all the time: other parts of themselves ("see section 3.2",
"requirement R4", "step 2 above"), other docs ("the limits in retry-policy.md"), and code
("error 4012", "`MAX_RETRIES`", "the SyncQueue class"). Reading one of those means
leaving the document to find what it means. With this feature, a reviewer clicks
**Find references** on a markdown file. Claude searches the repository and marks every
phrase that points at something it can find. Hovering over a marked phrase shows what it
points at in a popup, and clicking it goes there.

Like Ask Claude, it is private. The references are generated and stored locally and
are never sent to GitHub.

## Decisions

| Question | Decision |
|---|---|
| Scope | Targets anywhere in the repository at the page's commit: the same file, other docs, or code. External websites are left alone. |
| What one click covers | The one file whose button was clicked. |
| Where | A **Find references** button in the header of each rendered markdown file, shown only when Ask Claude is available. |
| What the popup shows | The lines Claude says the phrase points at: one list item for "R4", a whole section for "see §3", or a constant's definition. Same-file targets are copied from the page. Targets in other files come from the checkout: markdown rendered, code highlighted with the PR's changed lines marked, at most 80 lines. The popup's height is capped and it scrolls. |
| Clicking a phrase | Scrolls to the target if its file is shown on the page (in whichever view that file shows), and flashes it. Otherwise opens the lines on GitHub in a new tab. |
| How Claude is called | Like the Logic view: Agent SDK, read-only Read/Grep/Glob on a worktree of the page's commit, the same file guard, no MCP servers. The document, with line numbers, is at the start of the prompt. |
| Output format | JSON in a fenced block. A malformed answer gets one repair turn. Individual references that fail validation are dropped rather than repaired. |
| Caching | Stored in SQLite per login, PR, path and commit. |
| New commits | References found at an older commit are carried forward: see [New commits](#new-commits). |
| Automatic runs | An **Auto-find references** switch in the top bar, saved per PR in the browser. When on, opening the PR searches every rendered markdown file that has no references yet, and checks the changed lines of files carried forward from an older commit. When off, nothing runs without a click. |
| Many files | The server searches at most 2 files at once. Others wait, showing "Queued behind other files…". |
| Long runs | Run in the background through `TurnRunner`, keyed per login, PR, path and commit. A reload or a second tab rejoins the run. Claude's tool use is shown as progress ("Reading app/codes.py"). |

## Data model

```
DocRefs {
  id: str
  path: str
  headSha: str         # the commit whose checkout was read
  refs: Ref[]
  createdAt: str
}

Ref {
  line: int            # 1-based document line where the phrase starts
  text: str            # the phrase as a reader sees it, e.g. "section 3.2"
  targetPath: str?     # repo-relative path of the target; null for the same file
  targetStart: int     # 1-based first line of what it points at, in that file
  targetEnd: int       # last line, >= targetStart
  note: str            # short label for the popup, e.g. "§3.2 Retry policy"; may be ""
  changed: int[]       # only for other files: the PR's changed lines inside the target
  inDiff: bool         # only for other files: whether the PR changes that file
}
```

`DocRefs` also has `pending: int[]` (document lines still to check), `basedOn: str | null`
(the older commit a set was carried from) and `outdated: int` (references dropped as
outdated). All three are empty for a set from a full search.

## New commits

A set of references belongs to one commit. When the page shows a commit that has no set
yet, but an older commit does, the server carries the older set forward:

1. It compares the document, and every other file a reference points at, between the two
   commits' worktrees, line by line (`difflib`). No Claude call is needed.
2. A reference is kept, with its line numbers moved, if its phrase's line is unchanged and
   every line of its target is unchanged and still in one block.
3. A reference whose phrase line changed is dropped as outdated. Its new version is one of
   the changed lines.
4. A reference whose target changed is dropped as outdated, and its phrase line is added to
   the lines to check, since the phrase may now point somewhere else.
5. Lines added or changed in the document are the lines to check (`pending`), along with
   any still pending from the older set.

The carried set is saved for the new commit. Its kept references show straight away, and
the outdated ones are hidden. The file's header offers **Check N changed lines**, which runs
Claude with the whole document but asks only for references whose phrase starts on those
lines. The result is merged with the kept references and saved with nothing pending.

If the older commit is gone (force-pushed away), nothing can be carried forward. The old set
is then reported as stale, and the header offers **Find references again**.

## Validation

The server keeps a reference only if all of these hold:

- `line` is inside the document.
- `text` is 1–120 characters and appears in document lines `line` to `line + 1`, ignoring
  case, whitespace and markdown punctuation (`*`, `_`, `` ` ``, `~`, `[`, `]` and link targets).
- Same file (`targetPath` null, empty, or the document's own path): the target is inside
  the document and doesn't contain `line`.
- Another file: the path is inside the checkout and is a file, and the target lines are
  inside it.

At most 300 references are kept. Duplicates (same line, text and target) are dropped.

## API

All routes need the access cookie, like every other route.

- `GET /api/pr/{owner}/{repo}/{number}/refs?path=…&head=…` returns
  `{available, refs: DocRefs | null, stale, running, error}`. `refs` is the set for `head`,
  carried forward from an older commit first if needed (see [New commits](#new-commits)).
- `POST /api/pr/{owner}/{repo}/{number}/refs` with `{path, head, scope}` starts a run for
  that commit, or joins the one already running. `scope` is `"full"` (the default) or
  `"changed"`, which checks only the pending lines of a carried set.
- `GET /api/pr/{owner}/{repo}/{number}/refs/events?path=…&head=…` is an SSE stream of
  `tool` progress events, ending with `done` or `error` (or `idle` if nothing is running).
- `GET /api/refs/{refsId}/{index}/target` returns what a reference to another file points
  at: `{path, start, end, truncated, inDiff, githubUrl, kind}` plus `html` for markdown or
  `lines: [{n, html, changed}]` for code. Only stored references can be read this way, so
  the route can't be used to read arbitrary files.

## Frontend

- The button shows the state: **Find references**, a spinner with progress while running,
  **N references** once found (clicking it hides or shows the markers; its tooltip counts
  hidden outdated ones), **Check N changed lines** for a carried set, a **↻** button that
  searches the whole file again, or **Find references again** when stale. A failure shows
  in a toast with the server's message, and the button's tooltip shows the last failure.
- Markers only go in the Document view. Switching to Changes removes them, and switching
  back puts them back.
- With **Auto-find references** on, each file starts its run as soon as its state loads.
  Each commit and kind of run is tried once per page load, so a failure isn't retried in a loop.
- Markers are added to the rendered document after it is in the DOM. For each reference,
  the phrase is searched for in the blocks covering its `line`, and each matching text
  segment is wrapped in `<span class="doc-ref">`. References whose text isn't found are
  skipped. A phrase pointing at another file ends with a small ↗.
- Hovering over or focusing a marker opens the popup. It stays open while the pointer is
  over it, so long targets can be scrolled. The header shows the note and `lines a–b`, or
  `path:a–b` for another file.
- Clicking a marker doesn't open a comment composer the way clicking other document text does.

## Testing

- `tests/test_refs.py`: prompt building, validation and the drop rules, for both kinds of target.
- `tests/test_refs_api.py`: generate, joining a run, carrying forward, checking changed
  lines, the two-run limit and the target route, with Claude and git faked.
- `frontend/src/lib/docRefs.test.ts`: finding and wrapping phrases, and picking the target blocks.
- `frontend/src/pages/review/DocRefs.test.tsx`: the button states, popups, where a click
  goes, and automatic runs.
- `frontend/e2e/refs.spec.ts`: a same-file reference (hover, jump), a code reference (hover,
  open on GitHub), and the Auto-find switch (runs without a click, kept per PR).
