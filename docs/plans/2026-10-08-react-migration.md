# React Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Jinja templates and `static/app.js` with a React + TypeScript app.
Reviewers should notice no change in behaviour.

**Architecture:** Markdown and diff HTML stay server-rendered by `render.py`. A new
`/api/pr/{o}/{r}/{n}/page` endpoint replaces the Jinja context. The React app lives in
`frontend/` and is built by Vite into `src/spec_tackle/static/dist/`. The build output is
committed, so `uvx` installs need no Node. The new UI is served under `/next/…` until it
reaches parity, then it takes over `/` and `/pr/…`, and the old UI is deleted.

**Tech Stack:** Vite 6, React 19, TypeScript 5, Tailwind CSS 4 (`@tailwindcss/vite`,
`@tailwindcss/typography`), TanStack Query 5, Zustand 5, React Router 7, mermaid 11,
Vitest 3 + Testing Library, Playwright. Backend: FastAPI, pytest.

**Spec:** `docs/specs/2026-10-08-react-migration-design.md`

## Global Constraints

- Node ≥ 20 for building only. Python runtime never needs Node.
- The built bundle lives at `src/spec_tackle/static/dist/`, with hashed asset names, and
  is committed.
- `dist/.source-hash` = sha256 over `frontend/src/**`, `frontend/index.html`,
  `frontend/package-lock.json`, `frontend/vite.config.ts`, `frontend/tsconfig.json`.
  `tests/test_frontend_bundle.py` fails when it's stale.
- The localStorage keys stay exactly as they are:
  - `spec-tackle:theme`
  - `spec-tackle:<owner>/<repo>#<n>:seen`, `:filter`, `:hideBots`, `:showClaude`,
    `:draft:<threadId>`
  - values JSON-encoded, except `theme`, which is a raw string.
- Polling interval 30 s. Relative times refresh every 20 s. The layout gap between cards
  is 10 px.
- All existing API routes, SSE events, `/raw/…`, `/auth/…` and `HostCheck` stay unchanged.
- Copy is the same as the current UI: every label, hint, toast and confirm text is ported
  verbatim from `app.js` and the templates.

## Review Focus

1. **A long Claude answer streams in while other cards sit below it.** Cards must not
   overlap while the card grows. → Task 8 test: `layoutCards` re-run after a height
   change pushes later cards down.
2. **A reply draft typed before a 30 s poll re-render.** The text must survive the
   re-render and a reload. → Task 9 test: the draft persists across an activity update.
3. **Selecting text across two files.** No composer is offered. → Task 9 test:
   `selectionToRange` returns null across sections.
4. **Signed out mid-session** (a 401 on poll). One "Sign in" toast appears, not one per
   poll. → Task 5 test: `request` emits signedOut once.
5. **The new-commits banner when the PR is force-pushed.** The banner shows and comments
   still post against the rendered SHA. → Task 6 test: `applyActivity` sets
   `newCommits`.

---

## File structure

```
frontend/
  package.json, package-lock.json, tsconfig.json, vite.config.ts, index.html
  scripts/source-hash.mjs          # writes dist/.source-hash
  src/
    main.tsx                       # QueryClient, router, theme bootstrap
    router.tsx                     # "/" → IndexPage, "/pr/:owner/:repo/:number" → ReviewPage (basename /next during rollout)
    styles/app.css                 # @import tailwindcss + typography + ported app.css
    api/types.ts                   # Page, Activity, Thread, Comment, ClaudeThread, …
    api/request.ts                 # request(), ApiError, onSignedOut()
    api/queries.ts                 # usePage, useActivity (polling), useClaudeThreads
    state/storage.ts               # prKey(), loadPref(), savePref()  (key-compatible)
    state/review.ts                # zustand store: active, composer, filter, hideBots, showClaude, expanded…
    state/toasts.ts                # zustand toast queue + toast()
    lib/time.ts                    # timeAgo
    lib/threads.ts                 # threadRange, rangeLabel, commentableRange, isBotThread, isCollapsible, isShown, quoteFor
    lib/anchors.ts                 # elementsInRange, selectionToRange
    lib/layout.ts                  # layoutCards
    lib/activity.ts                # applyActivity (seen/fresh/arrivals)
    components/ThemeSwitch.tsx, Toaster.tsx, ViewerBadge.tsx, RelativeTime.tsx, Html.tsx
    pages/index/IndexPage.tsx, SignIn.tsx
    pages/review/ReviewPage.tsx, TopBar.tsx, PageTabs.tsx, Rail.tsx, Outline.tsx,
      Description.tsx, FileSection.tsx, Margin.tsx, ThreadCard.tsx, Composer.tsx,
      ClaudeCard.tsx, Conversation.tsx, FinishReview.tsx, GutterButton.tsx, SelectionButton.tsx
    pages/review/hooks/useAnchors.ts, useMarginLayout.ts, useKeyboard.ts, useScrollSpy.ts,
      useMermaid.ts, useClaudeStream.ts, useSelection.ts
  e2e/review.spec.ts, playwright.config.ts
src/spec_tackle/
  app.py                           # + /page, /api/session, SPA shell routes
  pages.py                         # build_page(): shared file builder (moved out of review_page)
  static/dist/                     # build output (committed)
tests/
  test_page_api.py, test_spa.py, test_frontend_bundle.py
  e2e_server.py                    # uvicorn with FakeSession, for Playwright
```

