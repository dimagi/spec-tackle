# Ask Claude

**Status:** Implemented on branch `feat/ask-claude`, in review.

## Goal

While reading a PR, you can ask Claude a question about a line or a selection, in the same way you start a comment. Claude answers with everything as context: the PR description, the diff, every review thread and conversation comment, and read-only access to the repository at the PR's commit. That lets it check a spec against the existing code.

Questions and answers are private. They are never sent to GitHub, saved locally, and are still there when you reopen the PR or restart spec-tackle.

## Decisions

| Question | Decision |
|---|---|
| Where answers go | Private margin threads, saved locally, never posted. |
| What Claude sees | PR metadata and description (markdown source), the full diff, every review thread and conversation comment (markdown source), the lines asked about, and read-only access to a checkout of the repo. |
| Single answer or conversation | A thread with follow-ups. Claude remembers the earlier messages. |
| How Claude is called | The Python Agent SDK (`claude-agent-sdk`), run inside the FastAPI process. |
| Repo on disk | One bare clone per repo, plus one git worktree per commit asked about. |
| Local storage | The SQLite store from [Recent PRs](recent-prs.md). |
| Which commit a thread uses | The commit the page was rendered at when the thread started. Follow-ups stay on that commit. |
| Sign-in and model | Whatever the user's own Claude Code install uses: its login or `ANTHROPIC_API_KEY`, and the model set in the user's settings. |
| When Claude Code is missing | The feature is unavailable and nothing about it is shown. |

## User stories

**1. Ask privately about a line.**
As a reviewer, I want to ask Claude about a line or a selection, so I can understand it without posting a question on the PR.

- I can start a question in three ways:
  - from the **+** button, switching the composer to **Ask Claude**;
  - by selecting text and pressing **c**, then switching modes;
  - by selecting text and pressing **a**, which opens the composer already in Ask Claude mode.
- In Ask Claude mode the composer has a violet accent and says the question is private.
- Nothing from Ask Claude mode reaches GitHub:
  - **⌘↵** asks Claude instead of posting;
  - the Preview tab is hidden, because it calls GitHub's markdown endpoint;
  - the "GitHub won't accept a line comment here" hint is hidden.
- Ask Claude mode does not pre-fill the `> quote` text, because the card already shows which lines the question is about.

**2. Have Claude check the spec against the code.**
As a reviewer, I want Claude to be able to read the repository, so it can tell me whether the spec matches how the code works today.

- Claude can use Read, Grep and Glob on a checkout of the repo at the thread's commit.
- Claude cannot read anything outside that checkout, including through symlinks, cannot change files, and cannot run commands or reach the network.
- While Claude works, the card shows what it is doing, for example "Reading app/models.py".

**3. Ask follow-ups.**
As a reviewer, I want to ask follow-up questions in the same thread, so I don't have to repeat the context.

- A follow-up sees the earlier questions and answers.
- Follow-ups still work after spec-tackle restarts, and after Claude Code has deleted its old session files.
- A follow-up uses the same commit and the same PR snapshot as the thread's first question, so all its answers are consistent.

**4. See past questions when I come back.**
As a reviewer, I want my earlier Claude threads to appear when I reopen a PR, so the answers aren't lost.

- Threads are anchored to their lines, the same way GitHub threads are.
- If the PR has new commits since a thread started, the card says so: "Asked on `abc1234`; the PR is now at `def5678`."
- If I reload while an answer is being written, the page reconnects to it. The answer keeps going and is not restarted. A second tab sees the same answer.

**5. Keep Claude threads out of the review workflow.**
As a reviewer, I want Claude threads kept separate from GitHub threads, so they don't affect my count of open review threads.

