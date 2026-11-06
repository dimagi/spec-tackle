import asyncio

import pytest
from fastapi.testclient import TestClient

from conftest import FakeGitHub, FakeSession, make_overview, signed_client
from spec_tackle.app import app
from spec_tackle.github import GitHub, GitHubError, PRRef
from spec_tackle.store import Store

API = "/api/pr/o/r/7"
ADDED = {"filename": "docs/a.md", "status": "added", "additions": 4, "deletions": 0,
         "patch": "@@ -0,0 +1,4 @@\n+one\n+two\n+three\n+four"}
# Only lines 2-3 are in the diff; line 9 is unchanged text.
MODIFIED = {"filename": "docs/a.md", "status": "modified", "additions": 1, "deletions": 1,
            "patch": "@@ -2,2 +2,2 @@\n-too\n+two\n three"}


class ReviewGitHub(FakeGitHub):
    """A GitHub that keeps one pending review, like the real one does per person and PR."""

    def __init__(self):
        super().__init__()
        self.head = "abc1234"
        self.texts = {"abc1234": "one\ntwo\nthree\nfour\n"}  # docs/a.md per commit
        self.file_list = [ADDED]
        self.thread_ids = ["T1"]
        self.pending: dict | None = None
        self.raw_calls: list[str] = []
        self.started: list[str] = []
        self.added: list[tuple] = []
        self.submitted: list[tuple] = []
        self.plain_reviews: list[tuple] = []
        self.fail_bodies: set[str] = set()
        self.fail_submit = False

    async def files(self, pr):
        return self.file_list

    async def raw_file(self, owner, repo, path, ref):
        self.raw_calls.append(ref)
        if ref not in self.texts:
            raise GitHubError("Not Found", 404)
        return self.texts[ref].encode()

    async def activity(self, pr):
        threads = [{"id": thread_id} for thread_id in self.thread_ids]
        return {**make_overview(self.head), "reviewThreads": {"nodes": threads}}

    async def review_state(self, pr):
        return {"head": self.head, "pullRequestId": "PR1", "pending": self.pending and dict(self.pending)}

    async def start_review(self, pull_request_id, commit):
        self.started.append(commit)
        self.pending = {"id": f"R{len(self.started)}", "comments": 0}
        return self.pending["id"]

    def _add(self, body, entry):
        if body in self.fail_bodies:
            raise GitHubError("GitHub refused this comment", 502)
        self.added.append(entry)
        self.pending["comments"] += 1

    async def add_review_thread(self, review_id, *, path, body, line=None, start_line=None):
        self._add(body, ("thread", review_id, path, line, start_line, body))

    async def add_review_reply(self, review_id, thread_id, body):
        self._add(body, ("reply", review_id, thread_id, body))

    async def submit_pending_review(self, review_id, event, body):
        if self.fail_submit:
            raise GitHubError("GitHub is having a moment", 502)
        self.submitted.append((review_id, event, body))
        self.pending = None
        return {"id": 99}

    async def submit_review(self, pr, event, body):
        self.plain_reviews.append((event, body))
        return {"id": 98}


@pytest.fixture
def drafts_app(tmp_path):
    with signed_client() as client:
        app.state.session = FakeSession()
        app.state.session.gh = ReviewGitHub()
        app.state.store = Store.open(tmp_path / "state.db")
        app.state.claude_cli = None
        client.gh = app.state.session.gh
        yield client


def _comment(client, body="Why three?", start=3, end=3, commit="abc1234"):
    response = client.post(f"{API}/drafts", json={
        "path": "docs/a.md", "start": start, "end": end, "commit": commit, "body": body})
    assert response.status_code == 200, response.text
    return response.json()


def _reply(client, body="Agreed", thread="T1"):
    response = client.post(f"{API}/drafts", json={"threadId": thread, "body": body})
    assert response.status_code == 200, response.text
    return response.json()


def _list(client):
    return client.get(f"{API}/drafts").json()


def _push(gh, text, head="def5678"):
    gh.head = head
    gh.texts[head] = text


# -- writing drafts ----------------------------------------------------------