---

### Task 1: Shared page builder and `GET /api/pr/{o}/{r}/{n}/page`

**Files:**
- Create: `src/spec_tackle/pages.py`
- Modify: `src/spec_tackle/app.py` (`review_page` uses `build_page`; new route)
- Test: `tests/test_page_api.py`

**Interfaces:**
- Produces: `async def build_page(client, pr: PRRef) -> dict`. It returns
  `{pr, overview, files, activity, headSha}`, where `files` is the list built today in
  `review_page` (sorted with rendered files first).
- Produces: the route `GET /api/pr/{owner}/{repo}/{number}/page` returns
  `{pr, overview, files, activity, viewer, claude}`. `pr` is
  `{owner, repo, number, url}`. `overview` is the GraphQL overview with `reviewThreads`,
  `comments` and `reviews` removed.

- [ ] Write a failing test with the `claude_app`-style fakes from `conftest.py`: GET
  `/api/pr/o/r/7/page`. Expect 200, `files[0]["path"] == "docs/a.md"`, `rendered`
  containing `data-ls`, `activity["headSha"] == "abc1234"`, `viewer["login"] == "me"`,
  and `"reviewThreads" not in overview`. Also cover signed out: a 401 JSON response with
  `signedOut: true`.
- [ ] Run `uv run pytest tests/test_page_api.py -v` and confirm it fails with a 404.
- [ ] Move the body of `review_page` into `pages.build_page`. `review_page` then calls it
  and builds the template context from the result. Add the route.
- [ ] Run the test, then `uv run pytest`. Everything should pass.
- [ ] Commit: `feat: add /page JSON endpoint with shared page builder`

### Task 2: Frontend scaffold, bundle check and SPA shell under `/next`

**Files:**
- Create: `frontend/{package.json,tsconfig.json,vite.config.ts,index.html,scripts/source-hash.mjs}`,
  `frontend/src/{main.tsx,router.tsx,styles/app.css}`, `tests/test_frontend_bundle.py`,
  `tests/test_spa.py`
- Modify: `src/spec_tackle/app.py` (shell routes, `GET /api/session`), `.gitignore`
  (`frontend/node_modules/`), `pyproject.toml` (nothing; dist ships as package data under
  `src/`)

**Interfaces:**
- Produces: `GET /api/session` → `{viewer: Viewer|null, ghCli: bool, claude: bool}`.
- Produces: shell routes `GET /next/` and `GET /next/pr/{owner}/{repo}/{number}`, which
  serve `static/dist/index.html` (`Cache-Control: no-cache`).
- Produces: Vite `base: "/static/dist/"`, `build.outDir: "../src/spec_tackle/static/dist"`,
  `emptyOutDir: true`, and dev server proxy for `/api`, `/auth`, `/raw` and `/static`
  → `http://127.0.0.1:8765`.
- Produces: the theme bootstrap. An inline script in `frontend/index.html`, copied
  verbatim from `_head.html`, defines `window.setTheme` and dispatches
  `spec-tackle:theme`.

- [ ] Write the failing tests:
  - `test_spa.py`: GET `/next/pr/o/r/7` returns 200, HTML containing `<div id="root">`.
    GET `/api/session` returns a viewer login of `me`.
  - `test_frontend_bundle.py`: recompute the hash the same way as `source-hash.mjs` and
    compare it with `dist/.source-hash`.
- [ ] Scaffold `frontend/` with the pinned versions, `npm install`, write a minimal `App`
  that renders the router, and run `npm run build` (which runs `vite build`, then
  `node scripts/source-hash.mjs`).
