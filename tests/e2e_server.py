"""spec-tackle with an in-memory fake GitHub, for the Playwright checks in frontend/e2e.

    uv run python tests/e2e_server.py   # serves http://127.0.0.1:8799
"""

from __future__ import annotations

import asyncio
import itertools
import sys
import tempfile
from pathlib import Path

import uvicorn

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from spec_tackle import claude_api  # noqa: E402
from spec_tackle.app import app  # noqa: E402
from spec_tackle.auth import NotSignedIn  # noqa: E402
from spec_tackle.claude import Event  # noqa: E402
from spec_tackle.store import Store  # noqa: E402
from spec_tackle.turns import TurnRunner  # noqa: E402

PORT = 8799
DATA = Path(tempfile.mkdtemp(prefix="spec-tackle-e2e-"))
HEAD = "e2e0000headsha"
DOC = "# Retry policy\n\nForms are sent once.\n\nFailures are retried with backoff.\n\n## Limits\n\nAt most five tries.\n"
ME = {"__typename": "User", "login": "me", "avatarUrl": ""}
ANN = {"__typename": "User", "login": "ann", "avatarUrl": ""}
TITLES = {7: "Retry failed form submissions", 8: "Rename the sync queue"}
ids = itertools.count(1000)


def comment(author: dict, body: str) -> dict:
    n = next(ids)
    return {"databaseId": n, "author": author, "body": body, "bodyHTML": f"<p>{body}</p>",
            "createdAt": "2026-10-08T09:00:00Z", "url": f"https://github.com/o/r/pull/7#c{n}"}


def thread(line: int, first: dict, resolved: bool = False) -> dict:
    return {"id": f"T{next(ids)}", "path": "docs/retry.md", "line": line, "startLine": None,
            "originalLine": line, "originalStartLine": None, "isResolved": resolved, "isOutdated": False,
            "subjectType": "LINE", "diffSide": "RIGHT", "resolvedBy": None, "comments": {"nodes": [first]}}


class FakeGitHub:
    token = "e2e"

    def __init__(self):
        self.head = HEAD
        self.threads = [thread(5, comment(ANN, "How long is the backoff?"))]
        self.conversation: list[dict] = []
        self.reviews: list[dict] = []
        self.posted: list[dict] = []

    def _activity(self, pr) -> dict:
        # Only PR 7 has comments, so a second PR shows whether state leaks between them.
        threads = self.threads if pr.number == 7 else []
        return {"headRefOid": self.head, "state": "OPEN", "isDraft": False, "merged": False, "viewer": {"login": "me", "avatarUrl": ""},
                "reviewThreads": {"nodes": threads}, "comments": {"nodes": self.conversation},
                "reviews": {"nodes": self.reviews}}

    async def overview(self, pr):
        return {"title": TITLES.get(pr.number, f"PR {pr.number}"), "number": pr.number,
                "url": f"https://github.com/o/r/pull/{pr.number}",
                "body": "Adds retries.", "bodyHTML": "<p>Adds retries.</p>", "author": ANN, "createdAt": "2026-10-08T08:00:00Z",
                "updatedAt": "", "baseRefName": "main", "headRefName": "retry", "additions": 9, "deletions": 0,
                "changedFiles": 1, "reviewDecision": None, **self._activity(pr)}

    async def activity(self, pr):
        return self._activity(pr)

    async def files(self, pr):
        patch = "@@ -0,0 +1,9 @@\n" + "\n".join(f"+{line}" for line in DOC.rstrip("\n").split("\n"))
        return [{"filename": "docs/retry.md", "status": "added", "additions": 9, "deletions": 0, "patch": patch}]

    async def raw_file(self, owner, repo, path, ref):
        return DOC.encode()

    async def render_markdown(self, pr, text):
        return f"<p>{text}</p>"

    async def create_review_comment(self, pr, payload):
        self.posted.append(payload)
        c = comment(ME, payload["body"])
        self.threads.append(thread(payload.get("line", 1), c))
        return {"id": c["databaseId"]}

    async def reply(self, pr, comment_id, body):
        c = comment(ME, body)
        for t in self.threads:
            if t["comments"]["nodes"][0]["databaseId"] == comment_id:
                t["comments"]["nodes"].append(c)
        return {"id": c["databaseId"]}

    async def conversation_comment(self, pr, body):
        c = comment(ME, body)
        self.conversation.append(c)
        return {"id": c["databaseId"]}

    async def submit_review(self, pr, event, body):
        r = comment(ME, body)
        state = {"APPROVE": "APPROVED", "REQUEST_CHANGES": "CHANGES_REQUESTED"}.get(event, "COMMENTED")
        self.reviews.append({**r, "state": state, "submittedAt": r["createdAt"]})
        return {"id": r["databaseId"]}

    async def review_requests(self):
        return [{"owner": "o", "repo": "r", "number": 8, "title": TITLES[8], "author": "ann",
                 "updatedAt": "2026-10-08T09:00:00Z", "isDraft": False, "url": "https://github.com/o/r/pull/8"}]

    async def set_thread_resolved(self, thread_id, resolved):
        for t in self.threads:
            if t["id"] == thread_id:
                t["isResolved"] = resolved


class FakeSession:
    def __init__(self):
        self.gh = FakeGitHub()
        self.login = None
        self.signed_in = True

    async def client(self):
        if not self.signed_in:
            raise NotSignedIn()
        return self.gh

    async def viewer(self):
        return {"login": "me", "name": None, "avatarUrl": ""} if self.signed_in else None

    async def token(self):
        return "e2e"

    async def drop(self):
        pass

    async def aclose(self):
        pass


@app.get("/e2e/posted")
async def posted():
    """What the UI sent to the fake GitHub, for assertions."""
    gh = app.state.session.gh
    return {"comments": gh.posted, "threads": gh.threads}


@app.post("/e2e/push")
async def push():
    """Someone force-pushes: the PR's head moves on."""
    app.state.session.gh.head = "e2e1111newhead"
    return {"ok": True}


@app.post("/e2e/signout")
async def signout():
    """GitHub stops accepting the token."""
    app.state.session.signed_in = False
    return {"ok": True}


class FakeCheckouts:
    def has_clone(self, *, owner, repo):
        return True

    async def worktree(self, *, owner, repo, sha, token):
        path = DATA / "wt" / sha / "docs"
        path.mkdir(parents=True, exist_ok=True)
        (path / "retry.md").write_text(DOC)
        return path.parent


ANSWER = " ".join(["Retries back off exponentially from one second, doubling each time."] * 12)


async def fake_ask(**kwargs):
    """Claude, streaming a long answer over about 1.5 seconds."""
    yield Event(kind="tool", text="Reading docs/retry.md")
    for word in ANSWER.split(" "):
        await asyncio.sleep(0.015)
        yield Event(kind="text", text=word + " ")
    yield Event(kind="done", text=ANSWER, session_id="e2e")


@app.post("/e2e/reset")
async def reset():
    """Start each test from the same PR."""
    app.state.session = FakeSession()
    app.state.store.close()
    app.state.store = Store.open(DATA / f"state-{next(ids)}.db")
    return {"ok": True}


async def main():
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=PORT, log_level="warning"))
    serving = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.05)
    app.state.session = FakeSession()
    app.state.store = Store.open(DATA / "state.db")
    app.state.claude_cli = "/fake/claude"
    app.state.checkouts = FakeCheckouts()
    app.state.turns = TurnRunner()
    claude_api.claude.ask = fake_ask
    await serving


if __name__ == "__main__":
    asyncio.run(main())
