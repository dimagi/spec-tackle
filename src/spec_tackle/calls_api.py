"""The call tree's routes (see docs/specs/2026-10-10-call-tree-design.md).

The analysis is pure and the same for every run on a commit, so it's kept in memory,
not in the store, and it works without Claude.
"""

from __future__ import annotations

import asyncio
from collections import OrderedDict

from fastapi import APIRouter, HTTPException, Request

from . import calls, logic, render
from .checkout import CheckoutError, CommitGone
from .github import GitHubError, PRRef

router = APIRouter()

CACHE_SIZE = 8
# (owner, repo, number, sha) -> the analysis, shared by requests that arrive while it runs.
_cache: OrderedDict[tuple, asyncio.Future] = OrderedDict()


async def _compute(state, client, pr: PRRef, head: str) -> dict:
    token = await state.session.token()
    files = await client.files(pr)
    root = await state.checkouts.worktree(owner=pr.owner, repo=pr.repo, sha=head, token=token)
    tree = await asyncio.to_thread(calls.analyse, root, files)
    changed = {
        f["filename"]: set(render.parse_patch(f.get("patch"))[1]) for f in files if f["status"] != "removed"
    }
    return {"root": root, "tree": tree, "changed": changed, "nodes": {n["id"]: n for n in tree["nodes"]}}


async def _analysis(request: Request, owner: str, repo: str, number: int, head: str) -> dict:
    state = request.app.state
    client = await state.session.client()  # raises NotSignedIn → 401 via the app's handler
    pr = PRRef(owner, repo, number)
    key = (owner, repo, number, head)
    task = _cache.get(key)
    if task is None:
        task = asyncio.ensure_future(_compute(state, client, pr, head))
        _cache[key] = task
        while len(_cache) > CACHE_SIZE:
            _cache.popitem(last=False)
    else:
        _cache.move_to_end(key)
    try:
        return await asyncio.shield(task)
    except Exception as exc:
        if _cache.get(key) is task:
            del _cache[key]  # a retry computes it again
        if isinstance(exc, CommitGone):
            raise HTTPException(409, str(exc))
        if isinstance(exc, CheckoutError):
            raise HTTPException(502, f"Couldn't fetch the repository: {exc}")
        if isinstance(exc, GitHubError):
            raise HTTPException(502, f"Couldn't read the PR from GitHub: {exc}")
        raise


@router.get("/api/pr/{owner}/{repo}/{number}/calls")
async def call_tree(request: Request, owner: str, repo: str, number: int, head: str):
    analysis = await _analysis(request, owner, repo, number, head)
    return {**analysis["tree"], "headSha": head}


@router.get("/api/pr/{owner}/{repo}/{number}/calls/source")
async def call_source(request: Request, owner: str, repo: str, number: int, head: str, node: str):
    analysis = await _analysis(request, owner, repo, number, head)
    # Only nodes the analysis found: the path never comes from the query string.
    found = analysis["nodes"].get(node)
    if not found:
        raise HTTPException(404, "No such function")
    ref = {k: found[k] for k in ("path", "symbol", "start", "end")}
    try:
        source = logic.function_source(analysis["root"], ref, changed=analysis["changed"].get(ref["path"], set()))
    except ValueError:
        raise HTTPException(404, "No such function")
    return {**source, "inDiff": ref["path"] in analysis["changed"]}