- [ ] Port `app.css` into `styles/app.css` after `@import "tailwindcss";`,
  `@plugin "@tailwindcss/typography";` and `@custom-variant dark (&:where(.dark, .dark *));`.
  Add the fonts link to `index.html`.
- [ ] Run `uv run pytest`. Everything should pass.
- [ ] Commit: `feat: scaffold React frontend served under /next`

### Task 3: Pure helpers ported from app.js

**Files:**
- Create: `frontend/src/lib/{time,threads,anchors,layout}.ts` plus `*.test.ts`

**Interfaces (exact):**
```ts
timeAgo(iso: string | null, now?: number): string
rangeLabel(start: number, end: number): string                 // "L3" | "L3–5"
threadRange(t: Thread): [number, number] | null
commentableRange(file: PageFile, start: number, end: number): {start:number,end:number} | null
isBotThread(t: Thread): boolean
isCollapsible(t: Thread): boolean
isShown(t: Thread, f: {filter:"open"|"all", hideBots:boolean}): boolean
quoteFor(text: string | null): string                           // "> a\n> b\n\n"
elementsInRange(view: Element, start: number, end: number): Element[]
selectionToRange(sel: Selection | null): {path,start,end,quote,rect} | null
layoutCards(items: {id:string, top:number, height:number}[], activeId: string|null, gap?: number): Map<string, number>
```

- [ ] Write failing Vitest tests:
  - `timeAgo` boundaries: 44 s → "just now", 60 s → "1m ago", 25 h → "1d ago",
    40 d → "1mo ago".
  - `commentableRange` against the same cases as `render.resolve_anchor`: whole file,
    clipped to a hunk, outside any hunk returns null.
  - `layoutCards`:
    - the pinned active card sits exactly at its top
    - later cards are pushed down
    - earlier cards are pushed up
    - a negative first position shifts everything down
    - re-running with a taller card pushes the next card down (Review Focus 1)
  - `elementsInRange` returns innermost elements only (a jsdom table fixture).
  - `selectionToRange` returns null across two sections (Review Focus 3).
- [ ] Run `npx vitest run src/lib` and confirm the tests fail.
- [ ] Port the code verbatim from `app.js`. Change only the signatures: helpers take
  arguments instead of reading globals.
- [ ] Run Vitest again. Everything should pass.
- [ ] Commit: `feat(frontend): port pure review helpers with tests`

### Task 4: Types, request wrapper, storage and stores

**Files:**
- Create: `frontend/src/api/{types,request}.ts`,
  `frontend/src/state/{storage,review,toasts}.ts`, tests

**Interfaces:**
- `class ApiError extends Error { status: number; signedOut: boolean }`
- `request<T>(method, url, body?): Promise<T>`. It calls the registered `onSignedOut`
  listener at most once per page life (Review Focus 4).
- `prKey(pr)`, `loadPref<T>(pr, name, fallback)`, `savePref(pr, name, value|null)`.
  These use `spec-tackle:${owner}/${repo}#${number}:${name}`.
- `useReview` (zustand):
  - state: `active`, `composer`, `filter`, `hideBots`, `showClaude`, `expanded`,
    `expandedBodies`
  - actions: `activate(id, opts?)`, `setFilter`, `toggleBots`, `toggleClaude`,
    `openComposer`, `closeComposer`, `setComposerMode`
- `toast(message, {kind, action, onAction, timeout})` and the `useToasts` store.

- [ ] Write failing tests:
  - `savePref` then `loadPref` round-trips, and the raw key equals
    `spec-tackle:o/r#7:filter`.
  - `request` with two 401 responses calls `onSignedOut` once.
  - `request` turns a 422 `detail` array into a joined message.
- [ ] Implement them.
- [ ] Run the tests. They should pass.
- [ ] Commit: `feat(frontend): api client, key-compatible storage and stores`

### Task 5: Activity reducer and live polling

**Files:**
- Create: `frontend/src/lib/activity.ts`, `frontend/src/api/queries.ts`, tests

**Interfaces:**
- `applyActivity(prev: {seen:Set<number>, fresh:Set<number>}, next: Activity, renderedSha: string)`
  → `{seen, fresh, arrivals: {comment, threadId|null}[], newCommits: boolean}`.
  Own comments go into `seen` but never into `arrivals` or `fresh`.
