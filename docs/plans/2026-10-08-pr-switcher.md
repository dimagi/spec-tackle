# PR Switcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the PR title in the review page's top bar a dropdown for jumping to another
PR. It lists PRs awaiting your review (from GitHub) and PRs you opened recently, and has a
box for pasting a link.

**Architecture:** One new backend read, `GitHub.review_requests()`, which runs a GraphQL
search and is exposed as `GET /api/review-requests`. On the frontend:
- a pure link parser (`lib/prRef.ts`) and a localStorage recents list (`state/recents.ts`)
- a `PrSwitcher` component that `TopBar` renders in place of its `<h1>` and `ReviewPage`
  controls
- the router keying `ReviewPage` by PR, so switching remounts the page with fresh
  per-PR state

**Tech Stack:** FastAPI + httpx (Python 3.12, uv, pytest); React 19 + TypeScript +
Tailwind 4 + React Query + react-router 7 (vitest, Testing Library, Playwright).

**Spec:** `docs/specs/2026-10-08-pr-switcher-design.md`

## Global Constraints

- Review queue query: `is:open is:pr review-requested:@me`, `first: 20`, newest `updatedAt` first.
- Recents: localStorage key `spec-tackle:recent-prs`, entries `{owner, repo, number, title, openedAt}`, newest first, deduplicated per PR, capped at **10**. No server-side storage.
- React Query key `["review-requests"]`, `staleTime` 2 minutes, no `refetchInterval`, enabled only while the dropdown is open.
- Shortcut: `p` opens the dropdown (ignored in inputs, textareas and dialogs, and with modifier keys, like the other shortcuts).
- Copy, verbatim:
  - Placeholder: "Paste a PR link or owner/repo#123, or type to filter"
  - Invalid input: "Not a GitHub pull request link"
  - Fetch failed: "Couldn't load review requests"
  - Empty queue: "Nothing waiting on you"
  - Discard confirm: "Discard your unsent text?"
- **Rebuild after any frontend change:** run `cd frontend && npm run build` and commit `src/spec_tackle/static/dist/` in the same commit as the source change (`tests/test_frontend_bundle.py` enforces this).
- No new dependencies. Commit messages use Conventional Commits and end with the `Co-Authored-By` trailer the session specifies.

## Review Focus

1. **Pasting real-world links**, such as `…/pull/12/files`, `…/pull/12#discussion_r99`, `…/pull/12?w=1`, an owner or repo containing `.` or `-`, or surrounding whitespace. Each should open PR 12. *Pinned in Task 2 (`parsePrRef` tests).*
2. **Corrupt or foreign recents in localStorage**, such as non-JSON, a non-array value, or entries missing fields. The dropdown should still open, showing only the valid entries. *Pinned in Task 2 (`recents` tests).*
3. **GitHub search returning non-PR nodes** (`{}`) **or a deleted author** (`author: null`). These must not crash: skip the empty nodes and use a `null` author. *Pinned in Task 1.*
4. **Pressing `p` while typing a comment** should type a "p", not open the dropdown. *Pinned in Task 4 (`useKeyboard` test).*
5. **Switching away and pressing Back** should show the first PR again, with its own title and threads, not the second PR's store. *Pinned in Task 5 (Playwright).*

---

## File map

| File | Change | Responsibility |
|---|---|---|
| `src/spec_tackle/github.py` | modify | `_REVIEW_REQUESTS_QUERY` and `GitHub.review_requests()` |
| `src/spec_tackle/app.py` | modify | `GET /api/review-requests` |
| `tests/conftest.py` | modify | `FakeGitHub.review_requests()` |
| `tests/test_review_requests.py` | create | backend tests |
| `frontend/src/lib/prRef.ts` (+ `.test.ts`) | create | `parsePrRef`, `prPath`, `samePr` |
| `frontend/src/state/recents.ts` (+ `.test.ts`) | create | `loadRecents`, `recordRecent`, `removeRecent` |
| `frontend/src/api/types.ts` | modify | `ReviewRequest` type |
| `frontend/src/api/queries.ts` | modify | `useReviewRequests(enabled)` |
| `frontend/src/pages/review/PrSwitcher.tsx` (+ `.test.tsx`) | create | the dropdown |
| `frontend/src/pages/review/TopBar.tsx` | modify | `switcher` slot replaces the `<h1>` |
| `frontend/src/pages/review/ReviewPage.tsx` | modify | open state, recents recording, `p`, discard confirm |
| `frontend/src/pages/review/hooks/useKeyboard.ts` (+ test) | modify | `switcher` handler on `p` |
| `frontend/src/router.tsx` | modify | key `ReviewPage` by PR, scroll to top |
| `README.md` | modify | mention the switcher |
| `tests/e2e_server.py`, `frontend/e2e/switcher.spec.ts` | modify / create | second PR, review queue, e2e test |

---

### Task 1: Backend review queue endpoint

**Files:**
- Modify: `src/spec_tackle/github.py` (add the query constant after `_ACTIVITY_QUERY`/`_OVERVIEW_QUERY`, and the method after `files()` in the `# -- reads` section)
- Modify: `src/spec_tackle/app.py` (add the route right after `session_info`, around line 193)
- Modify: `tests/conftest.py` (`FakeGitHub`)
- Create: `tests/test_review_requests.py`

