# PR switcher

**Status:** Draft, awaiting review.

## Goal

Let a reviewer working through a queue of PRs jump to another PR without leaving the review
page. Today the only way in is the index page's paste box or `uv run spec-tackle <url>`.
The reviewer wants one window and quick switching. They don't need several PRs kept open
side by side.

## Decisions

| Question | Decision |
|---|---|
| Shape | A dropdown in the top bar, not tabs. Only one PR is mounted at a time. |
| Trigger | The PR title in the top bar (`Title #123 ▾`) opens it. The shortcut `p` does the same. |
| Contents | A paste box, then **Review requested** (from GitHub), then **Recent** (from browser storage). |
| Switching | Client-side navigation to `/pr/:owner/:repo/:number`. The browser back button returns to the previous PR. |
| Per-PR state | `ReviewPage` is keyed by PR, so its store, seen-state and polling start fresh on every switch. |
| Review queue | GitHub search `is:open is:pr review-requested:@me`, up to 20, sorted by most recently updated. |
| Recents | The last 10 PRs opened, kept in localStorage. Nothing is stored on the server. |
| Out of scope | Tabs, keeping inactive PRs mounted, other queues (authored by me, mentioned), syncing recents across browsers. |

## Behaviour

### The dropdown

The title becomes a button (`aria-haspopup="listbox"`). Clicking it or pressing `p`
(outside text fields, like the other shortcuts in `useKeyboard`) opens a popover under the
top bar. From top to bottom it holds:

1. **Paste box**, focused on open, with the placeholder "Paste a PR link or owner/repo#123,
   or type to filter". If the text parses as a PR (the same rules as `parse_pr_url`: a full
   PR URL on any tab, or `owner/repo#123`), Enter opens that PR. Otherwise the text filters
   both lists by title, `owner/repo` or `#number`. If Enter is pressed when nothing matches
   and the text isn't a PR, an inline error reads "Not a GitHub pull request link".
2. **Review requested**: one row per PR showing `owner/repo #n`, the title, the author's
   login and the time since the last update (`RelativeTime`), plus a "draft" pill when the
   PR is a draft. While loading, the section shows "Loading…". If the fetch fails, it shows
   "Couldn't load review requests" with a Retry link, and the rest of the dropdown keeps
   working. If the list is empty, it shows "Nothing waiting on you".
3. **Recent**: the PRs from the recents list that aren't already under Review requested.
   Each row shows `owner/repo #n` and the title, with a × button that removes the row.
   The section is hidden when empty.

The current PR appears in whichever list holds it, marked with a check, and selecting it
just closes the dropdown. Arrow Up/Down move through the rows of both lists, Enter opens
the highlighted row (or the pasted link, as above), and Escape or a click outside closes
the dropdown.

### Switching

Selecting a PR calls `navigate("/pr/owner/repo/n")`. If the composer is open with unsent
text, the existing "Discard your unsent text?" confirm runs first, and cancelling it keeps
you on the current PR. Saved drafts (`spec-tackle:<pr>:draft:<id>`) are per PR already and
are kept.

`router.tsx` renders the review route through a wrapper that passes
`key={owner/repo/number}` to `ReviewPage`. Today `ReviewPage` creates its zustand store in
`useState` and would keep the old PR's store when the params change. Keying it remounts
the whole page, which resets the store, seen-state, margin engine and Claude streams, and
the activity poll moves to the new PR's query key. Scroll goes back to the top.

### Recents

`state/recents.ts` keeps a list under `spec-tackle:recent-prs`. Each entry is
`{owner, repo, number, title, openedAt}`, newest first, deduplicated by PR and capped at
10. `ReviewPage` records the PR once its page data has loaded, so PRs that fail to load
are never added. Reads and writes are wrapped in try/catch, like `storage.ts`, so the
dropdown works with an empty list when storage is unavailable.

## Backend changes

### New: `GitHub.review_requests()`

This runs a GraphQL `search(query: "is:open is:pr review-requested:@me", type: ISSUE,
first: 20)` and returns, for each `PullRequest` node: `number`, `title`, `isDraft`,
`updatedAt`, `url`, `repository { name owner { login } }` and `author { login }`. Results
are sorted by `updatedAt`, newest first.

### New: `GET /api/review-requests`

This returns a flat list:

```json
[{"owner": "dimagi", "repo": "spec-tackle", "number": 7, "title": "…",
  "author": "octocat", "updatedAt": "2026-10-08T09:00:00Z", "isDraft": false, "url": "…"}]
```

Errors go through the same `GitHubError` handling as the other `/api` routes, so a
signed-out session gives the usual signed-out response.

### Frontend query

`useReviewRequests(enabled)` in `api/queries.ts` has the query key `["review-requests"]`
and `staleTime` set to 2 minutes, with no `refetchInterval`. It is enabled only once the
dropdown has been opened, so loading a review page doesn't trigger a search.

## Components

- `pages/review/PrSwitcher.tsx`: the trigger plus popover. It gets the current `PRRef`
  and a `beforeLeave(): boolean` callback (the composer confirm) as props.
- `lib/prRef.ts`: `parsePrRef(text): PRRef | null`, which mirrors `parse_pr_url`.
- `state/recents.ts`: `loadRecents`, `recordRecent`, `removeRecent`.
- `TopBar.tsx`: the `<h1>` title is replaced by `PrSwitcher` (or wrapped in it).
- `useKeyboard.ts`: a new `p` handler.

## Testing

- **pytest:** `review_requests()` maps a canned GraphQL search response correctly, and
  `/api/review-requests` returns the flat list. A GitHub error gives the standard error
  response.
- **vitest:**
  - `parsePrRef`: full URLs including `/files` and `/changes`, the `owner/repo#n` form, and
    rejected input.
  - `recents`: add, deduplicate, cap at 10, remove, and storage that throws.
  - `PrSwitcher`:
    - filtering and list contents: the current PR is marked, and recents already in the
      review list are hidden
    - pasting a link and pressing Enter navigates
    - invalid input shows the error
    - keyboard navigation
    - the fetch-error state
    - cancelling the discard confirm keeps the current PR
- **Playwright:** `tests/e2e_server.py`'s fake GitHub gets `review_requests()` and a second
  PR. The e2e test opens PR A, uses the dropdown to switch to PR B, checks that B's title
  and content render, then presses Back and checks that A is shown again.
- Rebuild `src/spec_tackle/static/dist/` and commit it with the source change.