def test_a_comment_draft_keeps_the_text_it_was_written_against(drafts_app):
    draft = _comment(drafts_app, start=2, end=3)

    assert draft["kind"] == "comment"
    assert (draft["path"], draft["startLine"], draft["endLine"]) == ("docs/a.md", 2, 3)
    assert draft["anchorText"] == "two\nthree"
    assert draft["outdated"] is False and draft["sent"] is False and draft["error"] is None
    assert _list(drafts_app) == {"drafts": [draft], "githubPending": 0}


def test_drafting_posts_nothing_to_github(drafts_app):
    _comment(drafts_app)
    _reply(drafts_app)

    gh = drafts_app.gh
    assert (gh.started, gh.added, gh.submitted, gh.plain_reviews) == ([], [], [], [])


def test_a_reply_draft_belongs_to_a_thread(drafts_app):
    draft = _reply(drafts_app)

    assert (draft["kind"], draft["threadId"], draft["path"], draft["outdated"]) == ("reply", "T1", None, False)


@pytest.mark.parametrize("payload", [
    {"path": "docs/a.md", "start": 3, "end": 3, "commit": "abc1234", "body": "  "},
    {"threadId": "T1", "body": ""},
    {"path": "docs/a.md", "start": 3, "end": 2, "commit": "abc1234", "body": "Hm"},
    {"path": "docs/a.md", "start": 0, "end": 2, "commit": "abc1234", "body": "Hm"},
    {"path": "docs/a.md", "start": 9, "end": 9, "commit": "abc1234", "body": "Hm"},  # past the end
    {"body": "Neither lines nor a thread"},
])
def test_a_draft_needs_a_body_and_somewhere_to_go(drafts_app, payload):
    assert drafts_app.post(f"{API}/drafts", json=payload).status_code == 400
    assert _list(drafts_app)["drafts"] == []


def test_editing_and_deleting_a_draft(drafts_app):
    draft = _comment(drafts_app)

    edited = drafts_app.patch(f"/api/drafts/{draft['id']}", json={"body": "Why not five?"})
    assert edited.json()["body"] == "Why not five?"
    assert drafts_app.patch(f"/api/drafts/{draft['id']}", json={"body": " "}).status_code == 400

    assert drafts_app.delete(f"/api/drafts/{draft['id']}").json() == {"ok": True}
    assert _list(drafts_app)["drafts"] == []
    assert drafts_app.delete(f"/api/drafts/{draft['id']}").status_code == 404
    assert drafts_app.patch("/api/drafts/nope", json={"body": "x"}).status_code == 404


def test_another_login_cannot_see_or_touch_a_draft(drafts_app):
    draft = _comment(drafts_app)

    app.state.session.login_name = "someone-else"

    assert _list(drafts_app)["drafts"] == []
    assert drafts_app.patch(f"/api/drafts/{draft['id']}", json={"body": "x"}).status_code == 404
    assert drafts_app.delete(f"/api/drafts/{draft['id']}").status_code == 404


def test_drafts_are_off_without_a_store(drafts_app):
    assert drafts_app.get(f"{API}/page").json()["drafts"] is True

    app.state.store = None

    assert drafts_app.get(f"{API}/page").json()["drafts"] is False
    assert drafts_app.get(f"{API}/drafts").status_code == 404
    assert drafts_app.post(f"{API}/drafts", json={"threadId": "T1", "body": "x"}).status_code == 404


def test_drafts_need_the_access_cookie(drafts_app):
    assert TestClient(app).get(f"{API}/drafts").status_code == 403


def test_drafts_need_a_github_sign_in(drafts_app):
    app.state.session.signed_in = False

    assert drafts_app.get(f"{API}/drafts").status_code == 401


# -- outdated ----------------------------------------------------------------


def test_a_draft_survives_a_push_that_leaves_its_lines_alone(drafts_app):
    _comment(drafts_app, start=3, end=3)
    _push(drafts_app.gh, "one\ntwo\nthree\nfour\nfive\n")

    assert _list(drafts_app)["drafts"][0]["outdated"] is False


@pytest.mark.parametrize("text", [
    "one\ntwo\nTHREE\nfour\n",        # the passage changed
    "zero\none\ntwo\nthree\nfour\n",  # the passage moved down a line
    "one\ntwo\n",                     # the passage is gone
])
def test_a_draft_is_outdated_when_its_lines_hold_other_text(drafts_app, text):
    _comment(drafts_app, start=3, end=3)
    _push(drafts_app.gh, text)

    draft = _list(drafts_app)["drafts"][0]

    assert draft["outdated"] is True
    assert (draft["startLine"], draft["anchorText"]) == (3, "three")


