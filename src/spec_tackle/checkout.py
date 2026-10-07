"""Read-only checkouts of PR repos for Claude: one bare clone per repo, one worktree per commit.

The GitHub token goes to git through GIT_CONFIG_* environment variables, so it never
appears in a process list, a config file, or an error message.
"""

from __future__ import annotations

import asyncio
import base64
import os
import re
from collections.abc import Callable
from pathlib import Path

from .store import data_dir

_GONE_RE = re.compile(r"not our ref|couldn't find remote ref|unadvertised object", re.I)


class CheckoutError(Exception):
    pass


class CommitGone(CheckoutError):
    pass


def git_env(token: str) -> dict[str, str]:
    header = base64.b64encode(f"x-access-token:{token}".encode()).decode()
    return {
        **os.environ,
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_CONFIG_COUNT": "2",
        "GIT_CONFIG_KEY_0": "http.https://github.com/.extraHeader",
        "GIT_CONFIG_VALUE_0": f"Authorization: Basic {header}",
        # Check symlinks out as plain files so Claude's file walks can't follow them out.
        "GIT_CONFIG_KEY_1": "core.symlinks",
        "GIT_CONFIG_VALUE_1": "false",
    }


def _check_name(name: str) -> None:
    """Reject owner/repo names that could escape the checkout directory."""
    if name in (".", "..") or not re.fullmatch(r"[A-Za-z0-9_.-]+", name):
        raise CheckoutError(f"Not a valid owner or repo name: {name!r}")


def _github_remote(owner: str, repo: str) -> str:
    return f"https://github.com/{owner}/{repo}.git"


class Checkouts:
    def __init__(
        self, root: Path | None = None, remote: Callable[[str, str], str] | None = None
    ):
        self.root = root or data_dir() / "repos"
        self._remote = remote or _github_remote
        self._locks: dict[str, asyncio.Lock] = {}

    def has_clone(self, *, owner: str, repo: str) -> bool:
        _check_name(owner)
        _check_name(repo)
        return (self._bare(owner=owner, repo=repo) / "HEAD").exists()

    async def worktree(self, *, owner: str, repo: str, sha: str, token: str) -> Path:
        """A directory with the repo checked out at `sha`; created on first use."""
        _check_name(owner)
        _check_name(repo)
        if not re.fullmatch(r"[0-9a-f]{7,40}", sha):
            raise CheckoutError(f"Not a commit id: {sha!r}")
        target = self.root / owner / repo / sha
        lock = self._locks.setdefault(f"{owner}/{repo}", asyncio.Lock())
        async with lock:
            if (target / ".git").exists():
                return target
            bare = self._bare(owner=owner, repo=repo)
            env = git_env(token)
            if not self.has_clone(owner=owner, repo=repo):
                bare.parent.mkdir(parents=True, exist_ok=True)
                await self._git(
                    "clone", "--bare", "--filter=blob:none", self._remote(owner, repo), str(bare),
                    env=env, token=token,
                )
            await self._git("worktree", "prune", cwd=bare, env=env, token=token)
            if not await self._has_commit(bare=bare, sha=sha, env=env):
                try:
                    await self._git("fetch", "origin", sha, cwd=bare, env=env, token=token)
                except CheckoutError as exc:
                    if _GONE_RE.search(str(exc)):
                        raise CommitGone(
                            "This commit is no longer on GitHub (the branch was probably"
                            " force-pushed). Start a new question to ask about the current version."
                        ) from exc
                    raise
            await self._git(
                "worktree", "add", "--detach", str(target), sha, cwd=bare, env=env, token=token
            )
            return target

    def _bare(self, *, owner: str, repo: str) -> Path:
        return self.root / owner / f"{repo}.git"

    async def _has_commit(self, *, bare: Path, sha: str, env: dict[str, str]) -> bool:
        proc = await asyncio.create_subprocess_exec(
            "git", "cat-file", "-e", f"{sha}^{{commit}}", cwd=bare, env=env,
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
        )
        return await proc.wait() == 0

    async def _git(self, *args: str, env: dict[str, str], token: str, cwd: Path | None = None) -> None:
        proc = await asyncio.create_subprocess_exec(
            "git", *args, cwd=cwd, env=env,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await proc.communicate()
        if proc.returncode != 0:
            message = stderr.decode("utf-8", "replace").strip().replace(token, "***")
            raise CheckoutError(message or f"git {args[0]} failed")
