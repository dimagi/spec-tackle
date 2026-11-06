"""Review drafts: comments and replies kept locally until the review is submitted.

See docs/specs/2026-10-13-draft-comments-design.md.
"""

from __future__ import annotations

from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from . import render
from .github import GitHubError, PRRef

router = APIRouter()


class NewDraft(BaseModel):
    body: str
    # a comment on lines
    path: str | None = None
    start: int | None = None
    end: int | None = None
    commit: str | None = None
    # a reply
    threadId: str | None = None


class DraftChange(BaseModel):
    body: str | None = None
    # re-attaching
    path: str | None = None
    start: int | None = None
    end: int | None = None
    commit: str | None = None


# -- anchors and outdated ----------------------------------------------------


def _lines(text: str, start: int, end: int) -> str | None:
    """Source lines `start`–`end` (1-based), or None if the text doesn't reach that far."""
    lines = text.splitlines()[start - 1:end]
    return "\n".join(lines) if len(lines) == end - start + 1 else None


async def _anchor_text(client, pr: PRRef, *, path, start, end, commit) -> str:
    if not path or not commit or start is None or end is None:
        raise HTTPException(400, "A draft needs lines to sit on, or a thread to reply to")
    if not 1 <= start <= end:
        raise HTTPException(400, "Unknown lines")
    text = (await client.raw_file(pr.owner, pr.repo, quote(path), commit)).decode("utf-8", "replace")
    anchor = _lines(text, start, end)
    if anchor is None:
        raise HTTPException(400, f"{path} has no such lines")
    return anchor


async def _text_at(client, pr: PRRef, path: str, commit: str) -> str | None:
    try:
        return (await client.raw_file(pr.owner, pr.repo, quote(path), commit)).decode("utf-8", "replace")
    except GitHubError as exc:
        if exc.status == 404:
            return None
        raise


def _is_sent(draft: dict, state: dict) -> bool:
    """Whether the draft is already in the pending review on GitHub."""
    pending = state["pending"]
    return bool(pending) and draft["sentReviewId"] == pending["id"]


async def _current(*, store, client, login: str, pr: PRRef, state: dict) -> list[dict]:
    """The PR's drafts, with `outdated` worked out for the head commit.

    A comment draft is outdated when its lines no longer hold the text it was written
    against. Each draft is checked once per head commit.
    """
    head = state["head"]
    drafts = store.drafts_for_pr(login=login, pr=pr)
    unchecked = [
        d for d in drafts
        if d["kind"] == "comment" and d["checkedSha"] != head and not _is_sent(d, state)
    ]
    if not unchecked:
        return drafts
    in_pr = {f["filename"] for f in await client.files(pr) if f["status"] != "removed"}
    texts: dict[str, str | None] = {}
    for draft in unchecked:
        path = draft["path"]
        if path not in texts:
            texts[path] = await _text_at(client, pr, path, head) if path in in_pr else None
        text = texts[path]
        outdated = text is None or _lines(text, draft["startLine"], draft["endLine"]) != draft["anchorText"]
        store.set_draft_outdated(draft_id=draft["id"], checked_sha=head, outdated=outdated)
    return store.drafts_for_pr(login=login, pr=pr)


def _public(draft: dict, state: dict) -> dict:
    sent = _is_sent(draft, state)
    return {
        "id": draft["id"],
        "kind": draft["kind"],
        "body": draft["body"],
        "path": draft["path"],
        "startLine": draft["startLine"],
        "endLine": draft["endLine"],
        "anchorText": draft["anchorText"],
        "commit": draft["commit"],
        # A draft already on GitHub goes out with the review whatever happens to its lines.
        "outdated": draft["outdated"] and not sent,
        "threadId": draft["threadId"],
        "sent": sent,
        "error": draft["error"],
        "createdAt": draft["createdAt"],
        "updatedAt": draft["updatedAt"],
    }


# -- routes ------------------------------------------------------------------


async def _signed_in(request: Request) -> tuple:
    state = request.app.state
    if state.store is None:
        raise HTTPException(404, "Drafts need spec-tackle's local store, which couldn't be opened")
    client = await state.session.client()  # raises NotSignedIn → 401 via the app's handler
    login = (await state.session.viewer())["login"]
    return state.store, client, login


def _body(text: str | None) -> str:
    if not text or not text.strip():
        raise HTTPException(400, "Comment cannot be empty")
    return text.strip()


@router.get("/api/pr/{owner}/{repo}/{number}/drafts")
async def list_drafts(request: Request, owner: str, repo: str, number: int):
    store, client, login = await _signed_in(request)
    pr = PRRef(owner, repo, number)
    state = await client.review_state(pr)
    drafts = await _current(store=store, client=client, login=login, pr=pr, state=state)
    public = [_public(d, state) for d in drafts]
    pending = state["pending"]["comments"] if state["pending"] else 0
    return {"drafts": public, "githubPending": max(0, pending - sum(d["sent"] for d in public))}


@router.post("/api/pr/{owner}/{repo}/{number}/drafts")
async def create_draft(request: Request, owner: str, repo: str, number: int, d: NewDraft):
    store, client, login = await _signed_in(request)
    pr = PRRef(owner, repo, number)
    body = _body(d.body)
    if d.threadId:
        draft_id = store.create_reply_draft(login=login, pr=pr, thread_id=d.threadId, body=body)
    else:
        anchor = await _anchor_text(client, pr, path=d.path, start=d.start, end=d.end, commit=d.commit)
        draft_id = store.create_comment_draft(
            login=login, pr=pr, path=d.path, start=d.start, end=d.end, anchor_text=anchor,
            commit=d.commit, body=body,
        )
    # Nothing of a new draft is on GitHub, so there is no pending review to compare it with.
    return _public(store.draft(login=login, draft_id=draft_id), {"pending": None})