def test_a_draft_is_outdated_when_its_file_is_deleted_or_leaves_the_pr(drafts_app):
    _comment(drafts_app)
    drafts_app.gh.head = "def5678"  # no text for docs/a.md at this commit
    assert _list(drafts_app)["drafts"][0]["outdated"] is True

    _push(drafts_app.gh, "one\ntwo\nthree\nfour\n", head="fff9999")
    assert _list(drafts_app)["drafts"][0]["outdated"] is False

    drafts_app.gh.file_list = []
    _push(drafts_app.gh, "one\ntwo\nthree\nfour\n", head="eee0000")
    assert _list(drafts_app)["drafts"][0]["outdated"] is True


def test_a_reply_draft_is_never_outdated(drafts_app):
    _reply(drafts_app)
    _push(drafts_app.gh, "all\nnew\n")

    assert _list(drafts_app)["drafts"][0]["outdated"] is False
    assert drafts_app.gh.raw_calls == []


def test_outdated_is_worked_out_once_per_push(drafts_app):
    _comment(drafts_app, body="a", start=1, end=1)
    _comment(drafts_app, body="b", start=3, end=3)
    _push(drafts_app.gh, "one\ntwo\nTHREE\nfour\n")
    drafts_app.gh.raw_calls.clear()

    first = _list(drafts_app)
    second = _list(drafts_app)

    assert [d["outdated"] for d in first["drafts"]] == [False, True]
    assert second == first
    assert drafts_app.gh.raw_calls == ["def5678"]  # one fetch for the file's two drafts


def test_reattaching_an_outdated_draft(drafts_app):
    draft = _comment(drafts_app, start=3, end=3)
    _push(drafts_app.gh, "zero\none\ntwo\nthree\nfour\n")
    assert _list(drafts_app)["drafts"][0]["outdated"] is True

    moved = drafts_app.patch(f"/api/drafts/{draft['id']}", json={
        "path": "docs/a.md", "start": 4, "end": 4, "commit": "def5678"}).json()

    assert (moved["startLine"], moved["anchorText"], moved["outdated"]) == (4, "three", False)
    assert moved["body"] == draft["body"]
    assert _list(drafts_app)["drafts"] == [moved]


# -- submitting --------------------------------------------------------------


def _submit(client, event="COMMENT", body=""):
    return client.post(f"{API}/review", json={"event": event, "body": body})


def test_drafts_go_out_as_one_review(drafts_app):
    _comment(drafts_app, body="Why three?", start=2, end=3)
    _reply(drafts_app, body="Agreed")

    response = _submit(drafts_app, "APPROVE", "Looks good")

    gh = drafts_app.gh
    assert response.status_code == 200, response.text
    assert response.json() == {"sent": 2, "held": 0}
    assert gh.started == ["abc1234"]
    assert gh.added == [
        ("thread", "R1", "docs/a.md", 3, 2, "Why three?"),
        ("reply", "R1", "T1", "Agreed"),
    ]
    assert gh.submitted == [("R1", "APPROVE", "Looks good")]
    assert gh.plain_reviews == []
    assert _list(drafts_app) == {"drafts": [], "githubPending": 0}


def test_a_draft_on_unchanged_text_becomes_a_file_comment(drafts_app):
    drafts_app.gh.file_list = [MODIFIED]
    _comment(drafts_app, body="And this?", start=4, end=4)

    _submit(drafts_app)

    assert drafts_app.gh.added == [("thread", "R1", "docs/a.md", None, None, "**Re: line 4**\n\nAnd this?")]


def test_a_comment_review_with_drafts_needs_no_summary(drafts_app):
    assert _submit(drafts_app, "COMMENT", "").status_code == 400

    _comment(drafts_app)

    assert _submit(drafts_app, "REQUEST_CHANGES", "").status_code == 400
    assert drafts_app.gh.added == []
    assert _submit(drafts_app, "COMMENT", "").status_code == 200
    assert drafts_app.gh.submitted == [("R1", "COMMENT", "")]


