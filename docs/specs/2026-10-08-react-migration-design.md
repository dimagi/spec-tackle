# React migration

**Status:** Draft, awaiting review.
**Blocks:** [PR Map](2026-10-08-pr-map-design.md)

## Goal

Move the spec-tackle frontend from Jinja templates and one vanilla `app.js` (about 1,300
lines) to a React + TypeScript app. Reviewers should notice no change in behaviour. The
point is to give the PR Map, and later views like the test-coverage toggle, a frontend
where several linked views can share state without hand-managed DOM.

## Decisions

| Question | Decision |
|---|---|
| Scope | The whole frontend: the review page and the index/sign-in page. Jinja templates and `app.js` are deleted at the end. |
| Toolchain | Vite + React 19 + TypeScript, source in `frontend/`. |
| Shipping | The built bundle is committed to `src/spec_tackle/static/dist/`, so `uvx --from git+…` keeps working without Node. A pytest check fails when the bundle is stale. |
| Styling | Tailwind v4 at build time (`@tailwindcss/vite` + typography), replacing the CDN script. `app.css` is ported as-is into the Tailwind entry file. Google Fonts stay. |
| Markdown and diff rendering | Stays on the server (`render.py`). React inserts the line-mapped HTML (`data-ls`/`data-le`) as-is. |
| Page data | A new JSON endpoint replaces the Jinja context and the `boot` blob. |
| Server state | TanStack Query: page data, the 30s activity polling, mutations. |
| UI state | Zustand: active thread, composer, filters, page tab, and later the Map's hover/selection. |
| Routing | React Router (library mode), with two routes: `/` and `/pr/:owner/:repo/:number`. |
| Mermaid | The `mermaid` npm package, loaded lazily in a separate chunk, instead of the CDN import. |
| Rollout | The new UI is built next to the old one under `/next/…` until the parity checklist passes. Then it takes over the real routes and the old UI is deleted. |
| Stored browser state | The existing localStorage keys and formats are kept (`spec-tackle:theme`, `spec-tackle:<owner>/<repo>#<n>:{seen,filter,hideBots,showClaude,draft:<id>}`), so reviewers keep their drafts and read state. |
| Page tabs | The review page gets a page-level tab strip. It shows only **Review** for now; the Map adds **Map** next to it. The per-file Document/Changes toggle stays where it is. |

## Backend changes

### New: `GET /api/pr/{owner}/{repo}/{number}/page`

This returns everything `review_page()` passes to the template today:

```json
{
  "pr": {"owner": "…", "repo": "…", "number": 1, "url": "…"},
  "overview": {"title": "…", "state": "…", "headRefName": "…", "baseRefName": "…",
               "author": {"login": "…", "avatarUrl": "…"}, "createdAt": "…",
               "additions": 0, "deletions": 0, "changedFiles": 0, "bodyHTML": "…"},
  "files": [{"path": "…", "status": "modified", "additions": 0, "deletions": 0,
             "hunks": [], "wholeFile": false, "markdown": true,
             "rendered": "<html>", "diff": "<html>", "outline": [], "githubUrl": "…"}],
  "activity": {"…": "as normalize_activity()"},
  "viewer": {"login": "…", "name": "…", "avatarUrl": "…"},
  "claude": true
}
```

The file-building code moves from `review_page()` into a helper that both the old route
and the new endpoint use until the switch.

### Also new

- `GET /api/viewer` and `GET /api/session` for the index page: who is signed in, and
  whether `gh` is available.
- The SPA shell: `/`, `/pr/{owner}/{repo}/{number}` (and `/next/…` during the rollout)
  serve `static/dist/index.html`.
- `GET /?url=…` keeps redirecting on the server, as now. An invalid URL redirects to
  `/?error=…`.

### Errors

The `/api/` and `/auth/` handling of `GitHubError` stays as it is (JSON with `error` and
`signedOut`). The page-level branch, which rendered the index with an error, goes away:
the SPA gets `signedOut: true` from `/page` and shows the sign-in view with
`next = <current path>`. Other errors show inline with a "Retry".

### Unchanged

All existing API routes, the Claude routes and their SSE events, `/raw/…`, `/auth/…`,
`HostCheck`, `render.py`, `github.py`, `store.py`.

