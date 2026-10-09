import asyncio

import pytest

from spec_tackle.app import app
from spec_tackle.github import GitHub, GitHubError


def pull(number, updated, author="ann", draft=False):
    return {"number": number, "title": f"PR {number}", "isDraft": draft, "updatedAt": updated,
            "url": f"https://github.com/o/r/pull/{number}",
            "repository": {"name": "r", "owner": {"login": "o"}},
            "author": {"login": author} if author else None}


def test_review_requests_flattens_search_results_newest_first(monkeypatch):
    client = GitHub("tok")
    seen = {}

    async def fake_graphql(query, **variables):
        seen["query"] = query
        # Non-PR search hits come back as empty objects.
        return {"search": {"nodes": [pull(3, "2026-10-01T00:00:00Z"), {},
                                     pull(9, "2026-10-07T00:00:00Z", author=None, draft=True)]}}

    monkeypatch.setattr(client, "_graphql", fake_graphql)
    try:
        result = asyncio.run(client.review_requests())
    finally:
        asyncio.run(client.aclose())

    assert "is:open is:pr review-requested:@me" in seen["query"]
    assert "first: 20" in seen["query"]
    assert result == [
        {"owner": "o", "repo": "r", "number": 9, "title": "PR 9", "author": None,
         "updatedAt": "2026-10-07T00:00:00Z", "isDraft": True, "url": "https://github.com/o/r/pull/9"},
        {"owner": "o", "repo": "r", "number": 3, "title": "PR 3", "author": "ann",
         "updatedAt": "2026-10-01T00:00:00Z", "isDraft": False, "url": "https://github.com/o/r/pull/3"},
    ]


def test_endpoint_returns_the_queue(web_app):
    response = web_app.get("/api/review-requests")

    assert response.status_code == 200
    assert response.json()[0]["number"] == 8


def test_endpoint_passes_github_errors_through(web_app, monkeypatch):
    async def boom():
        raise GitHubError("search is down", 502)

    monkeypatch.setattr(app.state.session.gh, "review_requests", boom)

    response = web_app.get("/api/review-requests")

    assert response.status_code == 502
    assert response.json() == {"error": "search is down", "signedOut": False}


def test_endpoint_when_signed_out_says_so(web_app):
    app.state.session.signed_in = False

    response = web_app.get("/api/review-requests")

    assert response.status_code == 401
    assert response.json()["signedOut"] is True


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def json(self):
        return self.payload


def test_review_requests_keeps_results_when_some_orgs_error(monkeypatch):
    """A token not SSO-authorized for one org gets partial data plus errors; show what came back."""
    client = GitHub("tok")

    async def fake_request(method, url, **kwargs):
        return FakeResponse({
            "data": {"search": {"nodes": [pull(3, "2026-10-01T00:00:00Z"), None]}},
            "errors": [{"message": "Resource protected by organization SAML enforcement."}],
        })

    monkeypatch.setattr(client, "_request", fake_request)
    try:
        result = asyncio.run(client.review_requests())
    finally:
        asyncio.run(client.aclose())

    assert [p["number"] for p in result] == [3]


def test_review_requests_raises_when_search_failed_outright(monkeypatch):
    client = GitHub("tok")

    async def fake_request(method, url, **kwargs):
        return FakeResponse({"data": None, "errors": [{"message": "Something went wrong"}]})

    monkeypatch.setattr(client, "_request", fake_request)
    try:
        with pytest.raises(GitHubError, match="Something went wrong"):
            asyncio.run(client.review_requests())
    finally:
        asyncio.run(client.aclose())