**Interfaces:**
- Produces: `GitHub.review_requests() -> list[dict]`, where each dict is `{"owner": str, "repo": str, "number": int, "title": str, "author": str | None, "updatedAt": str, "isDraft": bool, "url": str}`, sorted newest `updatedAt` first.
- Produces: `GET /api/review-requests`, which returns that list as JSON. Errors use the existing `GitHubError` handler, which gives `{"error", "signedOut"}`.

- [ ] **Step 1: Add the fake to `tests/conftest.py`.** Inside `class FakeGitHub`, after `raw_file`:

```python
    async def review_requests(self):
        return [{"owner": "o", "repo": "r", "number": 8, "title": "Next spec", "author": "ann",
                 "updatedAt": "2026-10-08T09:00:00Z", "isDraft": False, "url": "https://github.com/o/r/pull/8"}]
```

- [ ] **Step 2: Write the failing tests** in `tests/test_review_requests.py`:

```python
import asyncio

from spec_tackle.app import app
from spec_tackle.github import GitHub, GitHubError


def pull(number, updated, author="ann", draft=False):
    return {"number": number, "title": f"PR {number}", "isDraft": draft, "updatedAt": updated,
            "url": f"https://github.com/o/r/pull/{number}",
            "repository": {"name": "r", "owner": {"login": "o"}},
            "author": {"login": author} if author else None}


def test_review_requests_flattens_search_results_newest_first(monkeypatch):
    client = GitHub("tok")
    seen = {}

    async def fake_graphql(query, **variables):
        seen["query"] = query
        # Non-PR search hits come back as empty objects.
        return {"search": {"nodes": [pull(3, "2026-10-01T00:00:00Z"), {},
                                     pull(9, "2026-10-07T00:00:00Z", author=None, draft=True)]}}

    monkeypatch.setattr(client, "_graphql", fake_graphql)
    try:
        result = asyncio.run(client.review_requests())
    finally:
        asyncio.run(client.aclose())

    assert "is:open is:pr review-requested:@me" in seen["query"]
    assert "first: 20" in seen["query"]
    assert result == [
        {"owner": "o", "repo": "r", "number": 9, "title": "PR 9", "author": None,
         "updatedAt": "2026-10-07T00:00:00Z", "isDraft": True, "url": "https://github.com/o/r/pull/9"},
        {"owner": "o", "repo": "r", "number": 3, "title": "PR 3", "author": "ann",
         "updatedAt": "2026-10-01T00:00:00Z", "isDraft": False, "url": "https://github.com/o/r/pull/3"},
    ]


def test_endpoint_returns_the_queue(web_app):
    response = web_app.get("/api/review-requests")

    assert response.status_code == 200
    assert response.json()[0]["number"] == 8


def test_endpoint_passes_github_errors_through(web_app, monkeypatch):
    async def boom():
        raise GitHubError("search is down", 502)

    monkeypatch.setattr(app.state.session.gh, "review_requests", boom)

    response = web_app.get("/api/review-requests")

    assert response.status_code == 502
    assert response.json() == {"error": "search is down", "signedOut": False}


def test_endpoint_when_signed_out_says_so(web_app):
    app.state.session.signed_in = False

    response = web_app.get("/api/review-requests")

    assert response.status_code == 401
    assert response.json()["signedOut"] is True
```

- [ ] **Step 3: Run the tests and check they fail.**
Run: `uv run pytest tests/test_review_requests.py -v`
Expected: the first test fails with `AttributeError: 'GitHub' object has no attribute 'review_requests'`, and the endpoint tests fail with 404.

- [ ] **Step 4: Implement.** In `src/spec_tackle/github.py`, next to the other query constants:

```python
_REVIEW_REQUESTS_QUERY = """
query {
  search(query: "is:open is:pr review-requested:@me sort:updated-desc", type: ISSUE, first: 20) {
    nodes {
      ... on PullRequest {
        number title isDraft updatedAt url
        repository { name owner { login } }
        author { login }
      }
    }
  }
}
"""
```

In `class GitHub`, after `files()`:

```python
    async def review_requests(self) -> list[dict]:
        """Open PRs waiting on the viewer's review, most recently updated first."""
        data = await self._graphql(_REVIEW_REQUESTS_QUERY)
        pulls = [
            {
                "owner": node["repository"]["owner"]["login"],
                "repo": node["repository"]["name"],
                "number": node["number"],
                "title": node["title"],
                "author": (node["author"] or {}).get("login"),
                "updatedAt": node["updatedAt"],
                "isDraft": node["isDraft"],
                "url": node["url"],
            }
            for node in data["search"]["nodes"]
            if node  # non-PR hits are empty objects
        ]
        return sorted(pulls, key=lambda p: p["updatedAt"], reverse=True)
```

In `src/spec_tackle/app.py`, after `session_info`:

```python
@app.get("/api/review-requests")
async def review_requests(request: Request):
    return await (await gh(request)).review_requests()
```

- [ ] **Step 5: Run the tests and check they pass.**
Run: `uv run pytest tests/test_review_requests.py -v`, then `uv run pytest`
Expected: all pass.

- [ ] **Step 6: Commit.**

```bash
git add src/spec_tackle/github.py src/spec_tackle/app.py tests/conftest.py tests/test_review_requests.py
git commit -m "feat: list PRs awaiting your review at /api/review-requests"
```

---

### Task 2: PR link parsing and the recents list

