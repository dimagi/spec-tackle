"""Thin async GitHub client covering just what a spec review needs."""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from dataclasses import dataclass

import httpx

API = "https://api.github.com"

_PR_URL_RE = re.compile(r"github\.com/([\w.-]+)/([\w.-]+)/pull/(\d+)")
_PR_SHORT_RE = re.compile(r"^([\w.-]+)/([\w.-]+)#(\d+)$")


class GitHubError(Exception):
    def __init__(self, message: str, status: int = 500):
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class PRRef:
    owner: str
    repo: str
    number: int

    @property
    def path(self) -> str:
        return f"{self.owner}/{self.repo}/{self.number}"


def parse_pr_url(value: str) -> PRRef:
    """Accept a full PR URL (any tab: /changes, /files, ...) or `owner/repo#123`."""
    value = value.strip()
    match = _PR_URL_RE.search(value) or _PR_SHORT_RE.match(value)
    if not match:
        raise ValueError(f"Not a GitHub pull request link: {value!r}")
    owner, repo, number = match.groups()
    return PRRef(owner, repo, int(number))


def find_token() -> str | None:
    """A token from GITHUB_TOKEN / GH_TOKEN, else from the GitHub CLI; None if signed out."""
    for var in ("GITHUB_TOKEN", "GH_TOKEN"):
        if os.environ.get(var):
            return os.environ[var]
    return gh_cli_token()


def gh_cli_token() -> str | None:
    if not shutil.which("gh"):
        return None
    result = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True)
    if result.returncode == 0 and result.stdout.strip():
        return result.stdout.strip()
    return None


_AUTHOR = "author { __typename login avatarUrl }"

_ACTIVITY_FIELDS = f"""
  headRefOid state isDraft merged
  reviewThreads(first: 100) {{
    nodes {{
      id isResolved isOutdated path line startLine originalLine originalStartLine
      diffSide subjectType resolvedBy {{ login }}
      comments(first: 100) {{
        nodes {{ id databaseId {_AUTHOR} body bodyHTML createdAt url replyTo {{ databaseId }} }}
      }}
    }}
  }}
  comments(first: 100) {{
    nodes {{ databaseId {_AUTHOR} body bodyHTML createdAt url }}
  }}
  reviews(first: 100) {{
    nodes {{ databaseId state {_AUTHOR} body bodyHTML submittedAt url }}
  }}
"""

_ACTIVITY_QUERY = f"""
query($owner: String!, $repo: String!, $number: Int!) {{
  viewer {{ login avatarUrl }}
  repository(owner: $owner, name: $repo) {{
    pullRequest(number: $number) {{ {_ACTIVITY_FIELDS} }}
  }}
}}
"""

_OVERVIEW_QUERY = f"""
query($owner: String!, $repo: String!, $number: Int!) {{
  viewer {{ login avatarUrl }}
  repository(owner: $owner, name: $repo) {{
    pullRequest(number: $number) {{
      title number url body bodyHTML createdAt updatedAt
      baseRefName headRefName additions deletions changedFiles reviewDecision
      {_AUTHOR}
      {_ACTIVITY_FIELDS}
    }}
  }}
}}
"""


_REVIEW_REQUESTS_QUERY = """
query {
  search(query: "is:open is:pr review-requested:@me sort:updated-desc", type: ISSUE, first: 20) {
    nodes {
      ... on PullRequest {
        number title isDraft updatedAt url
        repository { name owner { login } }
        author { login }
      }
    }
  }
}
"""


