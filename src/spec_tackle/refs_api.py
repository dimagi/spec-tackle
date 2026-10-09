"""Routes and the generation run for references in a document.

See docs/specs/2026-10-09-doc-references-design.md.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from . import claude, logic, refs, render
from .checkout import CheckoutError, CommitGone
from .claude_api import _signed_in
from .github import GitHubError, PRRef

router = APIRouter()

# The most lines a popup shows from another file.
MAX_TARGET_LINES = 80
# How many files Claude searches at once; the rest wait their turn.
MAX_RUNS = 2

# The last failure per run key, so a run that failed with nobody watching still says so.
_last_errors: dict[str, str] = {}
# One limit per event loop: tests start a new loop for each app.
_slots: dict[asyncio.AbstractEventLoop, asyncio.Semaphore] = {}


class Generate(BaseModel):
    path: str
    head: str
    # "changed" checks only the lines still pending after a newer commit; "full" searches the whole file.
    scope: Literal["full", "changed"] = "full"


def _key(*, login: str, pr: PRRef, path: str, sha: str) -> str:
    return f"refs:{login}:{pr.owner}/{pr.repo}#{pr.number}:{path}@{sha}"


def _slot() -> asyncio.Semaphore:
    loop = asyncio.get_running_loop()
    return _slots.setdefault(loop, asyncio.Semaphore(MAX_RUNS))


async def _state(*, state, login: str, pr: PRRef, path: str, head: str) -> dict:
    latest = head and state.store.doc_refs_at(login=login, pr=pr, path=path, head_sha=head)
    if not latest:
        latest = state.store.latest_doc_refs(login=login, pr=pr, path=path)
        if latest and head:
            latest = await _carried(state=state, login=login, pr=pr, path=path, head=head, old=latest) or latest
    key = _key(login=login, pr=pr, path=path, sha=head)
    running = bool(head) and state.turns.running(key)
    return {
        "available": True,
        "refs": latest,
        "stale": bool(latest and head and latest["headSha"] != head),
        "running": running,
        "error": None if running else _last_errors.get(key),
    }


async def _carried(*, state, login: str, pr: PRRef, path: str, head: str, old: dict) -> dict | None:
    """References from an older commit moved onto `head` and stored there, or None if that can't be done.

    Both commits' worktrees are compared line by line; no Claude call is needed.
    """
    try:
        token = await state.session.token()
        before = await state.checkouts.worktree(owner=pr.owner, repo=pr.repo, sha=old["headSha"], token=token)
        after = await state.checkouts.worktree(owner=pr.owner, repo=pr.repo, sha=head, token=token)
    except CheckoutError:  # e.g. the old commit was force-pushed away: a full search is needed
        return None
    paths = {path} | {r["targetPath"] for r in old["refs"] if r["targetPath"]}
    old_lines = {p: _lines(before, p) for p in paths}
    new_lines = {p: _lines(after, p) for p in paths}
    if new_lines[path] is None:
        return None
    kept, pending, outdated = refs.carry(old["refs"], path=path, old=old_lines, new=new_lines)
    # Lines still waiting from the older set are still waiting here too.
    doc = refs.line_map(old_lines[path] or [], new_lines[path])
    pending = sorted(set(pending) | {doc[n] for n in old["pending"] if n in doc})
    state.store.save_doc_refs(
        login=login, pr=pr, path=path, head_sha=head, refs=kept, pending=pending,
        based_on=old["headSha"], outdated=old["outdated"] + outdated,
    )
    return state.store.doc_refs_at(login=login, pr=pr, path=path, head_sha=head)


def _lines(root: Path, path: str) -> list[str] | None:
    file = Path(root) / path
    if not claude.inside(root=root, target=path) or not file.is_file():
        return None
    return file.read_text("utf-8", "replace").splitlines()


# -- the run -----------------------------------------------------------------


async def _ask(*, state, cwd: Path, snapshot: str, question: str, full_prompt: str, session_id, emit):
    """One Claude turn; progress goes to `emit`, the answer comes back."""
    writing = False
    async for event in claude.ask(
        cli=state.claude_cli,
        cwd=cwd,
        snapshot=snapshot,
        question=question,
        full_prompt=full_prompt,
        session_id=session_id,
        system=refs.REFS_SYSTEM_PROMPT,
    ):
        if event.kind == "tool":
            emit({"type": "tool", "text": event.text})
        elif event.kind == "text" and not writing:
            writing = True
            emit({"type": "tool", "text": "Listing references…"})
        elif event.kind == "done":
            return event.text, event.session_id
    return "", None


async def run_refs(
    *, state, client, token: str, login: str, pr: PRRef, path: str, sha: str, scope: str, emit,
) -> None:
    key = _key(login=login, pr=pr, path=path, sha=sha)

    def fail(message: str) -> None:
        _last_errors[key] = message
        emit({"type": "error", "text": message})

    slot = _slot()
    if slot.locked():
        emit({"type": "tool", "text": "Queued behind other files…"})
    async with slot:
        try:
            await _run(state=state, client=client, token=token, login=login, pr=pr, path=path, sha=sha,
                       scope=scope, emit=emit, fail=fail)
        except CommitGone as exc:
            fail(str(exc))
        except CheckoutError as exc:
            fail(f"Couldn't fetch the repository: {exc}")
        except GitHubError as exc:
            fail(f"Couldn't read the PR from GitHub: {exc}")
        except Exception as exc:  # noqa: BLE001 — any SDK failure is shown in the UI
            fail(claude.describe_error(exc))


async def _run(*, state, client, token: str, login: str, pr: PRRef, path: str, sha: str, scope: str, emit, fail):
    if not state.checkouts.has_clone(owner=pr.owner, repo=pr.repo):
        emit({"type": "tool", "text": f"Cloning {pr.owner}/{pr.repo}…"})
    cwd = await state.checkouts.worktree(owner=pr.owner, repo=pr.repo, sha=sha, token=token)
    emit({"type": "tool", "text": f"Reading {path}…"})
    text = _lines(cwd, path)
    if text is None:
        fail(f"{path} isn't in the checkout at {sha[:7]}.")
        return
    context = refs.snapshot(path=path, text="\n".join(text))
    if len(context) > claude.SNAPSHOT_LIMIT:
        fail("This file is too long to look for references in.")
        return

    # A set carried forward from an older commit only needs its pending lines checked.
    base = state.store.doc_refs_at(login=login, pr=pr, path=path, head_sha=sha)
    partial = scope == "changed" and base is not None
    if partial and not base["pending"]:
        emit({"type": "done", "refsId": base["id"]})
        return
    request = refs.partial_request(base["pending"]) if partial else refs.REFS_REQUEST

    answer, session = await _ask(
        state=state, cwd=cwd, snapshot=context, question=request, full_prompt=request, session_id=None, emit=emit,
    )
    found, problems = refs.parse(answer)
    if problems:
        emit({"type": "tool", "text": "Fixing the answer…"})
        repair = refs.repair_request(problems)
        full = f"{request}\n\nYour previous answer:\n{answer}\n\n{repair}"
        answer, session = await _ask(
            state=state, cwd=cwd, snapshot=context, question=repair, full_prompt=full, session_id=session, emit=emit,
        )
        found, problems = refs.parse(answer)
    if problems:
        fail(f"Claude's answer couldn't be read: {'; '.join(problems)}")
        return
    kept = refs.validate(found, text, path=path, root=cwd)
    if partial:
        wanted = set(base["pending"])
        kept = [r for r in kept if r["line"] in wanted]
    await _mark_changed(client=client, pr=pr, found=kept)
    if partial:
        kept = sorted(base["refs"] + kept, key=lambda r: r["line"])
    refs_id = state.store.save_doc_refs(
        login=login, pr=pr, path=path, head_sha=sha, refs=kept,
        based_on=base["basedOn"] if partial else None, outdated=0,
    )
    emit({"type": "done", "refsId": refs_id})


async def _mark_changed(*, client, pr: PRRef, found: list[dict]) -> None:
    """Note the PR's changed lines in each target in another file, so its popup can mark them."""
    if not any(r["targetPath"] for r in found):
        return
    changed = {
        f["filename"]: render.parse_patch(f.get("patch"))[1]
        for f in await client.files(pr)
        if f["status"] != "removed"
    }
    for r in found:
        if r["targetPath"]:
            lines = changed.get(r["targetPath"], set())
            r["changed"] = sorted(n for n in lines if r["targetStart"] <= n <= r["targetEnd"])
            r["inDiff"] = r["targetPath"] in changed