**Files:**
- Create: `frontend/src/lib/prRef.ts`, `frontend/src/lib/prRef.test.ts`
- Create: `frontend/src/state/recents.ts`, `frontend/src/state/recents.test.ts`

**Interfaces:**
- Consumes: `type PRRef = { owner: string; repo: string; number: number }` from `frontend/src/state/storage.ts`.
- Produces (`lib/prRef.ts`):
  - `parsePrRef(text: string): PRRef | null`
  - `prPath(pr: PRRef): string`, which returns `/pr/owner/repo/n`
  - `samePr(a: PRRef, b: PRRef): boolean`
- Produces (`state/recents.ts`):
  - `type RecentPr = PRRef & { title: string; openedAt: string }`
  - `loadRecents(): RecentPr[]`
  - `recordRecent(pr: PRRef & { title: string }, now?: Date): void`
  - `removeRecent(pr: PRRef): RecentPr[]`, which returns the list after removal

- [ ] **Step 1: Write the failing tests.** `frontend/src/lib/prRef.test.ts`:

```ts
import { parsePrRef, prPath, samePr } from "./prRef";

test.each([
  ["https://github.com/acme/specs/pull/12", "acme", "specs"],
  ["https://github.com/acme/specs/pull/12/files", "acme", "specs"],
  ["https://github.com/acme/specs/pull/12/changes", "acme", "specs"],
  ["https://github.com/acme/specs/pull/12#discussion_r99", "acme", "specs"],
  ["https://github.com/acme/specs/pull/12?w=1", "acme", "specs"],
  ["  github.com/my.org/spec-tackle/pull/12  ", "my.org", "spec-tackle"],
  ["acme/specs#12", "acme", "specs"],
])("parses %s", (text, owner, repo) => {
  expect(parsePrRef(text)).toEqual({ owner, repo, number: 12 });
});

test.each(["", "retry", "#12", "acme/specs", "https://github.com/acme/specs/issues/12", "acme/specs#x"])(
  "rejects %j", (text) => {
    expect(parsePrRef(text)).toBeNull();
  },
);

test("prPath and samePr", () => {
  expect(prPath({ owner: "o", repo: "r", number: 7 })).toBe("/pr/o/r/7");
  expect(samePr({ owner: "o", repo: "r", number: 7 }, { owner: "o", repo: "r", number: 7 })).toBe(true);
  expect(samePr({ owner: "o", repo: "r", number: 7 }, { owner: "o", repo: "r", number: 8 })).toBe(false);
});
```

`frontend/src/state/recents.test.ts`:

```ts
import { loadRecents, recordRecent, removeRecent } from "./recents";

const KEY = "spec-tackle:recent-prs";
const pr = (number: number, title = `PR ${number}`) => ({ owner: "o", repo: "r", number, title });

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

test("newest first, with the opening time", () => {
  recordRecent(pr(1), new Date("2026-10-08T09:00:00Z"));
  recordRecent(pr(2), new Date("2026-10-08T10:00:00Z"));
  expect(loadRecents()).toEqual([
    { owner: "o", repo: "r", number: 2, title: "PR 2", openedAt: "2026-10-08T10:00:00.000Z" },
    { owner: "o", repo: "r", number: 1, title: "PR 1", openedAt: "2026-10-08T09:00:00.000Z" },
  ]);
});

test("reopening a PR moves it to the top and refreshes its title", () => {
  recordRecent(pr(1));
  recordRecent(pr(2));
  recordRecent(pr(1, "Renamed"));
  expect(loadRecents().map((r) => [r.number, r.title])).toEqual([[1, "Renamed"], [2, "PR 2"]]);
});

test("keeps at most ten", () => {
  for (let n = 1; n <= 12; n++) recordRecent(pr(n));
  const list = loadRecents();
  expect(list).toHaveLength(10);
  expect(list[0].number).toBe(12);
  expect(list.at(-1)!.number).toBe(3);
});

test("remove drops one entry and returns the rest", () => {
  recordRecent(pr(1));
  recordRecent(pr(2));
  expect(removeRecent({ owner: "o", repo: "r", number: 2 }).map((r) => r.number)).toEqual([1]);
  expect(loadRecents().map((r) => r.number)).toEqual([1]);
});

test("ignores corrupt or foreign data", () => {
  localStorage.setItem(KEY, "{not json");
  expect(loadRecents()).toEqual([]);
  localStorage.setItem(KEY, JSON.stringify({ owner: "o" }));
  expect(loadRecents()).toEqual([]);
  localStorage.setItem(KEY, JSON.stringify([null, { owner: "o" }, { ...pr(3), openedAt: "" }]));
  expect(loadRecents().map((r) => r.number)).toEqual([3]);
});

test("works when storage throws", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
  expect(() => recordRecent(pr(1))).not.toThrow();
  expect(loadRecents()).toEqual([]);
});
```

- [ ] **Step 2: Run the tests and check they fail.**
Run: `cd frontend && npx vitest run src/lib/prRef.test.ts src/state/recents.test.ts`
Expected: FAIL, with module not found.

- [ ] **Step 3: Implement.** `frontend/src/lib/prRef.ts`:

```ts
import type { PRRef } from "../state/storage";

const URL_RE = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/;
const SHORT_RE = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;

/** A PR from a GitHub PR link (any tab) or `owner/repo#123`, like the server's parse_pr_url. */
export function parsePrRef(text: string): PRRef | null {
  const value = text.trim();
  const m = URL_RE.exec(value) ?? SHORT_RE.exec(value);
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]) } : null;
}