class GitHub:
    def __init__(self, token: str):
        self.token = token
        self._client = httpx.AsyncClient(
            base_url=API,
            timeout=30,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    # -- transport ---------------------------------------------------------

    async def _request(self, method: str, url: str, **kwargs) -> httpx.Response:
        response = await self._client.request(method, url, **kwargs)
        if response.status_code >= 400:
            try:
                data = response.json()
                message = data.get("message", response.text)
                details = [e.get("message") or str(e) for e in data.get("errors", [])]
                if details:
                    message = f"{message}: {'; '.join(map(str, details))}"
            except ValueError:
                message = response.text
            raise GitHubError(message, status=response.status_code)
        return response

    async def _graphql(self, query: str, **variables) -> dict:
        response = await self._request(
            "POST", "/graphql", json={"query": query, "variables": variables}
        )
        payload = response.json()
        if payload.get("errors"):
            raise GitHubError("; ".join(e["message"] for e in payload["errors"]), 502)
        return payload["data"]

    async def _paginate(self, url: str) -> list[dict]:
        items: list[dict] = []
        next_url: str | None = url
        while next_url:
            response = await self._request("GET", next_url, params={"per_page": 100})
            items.extend(response.json())
            next_url = response.links.get("next", {}).get("url")
        return items

    # -- reads -------------------------------------------------------------

    async def viewer(self) -> dict:
        data = (await self._request("GET", "/user")).json()
        return {"login": data["login"], "name": data.get("name"), "avatarUrl": data["avatar_url"]}

    async def overview(self, pr: PRRef) -> dict:
        data = await self._graphql(
            _OVERVIEW_QUERY, owner=pr.owner, repo=pr.repo, number=pr.number
        )
        pull = data["repository"]["pullRequest"]
        if pull is None:
            raise GitHubError("Pull request not found", 404)
        return {"viewer": data["viewer"], **pull}

    async def activity(self, pr: PRRef) -> dict:
        data = await self._graphql(
            _ACTIVITY_QUERY, owner=pr.owner, repo=pr.repo, number=pr.number
        )
        return {"viewer": data["viewer"], **data["repository"]["pullRequest"]}

    async def files(self, pr: PRRef) -> list[dict]:
        return await self._paginate(
            f"/repos/{pr.owner}/{pr.repo}/pulls/{pr.number}/files"
        )

    async def review_requests(self) -> list[dict]:
        """Open PRs waiting on the viewer's review, most recently updated first."""
        data = await self._graphql(_REVIEW_REQUESTS_QUERY)
        pulls = [
            {
                "owner": node["repository"]["owner"]["login"],
                "repo": node["repository"]["name"],
                "number": node["number"],
                "title": node["title"],
                "author": (node["author"] or {}).get("login"),
                "updatedAt": node["updatedAt"],
                "isDraft": node["isDraft"],
                "url": node["url"],
            }
            for node in data["search"]["nodes"]
            if node  # non-PR hits are empty objects
        ]
        return sorted(pulls, key=lambda p: p["updatedAt"], reverse=True)

    async def raw_file(self, owner: str, repo: str, path: str, ref: str) -> bytes:
        response = await self._request(
            "GET",
            f"/repos/{owner}/{repo}/contents/{path}",
            params={"ref": ref},
            headers={"Accept": "application/vnd.github.raw"},
        )
        return response.content

    async def render_markdown(self, pr: PRRef, text: str) -> str:
        response = await self._request(
            "POST",
            "/markdown",
            json={"text": text, "mode": "gfm", "context": f"{pr.owner}/{pr.repo}"},
        )
        return response.text

    # -- writes ------------------------------------------------------------

    async def create_review_comment(self, pr: PRRef, payload: dict) -> dict:
        response = await self._request(
            "POST",
            f"/repos/{pr.owner}/{pr.repo}/pulls/{pr.number}/comments",
            json=payload,
        )
        return response.json()

    async def reply(self, pr: PRRef, comment_id: int, body: str) -> dict:
        response = await self._request(
            "POST",
            f"/repos/{pr.owner}/{pr.repo}/pulls/{pr.number}/comments/{comment_id}/replies",
            json={"body": body},
        )
        return response.json()

    async def conversation_comment(self, pr: PRRef, body: str) -> dict:
        response = await self._request(
            "POST",
            f"/repos/{pr.owner}/{pr.repo}/issues/{pr.number}/comments",
            json={"body": body},
        )
        return response.json()

    async def submit_review(self, pr: PRRef, event: str, body: str) -> dict:
        payload = {"event": event}
        if body:
            payload["body"] = body
        response = await self._request(
            "POST",
            f"/repos/{pr.owner}/{pr.repo}/pulls/{pr.number}/reviews",
            json=payload,
        )
        return response.json()

    async def set_thread_resolved(self, thread_id: str, resolved: bool) -> None:
        mutation = "resolveReviewThread" if resolved else "unresolveReviewThread"
        await self._graphql(
            f"mutation($id: ID!) {{ {mutation}(input: {{threadId: $id}}) {{ thread {{ id }} }} }}",
            id=thread_id,
        )
