import asyncio
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from spec_tackle import app as web, claude_api
from spec_tackle.app import app
from spec_tackle.claude import Event
from spec_tackle.store import Store
from spec_tackle.turns import TurnRunner


@pytest.fixture(autouse=True)
def allow_test_host(monkeypatch):
    """TestClient sends `Host: testserver`."""
    monkeypatch.setattr(web, "allowed_hosts", {"localhost", "testserver"})


@pytest.fixture(autouse=True)
def isolated_data_home(tmp_path, monkeypatch):
    """Keep every test's state.db and repo checkouts out of the real home directory."""
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "data"))
    return tmp_path / "data"


AUTHOR = {"__typename": "User", "login": "ann", "avatarUrl": ""}


def make_overview(head="abc1234"):
    return {
        "title": "Add spec", "number": 7, "url": "https://github.com/o/r/pull/7", "body": "Desc",
        "bodyHTML": "<p>Desc</p>", "author": AUTHOR, "createdAt": "", "updatedAt": "",
        "baseRefName": "main", "headRefName": "spec", "headRefOid": head, "additions": 1,
        "deletions": 0, "changedFiles": 1, "reviewDecision": None, "state": "OPEN",
        "isDraft": False, "merged": False, "viewer": {"login": "me", "avatarUrl": ""},
        "reviewThreads": {"nodes": []}, "comments": {"nodes": []}, "reviews": {"nodes": []},
    }


class FakeGitHub:
    token = "tok"

    def __init__(self):
        self.overview_calls = 0

    async def overview(self, pr):
        self.overview_calls += 1
        return make_overview()

    async def files(self, pr):
        return [{"filename": "docs/a.md", "status": "added", "additions": 4, "deletions": 0,
                 "patch": "@@ -0,0 +1,4 @@\n+one\n+two\n+three\n+four"}]

    async def raw_file(self, owner, repo, path, ref):
        return b"# Title\n\ntwo\nthree\n"


class FakeSession:
    def __init__(self, login="me"):
        self.gh = FakeGitHub()
        self.login_name = login
        self.signed_in = True
        self.login = None  # LoginFlow slot used by /auth routes

    async def client(self):
        from spec_tackle.auth import NotSignedIn
        if not self.signed_in:
            raise NotSignedIn()
        return self.gh

    async def viewer(self):
        return {"login": self.login_name, "name": None, "avatarUrl": ""} if self.signed_in else None

    async def token(self):
        return (await self.client()).token

    async def drop(self):
        self.signed_in = False

    async def aclose(self):
        pass


class FakeCheckouts:
    def __init__(self, root: Path):
        self.root = root
        self.calls = []

    def has_clone(self, *, owner, repo):
        return bool(self.calls)

    async def worktree(self, *, owner, repo, sha, token):
        self.calls.append(sha)
        path = self.root / sha
        (path / "docs").mkdir(parents=True, exist_ok=True)
        (path / "docs" / "a.md").write_text("one\ntwo\nthree\nfour\n")
        return path


class FakeAsk:
    """Replaces claude.ask: records calls and replays scripted events with a small delay."""

    def __init__(self):
        self.calls = []
        self.delay = 0.05
        self.answer = "The answer."

    async def __call__(self, **kwargs):
        self.calls.append(kwargs)
        yield Event(kind="tool", text="Reading docs/a.md")
        await asyncio.sleep(self.delay)
        yield Event(kind="text", text="The ")
        yield Event(kind="done", text=self.answer, session_id=f"sess-{len(self.calls)}")


@pytest.fixture
def claude_app(tmp_path, monkeypatch):
    """A TestClient with Claude enabled and GitHub, git and the SDK faked out."""
    fake_ask = FakeAsk()
    monkeypatch.setattr(claude_api.claude, "ask", fake_ask)
    with TestClient(app) as client:
        app.state.session = FakeSession()
        app.state.store = Store.open(tmp_path / "state.db")
        app.state.claude_cli = "/usr/bin/claude"
        app.state.checkouts = FakeCheckouts(tmp_path / "wt")
        app.state.turns = TurnRunner()
        client.fake_ask = fake_ask
        yield client


@pytest.fixture
def web_app(tmp_path):
    """A TestClient signed in with a fake GitHub; Claude is off."""
    with TestClient(app) as client:
        app.state.session = FakeSession()
        app.state.claude_cli = None
        yield client
