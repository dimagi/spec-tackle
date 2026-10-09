import asyncio

import pytest

from spec_tackle import render
from spec_tackle.app import app
from spec_tackle.github import GitHub, GitHubError, PRRef


@pytest.mark.parametrize("path, kind", [
    ("comments/11", "review-comment"),
    ("conversation/12", "comment"),
    ("reviews/13", "review"),
])
def test_edit_routes_send_the_new_body(web_app, path, kind):
    response = web_app.patch(f"/api/pr/o/r/7/{path}", json={"body": "Better wording"})

    assert response.status_code == 200
    assert app.state.session.gh.edits == [(kind, int(path.split("/")[1]), "Better wording")]


def test_edits_cannot_empty_a_comment(web_app):
    response = web_app.patch("/api/pr/o/r/7/comments/11", json={"body": "  "})

    assert response.status_code == 400
    assert app.state.session.gh.edits == []


def test_mentionable_drops_the_at_sign(web_app):
    response = web_app.get("/api/pr/o/r/7/mentionable", params={"q": "@an"})

    assert response.json() == [{"login": "ann", "name": "Ann", "avatarUrl": ""}]
    assert app.state.session.gh.mention_queries == ["an"]


def test_mentionable_users_reads_the_repo(monkeypatch):
    client = GitHub("tok")
    seen = {}

    async def fake_graphql(query, **variables):
        seen.update(variables)
        return {"repository": {"mentionableUsers": {"nodes": [{"login": "ann", "name": None, "avatarUrl": "a"}, None]}}}

    monkeypatch.setattr(client, "_graphql", fake_graphql)
    try:
        users = asyncio.run(client.mentionable_users(PRRef("o", "r", 7), "an"))
    finally:
        asyncio.run(client.aclose())
    assert users == [{"login": "ann", "name": None, "avatarUrl": "a"}]
    assert seen == {"owner": "o", "repo": "r", "q": "an"}


def test_mentionable_users_of_a_missing_repo_is_a_404(monkeypatch):
    client = GitHub("tok")

    async def fake_graphql(query, **variables):
        return {"repository": None}

    monkeypatch.setattr(client, "_graphql", fake_graphql)
    try:
        with pytest.raises(GitHubError) as exc:
            asyncio.run(client.mentionable_users(PRRef("o", "r", 7), ""))
    finally:
        asyncio.run(client.aclose())
    assert exc.value.status == 404


def test_activity_says_which_comments_the_viewer_can_edit():
    author = {"__typename": "User", "login": "me", "avatarUrl": ""}
    mine = {"databaseId": 1, "author": author, "body": "b", "bodyHTML": "<p>b</p>",
            "createdAt": "2026-01-01T00:00:00Z", "url": "u", "viewerCanUpdate": True}
    activity = render.normalize_activity({
        "reviewThreads": {"nodes": [{
            "id": "T1", "isResolved": False, "isOutdated": False, "path": "a.md", "line": 3,
            "startLine": None, "originalLine": 3, "originalStartLine": None, "diffSide": "RIGHT",
            "subjectType": "LINE", "resolvedBy": None, "comments": {"nodes": [mine]},
        }]},
        "comments": {"nodes": [{**mine, "databaseId": 2, "viewerCanUpdate": False}]},
        "reviews": {"nodes": [{**mine, "databaseId": 3, "state": "APPROVED", "submittedAt": "2026-01-02T00:00:00Z"}]},
        "headRefOid": "abc", "state": "OPEN", "isDraft": False, "merged": False, "viewer": {"login": "me"},
    })

    assert activity["threads"][0]["comments"][0]["canEdit"] is True
    assert [c["canEdit"] for c in activity["conversation"]] == [False, True]
