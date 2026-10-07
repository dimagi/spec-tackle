import asyncio
import subprocess

import pytest

from spec_tackle import checkout
from spec_tackle.checkout import CheckoutError, Checkouts, CommitGone, git_env

TOKEN = "ghp_secret_token_value"


def _git(cwd, *args):
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


@pytest.fixture
def origin(tmp_path):
    """A local repo standing in for github.com/o/r, with one commit."""
    repo = tmp_path / "origin"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "main")
    _git(repo, "config", "user.email", "t@example.com")
    _git(repo, "config", "user.name", "t")
    _git(repo, "config", "uploadpack.allowAnySHA1InWant", "true")
    (repo / "spec.md").write_text("# Spec\n\nline three\n")
    _git(repo, "add", ".")
    _git(repo, "commit", "-q", "-m", "first")
    return repo


@pytest.fixture
def checkouts(tmp_path, origin):
    return Checkouts(root=tmp_path / "repos", remote=lambda owner, repo: f"file://{origin}")


def _head(origin):
    return _git(origin, "rev-parse", "HEAD")


def test_first_question_clones_and_checks_out_the_commit(checkouts, origin):
    assert not checkouts.has_clone(owner="o", repo="r")
    path = asyncio.run(checkouts.worktree(owner="o", repo="r", sha=_head(origin), token=TOKEN))
    assert (path / "spec.md").read_text().startswith("# Spec")
    assert checkouts.has_clone(owner="o", repo="r")


def test_reuses_clone_and_fetches_new_commits(checkouts, origin):
    first = _head(origin)
    asyncio.run(checkouts.worktree(owner="o", repo="r", sha=first, token=TOKEN))
    (origin / "spec.md").write_text("# Spec v2\n")
    _git(origin, "commit", "-qam", "second")
    second = _head(origin)

    path = asyncio.run(checkouts.worktree(owner="o", repo="r", sha=second, token=TOKEN))
    assert (path / "spec.md").read_text() == "# Spec v2\n"
    # The older worktree is still there for threads asked on it.
    again = asyncio.run(checkouts.worktree(owner="o", repo="r", sha=first, token=TOKEN))
    assert (again / "spec.md").read_text().startswith("# Spec\n")


def test_concurrent_requests_share_one_clone(checkouts, origin):
    async def both():
        sha = _head(origin)
        return await asyncio.gather(
            checkouts.worktree(owner="o", repo="r", sha=sha, token=TOKEN),
            checkouts.worktree(owner="o", repo="r", sha=sha, token=TOKEN),
        )

    a, b = asyncio.run(both())
    assert a == b and (a / "spec.md").exists()


def test_unknown_commit_raises_commit_gone(checkouts, origin):
    asyncio.run(checkouts.worktree(owner="o", repo="r", sha=_head(origin), token=TOKEN))
    with pytest.raises(CommitGone):
        asyncio.run(checkouts.worktree(owner="o", repo="r", sha="0" * 40, token=TOKEN))


def test_token_never_in_argv_files_or_errors(checkouts, origin, tmp_path, monkeypatch):
    seen_args = []
    real = asyncio.create_subprocess_exec

    async def spy(*args, **kwargs):
        seen_args.append(args)
        return await real(*args, **kwargs)

    monkeypatch.setattr(checkout.asyncio, "create_subprocess_exec", spy)
    asyncio.run(checkouts.worktree(owner="o", repo="r", sha=_head(origin), token=TOKEN))
    with pytest.raises(CommitGone) as excinfo:
        asyncio.run(checkouts.worktree(owner="o", repo="r", sha="0" * 40, token=TOKEN))

    assert seen_args and not any(TOKEN in " ".join(map(str, a)) for a in seen_args)
    assert TOKEN not in str(excinfo.value)
    for path in (tmp_path / "repos").rglob("*"):
        if path.is_file() and path.stat().st_size < 1_000_000:
            assert TOKEN.encode() not in path.read_bytes(), path


def test_git_env_sends_basic_auth_header_for_github_only():
    env = git_env("abc")
    assert env["GIT_CONFIG_COUNT"] == "1"
    assert env["GIT_CONFIG_KEY_0"] == "http.https://github.com/.extraHeader"
    # base64("x-access-token:abc")
    assert env["GIT_CONFIG_VALUE_0"] == "Authorization: Basic eC1hY2Nlc3MtdG9rZW46YWJj"
    assert env["GIT_TERMINAL_PROMPT"] == "0"


def test_rejects_unsafe_repo_names(checkouts, origin):
    sha = _head(origin)
    for bad in ("..", ".", "a/b", ""):
        with pytest.raises(CheckoutError):
            asyncio.run(checkouts.worktree(owner=bad, repo="r", sha=sha, token=TOKEN))
        with pytest.raises(CheckoutError):
            asyncio.run(checkouts.worktree(owner="o", repo=bad, sha=sha, token=TOKEN))
        with pytest.raises(CheckoutError):
            checkouts.has_clone(owner="o", repo=bad)
    path = asyncio.run(checkouts.worktree(owner="my-org", repo="my_repo.v2", sha=sha, token=TOKEN))
    assert (path / "spec.md").exists()
