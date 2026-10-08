import asyncio
import sys
import time

import pytest

from repo_fixture import SHOP, write_repo
from spec_tackle.app import app
from spec_tackle.maps import MapJobs, run_worker

READY = {"status": "ready", "nodes": [], "edges": [], "readingPath": [], "limits": {}, "skipped": []}


class Worktrees:
    def __init__(self, root):
        self.root = root
        self.calls = []

    async def worktree(self, *, owner, repo, sha, token):
        self.calls.append(sha)
        return self.root


class FakeRun:
    def __init__(self, result=READY, delay=0.05):
        self.result, self.delay, self.calls = result, delay, 0

    async def __call__(self, worktree, files, timeout):
        self.calls += 1
        await asyncio.sleep(self.delay)
        return self.result


def jobs(tmp_path, run):
    return MapJobs(tmp_path / "maps", Worktrees(tmp_path), run=run)


ARGS = dict(owner="o", repo="r", base="bae5567", head="abc1234", files=[], token="t")


async def settle(j, **kw):
    for _ in range(100):
        result = await j.get(**{**ARGS, **kw})
        if result["status"] != "pending":
            return result
        await asyncio.sleep(0.01)
    raise AssertionError("never finished")


def test_pending_then_ready(tmp_path):
    async def go():
        j = jobs(tmp_path, FakeRun())
        assert (await j.get(**ARGS))["status"] == "pending"
        assert (await settle(j))["status"] == "ready"
    asyncio.run(go())


def test_a_cached_map_does_not_run_again(tmp_path):
    async def go():
        run = FakeRun()
        await settle(jobs(tmp_path, run))
        again = jobs(tmp_path, run)  # e.g. after a restart
        assert (await again.get(**ARGS))["status"] == "ready"
        assert run.calls == 1
    asyncio.run(go())


def test_concurrent_requests_share_one_job(tmp_path):
    async def go():
        run = FakeRun(delay=0.2)
        j = jobs(tmp_path, run)
        await asyncio.gather(*(j.get(**ARGS) for _ in range(5)))
        await settle(j)
        assert run.calls == 1
    asyncio.run(go())


def test_a_failure_is_reported_once_then_retried(tmp_path):
    async def go():
        run = FakeRun(result={"status": "error", "message": "boom"})
        j = jobs(tmp_path, run)
        assert await settle(j) == {"status": "error", "message": "boom"}
        assert (await j.get(**ARGS))["status"] == "pending"  # tries again
        await settle(j)
        assert run.calls == 2
    asyncio.run(go())


def test_bad_names_never_reach_the_disk(tmp_path):
    async def go():
        with pytest.raises(ValueError):
            await jobs(tmp_path, FakeRun()).get(**{**ARGS, "owner": "../x"})
        with pytest.raises(ValueError):
            await jobs(tmp_path, FakeRun()).get(**{**ARGS, "head": "not-a-sha"})
    asyncio.run(go())


def test_the_worker_maps_a_real_checkout(tmp_path):
    root = write_repo(tmp_path, SHOP)
    files = [{"path": "shop/sync.py", "status": "modified", "additions": 1, "deletions": 0, "patch": "@@ -4,0 +5 @@\n+    return order.total()"}]

    result = asyncio.run(run_worker(root, files, timeout=60))

    assert result["status"] == "ready"
    assert result["limits"]["importGraph"] is True


def test_a_slow_import_graph_falls_back_to_a_partial_map(tmp_path):
    root = write_repo(tmp_path, SHOP)
    slow = [sys.executable, "-c",
            "import os, sys, time, json\n"
            "if not os.environ.get('SPEC_TACKLE_NO_GRAPH'): time.sleep(5)\n"
            "print(json.dumps({'status': 'ready', 'limits': {'importGraph': False}}))"]
    start = time.monotonic()

    result = asyncio.run(run_worker(root, [], timeout=0.5, command=slow))

    assert result["limits"]["importGraph"] is False
    assert time.monotonic() - start < 4


def test_map_route_starts_a_job_and_reports_head(web_app, tmp_path):
    app.state.maps = jobs(tmp_path, FakeRun(delay=0))
    first = web_app.get("/api/pr/o/r/7/map").json()
    assert first == {"status": "pending", "headSha": "abc1234"}
    for _ in range(50):
        data = web_app.get("/api/pr/o/r/7/map").json()
        if data["status"] == "ready":
            break
        time.sleep(0.02)
    assert data["status"] == "ready" and data["headSha"] == "abc1234"


def test_map_route_needs_sign_in(web_app):
    app.state.session.signed_in = False
    assert web_app.get("/api/pr/o/r/7/map").status_code == 401


MAP = {**READY, "nodes": [
    {"id": "shop/sync.py", "hop": 0}, {"id": "shop/models.py", "hop": 0}, {"id": "shop/tasks.py", "hop": 1},
]}


def cached_map(tmp_path):
    j = jobs(tmp_path, FakeRun())
    path = j._path(("o", "r", "bae5567", "abc1234"))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(__import__("json").dumps(MAP))
    return j


def test_narration_keeps_one_line_per_changed_file(claude_app, tmp_path):
    app.state.maps = cached_map(tmp_path)
    claude_app.fake_ask.answer = (
        'Here you go:\n{"shop/sync.py": "Adds retries.\\nMore detail.", "shop/models.py": "New Order model.",'
        ' "shop/tasks.py": "not in the PR", "made/up.py": "nope"}'
    )

    notes = claude_app.post("/api/pr/o/r/7/map/narrate").json()

    assert notes == {"shop/sync.py": "Adds retries.", "shop/models.py": "New Order model."}
    prompt = claude_app.fake_ask.calls[0]["full_prompt"]
    assert "shop/sync.py" in prompt and "shop/tasks.py" not in prompt


def test_narration_is_cached(claude_app, tmp_path):
    app.state.maps = cached_map(tmp_path)
    claude_app.fake_ask.answer = '{"shop/sync.py": "Adds retries."}'
    claude_app.post("/api/pr/o/r/7/map/narrate")
    claude_app.post("/api/pr/o/r/7/map/narrate")
    assert len(claude_app.fake_ask.calls) == 1


def test_narration_waits_for_the_map(claude_app, tmp_path):
    app.state.maps = jobs(tmp_path, FakeRun())
    assert claude_app.post("/api/pr/o/r/7/map/narrate").status_code == 409


def test_narration_needs_claude(web_app):
    assert web_app.post("/api/pr/o/r/7/map/narrate").status_code == 404


def test_a_claude_failure_comes_back_as_a_readable_error(claude_app, tmp_path, monkeypatch):
    app.state.maps = cached_map(tmp_path)

    async def broken(**kwargs):
        raise RuntimeError("CLI crashed")
        yield  # pragma: no cover

    monkeypatch.setattr("spec_tackle.claude_api.claude.ask", broken)
    response = claude_app.post("/api/pr/o/r/7/map/narrate")

    assert response.status_code == 502
    assert response.json()["detail"]


def test_an_unreadable_narration_is_an_error_and_not_cached(claude_app, tmp_path):
    app.state.maps = cached_map(tmp_path)
    claude_app.fake_ask.answer = "Sorry, I can't help with that."

    first = claude_app.post("/api/pr/o/r/7/map/narrate")
    claude_app.fake_ask.answer = '{"shop/sync.py": "Adds retries."}'
    second = claude_app.post("/api/pr/o/r/7/map/narrate")

    assert first.status_code == 502
    assert second.json() == {"shop/sync.py": "Adds retries."}