def test_a_review_without_drafts_is_posted_as_before(drafts_app):
    response = _submit(drafts_app, "APPROVE", "")

    assert response.status_code == 200
    assert drafts_app.gh.plain_reviews == [("APPROVE", "")]
    assert drafts_app.gh.started == []


def test_outdated_drafts_stay_behind(drafts_app):
    _comment(drafts_app, body="stale", start=3, end=3)
    _comment(drafts_app, body="fine", start=1, end=1)
    _push(drafts_app.gh, "one\ntwo\nTHREE\nfour\n")

    response = _submit(drafts_app)  # without listing first: submit checks for itself

    assert response.json() == {"sent": 1, "held": 1}
    assert [entry[-1] for entry in drafts_app.gh.added] == ["fine"]
    assert drafts_app.gh.started == ["def5678"]
    left = _list(drafts_app)["drafts"]
    assert [(d["body"], d["outdated"]) for d in left] == [("stale", True)]


def test_when_every_draft_is_outdated_the_review_goes_out_without_them(drafts_app):
    _comment(drafts_app, start=3, end=3)
    _push(drafts_app.gh, "one\ntwo\nTHREE\nfour\n")

    assert _submit(drafts_app, "COMMENT", "").status_code == 400
    response = _submit(drafts_app, "COMMENT", "Overall fine")

    assert response.json()["held"] == 1
    assert drafts_app.gh.plain_reviews == [("COMMENT", "Overall fine")]
    assert drafts_app.gh.started == []
    assert len(_list(drafts_app)["drafts"]) == 1


def test_a_reply_to_a_deleted_thread_stays_behind(drafts_app):
    _reply(drafts_app, body="orphan", thread="T-gone")
    _comment(drafts_app, body="fine")

    response = _submit(drafts_app)

    assert response.json() == {"sent": 1, "held": 1}
    assert [entry[-1] for entry in drafts_app.gh.added] == ["fine"]
    assert [d["body"] for d in _list(drafts_app)["drafts"]] == ["orphan"]


def test_a_pending_review_from_github_is_reused(drafts_app):
    drafts_app.gh.pending = {"id": "R-web", "comments": 2}
    _comment(drafts_app)
    assert _list(drafts_app)["githubPending"] == 2

    _submit(drafts_app)

    assert drafts_app.gh.started == []
    assert drafts_app.gh.added[0][1] == "R-web"
    assert drafts_app.gh.submitted == [("R-web", "COMMENT", "")]


def test_a_failure_midway_keeps_what_was_sent_and_a_retry_sends_the_rest(drafts_app):
    gh = drafts_app.gh
    first = _comment(drafts_app, body="first", start=1, end=1)
    bad = _comment(drafts_app, body="bad", start=2, end=2)
    _comment(drafts_app, body="last", start=3, end=3)
    gh.fail_bodies = {"bad"}

    response = _submit(drafts_app)

    assert response.status_code == 502
    assert response.json()["draftId"] == bad["id"]
    assert "GitHub refused this comment" in response.json()["error"]
    assert gh.submitted == []
    listed = _list(drafts_app)
    assert [(d["body"], d["sent"], bool(d["error"])) for d in listed["drafts"]] == [
        ("first", True, False), ("bad", False, True), ("last", False, False)]
    assert listed["githubPending"] == 0  # the one pending comment is our own draft

    # A draft already on GitHub can't be changed here.
    assert drafts_app.patch(f"/api/drafts/{first['id']}", json={"body": "x"}).status_code == 409
    assert drafts_app.delete(f"/api/drafts/{first['id']}").status_code == 409

    gh.fail_bodies = set()
    assert _submit(drafts_app).json() == {"sent": 3, "held": 0}

    assert [entry[-1] for entry in gh.added] == ["first", "bad", "last"]  # nothing twice
    assert gh.started == ["abc1234"]
    assert gh.submitted == [("R1", "COMMENT", "")]
    assert _list(drafts_app)["drafts"] == []


def test_a_failed_submit_is_retried_without_resending(drafts_app):
    gh = drafts_app.gh
    _comment(drafts_app)
    gh.fail_submit = True

    assert _submit(drafts_app).status_code == 502
    assert [d["sent"] for d in _list(drafts_app)["drafts"]] == [True]

    gh.fail_submit = False
    assert _submit(drafts_app).status_code == 200
    assert len(gh.added) == 1 and gh.submitted == [("R1", "COMMENT", "")]


