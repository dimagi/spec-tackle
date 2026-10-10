import asyncio
import sys

import pytest
from fastapi.testclient import TestClient

from spec_tackle import calls, calls_api
from spec_tackle.app import app

from conftest import FakeCheckouts

CALLS = "/api/pr/o/r/7/calls"
HEAD = "abc1234"

RETRY = "def backoff(tries, base):\n    return base * 2 ** tries\n"
FORMS = "from app.retry import backoff\n\n\ndef send(form):\n    return backoff(3, 1)\n"
FILES = [
    {"filename": "app/retry.py", "status": "modified", "additions": 2, "deletions": 2,
     "patch": "@@ -1,2 +1,2 @@\n-def backoff(tries):\n-    return 2 ** tries\n+def backoff(tries, base):\n+    return base * 2 ** tries"},
    {"filename": "docs/a.md", "status": "added", "additions": 1, "deletions": 0, "patch": "@@ -0,0 +1 @@\n+one"},
]


@pytest.fixture(autouse=True)
def fresh_cache(monkeypatch):
    # In a thread, not a child process, so tests can watch and replace calls.analyse.
    monkeypatch.setattr(calls_api, "run_analysis", lambda fn, *args: asyncio.to_thread(lambda: calls.analyse(*args)))
    calls_api._cache.clear()
    yield
    calls_api._cache.clear()


@pytest.fixture
def calls_app(web_app, tmp_path):
    """Claude off, with a checkout that has Python code and a PR that changes it."""
    checkouts = FakeCheckouts(tmp_path / "wt")
    checkouts.files[HEAD] = {"app/retry.py": RETRY, "app/forms.py": FORMS}
    app.state.checkouts = checkouts

    async def files(pr):
        return FILES

    app.state.session.gh.files = files
    web_app.checkouts = checkouts
    return web_app


def test_the_call_tree_works_without_claude(calls_app):
    before = "claude_agent_sdk" in sys.modules
    response = calls_app.get(CALLS, params={"head": HEAD})
    assert response.status_code == 200
    tree = response.json()
    assert tree["headSha"] == HEAD
    assert {n["id"] for n in tree["nodes"]} == {"app/retry.py::backoff", "app/forms.py::send"}
    [edge] = tree["edges"]
    assert edge["from"] == "app/forms.py::send" and edge["notUpdated"] is True
    assert tree["other"] == [{"path": "docs/a.md", "reason": "not Python"}]
    assert ("claude_agent_sdk" in sys.modules) == before


def test_the_analysis_is_cached_per_commit(calls_app, monkeypatch):
    runs = []
    real = calls.analyse
    monkeypatch.setattr(calls, "analyse", lambda root, files: runs.append(root) or real(root, files))
    first = calls_app.get(CALLS, params={"head": HEAD}).json()
    second = calls_app.get(CALLS, params={"head": HEAD}).json()
    assert first == second and len(runs) == 1 and calls_app.checkouts.calls == [HEAD]


def test_a_failed_analysis_is_not_cached(calls_app):
    calls_app.checkouts.offline = True
    assert calls_app.get(CALLS, params={"head": HEAD}).status_code == 502
    calls_app.checkouts.offline = False
    assert calls_app.get(CALLS, params={"head": HEAD}).status_code == 200


def test_the_cache_keeps_the_most_recent_commits(calls_app, monkeypatch):
    monkeypatch.setattr(calls_api, "CACHE_SIZE", 2)
    for sha in ("a1", "a2", "a3"):
        calls_app.get(CALLS, params={"head": sha})
    assert [key[-1] for key in calls_api._cache] == ["a2", "a3"]


def test_source_returns_a_nodes_lines_with_the_changes_marked(calls_app):
    response = calls_app.get(f"{CALLS}/source", params={"head": HEAD, "node": "app/retry.py::backoff"})
    assert response.status_code == 200
    source = response.json()
    assert source["symbol"] == "backoff" and source["path"] == "app/retry.py" and source["inDiff"] is True
    assert [(line["n"], line["changed"]) for line in source["lines"]] == [(1, True), (2, True)]

    unchanged = calls_app.get(f"{CALLS}/source", params={"head": HEAD, "node": "app/forms.py::send"}).json()
    assert unchanged["inDiff"] is False and not any(line["changed"] for line in unchanged["lines"])


def test_source_only_serves_nodes_in_the_tree(calls_app, tmp_path):
    (tmp_path / "secret.py").write_text("def x():\n    pass\n")
    for node in ("app/retry.py::nope", "../secret.py::x", "/etc/passwd::x", "app/retry.py"):
        response = calls_app.get(f"{CALLS}/source", params={"head": HEAD, "node": node})
        assert response.status_code == 404, node


def test_a_commit_that_is_gone_is_a_conflict(calls_app):
    calls_app.checkouts.gone.add(HEAD)
    response = calls_app.get(CALLS, params={"head": HEAD})
    assert response.status_code == 409 and response.json()["detail"] == "gone"


def test_a_repository_that_cannot_be_fetched_is_a_bad_gateway(calls_app):
    calls_app.checkouts.offline = True
    response = calls_app.get(CALLS, params={"head": HEAD})
    assert response.status_code == 502 and "Couldn't fetch the repository" in response.json()["detail"]


def test_the_routes_need_the_access_cookie_and_a_sign_in(calls_app):
    stranger = TestClient(app)
    assert stranger.get(CALLS, params={"head": HEAD}).status_code == 403
    assert stranger.get(f"{CALLS}/source", params={"head": HEAD, "node": "x"}).status_code == 403
    app.state.session.signed_in = False
    assert calls_app.get(CALLS, params={"head": HEAD}).status_code == 401


def test_the_analysis_runs_in_a_child_process(tmp_path):
    """The real runner: a fresh process gives the parse's memory back when it ends."""
    (tmp_path / "m.py").write_text("def f():\n    pass\n")
    files = [{"filename": "m.py", "status": "added", "patch": "@@ -0,0 +1,2 @@\n+def f():\n+    pass"}]
    tree = asyncio.run(calls_api._in_child(calls.analyse, tmp_path, files))
    assert [n["id"] for n in tree["nodes"]] == ["m.py::f"]


def test_a_github_failure_goes_to_the_apps_handler(calls_app):
    from spec_tackle.github import GitHubError

    async def files(pr):
        raise GitHubError("Bad credentials", status=401)

    app.state.session.gh.files = files
    response = calls_app.get(CALLS, params={"head": HEAD})
    assert response.status_code == 401 and response.json().get("signedOut") is True
