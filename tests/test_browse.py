import asyncio

import httpx
import pytest

from spec_tackle.app import app
from spec_tackle.github import GitHub, GitHubError, repo_search_query


def repo(owner, name, pushed, open_prs=1, private=False):
    return {"name": name, "owner": {"login": owner}, "description": f"{name} repo", "isPrivate": private,
            "pushedAt": pushed, "pullRequests": {"totalCount": open_prs}}


def run_with_graphql(monkeypatch, coro_fn, payload):
    client = GitHub("tok")
    seen = {}

    async def fake_graphql(query, **variables):
        seen.update(query=query, variables=variables)
        return payload

    monkeypatch.setattr(client, "_graphql", fake_graphql)
    try:
        return asyncio.run(coro_fn(client)), seen
    finally:
        asyncio.run(client.aclose())


@pytest.mark.parametrize("text, query", [
    ("conn", "conn in:name"),
    ("  dimagi/conn ", "user:dimagi conn in:name"),
    ("dimagi/", "user:dimagi"),
    ("dimagi/commcare connect", "user:dimagi commcare connect in:name"),
])
def test_repo_search_query(text, query):
    assert repo_search_query(text) == query


def test_viewer_repos_merges_owned_and_contributed_newest_first(monkeypatch):
    payload = {"viewer": {
        "repositories": {"nodes": [repo("me", "dots", "2026-09-01T00:00:00Z"), repo("dimagi", "hq", "2026-10-01T00:00:00Z")]},
        "repositoriesContributedTo": {"nodes": [repo("dimagi", "hq", "2026-10-01T00:00:00Z"), None,
                                                repo("dimagi", "connect", "2026-10-07T00:00:00Z", open_prs=4, private=True)]},
    }}
    result, _ = run_with_graphql(monkeypatch, lambda c: c.repos(), payload)

    assert result == [
        {"owner": "dimagi", "repo": "connect", "description": "connect repo", "isPrivate": True,
         "pushedAt": "2026-10-07T00:00:00Z", "openPrs": 4},
        {"owner": "dimagi", "repo": "hq", "description": "hq repo", "isPrivate": False,
         "pushedAt": "2026-10-01T00:00:00Z", "openPrs": 1},
        {"owner": "me", "repo": "dots", "description": "dots repo", "isPrivate": False,
         "pushedAt": "2026-09-01T00:00:00Z", "openPrs": 1},
    ]


def test_repo_search_passes_the_built_query(monkeypatch):
    payload = {"search": {"nodes": [repo("dimagi", "commcare-connect", "2026-10-07T00:00:00Z"), {}]}}
    result, seen = run_with_graphql(monkeypatch, lambda c: c.repos("dimagi/conn"), payload)

    assert seen["variables"]["q"] == "user:dimagi conn in:name"
    assert [r["repo"] for r in result] == ["commcare-connect"]


def test_open_pulls_lists_a_repos_open_prs(monkeypatch):
    payload = {"repository": {"pullRequests": {"nodes": [
        {"number": 5, "title": "Spec", "isDraft": True, "updatedAt": "2026-10-07T00:00:00Z",
         "url": "https://github.com/o/r/pull/5", "author": None},
    ]}}}
    result, seen = run_with_graphql(monkeypatch, lambda c: c.open_pulls("o", "r"), payload)

    assert seen["variables"] == {"owner": "o", "repo": "r"}
    assert "states: OPEN" in seen["query"]
    assert result == [{"owner": "o", "repo": "r", "number": 5, "title": "Spec", "author": None,
                       "updatedAt": "2026-10-07T00:00:00Z", "isDraft": True, "url": "https://github.com/o/r/pull/5"}]


def test_open_pulls_of_a_missing_repo_is_a_404(monkeypatch):
    with pytest.raises(GitHubError) as exc:
        run_with_graphql(monkeypatch, lambda c: c.open_pulls("o", "nope"), {"repository": None})
    assert exc.value.status == 404


def test_repos_endpoint(web_app):
    assert web_app.get("/api/repos").json()[0]["repo"] == "r"
    web_app.get("/api/repos", params={"q": "dimagi/conn"})
    assert app.state.session.gh.repo_queries == ["", "dimagi/conn"]


def test_pulls_endpoint(web_app):
    response = web_app.get("/api/repos/dimagi/connect/pulls")

    assert response.status_code == 200
    assert response.json()[0]["url"] == "https://github.com/dimagi/connect/pull/8"


def test_browse_endpoints_when_signed_out_say_so(web_app):
    app.state.session.signed_in = False

    for url in ("/api/repos", "/api/repos/o/r/pulls"):
        response = web_app.get(url)
        assert response.status_code == 401
        assert response.json()["signedOut"] is True


def test_network_failure_becomes_github_error():
    def drop_connection(request):
        raise httpx.ReadError("connection reset", request=request)

    async def call():
        client = GitHub("tok")
        client._client = httpx.AsyncClient(base_url="https://api.github.com",
                                           transport=httpx.MockTransport(drop_connection))
        try:
            await client.repos()
        finally:
            await client.aclose()

    with pytest.raises(GitHubError) as caught:
        asyncio.run(call())
    assert caught.value.status == 502
    assert "tok" not in str(caught.value)