## Frontend structure

```
frontend/
  index.html
  src/
    main.tsx, router.tsx
    api/          # typed fetch wrapper (request()), query hooks, mutations
    state/        # zustand stores: review UI, persisted prefs (localStorage adapter)
    lib/          # pure functions: layoutCards, elementsInRange, commentableRange,
                  # threadRange, timeAgo, rangeLabel  (ported 1:1 from app.js)
    pages/
      Index/      # sign-in (gh device flow + token), PR URL form, errors
      Review/
        TopBar, PageTabs, Rail (Stats, Filters, ThreadNav, Outline, Shortcuts)
        Description, FileSection (Document/Changes toggle, RenderedHtml, DiffHtml)
        Margin (ThreadCard, ClaudeCard, Composer), Conversation, FinishReviewDialog
        hooks/ (useAnchors, useMarginLayout, useSelection, useGutter, useKeyboard,
                useScrollSpy, useLiveActivity, useClaudeStream, useMermaid)
    styles/app.css
```

### Server-rendered HTML

- `RenderedHtml` and `DiffHtml` set `dangerouslySetInnerHTML` once per file and head SHA,
  and are memoised so they never re-render. The HTML is the same as today:
  `render.py` uses `html: False` and escapes code, and GitHub's `bodyHTML` is trusted as
  it is now.
- Anchor highlights (`has-thread`, `has-claude`, `is-active-anchor`, `is-drafting`) are
  added and removed on those DOM nodes by `useAnchors`, in an effect. React never owns
  those elements, so the two don't conflict.

### Margin layout

- The overlap-free placement in `layout()` becomes a pure function,
  `layoutCards(items, pinnedId, gap) -> positions`, ported as-is and unit-tested.
- `useMarginLayout` measures anchors and cards. It re-runs on a `ResizeObserver` of cards
  and the document, window resize, font load, image load and Mermaid redraws (which
  replace the `spec-tackle:layout` event). Each run is batched into one
  `requestAnimationFrame`.

### Live updates

- `useLiveActivity` uses a TanStack Query `refetchInterval` of 30s, refetches when the
  tab becomes visible and the last sync is older than 30s, and has a manual refresh from
  the sync button.
- The `applyActivity` logic (seen/fresh sets, toasts, flash, unread count in the title,
  new-commits banner) moves into one `onActivity` reducer, ported as-is.

### Claude threads

`useClaudeStream(threadId)` wraps an `EventSource` on `/api/claude/threads/{id}/events`,
with the same join-part-way-through behaviour as `listen()`.

## Parity checklist

The `/next` UI replaces the old one only when every item works the same as today.

**Top bar**
- [ ] Repo, state pill (open/draft/closed/merged), head → base branch, title and number
- [ ] "New commits pushed" banner and Reload
- [ ] Sync indicator: colours, "Live · 2m ago", "Checking…", "Sync failed", "Signed out"; click to refresh
- [ ] Open on GitHub link, theme switch (light/dark/system, no flash on load), viewer badge
- [ ] Finish review button and dialog: Comment, Approve, Request changes; body required except for Approve

**Rail**
- [ ] Open and resolved counts; Open/All filter; Hide bot comments; Show Claude threads (only when Claude is on)
- [ ] Prev/Next open thread and `j`/`k`
- [ ] Outline: description, files, headings with per-section open-thread counts, scroll-spy, conversation count

**Document**
- [ ] Description: author, relative time, +/−, file count, collapsible PR body
- [ ] File sections: path, status pill, +/−, Document/Changes toggle, rendered markdown, diff, "No preview" fallback
- [ ] Mermaid diagrams, redrawn when the theme changes
- [ ] Images through `/raw/…`, including in private repos

**Threads**
- [ ] Cards anchored beside their passages, with anchors highlighted; the active card sits level with its anchor and nothing overlaps
- [ ] Clicking a highlight activates its thread, and the other way round
- [ ] Resolved, outdated and bot threads collapse and expand; long bodies are clamped with "Show more"
- [ ] Reply (drafts kept in localStorage), resolve, reopen
- [ ] New comments flash; a toast with "Show"; unread count in the tab title while hidden

