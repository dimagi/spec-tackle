# src/spec_tackle/walkthrough_api.py
"""The Logic walkthrough's routes and its run (see docs/specs/2026-10-10-logic-walkthrough-design.md).

Claude traces the code by reading it. Nothing here runs code from the repository: the
session comes from claude.ask with Read/Grep/Glob only, and the only processes are the git
commands Checkouts already runs.
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from . import claude, logic, walkthrough
from .checkout import CheckoutError, CommitGone
from .claude_api import _signed_in
from .github import GitHubError, PRRef
from .logic_api import ask_json, pr_snapshot

router = APIRouter()

# The last failure per run key, so a run that failed with nobody watching still says so.
_last_errors: dict[str, str] = {}


class WalkRequest(BaseModel):
    entry: str
    inputs: dict[str, Any] | None = None


def _key(*, login: str, map_id: str, entry: str) -> str:
    return f"walk:{login}:{map_id}:{entry}"


async def _walk_map(request: Request, map_id: str, entry: str):
    """The signed-in user's map and a valid entry in it, or 404."""
    state, client, login = await _signed_in(request)
    saved = state.store.logic_map(login=login, map_id=map_id)
    if not saved or entry not in walkthrough.entry_ids(saved["blocks"]):
        raise HTTPException(404, "No such map or entry")
    return state, client, login, saved


def _state(*, state, login: str, map_id: str, entry: str) -> dict:
    key = _key(login=login, map_id=map_id, entry=entry)
    running = state.turns.running(key)
    proposed = state.store.proposed_trace(login=login, map_id=map_id, entry_id=entry)
    return {
        "trace": state.store.latest_trace(login=login, map_id=map_id, entry_id=entry),
        "starting": proposed["inputs"] if proposed else None,
        "running": running,
        "error": None if running else _last_errors.get(key),
    }


def _check(text: str, saved: dict, entry: str, inputs: list[dict] | None):
    data, problems = logic.parse_answer(text)
    if problems:
        return None, problems
    return walkthrough.validate_trace(data, blocks=saved["blocks"], entry_id=entry, inputs=inputs)


async def run_walk(*, state, client, token: str, login: str, saved: dict, entry: str,
                   inputs: list[dict] | None, emit) -> None:
    pr = PRRef(saved["owner"], saved["repo"], saved["number"])
    sha = saved["headSha"]
    key = _key(login=login, map_id=saved["id"], entry=entry)

    def fail(message: str) -> None:
        _last_errors[key] = message
        emit({"type": "error", "text": message})

    try:
        if not state.checkouts.has_clone(owner=pr.owner, repo=pr.repo):
            emit({"type": "tool", "text": f"Cloning {pr.owner}/{pr.repo}…"})
        cwd = await state.checkouts.worktree(owner=pr.owner, repo=pr.repo, sha=sha, token=token)
        emit({"type": "tool", "text": "Reading the PR…"})
        overview = await client.overview(pr)
        snapshot, _ = await pr_snapshot(client=client, pr=pr, overview=overview, cwd=cwd, sha=sha)
        block = logic.find_block(saved["blocks"], entry)
        ask = (walkthrough.propose_request(saved["blocks"], block) if inputs is None
               else walkthrough.fixed_request(saved["blocks"], block, inputs))
        common = dict(state=state, cwd=cwd, snapshot=snapshot, emit=emit,
                      system=walkthrough.WALK_SYSTEM_PROMPT, writing="Writing the trace…")

        text, session = await ask_json(question=ask, full_prompt=ask, session_id=None, **common)
        result, problems = _check(text, saved, entry, inputs)
        if problems:
            emit({"type": "tool", "text": "Fixing the trace…"})
            repair = walkthrough.repair_request(problems)
            # If the session has expired, the replay still needs the first answer to fix it.
            full = f"{ask}\n\nYour previous answer:\n{text}\n\n{repair}"
            text, session = await ask_json(question=repair, full_prompt=full, session_id=session, **common)
            result, problems = _check(text, saved, entry, inputs)
        if problems:
            shown = "; ".join(problems[:5]) + (f" (and {len(problems) - 5} more)" if len(problems) > 5 else "")
            fail(f"Claude's walkthrough didn't pass validation: {shown}")
            return
        trace_id = state.store.save_trace(
            login=login, map_id=saved["id"], entry_id=entry,
            input_hash=walkthrough.input_hash(walkthrough.values_of(result["inputs"])),
            inputs=result["inputs"], steps=result["steps"], outcome=result["outcome"],
            proposed=inputs is None,
        )
        emit({"type": "done", "traceId": trace_id})
    except CommitGone as exc:
        fail(str(exc))
    except CheckoutError as exc:
        fail(f"Couldn't fetch the repository: {exc}")
    except GitHubError as exc:
        fail(f"Couldn't read the PR from GitHub: {exc}")
    except Exception as exc:  # noqa: BLE001 — any SDK failure is shown in the panel
        fail(claude.describe_error(exc))


