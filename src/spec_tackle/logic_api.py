"""The Logic view's routes and its generation run (see docs/specs/2026-10-08-logic-view-design.md)."""

from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from . import claude, logic, render
from .checkout import CheckoutError, CommitGone
from .claude_api import _signed_in
from .github import GitHubError, PRRef

router = APIRouter()


def _key(*, login: str, pr: PRRef, sha: str) -> str:
    return f"logic:{login}:{pr.owner}/{pr.repo}#{pr.number}@{sha}"


def _public(m: dict | None) -> dict | None:
    if m is None:
        return None
    return {k: m[k] for k in ("id", "headSha", "summary", "blocks", "createdAt")}


def _state(*, state, login: str, pr: PRRef, head: str) -> dict:
    latest = state.store.latest_logic_map(login=login, pr=pr)
    return {
        "available": True,
        "map": _public(latest),
        "stale": bool(latest and head and latest["headSha"] != head),
        "running": bool(head) and state.turns.running(_key(login=login, pr=pr, sha=head)),
    }


# -- the run -----------------------------------------------------------------


async def _ask(*, state, cwd, snapshot: str, question: str, full_prompt: str, session_id, emit):
    """One Claude turn for the map; progress goes to `emit`, the answer comes back."""
    writing = False
    async for event in claude.ask(
        cli=state.claude_cli,
        cwd=cwd,
        snapshot=snapshot,
        question=question,
        full_prompt=full_prompt,
        session_id=session_id,
        system=logic.LOGIC_SYSTEM_PROMPT,
    ):
        if event.kind == "tool":
            emit({"type": "tool", "text": event.text})
        elif event.kind == "text" and not writing:
            writing = True  # the answer itself is JSON; show that it's coming, not the JSON
            emit({"type": "tool", "text": "Writing the map…"})
        elif event.kind == "done":
            return event.text, event.session_id
    return "", None


def _check(text: str, cwd) -> tuple[dict | None, list[str]]:
    data, problems = logic.parse_answer(text)
    if problems:
        return None, problems
    return logic.validate_map(data, cwd)


async def run_logic(*, state, client, token: str, login: str, pr: PRRef, overview: dict, emit) -> None:
    sha = overview["headRefOid"]
    try:
        if not state.checkouts.has_clone(owner=pr.owner, repo=pr.repo):
            emit({"type": "tool", "text": f"Cloning {pr.owner}/{pr.repo}…"})
        cwd = await state.checkouts.worktree(owner=pr.owner, repo=pr.repo, sha=sha, token=token)
        emit({"type": "tool", "text": "Reading the PR…"})
        files = await client.files(pr)
        markdown = {
            f["filename"]: claude.read_lines(root=cwd, path=f["filename"], start=1, end=10**9)
            for f in files
            if render.is_markdown(f["filename"]) and f["status"] != "removed"
        }
        snapshot = claude.build_context(
            overview=overview, files=files, markdown=markdown,
            activity=render.normalize_activity(overview), commit=sha,
        )
        changed = {
            f["filename"]: sorted(render.parse_patch(f.get("patch"))[1])
            for f in files
            if f["status"] != "removed"
        }

        text, session = await _ask(
            state=state, cwd=cwd, snapshot=snapshot, question=logic.LOGIC_REQUEST,
            full_prompt=logic.LOGIC_REQUEST, session_id=None, emit=emit,
        )
        result, problems = _check(text, cwd)
        if problems:
            emit({"type": "tool", "text": "Fixing the map…"})
            repair = logic.repair_request(problems)
            # If the session has expired, the replay still needs the first answer to fix it.
            full = f"{logic.LOGIC_REQUEST}\n\nYour previous answer:\n{text}\n\n{repair}"
            text, session = await _ask(
                state=state, cwd=cwd, snapshot=snapshot, question=repair,
                full_prompt=full, session_id=session, emit=emit,
            )
            result, problems = _check(text, cwd)
        if problems:
            shown = "; ".join(problems[:5]) + (f" (and {len(problems) - 5} more)" if len(problems) > 5 else "")
            emit({"type": "error", "text": f"Claude's map didn't pass validation: {shown}"})
            return
        map_id = state.store.save_logic_map(
            login=login, pr=pr, head_sha=sha, summary=result["summary"],
            blocks=result["blocks"], changed_lines=changed,
        )
        emit({"type": "done", "mapId": map_id})
    except CommitGone as exc:
        emit({"type": "error", "text": str(exc)})
    except CheckoutError as exc:
        emit({"type": "error", "text": f"Couldn't fetch the repository: {exc}"})
    except GitHubError as exc:
        emit({"type": "error", "text": f"Couldn't read the PR from GitHub: {exc}"})
    except Exception as exc:  # noqa: BLE001 — any SDK failure is shown in the view
        emit({"type": "error", "text": claude.describe_error(exc)})


# -- routes ------------------------------------------------------------------


@router.get("/api/pr/{owner}/{repo}/{number}/logic")
async def logic_state(request: Request, owner: str, repo: str, number: int, head: str = ""):
    state = request.app.state
    if not state.claude_cli or state.store is None:
        return {"available": False, "map": None, "stale": False, "running": False}
    state, _, login = await _signed_in(request)
    return _state(state=state, login=login, pr=PRRef(owner, repo, number), head=head)


@router.post("/api/pr/{owner}/{repo}/{number}/logic")
async def generate(request: Request, owner: str, repo: str, number: int):
    state, client, login = await _signed_in(request)
    pr = PRRef(owner, repo, number)
    overview = await client.overview(pr)
    sha = overview["headRefOid"]
    key = _key(login=login, pr=pr, sha=sha)
    if not state.turns.running(key):
        token = await state.session.token()
        state.turns.start(
            thread_id=key,
            work=lambda emit: run_logic(
                state=state, client=client, token=token, login=login, pr=pr, overview=overview, emit=emit
            ),
        )
    return {**_state(state=state, login=login, pr=pr, head=sha), "head": sha}


@router.get("/api/pr/{owner}/{repo}/{number}/logic/events")
async def logic_events(request: Request, owner: str, repo: str, number: int, head: str):
    state, _, login = await _signed_in(request)
    key = _key(login=login, pr=PRRef(owner, repo, number), sha=head)

    async def stream():
        if not state.turns.running(key):
            yield f"data: {json.dumps({'type': 'idle'})}\n\n"
            return
        async for event in state.turns.subscribe(key):
            yield f"data: {json.dumps(event)}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


@router.get("/api/logic/{map_id}/blocks/{block_id}/functions")
async def block_functions(request: Request, map_id: str, block_id: str):
    state, _, login = await _signed_in(request)
    saved = state.store.logic_map(login=login, map_id=map_id)
    block = saved and logic.find_block(saved["blocks"], block_id)
    if not block or "children" in block:
        raise HTTPException(404, "No such block")
    token = await state.session.token()
    try:
        root = await state.checkouts.worktree(
            owner=saved["owner"], repo=saved["repo"], sha=saved["headSha"], token=token
        )
    except CheckoutError as exc:
        raise HTTPException(502, f"Couldn't fetch the repository: {exc}")
    changed = saved["changedLines"]
    functions = []
    for ref in block.get("functions", []):
        try:
            source = logic.function_source(root, ref, changed=set(changed.get(ref["path"], [])))
        except ValueError:
            source = {**ref, "lines": [], "missing": "File not found in the checkout"}
        functions.append({**source, "inDiff": ref["path"] in changed})
    return {"label": block["label"], "headSha": saved["headSha"], "functions": functions}
