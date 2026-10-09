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
        nodes {{ id databaseId {_AUTHOR} body bodyHTML createdAt url viewerCanUpdate replyTo {{ databaseId }} }}
      }}
    }}
  }}
  comments(first: 100) {{
    nodes {{ databaseId {_AUTHOR} body bodyHTML createdAt url viewerCanUpdate }}
  }}
  reviews(first: 100) {{
    nodes {{ databaseId state {_AUTHOR} body bodyHTML submittedAt url viewerCanUpdate }}
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


_REPO_FIELDS = "name owner { login } description isPrivate pushedAt pullRequests(states: OPEN) { totalCount }"

_VIEWER_REPOS_QUERY = f"""
query {{
  viewer {{
    repositories(first: 30, orderBy: {{field: PUSHED_AT, direction: DESC}},
                 affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER],
                 ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]) {{
      nodes {{ {_REPO_FIELDS} }}
    }}
    repositoriesContributedTo(first: 30, orderBy: {{field: PUSHED_AT, direction: DESC}}, includeUserRepositories: true,
                              contributionTypes: [COMMIT, PULL_REQUEST, PULL_REQUEST_REVIEW]) {{
      nodes {{ {_REPO_FIELDS} }}
    }}
  }}
}}
"""

_REPO_SEARCH_QUERY = f"""
query($q: String!) {{
  search(query: $q, type: REPOSITORY, first: 20) {{
    nodes {{ ... on Repository {{ {_REPO_FIELDS} }} }}
  }}
}}
"""

_OPEN_PULLS_QUERY = """
query($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
    pullRequests(states: OPEN, first: 50, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes { number title isDraft updatedAt url author { login } }
    }
  }
}
"""

_MENTIONABLE_QUERY = """
query($owner: String!, $repo: String!, $q: String!) {
  repository(owner: $owner, name: $repo) {
    mentionableUsers(query: $q, first: 8) { nodes { login name avatarUrl } }
  }
}
"""


def repo_search_query(text: str) -> str:
    """GitHub search syntax for what someone typed: `owner/partial` searches within that owner."""
    owner, slash, name = text.strip().partition("/")
    if not slash:
        return f"{owner} in:name"
    return f"user:{owner} {name.strip()} in:name" if name.strip() else f"user:{owner}"


def _repo(node: dict) -> dict:
    return {
        "owner": node["owner"]["login"],
        "repo": node["name"],
        "description": node["description"],
        "isPrivate": node["isPrivate"],
        "pushedAt": node["pushedAt"],
        "openPrs": node["pullRequests"]["totalCount"],
    }


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

    async def _graphql(self, query: str, *, partial: bool = False, **variables) -> dict:
        """Run a query; with `partial`, return whatever data came back alongside errors."""
        response = await self._request(
            "POST", "/graphql", json={"query": query, "variables": variables}
        )
        payload = response.json()
        if payload.get("errors") and not (partial and payload.get("data")):
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
        # Orgs the token isn't SSO-authorized for add errors; keep the rest of the results.
        data = await self._graphql(_REVIEW_REQUESTS_QUERY, partial=True)
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

    async def repos(self, query: str = "") -> list[dict]:
        """Repos to browse: the viewer's own and contributed ones, or a search when `query` is given."""
        # Orgs the token isn't SSO-authorized for add errors; keep the rest of the results.
        if query.strip():
            data = await self._graphql(_REPO_SEARCH_QUERY, partial=True, q=repo_search_query(query))
            return [_repo(node) for node in data["search"]["nodes"] if node]
        viewer = (await self._graphql(_VIEWER_REPOS_QUERY, partial=True))["viewer"]
        found: dict[tuple[str, str], dict] = {}
        for key in ("repositories", "repositoriesContributedTo"):
            for node in (viewer.get(key) or {}).get("nodes") or []:
                if node:
                    repo = _repo(node)
                    found.setdefault((repo["owner"], repo["repo"]), repo)
        ordered = sorted(found.values(), key=lambda r: r["pushedAt"] or "", reverse=True)
        return ordered[:30]

    async def open_pulls(self, owner: str, repo: str) -> list[dict]:
        """A repo's open PRs, most recently updated first."""
        data = await self._graphql(_OPEN_PULLS_QUERY, owner=owner, repo=repo)
        if data["repository"] is None:
            raise GitHubError("Repository not found", 404)
        return [
            {
                "owner": owner,
                "repo": repo,
                "number": node["number"],
                "title": node["title"],
                "author": (node["author"] or {}).get("login"),
                "updatedAt": node["updatedAt"],
                "isDraft": node["isDraft"],
                "url": node["url"],
            }
            for node in data["repository"]["pullRequests"]["nodes"]
            if node
        ]

    async def mentionable_users(self, pr: PRRef, query: str) -> list[dict]:
        """People who can be @mentioned in the PR's repo, matching `query`."""
        data = await self._graphql(_MENTIONABLE_QUERY, owner=pr.owner, repo=pr.repo, q=query)
        if data["repository"] is None:
            raise GitHubError("Repository not found", 404)
        return [
            {"login": node["login"], "name": node["name"], "avatarUrl": node["avatarUrl"]}
            for node in data["repository"]["mentionableUsers"]["nodes"]
            if node
        ]

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

    async def edit_review_comment(self, pr: PRRef, comment_id: int, body: str) -> dict:
        response = await self._request(
            "PATCH",
            f"/repos/{pr.owner}/{pr.repo}/pulls/comments/{comment_id}",
            json={"body": body},
        )
        return response.json()

    async def edit_conversation_comment(self, pr: PRRef, comment_id: int, body: str) -> dict:
        response = await self._request(
            "PATCH",
            f"/repos/{pr.owner}/{pr.repo}/issues/comments/{comment_id}",
            json={"body": body},
        )
        return response.json()

    async def edit_review(self, pr: PRRef, review_id: int, body: str) -> dict:
        response = await self._request(
            "PUT",
            f"/repos/{pr.owner}/{pr.repo}/pulls/{pr.number}/reviews/{review_id}",
            json={"body": body},
        )
        return response.json()

    async def set_thread_resolved(self, thread_id: str, resolved: bool) -> None:
        mutation = "resolveReviewThread" if resolved else "unresolveReviewThread"
        await self._graphql(
            f"mutation($id: ID!) {{ {mutation}(input: {{threadId: $id}}) {{ thread {{ id }} }} }}",
            id=thread_id,
        )