export const prPath = (pr: PRRef) => `/pr/${pr.owner}/${pr.repo}/${pr.number}`;

export const samePr = (a: PRRef, b: PRRef) => a.owner === b.owner && a.repo === b.repo && a.number === b.number;
```

`frontend/src/state/recents.ts`:

```ts
/** PRs recently opened in this browser, for the PR switcher. */

import { samePr } from "../lib/prRef";
import type { PRRef } from "./storage";

export type RecentPr = PRRef & { title: string; openedAt: string };

const KEY = "spec-tackle:recent-prs";
const MAX = 10;

const isRecent = (r: unknown): r is RecentPr => {
  const x = r as RecentPr | null;
  return !!x && typeof x.owner === "string" && typeof x.repo === "string"
    && typeof x.number === "number" && typeof x.title === "string";
};

export function loadRecents(): RecentPr[] {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(list) ? list.filter(isRecent) : [];
  } catch {
    return [];
  }
}

function save(list: RecentPr[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* private mode etc. */
  }
}

/** Put this PR at the top of the list, refreshing its title. */
export function recordRecent(pr: PRRef & { title: string }, now = new Date()) {
  const entry: RecentPr = { owner: pr.owner, repo: pr.repo, number: pr.number, title: pr.title, openedAt: now.toISOString() };
  save([entry, ...loadRecents().filter((r) => !samePr(r, pr))].slice(0, MAX));
}

export function removeRecent(pr: PRRef): RecentPr[] {
  const list = loadRecents().filter((r) => !samePr(r, pr));
  save(list);
  return list;
}
```

- [ ] **Step 4: Run the tests and check they pass.**
Run: `cd frontend && npx vitest run src/lib/prRef.test.ts src/state/recents.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Rebuild and commit.**

```bash
cd frontend && npm run build && cd ..
uv run pytest tests/test_frontend_bundle.py
git add frontend/src/lib/prRef.ts frontend/src/lib/prRef.test.ts frontend/src/state/recents.ts frontend/src/state/recents.test.ts src/spec_tackle/static/dist
git commit -m "feat(frontend): parse PR links and remember recently opened PRs"
```

---

### Task 3: The `PrSwitcher` component

**Files:**
- Modify: `frontend/src/api/types.ts` (add after `PRInfo`)
- Modify: `frontend/src/api/queries.ts` (add after `usePage`)
- Create: `frontend/src/pages/review/PrSwitcher.tsx`, `frontend/src/pages/review/PrSwitcher.test.tsx`

**Interfaces:**
- Consumes: `parsePrRef`, `prPath`, `samePr` (Task 2); `loadRecents`, `removeRecent`, `RecentPr` (Task 2); `GET /api/review-requests` (Task 1).
- Produces:
  - `type ReviewRequest = { owner: string; repo: string; number: number; title: string; author: string | null; updatedAt: string; isDraft: boolean; url: string }`
  - `useReviewRequests(enabled: boolean)`
  - the component `PrSwitcher` with props `{ current: PRRef & { title: string }; open: boolean; onOpenChange: (open: boolean) => void; beforeLeave: () => boolean }`. It renders the page's `<h1>`, with the trigger button inside it.

- [ ] **Step 1: Add the type and the query.** In `types.ts`:

```ts
export type ReviewRequest = {
  owner: string; repo: string; number: number; title: string;
  author: string | null; updatedAt: string; isDraft: boolean; url: string;
};
```

In `queries.ts`, import `ReviewRequest` into the existing type import, then add:

```ts
/** Open PRs waiting on the viewer's review; fetched only once the switcher has been opened. */
export function useReviewRequests(enabled: boolean) {
  return useQuery({
    queryKey: ["review-requests"],
    queryFn: () => request<ReviewRequest[]>("GET", "/api/review-requests"),
    enabled,
    staleTime: 2 * 60_000,
  });
}
```

- [ ] **Step 2: Write the failing tests** in `frontend/src/pages/review/PrSwitcher.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import type { ReviewRequest } from "../../api/types";
import { loadRecents, recordRecent } from "../../state/recents";
import { PrSwitcher } from "./PrSwitcher";

const CURRENT = { owner: "o", repo: "r", number: 7, title: "Add spec" };

const req = (number: number, title: string, over: Partial<ReviewRequest> = {}): ReviewRequest => ({
  owner: "dimagi", repo: "app", number, title, author: "ann",
  updatedAt: "2026-10-08T09:00:00Z", isDraft: false, url: `https://github.com/dimagi/app/pull/${number}`, ...over,
});

function respond(body: unknown, status = 200) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));
}

function Landed() {
  return <p>landed {useLocation().pathname}</p>;
}