- `usePage(pr)`: TanStack Query on `/page`, with `staleTime: Infinity`.
- `useLiveActivity(pr, initial)`: a query on `/activity` with `refetchInterval: 30000`.
  It refetches on `visibilitychange` when the last sync is older than 30 s. It returns
  `{activity, lastSync, fetching, error, refresh}`.

- [ ] Write failing tests:
  - the first visit marks everything seen
  - a later arrival from another user is fresh and in arrivals
  - your own comment is not
  - a changed head SHA sets `newCommits` (Review Focus 5)
- [ ] Implement them.
- [ ] Run the tests. They should pass.
- [ ] Commit: `feat(frontend): activity reducer and live polling`

### Task 6: Review page, read-only

**Files:**
- Create: `ReviewPage.tsx`, `TopBar.tsx`, `PageTabs.tsx`, `Description.tsx`,
  `FileSection.tsx`, `Rail.tsx`, `Outline.tsx`, `components/*`, `hooks/useMermaid.ts`,
  `hooks/useScrollSpy.ts`

**Interfaces:**
- `FileSection` renders `<section class="file paper" data-path id="file-N">`, keeping the
  `.view[data-view]` elements, so anchors keep working.
  - It sets server HTML with `<Html html=… />`, a memoised `dangerouslySetInnerHTML` that
    never re-renders for the same string.
  - The Document/Changes toggle is component state, and calls
    `onViewChange(path, view)`.
- `PageTabs` shows only "Review" for now and exposes `tabs` and `active` for the Map
  later.
- `useMermaid(root)`: a lazy `import("mermaid")` that redraws on `spec-tackle:theme` and
  then fires `spec-tackle:layout`.

- [ ] Write failing RTL tests:
  - `TopBar` renders the "draft" pill for `isDraft && state === "OPEN"`, "Sync failed —
    retrying" on error, and the new-commits banner.
  - `FileSection` toggling to Changes hides the rendered view.
- [ ] Implement the components, porting the markup and classes from `review.html` as-is.
- [ ] Run the tests, then `npm run build`, then `uv run pytest`.
- [ ] Commit: `feat(frontend): read-only review page`

### Task 7: Margin: thread cards, anchoring, layout, filters, keyboard

**Files:**
- Create: `Margin.tsx`, `ThreadCard.tsx`, `hooks/useAnchors.ts`,
  `hooks/useMarginLayout.ts`, `hooks/useKeyboard.ts`

