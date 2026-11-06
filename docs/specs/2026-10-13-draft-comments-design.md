# Draft comments

**Status:** Implemented.
**Issue:** [#26](https://github.com/dimagi/spec-tackle/issues/26)
**Builds on:** [Ask Claude](ask-claude.md) (private margin cards stored locally)

## Goal

While reading a spec, a reviewer often has a question that the spec answers further down.
Today every comment is posted to GitHub the moment it is written, so the only way to keep
the question is to post it, and spec-tackle has no way to remove it afterwards.

With this feature a reviewer can add a comment or a reply **to the review** instead of
posting it. It is stored locally as a draft, shown in the margin, and can be edited or
deleted without GitHub knowing. All drafts are posted together, as one GitHub review, when
the reviewer finishes the review.

Until then drafts are private. They are stored on this machine and nothing about them is
sent to GitHub.

## Decisions

| Question | Decision |
|---|---|
| Where drafts live | Locally, in SQLite, per login and PR. Not in a GitHub pending review. |
| Draft or post | A choice per comment: **Add to review** next to the existing **Comment** / **Reply** button. There is no draft mode to switch on. |
| What can be drafted | New comments on lines, and replies to existing review threads. |
| What can't | PR-level conversation comments. GitHub can't put them in a review, so they still post immediately. |
| Keyboard | ⌘↵ posts immediately, as today. ⌘⇧↵ adds to the review. |
| How drafts reach GitHub | As one review: find or create the reviewer's pending review, add each draft to it, then submit it with the verdict. One notification. |
| New commits | A draft whose lines no longer hold the text it was written against is flagged **Outdated**. It is not moved automatically. |
| Outdated drafts on submit | Held back. The rest of the review is submitted; outdated drafts stay as local drafts until deleted or re-attached. |
| Drafted replies and new commits | Never outdated: they belong to a thread, not to lines. |
| A pending review already on GitHub | Reused, because GitHub allows one per person per PR. Its comments are published with the drafts, and the dialog says so first. |
| Draft body in the margin | Shown as plain text, so listing drafts makes no GitHub call. |
| No local store | Drafts are off and only the immediate buttons show, like Ask Claude. |

## Data model

Migration 6 in `store.py`:

```sql
CREATE TABLE review_drafts (
    id TEXT PRIMARY KEY, login TEXT NOT NULL,
    owner TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL,
    kind TEXT NOT NULL,            -- 'comment' or 'reply'
    body TEXT NOT NULL,
    -- kind = 'comment'
    path TEXT, start_line INTEGER, end_line INTEGER,
    anchor_text TEXT,              -- the source lines the draft was written against
    commit_sha TEXT,               -- the commit those line numbers belong to
    checked_sha TEXT,              -- the head commit `outdated` was last worked out for
    outdated INTEGER NOT NULL DEFAULT 0,
    -- kind = 'reply'
    thread_id TEXT,                -- GraphQL id of the review thread
    -- submitting
    sent_review_id TEXT,           -- the pending review this draft has been added to
    error TEXT,                    -- why the last attempt to send it failed
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX review_drafts_by_pr ON review_drafts (login, owner, repo, number);
```

As JSON:

```
Draft {
  id: str
  kind: "comment" | "reply"
  body: str
  path: str?           # comment only
  startLine: int?      # comment only
  endLine: int?        # comment only
  anchorText: str?     # comment only
  commit: str?         # comment only
  outdated: bool       # always false for a reply
  threadId: str?       # reply only
  sent: bool           # already in the pending review on GitHub
  error: str?
  createdAt: str
  updatedAt: str
}
```

Every store method takes `login`, as the Claude thread methods do, so one login never sees
another's drafts.

## Outdated drafts

When a comment draft is created or re-attached, the server reads the file at `commit`
(`GitHub.raw_file`) and stores lines `start_line`–`end_line` as `anchor_text`.

When drafts are listed, each comment draft whose `checked_sha` is not the PR's current head
is checked again:

- The file is read at the head, once per path however many drafts it holds.
- The draft is outdated if lines `start_line`–`end_line` there differ from `anchor_text`,
  or the file is gone or no longer part of the PR.
- `outdated` and `checked_sha` are saved, so each push costs one fetch per affected file.

A passage that only moved, because lines were added or removed above it, is flagged too.
Following it automatically is [out of scope](#out-of-scope).

An outdated draft keeps its old line numbers and is drawn there. Its card shows
`anchor_text`, so the reviewer can see what the comment was about. **Re-attach** lets the
reviewer pick lines the usual way, with the gutter button or a text selection. The draft
then takes the new lines, the commit the page was rendered at, and a fresh `anchor_text`,
and loses its flag.

## API

A new module `drafts_api.py` holds a router, like `claude_api.py`. Every route needs the
access cookie and a signed-in GitHub session. All return 404 when the store is unavailable.

| Route | Does |
|---|---|
| `GET /api/pr/{owner}/{repo}/{number}/drafts` | Returns `{drafts: Draft[], githubPending: int}`. Re-checks outdated flags against the current head. `githubPending` is the number of comments in the viewer's pending review on GitHub that did not come from a draft marked `sent`. |
| `POST /api/pr/{owner}/{repo}/{number}/drafts` | With `{path, start, end, commit, body}` creates a comment draft. With `{threadId, body}` creates a reply draft. Returns the draft. |
| `PATCH /api/drafts/{id}` | With `{body}` edits the text. With `{path, start, end, commit}` re-attaches. Refused with 409 when the draft is `sent`. |
| `DELETE /api/drafts/{id}` | Deletes the draft. Refused with 409 when it is `sent`. |

`GET …/page` gains `drafts: bool`: whether the store is available.

`POST …/review` keeps its request body. Its behaviour changes as described next.

## Submitting

With no drafts to send, `POST …/review` does what it does today.

With drafts to send (not outdated), it:

1. **Finds the viewer's pending review** on the PR, or creates one at the current head.
2. **Adds each draft** whose `sent_review_id` is not that review's id:
   - a comment draft goes through `render.resolve_anchor` against the files at the head.
     Lines in a hunk become a line thread. Unchanged text becomes a file-level thread whose
     body starts with `**Re: lines N–M**`, as `create_comment` does today;
   - a reply draft is added to its thread.

   After each one, `sent_review_id` is set and `error` cleared.
3. **Submits the review** with the event and summary.
4. **Deletes** the drafts that were sent.

A Comment review needs a summary only when it carries no drafts. Request changes still
needs one.

### Failure and retry

If adding a draft fails, the route stops, stores the message in that draft's `error`, and
answers with a 502 that names the draft. Drafts sent before it stay in the pending review
on GitHub, where only the reviewer can see them.

A `sent` draft is locked: it can't be edited or deleted here, because the copy on GitHub
would no longer match. Its card says "Waiting to be submitted".

Submitting again repeats the steps. Step 2 skips drafts already in the pending review, so
nothing is posted twice. If the reviewer deleted the pending review on github.com in the
meantime, a new one is created; its id matches no draft, so every draft is sent again.

If step 3 fails, all drafts are `sent` and locked, and a retry goes straight to submitting.

### GitHub calls

New methods on `GitHub`, all GraphQL:

| Method | Call |
|---|---|
| `pending_review(pr)` | The viewer's review in state `PENDING`: its id and comment count, or None. |
| `start_review(pr, commit)` | `addPullRequestReview` with no event. |
| `add_review_thread(review_id, …)` | `addPullRequestReviewThread`, with `line`/`startLine` on side `RIGHT`, or `subjectType: FILE`. |
| `add_review_reply(review_id, thread_id, body)` | `addPullRequestReviewThreadReply`. |
| `submit_pending_review(review_id, event, body)` | `submitPullRequestReview`. |

The existing REST `submit_review` stays for reviews without drafts.

## Frontend

### Writing a draft

- `Composer`, in Comment mode, shows **Add to review** beside **Comment**. The help line
  reads "Markdown · ⌘↵ to post · ⌘⇧↵ to add to review". Ask Claude mode is unchanged.
- `ReplyBox` on a review thread shows **Add to review** beside **Reply**, with the same
  shortcut. The reply box on a Claude card is unchanged.
- Neither button shows when `page.drafts` is false.
- Re-attaching uses the composer's line picking: while a draft is being re-attached,
  choosing lines moves the draft there and does not open a new composer. Escape cancels.

### Showing drafts

- A comment draft is a new margin item kind, `draft`, with its own `DraftCard`. The header
  shows the line range and "Draft · only you". The body is plain text with line breaks
  kept. Edit swaps the body for a textarea; Delete asks first.
- An outdated draft's card adds an **Outdated** chip, the original text, and **Re-attach**.
- A reply draft is drawn at the bottom of its `ThreadCard`, after the posted comments, with
  a **Draft** chip and Edit and Delete. A thread with a reply draft is never collapsed or
  hidden by the Open filter, so a draft can't go unseen.
- A draft with an `error` shows it on the card. A `sent` draft shows "Waiting to be
  submitted" and no Edit or Delete.
- Drafts come from a React Query query, refetched when the PR's head changes.

### Finishing the review

- The **Finish review** button shows the number of drafts, e.g. "Finish review · 3".
- `FinishReview` replaces "Your margin comments are already on the PR" with what will
  happen:
  - "3 drafts will be posted with this review."
  - "1 outdated draft stays behind." when there are any.
  - "You also have 2 pending comments on GitHub; they'll be submitted too." when
    `githubPending` is above zero.
- If the submit fails, the dialog closes, a toast says which draft failed, and that draft
  becomes the active card.
- After a successful submit the activity and draft queries are refetched, so the drafts
  reappear as ordinary threads.

## Edge cases

- **The thread of a reply draft is gone** (deleted on GitHub). The draft is listed without
  a card to sit in, so it is shown in the dialog as "1 reply to a deleted thread" with a
  Delete button, and is not sent.
- **The file of a comment draft left the PR.** The draft is outdated and held back.
- **All drafts are outdated.** The dialog says so and the review is submitted without any,
  through today's path.
- **The page was rendered at an older commit than the head.** Line numbers of a draft that
  is not outdated hold the same text at both commits, so it is sent with those numbers.
- **Signed in as someone else.** Drafts belong to a login; another login sees none.
- **Two tabs.** Each refetches drafts on focus. Submitting in both is safe: the second
  finds nothing left to send.

## Out of scope

- Moving a draft automatically when its passage shifts.
- Drafting PR-level conversation comments.
- Syncing drafts between machines.
- Rendering draft bodies as markdown in the margin.

## Testing

**pytest**

- `Store`: create, list, edit, re-attach, delete, per-login isolation, the migration.
- Routes: each of the four, 409 on a `sent` draft, 404 without a store, the access cookie.
- Outdated: unchanged text, changed text, moved text, removed file, a reply; and that a
  second listing at the same head fetches nothing.
- Submit, against the fake GitHub: comment and reply drafts in one review; a file-level
  thread for unchanged text; outdated drafts left behind; an existing pending review
  reused; a failure midway then a retry that sends only the rest; a pending review deleted
  between attempts; no drafts taking today's path.

**vitest**

- `Composer` and `ReplyBox`: the second button, the shortcut, hidden when drafts are off.
- `DraftCard`: edit, delete, outdated, sent, error.
- `ThreadCard`: a reply draft, and that it keeps the thread expanded.
- `FinishReview`: each line of the summary text, and the summary rule for Comment.

**Playwright**

- Draft a question, reload, see it, delete it; nothing reaches the fake GitHub.
- Draft a comment and a reply, finish the review, and see both as posted threads.
- Push a commit that changes a drafted passage; the draft is flagged and held back.

`tests/e2e_server.py`'s fake GitHub gains the five new methods.