function Harness({ initiallyOpen, beforeLeave }: { initiallyOpen: boolean; beforeLeave: () => boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  return <PrSwitcher current={CURRENT} open={open} onOpenChange={setOpen} beforeLeave={beforeLeave} />;
}

function setup({ open = true, beforeLeave = () => true } = {}) {
  const router = createMemoryRouter(
    [
      { path: "/pr/o/r/7", element: <Harness initiallyOpen={open} beforeLeave={beforeLeave} /> },
      { path: "/pr/:owner/:repo/:number", element: <Landed /> },
    ],
    { initialEntries: ["/pr/o/r/7"] },
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
}

beforeEach(() => {
  localStorage.clear();
  recordRecent({ owner: "x", repo: "y", number: 1, title: "Old one" });
  recordRecent({ owner: "dimagi", repo: "app", number: 3, title: "Sync queue" });
  recordRecent(CURRENT);
});
afterEach(() => vi.unstubAllGlobals());

test("the title opens the dropdown with the input focused", async () => {
  respond([]);
  setup({ open: false });
  expect(screen.getByRole("heading")).toHaveTextContent("Add spec #7");
  await userEvent.click(screen.getByRole("button", { name: /Add spec/ }));
  expect(screen.getByRole("textbox", { name: "Pull request link or filter" })).toHaveFocus();
});

test("lists review requests, then recents not already listed, with the current PR marked", async () => {
  respond([req(3, "Sync queue"), req(4, "Draft thing", { isDraft: true })]);
  setup();
  const requested = within(screen.getByRole("group", { name: "Review requested" }));
  expect(await requested.findByText("Sync queue")).toBeInTheDocument();
  expect(requested.getByText("Draft thing")).toBeInTheDocument();
  expect(requested.getByText("draft")).toBeInTheDocument();

  const recent = within(screen.getByRole("group", { name: "Recent" }));
  expect(recent.getByText("Add spec")).toBeInTheDocument();
  expect(recent.getByText("Old one")).toBeInTheDocument();
  expect(recent.queryByText("Sync queue")).toBeNull();
  expect(screen.getByRole("option", { name: /Add spec/ })).toContainElement(screen.getByLabelText("Current pull request"));
});

test("clicking a PR opens it", async () => {
  respond([req(3, "Sync queue")]);
  setup();
  await userEvent.click(await screen.findByRole("option", { name: /Sync queue/ }));
  expect(await screen.findByText("landed /pr/dimagi/app/3")).toBeInTheDocument();
});

test("a pasted link opens on Enter", async () => {
  respond([]);
  setup();
  await userEvent.type(screen.getByRole("textbox"), "https://github.com/acme/specs/pull/12/files{Enter}");
  expect(await screen.findByText("landed /pr/acme/specs/12")).toBeInTheDocument();
});

test("typing filters both lists", async () => {
  respond([req(3, "Sync queue"), req(4, "Draft thing")]);
  setup();
  await screen.findByText("Sync queue");
  await userEvent.type(screen.getByRole("textbox"), "old");
  expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([expect.stringContaining("Old one")]);
});

test("Enter with no match and no link says so", async () => {
  respond([]);
  setup();
  await userEvent.type(screen.getByRole("textbox"), "zzz{Enter}");
  expect(screen.getByRole("alert")).toHaveTextContent("Not a GitHub pull request link");
});

test("arrow keys move the highlight; Enter opens it", async () => {
  respond([req(3, "Sync queue"), req(4, "Draft thing")]);
  setup();
  await screen.findByText("Sync queue");
  // Rows: #3, #4 (requested), then o/r#7 and x/y#1 (recent).
  await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowUp}{Enter}");
  expect(await screen.findByText("landed /pr/dimagi/app/4")).toBeInTheDocument();
});

test("a failed fetch leaves recents and pasting working", async () => {
  respond({ error: "boom" }, 502);
  setup();
  expect(await screen.findByText("Couldn't load review requests")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  expect(screen.getByText("Old one")).toBeInTheDocument();
});

test("an empty queue says so", async () => {
  respond([]);
  setup();
  expect(await screen.findByText("Nothing waiting on you")).toBeInTheDocument();
});

test("declining to leave keeps you on this PR", async () => {
  respond([req(3, "Sync queue")]);
  const beforeLeave = vi.fn(() => false);
  setup({ beforeLeave });
  await userEvent.click(await screen.findByRole("option", { name: /Sync queue/ }));
  expect(beforeLeave).toHaveBeenCalled();
  expect(screen.queryByText(/^landed/)).toBeNull();
});

test("picking the current PR just closes the dropdown", async () => {
  respond([]);
  const beforeLeave = vi.fn(() => true);
  setup({ beforeLeave });
  await userEvent.click(screen.getByRole("option", { name: /Add spec/ }));
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(beforeLeave).not.toHaveBeenCalled();
  expect(screen.queryByText(/^landed/)).toBeNull();
});

test("a recent can be removed", async () => {
  respond([]);
  setup();
  await userEvent.click(screen.getByRole("button", { name: "Remove x/y#1 from recent" }));
  expect(screen.queryByText("Old one")).toBeNull();
  expect(loadRecents().map((r) => r.number)).not.toContain(1);
});

test("Escape and clicking outside close it", async () => {
  respond([]);
  setup();
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("listbox")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: /Add spec/ }));
  expect(screen.getByRole("listbox")).toBeInTheDocument();
  await userEvent.click(document.body);
  expect(screen.queryByRole("listbox")).toBeNull();
});
```

- [ ] **Step 3: Run the tests and check they fail.**
Run: `cd frontend && npx vitest run src/pages/review/PrSwitcher.test.tsx`
Expected: FAIL, with `PrSwitcher` not found.

- [ ] **Step 4: Implement** `frontend/src/pages/review/PrSwitcher.tsx`:

```tsx
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { useReviewRequests } from "../../api/queries";
import { RelativeTime } from "../../components/RelativeTime";
import { parsePrRef, prPath, samePr } from "../../lib/prRef";
import { loadRecents, removeRecent, type RecentPr } from "../../state/recents";
import type { PRRef } from "../../state/storage";