async def _editable(*, store, client, login: str, draft_id: str) -> tuple[dict, PRRef, dict]:
    draft = store.draft(login=login, draft_id=draft_id)
    if draft is None:
        raise HTTPException(404, "No such draft")
    pr = PRRef(draft["owner"], draft["repo"], draft["number"])
    state = {"pending": None}
    if draft["sentReviewId"]:
        state = await client.review_state(pr)
        if _is_sent(draft, state):
            raise HTTPException(
                409, "This draft is already in your pending review on GitHub. Submit the review to post it."
            )
    return draft, pr, state


@router.patch("/api/drafts/{draft_id}")
async def change_draft(request: Request, draft_id: str, c: DraftChange):
    store, client, login = await _signed_in(request)
    draft, pr, state = await _editable(store=store, client=client, login=login, draft_id=draft_id)
    if c.body is not None:
        store.set_draft_body(draft_id=draft_id, body=_body(c.body))
    if c.path is not None:
        if draft["kind"] != "comment":
            raise HTTPException(400, "A reply stays with its thread")
        anchor = await _anchor_text(client, pr, path=c.path, start=c.start, end=c.end, commit=c.commit)
        store.reattach_draft(
            draft_id=draft_id, path=c.path, start=c.start, end=c.end, anchor_text=anchor, commit=c.commit
        )
    return _public(store.draft(login=login, draft_id=draft_id), state)


@router.delete("/api/drafts/{draft_id}")
async def delete_draft(request: Request, draft_id: str):
    store, client, login = await _signed_in(request)
    await _editable(store=store, client=client, login=login, draft_id=draft_id)
    store.delete_draft(login=login, draft_id=draft_id)
    return {"ok": True}


# -- submitting --------------------------------------------------------------


def _thread(draft: dict, file: dict | None) -> dict:
    """Where a comment draft goes in the review: its lines if the PR changed them, else the file."""
    if file is None:
        raise GitHubError(f"{draft['path']} is no longer part of this PR", 502)
    start, end = draft["startLine"], draft["endLine"]
    hunks, _ = render.parse_patch(file.get("patch"))
    anchor = render.resolve_anchor(start, end, hunks, file["status"] == "added")
    if anchor:
        return {"path": draft["path"], "body": draft["body"], "line": anchor["line"],
                "start_line": anchor["start_line"]}
    # Unchanged text can't take a line comment; fall back to a file-level one.
    lines = f"line {start}" if start == end else f"lines {start}–{end}"
    return {"path": draft["path"], "body": f"**Re: {lines}**\n\n{draft['body']}"}


async def _plain_review(client, pr: PRRef, *, event: str, body: str, held: int) -> dict:
    if event != "APPROVE":
        _body(body)
    await client.submit_review(pr, event, body)
    return {"sent": 0, "held": held}


async def submit_review(*, store, client, login: str, pr: PRRef, event: str, body: str):
    """Post a review, carrying every draft that can go with it.

    Drafts are added one at a time to the viewer's pending review on GitHub, which is then
    submitted. Each draft is marked as sent once GitHub has it, so trying again after a
    failure sends only the rest.
    """
    if store is None or not store.drafts_for_pr(login=login, pr=pr):
        return await _plain_review(client, pr, event=event, body=body, held=0)

    state = await client.review_state(pr)
    drafts = await _current(store=store, client=client, login=login, pr=pr, state=state)
    threads: set[str] = set()
    if any(d["kind"] == "reply" and not _is_sent(d, state) for d in drafts):
        threads = {t["id"] for t in (await client.activity(pr))["reviewThreads"]["nodes"]}
    sending = [
        d for d in drafts
        if _is_sent(d, state) or (d["threadId"] in threads if d["kind"] == "reply" else not d["outdated"])
    ]
    held = len(drafts) - len(sending)
    if not sending:
        return await _plain_review(client, pr, event=event, body=body, held=held)
    if event == "REQUEST_CHANGES":
        _body(body)

    pending = state["pending"]
    review_id = pending["id"] if pending else await client.start_review(state["pullRequestId"], state["head"])
    files: dict[str, dict] | None = None
    for draft in sending:
        if draft["sentReviewId"] == review_id:
            continue
        try:
            if draft["kind"] == "reply":
                await client.add_review_reply(review_id, draft["threadId"], draft["body"])
            else:
                if files is None:
                    files = {f["filename"]: f for f in await client.files(pr)}
                await client.add_review_thread(review_id, **_thread(draft, files.get(draft["path"])))
        except GitHubError as exc:
            if exc.status == 401:
                raise
            store.set_draft_error(draft_id=draft["id"], error=str(exc))
            return JSONResponse(
                {"error": f"A draft couldn't be added to the review: {exc}", "draftId": draft["id"],
                 "signedOut": False},
                status_code=502,
            )
        store.mark_draft_sent(draft_id=draft["id"], review_id=review_id)

    await client.submit_pending_review(review_id, event, body)
    for draft in sending:
        store.delete_draft(login=login, draft_id=draft["id"])
    return {"sent": len(sending), "held": held}
