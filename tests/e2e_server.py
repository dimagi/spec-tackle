"""spec-tackle with an in-memory fake GitHub, for the Playwright checks in frontend/e2e.

    uv run python tests/e2e_server.py   # serves http://127.0.0.1:8799
"""

from __future__ import annotations

import asyncio
import itertools
import sys
from pathlib import Path

import uvicorn

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from spec_tackle.app import app  # noqa: E402

PORT = 8799
HEAD = "e2e0000headsha"
DOC = "# Retry policy\n\nForms are sent once.\n\nFailures are retried with backoff.\n\n## Limits\n\nAt most five tries.\n"
ME = {"__typename": "User", "login": "me", "avatarUrl": ""}
ANN = {"__typename": "User", "login": "ann", "avatarUrl": ""}
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
        self.threads = [thread(5, comment(ANN, "How long is the backoff?"))]
        self.conversation: list[dict] = []
        self.reviews: list[dict] = []
        self.posted: list[dict] = []

    def _activity(self) -> dict:
        return {"headRefOid": HEAD, "state": "OPEN", "isDraft": False, "merged": False, "viewer": {"login": "me", "avatarUrl": ""},
                "reviewThreads": {"nodes": self.threads}, "comments": {"nodes": self.conversation},
                "reviews": {"nodes": self.reviews}}

    async def overview(self, pr):
        return {"title": "Retry failed form submissions", "number": 7, "url": "https://github.com/o/r/pull/7",
                "body": "Adds retries.", "bodyHTML": "<p>Adds retries.</p>", "author": ANN, "createdAt": "2026-10-08T08:00:00Z",
                "updatedAt": "", "baseRefName": "main", "headRefName": "retry", "additions": 9, "deletions": 0,
                "changedFiles": 1, "reviewDecision": None, **self._activity()}

    async def activity(self, pr):
        return self._activity()

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

    async def set_thread_resolved(self, thread_id, resolved):
        for t in self.threads:
            if t["id"] == thread_id:
                t["isResolved"] = resolved


class FakeSession:
    def __init__(self):
        self.gh = FakeGitHub()
        self.login = None

    async def client(self):
        return self.gh

    async def viewer(self):
        return {"login": "me", "name": None, "avatarUrl": ""}

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


@app.post("/e2e/reset")
async def reset():
    """Start each test from the same PR."""
    app.state.session = FakeSession()
    return {"ok": True}


async def main():
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=PORT, log_level="warning"))
    serving = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.05)
    app.state.session = FakeSession()
    app.state.claude_cli = None
    await serving


if __name__ == "__main__":
    asyncio.run(main())