type Props = {
  current: PRRef & { title: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Asked before leaving this PR; false keeps the reviewer here (e.g. unsent composer text). */
  beforeLeave: () => boolean;
};

/** The top bar's PR title, which opens a list of PRs to switch to. */
export function PrSwitcher({ current, open, onOpenChange, beforeLeave }: Props) {
  const navigate = useNavigate();
  const requests = useReviewRequests(open);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [recents, setRecents] = useState<RecentPr[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setText("");
    setError(null);
    setHighlight(0);
    setRecents(loadRecents());
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onOpenChange(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, onOpenChange]);

  const pasted = parsePrRef(text);
  const query = pasted ? "" : text.trim().toLowerCase();
  const matches = (pr: PRRef, title: string) =>
    !query || `${pr.owner}/${pr.repo} #${pr.number} ${title}`.toLowerCase().includes(query);
  const queue = requests.data ?? [];
  const requested = queue.filter((r) => matches(r, r.title));
  const recent = recents.filter((r) => !queue.some((q) => samePr(q, r)) && matches(r, r.title));
  const rows: PRRef[] = [...requested, ...recent];

  const go = (pr: PRRef) => {
    if (samePr(pr, current)) return onOpenChange(false);
    if (!beforeLeave()) return;
    onOpenChange(false);
    navigate(prPath(pr));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setHighlight((h) => Math.min(h + 1, rows.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
    else if (e.key === "Escape") { e.preventDefault(); onOpenChange(false); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (pasted) go(pasted);
      else if (rows[highlight]) go(rows[highlight]);
      else setError("Not a GitHub pull request link");
    }
  };

  const option = (pr: PRRef, index: number, body: ReactNode, onRemove?: () => void) => (
    <Option key={`${pr.owner}/${pr.repo}#${pr.number}`} active={index === highlight} current={samePr(pr, current)}
      onPick={() => go(pr)} onHover={() => setHighlight(index)} onRemove={onRemove}
      removeLabel={`Remove ${pr.owner}/${pr.repo}#${pr.number} from recent`}>
      {body}
    </Option>
  );

  let queueBody: ReactNode;
  if (requests.isPending) queueBody = <Status>Loading…</Status>;
  else if (requests.error) queueBody = (
    <Status>
      Couldn't load review requests{" "}
      <button type="button" className="font-semibold underline" onClick={() => requests.refetch()}>Retry</button>
    </Status>
  );
  else if (!queue.length) queueBody = <Status>Nothing waiting on you</Status>;
  else if (!requested.length) queueBody = <Status>No matches</Status>;
  else queueBody = requested.map((r, i) => option(r, i, (
    <>
      <div className="flex items-center gap-2 text-xs text-stone-500">
        <span className="font-mono">{r.owner}/{r.repo} #{r.number}</span>
        {r.isDraft && <span className="rounded bg-stone-200 px-1.5 text-[10px] font-semibold uppercase dark:bg-stone-700">draft</span>}
      </div>
      <div className="truncate font-medium">{r.title}</div>
      <div className="text-xs text-stone-500">{r.author ?? "ghost"} · updated <RelativeTime iso={r.updatedAt} /></div>
    </>
  )));

  return (
    <div ref={rootRef} className="relative min-w-0">
      <h1 className="truncate text-sm font-semibold">
        <button type="button" aria-haspopup="listbox" aria-expanded={open} title="Switch pull request (p)"
          onClick={() => onOpenChange(!open)}
          className="max-w-full truncate rounded text-left hover:text-amber-700 dark:hover:text-amber-300">
          {current.title} <span className="font-normal text-stone-400">#{current.number}</span>
          <span aria-hidden="true" className="ml-1 text-stone-400">▾</span>
        </button>
      </h1>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-2 w-[min(36rem,90vw)] rounded-xl border border-stone-200 bg-white p-2 shadow-xl dark:border-stone-700 dark:bg-stone-900">
          <input
            autoFocus value={text} onKeyDown={onKeyDown}
            onChange={(e) => { setText(e.target.value); setError(null); setHighlight(0); }}
            aria-label="Pull request link or filter" placeholder="Paste a PR link or owner/repo#123, or type to filter"
            className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm outline-none ring-amber-400/40 placeholder:text-stone-400 focus:border-amber-500 focus:ring-4 dark:border-stone-700 dark:bg-stone-950"
          />
          {error && <p role="alert" className="px-2 pt-1 text-xs text-rose-600 dark:text-rose-400">{error}</p>}
          <div role="listbox" aria-label="Pull requests" className="mt-2 max-h-[60vh] overflow-y-auto">
            <Section title="Review requested">{queueBody}</Section>
            {recent.length > 0 && (
              <Section title="Recent">
                {recent.map((r, i) => option(r, requested.length + i, (
                  <>
                    <div className="font-mono text-xs text-stone-500">{r.owner}/{r.repo} #{r.number}</div>
                    <div className="truncate font-medium">{r.title}</div>
                  </>
                ), () => setRecents(removeRecent(r))))}
              </Section>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={title} className="mb-1">
      <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-stone-500">{title}</div>
      {children}
    </div>
  );
}

function Status({ children }: { children: ReactNode }) {
  return <div className="px-2 py-1.5 text-sm text-stone-500">{children}</div>;
}

type OptionProps = {
  active: boolean; current: boolean; children: ReactNode; removeLabel: string;
  onPick: () => void; onHover: () => void; onRemove?: () => void;
};

function Option({ active, current, children, removeLabel, onPick, onHover, onRemove }: OptionProps) {
  return (
    <div
      role="option" aria-selected={active} onClick={onPick} onMouseEnter={onHover}
      // Keep focus in the input so the keyboard keeps working.
      onMouseDown={(e) => e.preventDefault()}
      className={`flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${active ? "bg-amber-100 dark:bg-amber-500/15" : ""}`}
    >
      <span className="w-3 shrink-0 text-amber-600 dark:text-amber-400">
        {current && <span aria-label="Current pull request">✓</span>}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
      {onRemove && (
        <button type="button" aria-label={removeLabel} onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="rounded px-1.5 text-stone-400 hover:bg-stone-200 hover:text-stone-700 dark:hover:bg-stone-800 dark:hover:text-stone-200">
          ×
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Run the tests and check they pass.**
Run: `cd frontend && npx vitest run src/pages/review/PrSwitcher.test.tsx && npm run typecheck`
Expected: PASS. If the "clicking outside" test doesn't close the dropdown, check that `userEvent.click(document.body)` fires `mousedown` on `document`, which it does in user-event 14.

- [ ] **Step 6: Rebuild and commit.**

```bash
cd frontend && npm run build && cd ..
uv run pytest tests/test_frontend_bundle.py
git add frontend/src/api/types.ts frontend/src/api/queries.ts frontend/src/pages/review/PrSwitcher.tsx frontend/src/pages/review/PrSwitcher.test.tsx src/spec_tackle/static/dist
git commit -m "feat(frontend): PR switcher dropdown with review queue and recents"
```

---

### Task 4: Wire the switcher into the review page

**Files:**
- Modify: `frontend/src/pages/review/hooks/useKeyboard.ts`, `frontend/src/pages/review/hooks/useKeyboard.test.tsx`
- Modify: `frontend/src/pages/review/TopBar.tsx`
- Modify: `frontend/src/pages/review/ReviewPage.tsx`
- Modify: `frontend/src/router.tsx`
- Modify: `README.md` (the "Reviewer tools" bullet, line 47)

**Interfaces:**
- Consumes: `PrSwitcher` (Task 3) and `recordRecent` (Task 2).
- Produces:
  - `KeyHandlers.switcher?: () => void`
  - a `TopBar` prop `switcher: ReactNode`, which replaces the built-in `<h1>`

- [ ] **Step 1: Write the failing keyboard test.** Append to `useKeyboard.test.tsx`:

```tsx
test("p opens the PR switcher, but not while typing", async () => {
  const switcher = vi.fn();
  renderHook(() => useKeyboard({ step: vi.fn(), escape: vi.fn(), reply: vi.fn(), switcher }));

  await userEvent.keyboard("p");
  expect(switcher).toHaveBeenCalledTimes(1);

  const textarea = document.body.appendChild(document.createElement("textarea"));
  textarea.focus();
  await userEvent.keyboard("p");
  expect(switcher).toHaveBeenCalledTimes(1);
  expect(textarea.value).toBe("p");
  textarea.remove();
});
```

- [ ] **Step 2: Run the test and check it fails.**
Run: `cd frontend && npx vitest run src/pages/review/hooks/useKeyboard.test.tsx`
Expected: FAIL, because `switcher` was called 0 times. Typecheck also complains about the unknown key.

- [ ] **Step 3: Implement the shortcut.** In `useKeyboard.ts`, add the following to `KeyHandlers`:

```ts
  /** p: open the PR switcher. */
  switcher?: () => void;
```

and add this branch to the chain, before `Escape`:

```ts
      else if (e.key === "p" && h.switcher) { e.preventDefault(); h.switcher(); }
```

Run the test again and check it passes.

- [ ] **Step 4: Give `TopBar` a switcher slot.** In `TopBar.tsx`, add `switcher: ReactNode;` to `Props`, add `switcher` to the destructured props, and replace

```tsx
          <h1 className="truncate text-sm font-semibold">
            {overview.title} <span className="font-normal text-stone-400">#{pr.number}</span>
          </h1>
```

with

```tsx
          {switcher}
```

- [ ] **Step 5: Wire up `ReviewPage.tsx`.**
  1. Add the imports `import { PrSwitcher } from "./PrSwitcher";` and `import { recordRecent } from "../../state/recents";`.
  2. In `Review`, next to the other `useState` calls, add `const [switcherOpen, setSwitcherOpen] = useState(false);`.
  3. Right after the `document.title` effect, record the PR:

```tsx
  useEffect(() => {
    recordRecent({ ...pr, title: page.overview.title });
  }, [pr, page.overview.title]);
```

  4. Pull the discard prompt out of `openComposer` into a helper, and use it in both places:

```tsx
  /** True unless the composer holds unsent text the reviewer wants to keep. */
  const confirmDiscard = () =>
    !(store.getState().composer && composerDirty.current) || confirm("Discard your unsent text?");

  const openComposer = (target: ComposerTarget) => {
    if (!confirmDiscard()) return;
    composerDirty.current = false;
    clearSelection();
    store.getState().openComposer(target);
  };
```

  5. In the `useKeyboard({...})` call, add `switcher: () => setSwitcherOpen(true),`.
  6. Pass the slot to `<TopBar …>`:

```tsx
        switcher={
          <PrSwitcher current={{ ...pr, title: page.overview.title }} open={switcherOpen}
            onOpenChange={setSwitcherOpen} beforeLeave={confirmDiscard} />
        }
```

- [ ] **Step 6: Key the review route by PR** in `router.tsx`:

```tsx
import { useLayoutEffect } from "react";
import { createBrowserRouter, useParams } from "react-router";
import { IndexPage } from "./pages/index/IndexPage";
import { ReviewPage } from "./pages/review/ReviewPage";

/** Each PR gets a fresh review page: its store, seen-state and polling are per PR. */
function ReviewRoute() {
  const { owner, repo, number } = useParams();
  const key = `${owner}/${repo}/${number}`;
  useLayoutEffect(() => window.scrollTo(0, 0), [key]);
  return <ReviewPage key={key} />;
}

export const router = createBrowserRouter([
  { path: "/", element: <IndexPage /> },
  { path: "/pr/:owner/:repo/:number", element: <ReviewRoute /> },
]);
```

- [ ] **Step 7: Update the README.** In the "Reviewer tools" bullet, after `` `j`/`k` to jump between open threads, `` insert: `` a PR switcher on the title (or `p`) listing PRs awaiting your review and ones you opened recently, ``.

- [ ] **Step 8: Run all frontend checks.**
Run: `cd frontend && npm test && npm run typecheck`
Expected: all pass. `ReviewPage.test.tsx` still passes, because it renders `ReviewPage` directly and the error path doesn't reach `TopBar`.

- [ ] **Step 9: Rebuild and commit.**

```bash
cd frontend && npm run build && cd ..
uv run pytest
git add frontend/src/pages/review/hooks/useKeyboard.ts frontend/src/pages/review/hooks/useKeyboard.test.tsx frontend/src/pages/review/TopBar.tsx frontend/src/pages/review/ReviewPage.tsx frontend/src/router.tsx README.md src/spec_tackle/static/dist
git commit -m "feat(frontend): switch PRs from the review page's title"
```

---

### Task 5: End-to-end check

**Files:**
- Modify: `tests/e2e_server.py`
- Create: `frontend/e2e/switcher.spec.ts`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Teach the fake GitHub about a second PR.** In `tests/e2e_server.py`, add the following below `ANN`:

```python
TITLES = {7: "Retry failed form submissions", 8: "Rename the sync queue"}
```

In `FakeGitHub.overview`, replace the hard-coded `"title"`, `"number"` and `"url"` values with:

```python
        return {"title": TITLES.get(pr.number, f"PR {pr.number}"), "number": pr.number,
                "url": f"https://github.com/o/r/pull/{pr.number}",
```

The rest of the dict stays as it is. Then add this method to `FakeGitHub`:

```python
    async def review_requests(self):
        return [{"owner": "o", "repo": "r", "number": 8, "title": TITLES[8], "author": "ann",
                 "updatedAt": "2026-10-08T09:00:00Z", "isDraft": False, "url": "https://github.com/o/r/pull/8"}]
```

- [ ] **Step 2: Write the e2e test** `frontend/e2e/switcher.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  await request.post("/e2e/reset");
});

test("switch to another PR from the title, then back", async ({ page }) => {
  await page.goto("/pr/o/r/7");
  const title = page.locator("header h1");
  await expect(title).toContainText("Retry failed form submissions");

  await title.getByRole("button").click();
  await page.getByRole("option", { name: /Rename the sync queue/ }).click();

  await expect(page).toHaveURL(/\/pr\/o\/r\/8$/);
  await expect(title).toContainText("Rename the sync queue");
  await expect(page).toHaveTitle(/#8/);

  await page.goBack();
  await expect(page).toHaveURL(/\/pr\/o\/r\/7$/);
  await expect(title).toContainText("Retry failed form submissions");
  await expect(page.locator(".thread-card", { hasText: "How long is the backoff?" })).toBeVisible();

  // p reopens it; PR 8 is in the review queue, so Recent shows only PR 7.
  await page.keyboard.press("p");
  const recent = page.getByRole("group", { name: "Recent" });
  await expect(recent.getByRole("option")).toHaveCount(1);
  await expect(recent).toContainText("Retry failed form submissions");
});

test("paste a link into the switcher", async ({ page }) => {
  await page.goto("/pr/o/r/7");
  await page.keyboard.press("p");
  await page.getByRole("textbox", { name: "Pull request link or filter" }).fill("https://github.com/o/r/pull/8/files");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/pr\/o\/r\/8$/);
});
```

- [ ] **Step 3: Run the e2e suite.**
Run: `cd frontend && npm run e2e`
Expected: all tests pass, including the existing ones in `review.spec.ts`. Playwright gives each test a fresh browser context, so recents start empty in each test.

- [ ] **Step 4: Run the full suite and commit.**

```bash
uv run pytest && (cd frontend && npm test && npm run typecheck)
git add tests/e2e_server.py frontend/e2e/switcher.spec.ts
git commit -m "test: e2e for switching PRs from the title dropdown"
```
