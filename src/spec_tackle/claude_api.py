"""Private Claude threads: the HTTP routes and what one turn does."""

from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from . import claude, render
from .checkout import CheckoutError, CommitGone
from .github import PRRef
from .turns import Busy

router = APIRouter()


class NewQuestion(BaseModel):
    path: str
    start: int
    end: int
    commit: str
    question: str


class FollowUp(BaseModel):
    question: str


# -- one turn ----------------------------------------------------------------


async def run_turn(*, state, client, token: str, login: str, thread_id: str, emit) -> None:
    """Check out the thread's commit, build its snapshot once, ask Claude, save the result."""
    store = state.store
    thread = store.thread(login=login, thread_id=thread_id)
    pr = PRRef(thread["owner"], thread["repo"], thread["number"])
    try:
        if not state.checkouts.has_clone(owner=pr.owner, repo=pr.repo):
            emit({"type": "tool", "text": f"Cloning {pr.owner}/{pr.repo}…"})
        cwd = await state.checkouts.worktree(
            owner=pr.owner, repo=pr.repo, sha=thread["commit"], token=token
        )
        if thread["snapshot"] is None:
            anchor = claude.read_lines(
                root=cwd, path=thread["path"], start=thread["startLine"], end=thread["endLine"]
            )
            emit({"type": "tool", "text": "Reading the PR…"})
            overview, files = await asyncio.gather(client.overview(pr), client.files(pr))
            markdown = {
                f["filename"]: claude.read_lines(root=cwd, path=f["filename"], start=1, end=10**9)
                for f in files
                if render.is_markdown(f["filename"]) and f["status"] != "removed"
            }
            snapshot = claude.build_context(
                overview=overview,
                files=files,
                markdown=markdown,
                activity=render.normalize_activity(overview),
                commit=thread["commit"],
            )
            store.set_thread_context(thread_id=thread_id, anchor_text=anchor, snapshot=snapshot)
            thread = store.thread(login=login, thread_id=thread_id)

        *earlier, last = thread["messages"]
        full_prompt = claude.turn_prompt(thread={**thread, "messages": earlier}, question=last["body"])
        async for event in claude.ask(
            cli=state.claude_cli,
            cwd=cwd,
            snapshot=thread["snapshot"],
            question=last["body"],
            full_prompt=full_prompt,
            session_id=thread["sessionId"],
        ):
            if event.kind == "done":
                store.add_message(thread_id=thread_id, role="assistant", body=event.text)
                if event.session_id:
                    store.set_session(thread_id=thread_id, session_id=event.session_id)
                emit({"type": "done", "body": event.text, "bodyHTML": render.render_answer(event.text)})
            else:
                emit({"type": event.kind, "text": event.text})
    except CommitGone as exc:
        _fail(store=store, thread_id=thread_id, emit=emit, message=str(exc))
    except CheckoutError as exc:
        _fail(store=store, thread_id=thread_id, emit=emit, message=f"Couldn't fetch the repository: {exc}")
    except ValueError as exc:  # anchor path outside the checkout
        _fail(store=store, thread_id=thread_id, emit=emit, message=str(exc))
    except Exception as exc:  # noqa: BLE001 — any SDK or GitHub failure is shown in the thread
        _fail(store=store, thread_id=thread_id, emit=emit, message=claude.describe_error(exc))


def _fail(*, store, thread_id: str, emit, message: str) -> None:
    store.add_message(thread_id=thread_id, role="error", body=message)
    emit({"type": "error", "text": message})


# -- routes ------------------------------------------------------------------


def _enabled(request: Request):
    state = request.app.state
    if not state.claude_cli or state.store is None:
        raise HTTPException(404, "Claude Code isn't installed")
    return state


async def _signed_in(request: Request) -> tuple:
    state = _enabled(request)
    client = await state.session.client()  # raises NotSignedIn → 401 via the app's handler
    login = (await state.session.viewer())["login"]
    return state, client, login


def _public(*, state, thread: dict) -> dict:
    messages = [
        {**m, "bodyHTML": render.render_answer(m["body"])} if m["role"] == "assistant" else m
        for m in thread["messages"]
    ]
    return {
        "id": thread["id"],
        "path": thread["path"],
        "startLine": thread["startLine"],
        "endLine": thread["endLine"],
        "anchorText": thread["anchorText"],
        "commit": thread["commit"],
        "createdAt": thread["createdAt"],
        "running": state.turns.running(thread["id"]),
        "messages": messages,
    }


async def _start(*, state, client, login: str, thread_id: str) -> None:
    token = await state.session.token()
    state.turns.start(
        thread_id=thread_id,
        work=lambda emit: run_turn(
            state=state, client=client, token=token, login=login, thread_id=thread_id, emit=emit
        ),
    )


def _question(text: str) -> str:
    if not text.strip():
        raise HTTPException(400, "Ask a question first")
    return text.strip()


@router.get("/api/pr/{owner}/{repo}/{number}/claude/threads")
async def list_threads(request: Request, owner: str, repo: str, number: int):
    state, _, login = await _signed_in(request)
    threads = state.store.threads_for_pr(login=login, pr=PRRef(owner, repo, number))
    return [_public(state=state, thread=t) for t in threads]


@router.post("/api/pr/{owner}/{repo}/{number}/claude/threads")
async def create_thread(request: Request, owner: str, repo: str, number: int, q: NewQuestion):
    state, client, login = await _signed_in(request)
    question = _question(q.question)
    thread_id = state.store.create_thread(
        login=login, pr=PRRef(owner, repo, number), path=q.path, start=q.start, end=q.end, commit=q.commit
    )
    state.store.add_message(thread_id=thread_id, role="user", body=question)
    await _start(state=state, client=client, login=login, thread_id=thread_id)
    return _public(state=state, thread=state.store.thread(login=login, thread_id=thread_id))


@router.post("/api/claude/threads/{thread_id}/messages")
async def follow_up(request: Request, thread_id: str, q: FollowUp):
    state, client, login = await _signed_in(request)
    question = _question(q.question)
    if state.store.thread(login=login, thread_id=thread_id) is None:
        raise HTTPException(404, "No such thread")
    if state.turns.running(thread_id):
        raise HTTPException(409, "Claude is still answering")
    state.store.add_message(thread_id=thread_id, role="user", body=question)
    try:
        await _start(state=state, client=client, login=login, thread_id=thread_id)
    except Busy:
        raise HTTPException(409, "Claude is still answering")
    return _public(state=state, thread=state.store.thread(login=login, thread_id=thread_id))


@router.get("/api/claude/threads/{thread_id}/events")
async def events(request: Request, thread_id: str):
    state, _, login = await _signed_in(request)
    if state.store.thread(login=login, thread_id=thread_id) is None:
        raise HTTPException(404, "No such thread")

    async def stream():
        if not state.turns.running(thread_id):
            yield f"data: {json.dumps({'type': 'idle'})}\n\n"
            return
        async for event in state.turns.subscribe(thread_id):
            yield f"data: {json.dumps(event)}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


@router.delete("/api/claude/threads/{thread_id}")
async def delete_thread(request: Request, thread_id: str):
    state, _, login = await _signed_in(request)
    if state.store.thread(login=login, thread_id=thread_id) is None:
        raise HTTPException(404, "No such thread")
    state.turns.cancel(thread_id)
    state.store.delete_thread(login=login, thread_id=thread_id)
    return {"ok": True}