# -- routes ------------------------------------------------------------------


@router.get("/api/pr/{owner}/{repo}/{number}/refs")
async def refs_state(request: Request, owner: str, repo: str, number: int, path: str, head: str = ""):
    state = request.app.state
    if not state.claude_cli or state.store is None:
        return {"available": False, "refs": None, "stale": False, "running": False, "error": None}
    state, _, login = await _signed_in(request)
    return await _state(state=state, login=login, pr=PRRef(owner, repo, number), path=path, head=head)


@router.post("/api/pr/{owner}/{repo}/{number}/refs")
async def generate(request: Request, owner: str, repo: str, number: int, body: Generate):
    state, client, login = await _signed_in(request)
    if not render.is_markdown(body.path):
        raise HTTPException(400, "References can only be found in markdown files")
    if not body.head:
        raise HTTPException(400, "head is required")
    pr = PRRef(owner, repo, number)
    key = _key(login=login, pr=pr, path=body.path, sha=body.head)
    if not state.turns.running(key):
        _last_errors.pop(key, None)
        token = await state.session.token()
        state.turns.start(
            thread_id=key,
            work=lambda emit: run_refs(
                state=state, client=client, token=token, login=login, pr=pr,
                path=body.path, sha=body.head, scope=body.scope, emit=emit,
            ),
        )
    return await _state(state=state, login=login, pr=pr, path=body.path, head=body.head)


