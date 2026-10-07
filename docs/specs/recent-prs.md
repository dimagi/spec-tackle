# Recent PRs

## Goal

The home page lists the PRs you opened before, and the list survives a restart of spec-tackle. Today nothing is stored, so after a restart you have to find and paste each PR link again.

## User stories

**1. Reopen a PR after a restart.**
As a reviewer, I want the PRs I opened listed on the home page, so I can go back to one after restarting spec-tackle without finding its link again.

- Every PR whose review page loaded successfully is listed.
- The newest is first, and the list shows at most 20.
- The list is still there after spec-tackle restarts.
- Opening a listed PR again moves it to the top and refreshes its title.
- A PR that failed to load is not listed.

**2. Tidy the list.**
As a reviewer, I want to remove PRs I'm done with, so the list only shows work I care about.

- Each row has an × button that removes it at once, with no confirmation.
- Removing a PR from the list does not delete its private Claude threads (see [Ask Claude](ask-claude.md)). If you open the PR again, they are still there.

**3. See only my own PRs.**
As a reviewer who sometimes switches GitHub accounts, I want the list to show only PRs I opened while signed in as the current account, so I don't see titles from another account's private repos.

- Each entry records the GitHub login that opened it.
- The home page lists only entries for the signed-in login.
- When signed out, no list is shown.

## Scope

- Store a record of each PR you open. Do not cache PR content: opening a PR still loads everything fresh from GitHub.
- Out of scope: search, pinning, and sharing between machines.

## Design

### Storage (`src/spec_tackle/store.py`)

A new module owns all local state. [Ask Claude](ask-claude.md) uses it too.

- Location: `$XDG_DATA_HOME/spec-tackle/state.db`, falling back to `~/.local/share/spec-tackle/state.db`. Create the directory if it is missing.
- SQLite through the built-in `sqlite3` module. Open it with `check_same_thread=False`, because FastAPI's `TestClient` and any thread-pool code may use a different thread. All access goes through one `Store` object, and the event loop runs one statement at a time, so no locking is needed.
- Migrations: keep the schema version in `PRAGMA user_version`. On open, apply each migration newer than the stored version, in order. Migration 1:

```sql
CREATE TABLE recent_prs (
    login       TEXT NOT NULL,     -- GitHub login that opened it
    owner       TEXT NOT NULL,
    repo        TEXT NOT NULL,
    number      INTEGER NOT NULL,
    title       TEXT NOT NULL,
    opened_at   TEXT NOT NULL,     -- ISO 8601, UTC
    PRIMARY KEY (login, owner, repo, number)
);
```

The `Store` API:

- `Store.open(path: Path | None = None) -> Store`: uses the default location when `path` is None. Raises `StoreError` if the file cannot be opened or migrated.
- `record_pr_opened(login: str, pr: PRRef, title: str) -> None`: an upsert that refreshes `title` and `opened_at`.
- `recent_prs(login: str, limit: int = 20) -> list[dict]`: newest first. Each dict has `owner`, `repo`, `number`, `title` and `openedAt`.
- `forget_pr(login: str, pr: PRRef) -> None`.

### App wiring (`app.py`)

- `lifespan` opens the store with `Store.open()` and keeps it on `app.state.store`. If it raises `StoreError`, log a warning, set `app.state.store = None`, and keep running. With no store, recent PRs and Ask Claude are both turned off.
- `review_page` calls `record_pr_opened` as its last step, after the whole page has been built and just before it returns the response. If anything fails earlier (the overview, the file list, or a raw file), nothing is recorded.
- New route `DELETE /api/recent/{owner}/{repo}/{number}`: removes the entry for the signed-in user. It returns `{"ok": true}`, `401` when signed out (through the existing `github_error` handler), and `404` when there is no store.
- `index_page` passes `recent` (a list, empty when signed out or when there is no store) to the template.

### Home page (`templates/index.html`)

- When signed in and `recent` is not empty, a "Recent" section appears below the PR link form. Each row is a link to `/pr/{owner}/{repo}/{number}` showing:
  - the title,
  - `owner/repo#number` in muted text,
  - a relative time ("3 days ago"),
  - and an × button.
- The relative time is rendered on the server (a small `time_ago` Jinja filter in `app.py`), so the page needs no script for it.
- A new signed-in `<script>` block handles the × button: it calls the DELETE route and removes the row. If that was the last row, it also hides the section. The page today only has a script when signed out, so this block is new.

## Errors

- If the store fails to open, spec-tackle warns once at startup and runs without recent PRs.
- If a write fails while a PR page is loading, log it and still show the page. A failure to record a PR must never stop the page from loading.

## Technical plan

1. **Store module.** Write `store.py`: `Store.open`, the migration runner, migration 1, and the three methods. Add `tests/test_store.py` using a temporary directory. Test:
   - a record is created, and opening it again updates it instead of duplicating it;
   - newest-first order and the limit;
   - entries are separated by login;
   - `forget_pr`;
   - a database at version 0 is migrated;
   - an unwritable path raises `StoreError`.
2. **Shared app-test setup.** Add `tests/conftest.py` with:
   - a `FakeSession`, whose `client()` returns a stub GitHub client with canned `overview`, `files` and `raw_file` replies, and whose `viewer()` returns a fixed login;
   - a fixture that builds a `TestClient` with `app.state.session` and `app.state.store` replaced by the fake session and a temporary store.

   [Ask Claude](ask-claude.md) reuses this setup.
3. **Wiring.** Open the store in `lifespan` (falling back to `None`), record from `review_page`, and add the DELETE route. Tests:
   - opening a PR records it;
   - a stubbed `raw_file` failure records nothing;
   - DELETE removes the entry;
   - every path works with `store=None`.
4. **Home page.** Add the `time_ago` filter, the Recent section, and the × script. Test that the home page HTML lists the recorded PRs for the signed-in login and shows no list when signed out.
5. **Manual check.** Open two PRs, restart spec-tackle, and confirm both are listed with the newer one first. Remove one with × and reload the page to confirm it stays gone.

Files touched: `src/spec_tackle/store.py` (new), `src/spec_tackle/app.py`, `src/spec_tackle/templates/index.html`, `tests/conftest.py` (new), `tests/test_store.py` (new), `tests/test_app_recent.py` (new).