**Composer**
- [ ] The gutter **+** on hover; selecting text shows the floating button; `c` comments, `a` asks Claude
- [ ] Comment and Ask Claude modes (violet accent, no preview, no GitHub hint in Ask Claude); Preview tab; ⌘↵ submits; Esc closes
- [ ] The file-comment fallback hint for unchanged lines; the `> quote` prefill

**Claude**
- [ ] Threads load and anchor; tool progress streams in; follow-ups; delete; "asked on `abc` / now at `def`" note; a reload rejoins a running answer

**Conversation**
- [ ] The list and the general comment form (⌘↵)

**Index**
- [ ] PR URL form; `gh` device-flow sign-in (code, copy, open GitHub, polling); paste a token; error and notice states; `next` redirect after sign-in

**Global**
- [ ] Relative times refresh every 20s; the signed-out state anywhere sends you to sign-in

## Build and packaging

- `frontend/package.json` scripts: `dev` (Vite dev server proxying `/api`, `/auth` and
  `/raw` to uvicorn on 8765), `build`, `test`, `typecheck`.
- `vite build` writes to `src/spec_tackle/static/dist/` with hashed asset names, plus
  `dist/.source-hash`, a hash of `frontend/src`, `package-lock.json` and the config files.
- `tests/test_frontend_bundle.py` recomputes that hash and fails with
  "run `npm run build`" when it differs.
- The dist assets are served by the existing `/static` mount. `index.html` is served by
  the SPA shell routes above.
- The README's Development section gains: `cd frontend && npm install && npm run dev`.

## Rollout steps

1. Scaffold `frontend/`, Tailwind, the dist check and the SPA shell at `/next/`.
2. Add the `/page`, `/api/viewer` and `/api/session` endpoints, and extract the shared
   file builder.
3. Port the pure `lib/` functions with tests.
4. Build the read-only review page: top bar, rail, description, files, Mermaid, outline,
   scroll-spy.
5. Margin: threads, anchoring, layout, filters, keyboard.
6. Writing: composer, replies, resolve, conversation, Finish review.
7. Live updates and toasts.
8. Claude threads and streaming.
9. Index and sign-in.
10. Go through the parity checklist on a real spec PR and a real code PR, comparing
    `/next` with the current UI side by side.
11. Switch: SPA on the real routes, remove `/next`, delete `templates/` (except anything
    still needed), `static/app.js` and `static/app.css`, and drop the `jinja2` dependency.

Each step leaves the old UI working, so the work can merge step by step.

## Testing

- **pytest:** the `/page`, `/api/viewer` and `/api/session` responses with the GitHub
  client mocked (the same pattern as `test_claude_api.py`); SPA shell routing; the bundle
  freshness check.
- **Vitest:** the `lib/` functions (`layoutCards` cases: pinned active card, push up,
  push down, negative shift; `elementsInRange`; `commentableRange` against the same cases
  as `render.resolve_anchor`; `timeAgo`), the `onActivity` reducer (seen/fresh, own
  comments ignored), and the localStorage adapter (key compatibility).
- **React Testing Library:** composer modes, thread card collapse and expand, filters,
  the Finish review validation.
- **Playwright:** against uvicorn with a fake GitHub (a `respx`-style fixture serving a
  recorded PR). Covers opening a PR, posting a comment, replying, resolving, `j`/`k`
  navigation, Ask Claude with a stubbed SDK, and the dark theme. A screenshot of a
  fixture PR is compared between the old UI and `/next` during the rollout.

## Out of scope

- Visual redesign: the UI should look the same, and design changes come after the
  switch.
- Moving markdown or diff rendering to the client.
- The PR Map and the test-coverage toggle (separate specs, built on top of this one).
- New API behaviour beyond the endpoints listed above.

## New dependencies

- Frontend (dev and build only, never needed at runtime): `react`, `react-dom`,
  `react-router`, `@tanstack/react-query`, `zustand`, `mermaid`, `vite`,
  `@vitejs/plugin-react`, `tailwindcss`, `@tailwindcss/vite`,
  `@tailwindcss/typography`, `typescript`, `vitest`, `@testing-library/react`,
  `@playwright/test`.
- Python dev: `respx` (for the fake GitHub in tests).