@router.get("/api/pr/{owner}/{repo}/{number}/refs/events")
async def refs_events(request: Request, owner: str, repo: str, number: int, path: str, head: str):
    state, _, login = await _signed_in(request)
    key = _key(login=login, pr=PRRef(owner, repo, number), path=path, sha=head)

    async def stream():
        if not state.turns.running(key):
            yield f"data: {json.dumps({'type': 'idle'})}\n\n"
            return
        async for event in state.turns.subscribe(key):
            yield f"data: {json.dumps(event)}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


@router.get("/api/refs/{refs_id}/{index}/target")
async def ref_target(request: Request, refs_id: str, index: int):
    """What a reference to another file points at, read from the checkout: rendered markdown or code."""
    state, _, login = await _signed_in(request)
    saved = state.store.doc_refs(login=login, refs_id=refs_id)
    ref = saved["refs"][index] if saved and 0 <= index < len(saved["refs"]) else None
    if not ref or not ref.get("targetPath"):
        raise HTTPException(404, "No such reference")
    owner, repo, sha, path = saved["owner"], saved["repo"], saved["headSha"], ref["targetPath"]
    token = await state.session.token()
    try:
        root = await state.checkouts.worktree(owner=owner, repo=repo, sha=sha, token=token)
    except CheckoutError as exc:
        raise HTTPException(502, f"Couldn't fetch the repository: {exc}")
    start = ref["targetStart"]
    end = min(ref["targetEnd"], start + MAX_TARGET_LINES - 1)
    out = {
        "path": path, "start": start, "end": end, "truncated": end < ref["targetEnd"],
        "inDiff": ref.get("inDiff", False),
        "githubUrl": f"https://github.com/{owner}/{repo}/blob/{sha}/{path}#L{start}-L{ref['targetEnd']}",
    }
    if render.is_markdown(path):
        html = render.render_markdown(
            claude.read_lines(root=root, path=path, start=start, end=end), path=path,
            raw_base=f"/raw/{owner}/{repo}/{sha}", blob_base=f"https://github.com/{owner}/{repo}/blob/{sha}",
        )
        return {**out, "kind": "markdown", "html": html}
    source = logic.function_source(
        root, {"path": path, "symbol": "", "start": start, "end": end}, changed=set(ref.get("changed", [])),
    )
    return {**out, "kind": "code", "lines": source["lines"]}