@router.get("/api/logic/{map_id}/walkthrough")
async def walk_state(request: Request, map_id: str, entry: str):
    state, _, login, _ = await _walk_map(request, map_id, entry)
    return _state(state=state, login=login, map_id=map_id, entry=entry)


@router.post("/api/logic/{map_id}/walkthrough")
async def walk_run(request: Request, map_id: str, body: WalkRequest):
    state, client, login, saved = await _walk_map(request, map_id, body.entry)
    key = _key(login=login, map_id=map_id, entry=body.entry)
    if state.turns.running(key):
        return _state(state=state, login=login, map_id=map_id, entry=body.entry)

    inputs = None
    if body.inputs is not None:
        proposed = state.store.proposed_trace(login=login, map_id=map_id, entry_id=body.entry)
        if not proposed:
            raise HTTPException(400, "This entry has no starting inputs yet")
        if set(body.inputs) != {i["name"] for i in proposed["inputs"]}:
            raise HTTPException(400, "The inputs must have the same names as the starting inputs")
        cached = state.store.trace_by_hash(login=login, map_id=map_id, entry_id=body.entry,
                                           input_hash=walkthrough.input_hash(body.inputs))
        if cached:
            state.store.touch_trace(trace_id=cached["id"])
            return _state(state=state, login=login, map_id=map_id, entry=body.entry)
        inputs = [{**i, "value": body.inputs[i["name"]]} for i in proposed["inputs"]]
    else:
        proposed = state.store.proposed_trace(login=login, map_id=map_id, entry_id=body.entry)
        if proposed:
            state.store.touch_trace(trace_id=proposed["id"])
            return _state(state=state, login=login, map_id=map_id, entry=body.entry)

    _last_errors.pop(key, None)
    token = await state.session.token()
    state.turns.start(
        thread_id=key,
        work=lambda emit: run_walk(state=state, client=client, token=token, login=login, saved=saved,
                                   entry=body.entry, inputs=inputs, emit=emit),
    )
    return _state(state=state, login=login, map_id=map_id, entry=body.entry)


@router.get("/api/logic/{map_id}/walkthrough/events")
async def walk_events(request: Request, map_id: str, entry: str):
    state, _, login, _ = await _walk_map(request, map_id, entry)
    key = _key(login=login, map_id=map_id, entry=entry)

    async def stream():
        if not state.turns.running(key):
            yield f"data: {json.dumps({'type': 'idle'})}\n\n"
            return
        async for event in state.turns.subscribe(key):
            yield f"data: {json.dumps(event)}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


@router.get("/api/logic/traces/{trace_id}")
async def get_trace(request: Request, trace_id: str):
    state, _, login = await _signed_in(request)
    trace = state.store.trace(login=login, trace_id=trace_id)
    if not trace:
        raise HTTPException(404, "No such trace")
    return trace