def test_drafts_are_resent_if_the_pending_review_was_deleted_on_github(drafts_app):
    gh = drafts_app.gh
    first = _comment(drafts_app, body="first", start=1, end=1)
    _comment(drafts_app, body="bad", start=2, end=2)
    gh.fail_bodies = {"bad"}
    _submit(drafts_app)

    gh.pending = None  # deleted on github.com
    gh.fail_bodies = set()

    # With no pending review holding it, the draft is editable again.
    assert _list(drafts_app)["drafts"][0]["sent"] is False
    assert drafts_app.patch(f"/api/drafts/{first['id']}", json={"body": "first!"}).status_code == 200

    assert _submit(drafts_app).json() == {"sent": 2, "held": 0}
    assert [(entry[1], entry[-1]) for entry in gh.added] == [("R1", "first"), ("R2", "first!"), ("R2", "bad")]
    assert gh.submitted == [("R2", "COMMENT", "")]


def test_a_sent_draft_is_not_held_back_by_a_later_push(drafts_app):
    gh = drafts_app.gh
    _comment(drafts_app, start=3, end=3)
    gh.fail_submit = True
    _submit(drafts_app)

    _push(gh, "one\ntwo\nTHREE\nfour\n")
    gh.fail_submit = False

    assert _list(drafts_app)["drafts"][0]["outdated"] is False  # it is already on GitHub
    assert _submit(drafts_app).json() == {"sent": 1, "held": 0}
    assert _list(drafts_app)["drafts"] == []


# -- the GitHub calls --------------------------------------------------------


def _with_graphql(monkeypatch, answer):
    client = GitHub("tok")
    seen = []

    async def fake_graphql(query, **variables):
        seen.append((query, variables))
        return answer

    monkeypatch.setattr(client, "_graphql", fake_graphql)
    return client, seen


def _run(client, coro):
    try:
        return asyncio.run(coro)
    finally:
        asyncio.run(client.aclose())


def test_review_state_finds_the_viewers_pending_review(monkeypatch):
    reviews = [{"id": "R-other", "viewerDidAuthor": False, "comments": {"totalCount": 9}},
               {"id": "R-mine", "viewerDidAuthor": True, "comments": {"totalCount": 2}}]
    client, _ = _with_graphql(monkeypatch, {"repository": {"pullRequest": {
        "id": "PR1", "headRefOid": "abc", "reviews": {"nodes": reviews}}}})

    state = _run(client, client.review_state(PRRef("o", "r", 7)))

    assert state == {"head": "abc", "pullRequestId": "PR1", "pending": {"id": "R-mine", "comments": 2}}


def test_review_state_without_a_pending_review(monkeypatch):
    client, _ = _with_graphql(monkeypatch, {"repository": {"pullRequest": {
        "id": "PR1", "headRefOid": "abc", "reviews": {"nodes": []}}}})

    assert _run(client, client.review_state(PRRef("o", "r", 7)))["pending"] is None


def test_a_line_thread_and_a_file_thread(monkeypatch):
    client, seen = _with_graphql(monkeypatch, {"addPullRequestReviewThread": {"thread": {"id": "T9"}}})

    async def both():
        await client.add_review_thread("R1", path="a.md", body="b", line=5, start_line=3)
        await client.add_review_thread("R1", path="a.md", body="b")

    _run(client, both())

    assert seen[0][1]["input"] == {"pullRequestReviewId": "R1", "path": "a.md", "body": "b",
                                   "line": 5, "side": "RIGHT", "startLine": 3, "startSide": "RIGHT"}
    assert seen[1][1]["input"] == {"pullRequestReviewId": "R1", "path": "a.md", "body": "b",
                                   "subjectType": "FILE"}


def test_a_thread_github_quietly_drops_is_an_error(monkeypatch):
    client, _ = _with_graphql(monkeypatch, {"addPullRequestReviewThread": {"thread": None}})

    with pytest.raises(GitHubError):
        _run(client, client.add_review_thread("R1", path="a.md", body="b", line=5))