**Interfaces:**
- `useAnchors(docRef, items)`: computes the anchors for each card (`elementsInRange` on
  the visible view of the card's file section) and toggles the `has-thread`,
  `has-claude`, `is-active-anchor` and `is-drafting` classes. It returns
  `Map<id, Element[]>`. A click on an anchor element cycles to the next thread on that
  element (`_threads` order, as today).
- `useMarginLayout(marginRef, cards, anchors, activeId)`: measures, calls `layoutCards`,
  and writes `style.top`. It is triggered by a `ResizeObserver` on the doc and cards,
  `resize`, `spec-tackle:layout`, image load and font readiness, batched into one
  `requestAnimationFrame`.
- `ThreadCard` ports `fillCard` and `commentHTML`:
  - collapsed summary for resolved, outdated and bot threads
  - "Show more" clamp above 230 px
  - "new" chips
- `useKeyboard`: `j`/`k` stepping (as in `stepThread`), `r` focuses the reply, Esc. It
  ignores events in inputs, textareas and dialogs, and with modifiers.

- [ ] Write failing tests:
  - `ThreadCard` collapsed renders the summary text, sliced to 160 characters.
  - "Show more" removes the clamp.
  - `useKeyboard`'s `j` activates the next open thread, given positions.
- [ ] Implement them.
- [ ] Run the tests and build.
- [ ] Commit: `feat(frontend): margin threads with anchoring and layout`

### Task 8: Writing: composer, gutter, selection, replies, resolve

**Files:**
- Create: `Composer.tsx`, `GutterButton.tsx`, `SelectionButton.tsx`,
  `hooks/useSelection.ts`; modify `ThreadCard.tsx`

**Interfaces:**
- `openComposer({path,start,end,quote?,mode?})` asks "Discard your unsent text?" before
  replacing a composer that has non-quote text.
- Composer:
  - modes `comment` and `claude` (Claude mode only when `page.claude` is true)
  - Write/Preview tabs (Preview hidden in Claude mode)
  - hints from `commentableRange`
  - ⌘↵ submits; Esc closes when empty
- Posting calls POST `/comments` with `commit: renderedSha`, then the toast "Comment
  posted to the PR", then a refresh, then activates the new thread.
- Reply drafts go to `savePref(pr, "draft:"+id)` on input and are restored on mount
  (Review Focus 2).
- `setResolved` is optimistic, with an Undo toast, and rolls back on error.

- [ ] Write failing tests:
  - Claude mode clears the quote prefill, and switching back restores it.
  - The draft survives a re-render with new activity.
  - The resolve rollback on a rejected request.
- [ ] Implement them.
- [ ] Run the tests and build.
- [ ] Commit: `feat(frontend): composer, replies and resolution`

### Task 9: Conversation and Finish review

**Files:**
- Create: `Conversation.tsx`, `FinishReview.tsx`

- [ ] Write failing tests:
  - Finish review without a body for COMMENT shows the toast "Add a summary for this
    kind of review" and does not post.
  - APPROVE posts with an empty body.
  - The conversation lists the verdict label "requested changes".
- [ ] Implement them, ported from `renderConversation` and the review form. The dialog
  uses a native `<dialog>`.
- [ ] Run the tests and build.
- [ ] Commit: `feat(frontend): conversation and finish review`

### Task 10: Claude threads

**Files:**
- Create: `ClaudeCard.tsx`, `hooks/useClaudeStream.ts`, plus `useClaudeThreads` in
  `api/queries.ts`

**Interfaces:**
- `useClaudeStream(id, onFinish)` opens
  `EventSource(/api/claude/threads/{id}/events)`. It accumulates `text`, shows the latest
  `tool` text, and on any other event or an error closes and calls `onFinish`, which
  reloads the threads.
- `ClaudeCard` ports `fillClaudeCard`:
  - the commit-drift note
  - "Interrupted. Ask again."
  - follow-ups
  - delete, after the confirm "Delete this Claude thread? This can't be undone."

- [ ] Write failing tests:
  - the stream reducer appends text and replaces the tool text
  - the drift note shows when `thread.commit !== headSha`
- [ ] Implement them.
- [ ] Run the tests and build.
- [ ] Commit: `feat(frontend): private Claude threads`

### Task 11: Index page and sign-in

**Files:**
- Create: `pages/index/IndexPage.tsx`, `SignIn.tsx`; the spectacles SVG becomes
  `components/Spectacles.tsx` (copied from `_spectacles.svg`)

**Interfaces:**
- Uses `/api/session`, `POST /auth/login`, `GET /auth/login` (polled every 2 s),
  `POST /auth/token`.
- Query parameters: `error`, `notice`, `next` (same-origin paths only), `url`
  (prefill).
- The PR URL form submits with a GET to `/?url=…` (a server redirect, unchanged).

- [ ] Write failing tests:
  - the device-flow state machine: waiting, then done, redirects to `next`
  - failure shows the error and "Try again"
  - an unsafe `next` (`//evil`) is ignored
- [ ] Implement them.
- [ ] Run the tests and build.
- [ ] Commit: `feat(frontend): index and sign-in page`

### Task 12: Playwright parity checks

**Files:**
- Create: `tests/e2e_server.py` (uvicorn on port 8799 with `FakeSession` from the
  conftest fakes plus a canned PR with threads), `frontend/playwright.config.ts`,
  `frontend/e2e/review.spec.ts`

- [ ] Write the e2e specs:
  - open `/next/pr/o/r/7`
  - a thread card is visible beside its anchor
  - `j` activates it
  - hover a block, click +, type, ⌘↵, and the fake receives the comment
  - resolve
  - toggle the dark theme
- [ ] Run `npx playwright test`. They should pass.
- [ ] Commit: `test: playwright parity checks for the React review page`

### Task 13: Switch over

**Files:**
- Modify: `app.py`:
  - `/` and `/pr/…` serve the SPA shell
  - `/?url=` still redirects; an invalid URL redirects to `/?error=…&url=…`
  - the page-level `GitHubError` branch goes away
  - remove `/next`
- Delete: `templates/`, `static/app.js`, `static/app.css`
- Modify: `router.tsx` (basename `/`), `pyproject.toml` (drop `jinja2`), README
  (Development section)

- [ ] Update `test_spa.py` for the real routes, and add the redirect test for an invalid
  URL.
- [ ] Make the change, then rebuild.
- [ ] Run `uv run pytest`, `npm test` and `npx playwright test` (base URL updated).
- [ ] Commit: `feat: React UI replaces the Jinja templates`