- Claude cards are labelled "Claude · private" and have a violet border.
- They are left out of the open-thread counts, the outline counts, the Open/All filter, and **j**/**k** navigation.
- A "Claude" toggle in the filter bar shows or hides them.
- I can delete a thread, after a confirmation.

**6. Errors I can recover from.**
As a reviewer, I want failures shown inside the thread, so I know what went wrong and my question isn't lost.

- The thread saves and shows each error: git failed, Claude Code isn't signed in, the commit is no longer on GitHub, or anything else.
- After an error, the follow-up box still works, so I can ask again.

**7. Off when Claude Code isn't installed.**
As a user without Claude Code, I don't want to see controls that can't work.

- With no `claude` on PATH, the page shows no Ask Claude button, no **a** shortcut, no Claude filter and no Claude cards. The Claude routes return 404.
- At startup the terminal says: `spec-tackle: Claude Code not found; Ask Claude is off.`
- The feature is also off when the local store failed to open.

## Design

### Availability and installation

- `claude.find_cli()` returns `shutil.which("claude")`. It runs once in `lifespan`. `app.state.claude_cli` holds the path when the CLI was found, the SDK imports, and the store opened, and is `None` otherwise.
- Every SDK call passes `cli_path=app.state.claude_cli`. The SDK wheel ships its own Claude Code binary, and passing the path means that copy is never used.
- `claude-agent-sdk` is an **optional extra**, `spec-tackle[claude]`, because the bundled binary makes the install much bigger and people without Claude Code gain nothing from it. The README explains how to run with the extra:

  ```bash
  uvx --from 'spec-tackle[claude] @ git+https://github.com/dimagi/spec-tackle' spec-tackle
  ```

  If the extra isn't installed but `claude` is on PATH, the startup message says to install the extra.
- Sign-in: `cli_path` makes the SDK run the user's own `claude` binary, which uses its own sign-in. Technical plan step 0 confirms this.
- Settings: `setting_sources=["user"]`. This loads the user's `~/.claude` settings, including their model choice. It never loads the reviewed repo's `.claude/` or `CLAUDE.md` project settings, because the repo under review is untrusted.

### Repo checkouts (`src/spec_tackle/checkout.py`)

- Root: `$XDG_DATA_HOME/spec-tackle/repos/`, falling back to `~/.local/share/spec-tackle/repos/`.
- Bare clone: `repos/{owner}/{repo}.git`. It is created on first use with `git clone --bare --filter=blob:none https://github.com/{owner}/{repo}.git`.
- Worktree: `repos/{owner}/{repo}/{sha}`, checked out with `core.symlinks=false`, so committed symlinks become plain files and cannot point outside the worktree. `owner` and `repo` are validated before they are used in paths or URLs. If it is missing:
  1. Run `git worktree prune`.
  2. If the commit isn't in the clone, run `git fetch origin <sha>`.
  3. Run `git worktree add --detach <dir> <sha>`.
- `async def worktree(pr: PRRef, sha: str, token: str) -> Path` is idempotent. A per-repo `asyncio.Lock` serialises clones, fetches and worktree adds for the same repo.
- **Token handling.** The token is passed only through environment variables on each git call:
  - `GIT_CONFIG_COUNT=2`
  - `GIT_CONFIG_KEY_0=http.https://github.com/.extraHeader`
  - `GIT_CONFIG_VALUE_0=Authorization: Basic <base64("x-access-token:" + token)>`
  - `GIT_CONFIG_KEY_1=core.symlinks`
  - `GIT_CONFIG_VALUE_1=false`

  The token travels only in `KEY_0` / `VALUE_0`; the second pair holds no secret. The token never appears in process arguments (which `ps` shows), in `config` files, or in error text. `Session` gets a public `async def token() -> str` method; today the token is only held privately.
- **Commit no longer on GitHub.** After a force-push, an old commit may not be fetchable. Then `worktree()` raises `CommitGone`, and the thread shows: "This commit is no longer on GitHub (the branch was probably force-pushed). Start a new question to ask about the current version."
- git runs through `asyncio.create_subprocess_exec`. Any other failure raises `CheckoutError` with git's stderr.
- No automatic cleanup. Worktrees are cheap with a blob-filtered clone. Out of scope: a `spec-tackle --clean` command, to add later if disk use becomes a problem.

### PR context (`src/spec_tackle/claude.py`, `github.py`)

The GraphQL queries fetch only `bodyHTML` today, so `github.py` adds `body` to the overview query and to the comment and review fields in `_ACTIVITY_FIELDS`. `render.normalize_activity` passes `body` through, and the UI keeps using `bodyHTML`.

`build_context(overview, files, markdown_texts, activity) -> str` builds a text snapshot containing:

- the PR title, author, URL, state (open, draft, merged or closed), base and head refs, the head commit, and the description (markdown source);
- every changed file with its status and patch;
- the full text of each changed markdown file at the commit;
- every review thread, with its file, line range, and resolved or outdated state, and each comment's author and markdown body;
- every conversation comment and every review summary.

It has two limits:

- The queries return at most 100 threads, comments and reviews. If a limit is reached, the snapshot says so.
- If the snapshot is over about 400 KB, patches for non-markdown files are dropped first and replaced by a note that Claude can read those files from the checkout.

When a thread is created, the snapshot is built once and **stored on the thread**. Follow-ups reuse it, so Claude never sees a diff from one commit beside a checkout of another. The PR's comments may have changed since; to see the current state, start a new thread.

The question's anchor (path, line range, and the text of those lines) goes into the user prompt, not the snapshot. The server reads the anchor text from the file in the worktree, so it does not rely on the browser's selection, which can be missing or cut short.

### Running a turn (`claude.py`)

`ask(question, snapshot, cwd, session_id, history) -> AsyncIterator[Event]` calls `query()` with these `ClaudeAgentOptions`:

- `cli_path`: the detected `claude`.
- `cwd`: the worktree.
- `system_prompt`: the Claude Code preset, with appended text saying:
  - Claude is helping a reviewer understand this PR;
  - the working directory is the repo at the PR's commit;
  - Claude must not suggest edits as if it can make them.

  The snapshot is not in the system prompt. The SDK passes the system prompt to the CLI as a single command-line argument, which Linux limits to 128 KiB, so a large PR would stop every turn from starting. Instead, the first message of each new session (a first question, or the replay after an expired session) starts with the snapshot. A resumed session already has it, so a follow-up sends only the question.
- `verbatim_prompts=True`: Claude Code delivers each prompt exactly as written, without expanding `@path` mentions or running slash commands. Prompts include text from the PR (anchor lines, earlier answers), and an `@~/...` mention in that text would otherwise attach a local file without any tool call, so the PreToolUse hook would never see it. This needs Claude Code 2.1.248 or later; the SDK warns when the CLI is older.
- `tools=["Read", "Grep", "Glob"]`: removes every other built-in tool.
- `allowed_tools=["Read", "Grep", "Glob"]`.
- `permission_mode="default"`.
- `setting_sources=["user"]`.
- `include_partial_messages=True`.
- `resume=session_id` when the thread has one.
- `hooks`: a **PreToolUse** hook that is the actual security boundary. It denies:
  - any tool other than Read, Grep and Glob;
  - any path-like input (`file_path`, `path`, `notebook_path`) that does not resolve, after `os.path.realpath`, to a location inside the worktree;
  - any path starting with `~`;
  - a Glob `pattern` or Grep `glob` that contains `..`, `~` or `\`, starts an alternative with `/`, uses a character class containing `.`, `/` or `~`, or has a literal prefix that falls outside the search path;
  - anything else, if the guard itself raises an error (any error inside the guard denies).

  Hooks passed in code run whatever `setting_sources` says. A hook is used rather than `can_use_tool`, because `can_use_tool` is not called for tools that `allowed_tools` already approves.
- **Expired sessions.** Claude Code deletes old session files. If resuming fails because the session is missing, retry once without `resume`, with the thread's earlier messages (from `claude_messages`) placed before the new question in the prompt.
- `ask()` yields these events:
  - `text`: a chunk of answer text;
  - `tool`: a short label such as "Reading app/models.py";
  - `done`: the final answer markdown and the session ID;
  - `error`: a message.

### Turns run in the background (`claude.py`, `TurnRunner`)

A turn must outlive the request that started it, because FastAPI cancels a streaming response's generator when the browser disconnects.

- `TurnRunner` lives on `app.state`. `start(thread_id, ...)` runs the turn as an `asyncio.Task`. It returns a conflict if a turn for that thread is already running.
- Each running turn keeps a list of its events so far, plus a set of subscriber queues. `subscribe(thread_id)` yields the stored events and then the live ones. Any number of tabs can subscribe, and a reload subscribes again.
- When the turn ends, the runner saves the answer (or the error) and the session ID to the store, sends `done` or `error`, and discards the in-memory events.
- If a thread is deleted mid-turn, its task is cancelled.
- When spec-tackle shuts down, running tasks are cancelled. A question left without an answer is shown with "Interrupted. Ask again."

### Storage (`store.py`, migration 2)

```sql
CREATE TABLE claude_threads (
    id          TEXT PRIMARY KEY,      -- uuid4
    login       TEXT NOT NULL,         -- GitHub login, same as recent_prs
    owner       TEXT NOT NULL,
    repo        TEXT NOT NULL,
    number      INTEGER NOT NULL,
    path        TEXT NOT NULL,
    start_line  INTEGER NOT NULL,
    end_line    INTEGER NOT NULL,
    anchor_text TEXT,                  -- read from the worktree by the first turn
    commit_sha  TEXT NOT NULL,
    snapshot    TEXT,                  -- PR context, built by the first turn, reused for follow-ups
    session_id  TEXT,                  -- set after the first answer
    created_at  TEXT NOT NULL
);
CREATE TABLE claude_messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id   TEXT NOT NULL REFERENCES claude_threads(id) ON DELETE CASCADE,
    role        TEXT NOT NULL,         -- 'user' | 'assistant' | 'error'
    body        TEXT NOT NULL,         -- markdown
    created_at  TEXT NOT NULL
);
```

Turn on `PRAGMA foreign_keys = ON` when the store opens. Removing a PR from the recent list does not touch these tables.

### API (`app.py`)

All routes:

- return `404` when `app.state.claude_cli` is None;
- return `401` when signed out (through `github_error`);
- only touch threads that belong to the signed-in login.

| Route | What it does |
|---|---|
| `GET /api/pr/{owner}/{repo}/{number}/claude/threads` | The PR's threads with their messages. Answers include `bodyHTML`. Each thread includes `running: bool`. |
| `POST /api/pr/{owner}/{repo}/{number}/claude/threads` with `{path, start, end, commit, question}` | Creates the thread for `commit` (the page's `RENDERED_SHA`), saves the question, starts the turn, and returns the thread. The turn then gets the worktree, reads the anchor text, and builds and stores the snapshot before calling Claude. |
| `POST /api/claude/threads/{id}/messages` with `{question}` | Saves a follow-up and starts its turn. Returns `409` if a turn is already running. |
| `GET /api/claude/threads/{id}/events` | Server-sent events from `TurnRunner.subscribe`. If no turn is running, it sends a single `idle` event. |
| `DELETE /api/claude/threads/{id}` | Cancels any running turn and deletes the thread. |

Creating a thread can take a while on the first question in a repo, because of the clone. The POST returns once the turn has started, and the clone happens inside the turn, so the card shows "Cloning owner/repo…" as a `tool` event. The anchor text and snapshot are therefore filled in by the turn before Claude is called.

### Rendering answers safely

Answers are rendered on the server by a new `render.render_answer(markdown) -> str`, a separate markdown-it instance. The existing `render_markdown` is tied to the PR's raw-file and blob paths, so it can't be reused. Its settings:

- `html=False`, so raw HTML isn't allowed.
- The `image` rule is turned off, and images are shown as their alt text plus the URL in plain text. A PR could steer Claude into writing an image whose URL leaks data the moment the answer is shown.
- Links get `rel="noopener noreferrer"` and `target="_blank"`.
- Code blocks use the existing Pygments highlighting.

While an answer streams, the client shows it as plain text. The `done` event carries the rendered `bodyHTML`, which then replaces it.

### UI (`app.js`, `review.html`, `app.css`)

- `BOOT` gains `claude: bool`. When it is false, no Claude code runs.
- **Composer modes.** The composer gets a two-way switch, **Comment | Ask Claude**, in its header. `state.composer.mode` holds the current mode, and:
  - the submit button's label and action follow it;
  - the **⌘↵** handler (app.js:601–603) calls `submitComposer`, which branches on the mode;
  - in Ask Claude mode the Preview tab is hidden and so is the "GitHub won't accept a line comment here" hint;
  - in Ask Claude mode no quote is pre-filled. If you switch from Comment mode, a pre-filled quote you haven't edited is removed.
- **Shortcut.** **a** on a selection calls `openComposer({..., mode: "claude"})`.
- **Cards.** A separate `claudeCards` map, kept apart from `cards`, because `renderThreads` (app.js:185–187) deletes any card not found in `activity.threads`. `layout()` and `markAnchors()` include `claudeCards`. The open-thread counts, `orderedOpenThreads` and the filters ignore them.
- **Card contents:**
  - the "Claude · private" label and the commit note;
  - the messages, with answers using `bodyHTML`;
  - while a turn runs: a spinner, the latest `tool` label, and the text as it streams;
  - the follow-up box, which reuses the reply-box markup;
  - a delete button.
- **Loading.** On page load, fetch the threads. For each one with `running: true`, open an `EventSource` on `/events`. When you submit a question or follow-up, open the same stream.
- **Filter bar.** A "Claude" toggle, remembered in `localStorage` like the existing filters.
- **CSS.** Violet accent variants of `.thread-card` and of the composer.

## Security summary

- Claude can read only inside the worktree, enforced by the PreToolUse hook using resolved paths. It cannot write, run commands or use the network.
- The reviewed repo's project settings, hooks, MCP config and `CLAUDE.md` are never loaded.
- The GitHub token goes to git only through environment variables, never in process arguments, files or error text.
- Answers are treated as untrusted: no raw HTML, no images that load automatically, and links open in a new tab with no referrer.

## Out of scope

- Posting answers to GitHub.
- Choosing a model per question.
- Automatic cleanup of clones and worktrees.
- Refreshing a thread's snapshot with newer PR comments.

## Technical plan

0. **Confirm the SDK assumptions.** Done, using a throwaway script. Verified with claude-agent-sdk 0.2.164 and Claude Code 2.1.292:
   - with `cli_path` set to the user's `claude`, a query works with no `ANTHROPIC_API_KEY`, using the CLI's own login;
   - `tools=[...]` removes the other built-in tools;
   - PreToolUse hooks run for auto-approved tools and can deny them;
   - `resume` with an unknown session ID raises `ResultError` with "No conversation found with session ID";
   - text streams as `content_block_delta` / `text_delta` `StreamEvent`s.

1. **Packaging.** Add the `claude` optional extra to `pyproject.toml`. Make `find_cli()` and the import check set `app.state.claude_cli`, and print the startup message in `__init__.py`. Test with the CLI missing, the extra missing, and the store missing.
2. **Store migration 2.** Add the two tables, foreign keys, and the thread and message methods. Test in `tests/test_store.py`, including the cascade delete and that removing a recent PR leaves its threads.
3. **Checkouts.** Write `checkout.py` and `Session.token()`. Add `tests/test_checkout.py`, which uses a local bare repo as `origin` through a URL override. Test:
   - the first clone;
   - reusing an existing clone;
   - adding a worktree for a new commit;
   - two concurrent calls sharing one lock;
   - `CommitGone` for a commit that doesn't exist;
   - the token never appearing in `config`, in process arguments (by checking the arguments built), or in error text.
4. **Context.** Add `body` to the GraphQL fields and to `normalize_activity`. Write `build_context`. Add `tests/test_claude_context.py`: it includes the description, the threads, the conversation and reviews; it drops non-markdown patches over the limit; and it notes when 100 items were reached.
5. **`ask()` and the path hook.** Write the options, the hook, event mapping, and the expired-session fallback. Unit-test the hook directly: deny `../` paths, absolute paths outside the worktree, symlinks that point outside, and other tools; allow paths inside the worktree.
6. **TurnRunner.** Write the background task, the event list, subscribers, cancellation on delete, and saving to the store. Test it with a fake `ask()`: a subscriber that joins mid-turn gets the earlier events; two subscribers get the same events; a second start returns a conflict; deleting cancels the turn.
7. **Routes and answer rendering.** Add the five routes and `render.render_answer`. Add `tests/test_app_claude.py`, using the `conftest.py` fake session from Recent PRs and a fake `ask()`. Test:
   - the create → events → saved answer flow;
   - a follow-up passes the saved session ID;
   - 409 on a second concurrent turn;
   - 404 for every route with no CLI;
   - 401 when signed out;
   - one login can't see another's threads.

   Test `render_answer` drops raw HTML and images.
8. **Front end.** In `app.js`: composer modes, the **a** shortcut, `claudeCards` in `layout()`/`markAnchors()`, card rendering and streaming, reconnecting on load, and the filter toggle. In `app.css`: the violet variants. In `review.html`: `BOOT.claude`.
9. **README.** Document the `[claude]` extra, the uvx command, and that the feature needs Claude Code installed and signed in.
10. **Manual check against a real PR:**
    - ask about a spec line that refers to existing code, and confirm Claude reads the repo;
    - ask a follow-up;
    - reload mid-answer;
    - restart and reopen the PR;
    - run once with `claude` removed from PATH and confirm nothing Claude-related shows.

Files touched: `pyproject.toml`, `README.md`, `src/spec_tackle/__init__.py`, `app.py`, `auth.py`, `github.py`, `render.py`, `store.py`, `checkout.py` (new), `claude.py` (new), `static/app.js`, `static/app.css`, `templates/review.html`, plus the new test files `tests/test_checkout.py`, `tests/test_claude_context.py`, `tests/test_app_claude.py`, and changes to `tests/test_store.py`.
