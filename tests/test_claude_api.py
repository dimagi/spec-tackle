import json
import time

import pytest

from spec_tackle.app import app

NEW = {"path": "docs/a.md", "start": 2, "end": 3, "commit": "abc1234", "question": "Why two?"}


def _events(client, thread_id):
    with client.stream("GET", f"/api/claude/threads/{thread_id}/events") as response:
        assert response.headers["content-type"].startswith("text/event-stream")
        return [json.loads(line[6:]) for line in response.iter_lines() if line.startswith("data: ")]


def _wait_idle(client, thread_id):
    for _ in range(100):
        threads = client.get("/api/pr/o/r/7/claude/threads").json()
        thread = next(t for t in threads if t["id"] == thread_id)
        if not thread["running"]:
            return thread
        time.sleep(0.02)
    raise AssertionError("turn never finished")


def test_ask_streams_and_saves_the_answer(claude_app):
    thread = claude_app.post("/api/pr/o/r/7/claude/threads", json=NEW).json()
    assert thread["running"] is True
    assert [m["role"] for m in thread["messages"]] == ["user"]

    events = _events(claude_app, thread["id"])
    assert events[0] == {"type": "tool", "text": "Cloning o/r…"}
    assert {"type": "text", "text": "The "} in events
    assert events[-1]["type"] == "done" and "<p>The answer.</p>" in events[-1]["bodyHTML"]

    saved = _wait_idle(claude_app, thread["id"])
    assert saved["anchorText"] == "two\nthree"
    assert [(m["role"], m["body"]) for m in saved["messages"]] == [("user", "Why two?"), ("assistant", "The answer.")]
    assert "<p>The answer.</p>" in saved["messages"][1]["bodyHTML"]
    assert "snapshot" not in saved

    call = claude_app.fake_ask.calls[0]
    assert call["cwd"].name == "abc1234" and call["session_id"] is None
    assert "Desc" in call["snapshot"] and "two\nthree" in call["full_prompt"]


def test_followup_reuses_snapshot_and_session(claude_app):
    thread = claude_app.post("/api/pr/o/r/7/claude/threads", json=NEW).json()
    _wait_idle(claude_app, thread["id"])
    claude_app.post(f"/api/claude/threads/{thread['id']}/messages", json={"question": "And three?"})
    _wait_idle(claude_app, thread["id"])

    first, second = claude_app.fake_ask.calls
    assert second["session_id"] == "sess-1"
    assert second["question"] == "And three?"
    assert second["snapshot"] == first["snapshot"]
    assert second["cwd"] == first["cwd"]
    assert app.state.session.gh.overview_calls == 1  # snapshot built once


def test_followup_while_running_is_409(claude_app):
    claude_app.fake_ask.delay = 0.5
    thread = claude_app.post("/api/pr/o/r/7/claude/threads", json=NEW).json()
    response = claude_app.post(f"/api/claude/threads/{thread['id']}/messages", json={"question": "again"})
    assert response.status_code == 409
    _wait_idle(claude_app, thread["id"])


def test_events_when_idle(claude_app):
    thread = claude_app.post("/api/pr/o/r/7/claude/threads", json=NEW).json()
    _wait_idle(claude_app, thread["id"])
    assert _events(claude_app, thread["id"]) == [{"type": "idle"}]


def test_errors_are_saved_in_the_thread(claude_app, monkeypatch):
    from spec_tackle.checkout import CommitGone

    async def gone(**kwargs):
        raise CommitGone("This commit is no longer on GitHub.")

    monkeypatch.setattr(app.state.checkouts, "worktree", gone)
    thread = claude_app.post("/api/pr/o/r/7/claude/threads", json=NEW).json()
    saved = _wait_idle(claude_app, thread["id"])
    assert saved["messages"][-1] == {**saved["messages"][-1], "role": "error",
                                     "body": "This commit is no longer on GitHub."}


def test_github_errors_are_not_blamed_on_claude(claude_app, monkeypatch):
    from spec_tackle.github import GitHubError

    async def denied(pr):
        raise GitHubError(message="Requires authentication", status=401)

    monkeypatch.setattr(app.state.session.gh, "overview", denied)
    thread = claude_app.post("/api/pr/o/r/7/claude/threads", json=NEW).json()
    saved = _wait_idle(claude_app, thread["id"])
    assert saved["messages"][-1]["role"] == "error"
    assert saved["messages"][-1]["body"].startswith("Couldn't read the PR from GitHub")


def test_create_rejects_path_outside_checkout(claude_app):
    thread = claude_app.post("/api/pr/o/r/7/claude/threads", json={**NEW, "path": "../../etc/passwd"}).json()
    saved = _wait_idle(claude_app, thread["id"])
    assert saved["messages"][-1]["role"] == "error"
    assert "outside the checkout" in saved["messages"][-1]["body"]
    assert claude_app.fake_ask.calls == []


def test_empty_question_is_400(claude_app):
    assert claude_app.post("/api/pr/o/r/7/claude/threads", json={**NEW, "question": "  "}).status_code == 400


def test_delete(claude_app):
    thread = claude_app.post("/api/pr/o/r/7/claude/threads", json=NEW).json()
    assert claude_app.delete(f"/api/claude/threads/{thread['id']}").json() == {"ok": True}
    assert claude_app.get("/api/pr/o/r/7/claude/threads").json() == []
    assert claude_app.delete(f"/api/claude/threads/{thread['id']}").status_code == 404


def test_threads_are_per_login(claude_app):
    thread = claude_app.post("/api/pr/o/r/7/claude/threads", json=NEW).json()
    _wait_idle(claude_app, thread["id"])
    app.state.session.login_name = "someone-else"
    assert claude_app.get("/api/pr/o/r/7/claude/threads").json() == []
    assert claude_app.delete(f"/api/claude/threads/{thread['id']}").status_code == 404


def test_claude_routes_401_when_signed_out(claude_app):
    app.state.session.signed_in = False
    response = claude_app.get("/api/pr/o/r/7/claude/threads")
    assert response.status_code == 401 and response.json()["signedOut"] is True


@pytest.mark.parametrize("method, url", [
    ("GET", "/api/pr/o/r/7/claude/threads"),
    ("POST", "/api/pr/o/r/7/claude/threads"),
    ("POST", "/api/claude/threads/x/messages"),
    ("GET", "/api/claude/threads/x/events"),
    ("DELETE", "/api/claude/threads/x"),
])
def test_every_route_404_without_claude(claude_app, method, url):
    app.state.claude_cli = None
    response = claude_app.request(method, url, json=NEW if method == "POST" else None)
    assert response.status_code == 404
    assert response.json()["detail"] == "Claude Code isn't installed"
