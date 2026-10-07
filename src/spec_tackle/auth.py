"""Who spec-tackle talks to GitHub as, and signing in from the browser.

Signing in drives the GitHub CLI's browser flow (`gh auth login --web`): we show
its one-time code on the page, the user approves it on github.com, and the token
lands in the CLI's own store. A pasted personal access token is the fallback for
machines without `gh`; it is kept in memory only.
"""

from __future__ import annotations

import asyncio
import re
import shutil

from .github import GitHub, GitHubError, find_token, gh_cli_token

DEVICE_URL = "https://github.com/login/device"
_CODE_RE = re.compile(r"\b([A-Z0-9]{4}-[A-Z0-9]{4})\b")
_URL_RE = re.compile(r"https://\S+/login/device\S*")


class NotSignedIn(GitHubError):
    def __init__(self, message: str = "You're not signed in to GitHub."):
        super().__init__(message, status=401)


class Session:
    def __init__(self) -> None:
        self._gh: GitHub | None = None
        self._viewer: dict | None = None
        self._pasted_token: str | None = None
        self.login: LoginFlow | None = None

    async def client(self) -> GitHub:
        """The signed-in client; picks up a login made elsewhere (e.g. `gh auth login`)."""
        if self._gh is None:
            token = self._pasted_token or find_token()
            if not token:
                raise NotSignedIn()
            await self._connect(token)
        return self._gh

    async def viewer(self) -> dict | None:
        """The signed-in user, or None when signed out or the token is rejected."""
        try:
            await self.client()
        except GitHubError:
            return None
        return self._viewer

    async def use_token(self, token: str) -> dict:
        await self._connect(token)
        self._pasted_token = token
        return self._viewer

    async def use_cli_token(self) -> dict:
        token = gh_cli_token()
        if not token:
            raise NotSignedIn("The GitHub CLI finished but has no token.")
        await self._connect(token)
        return self._viewer

    async def drop(self) -> None:
        """Forget the current token (GitHub rejected it); the next request looks again."""
        if self._gh is not None:
            await self._gh.aclose()
        self._gh = self._viewer = self._pasted_token = None

    async def aclose(self) -> None:
        if self._gh is not None:
            await self._gh.aclose()
        if self.login is not None:
            self.login.cancel()

    async def _connect(self, token: str) -> None:
        client = GitHub(token)
        try:
            viewer = await client.viewer()
        except GitHubError as exc:
            await client.aclose()
            if exc.status == 401:
                raise NotSignedIn("GitHub didn't accept that token.") from exc
            raise
        if self._gh is not None:
            await self._gh.aclose()
        self._gh, self._viewer = client, viewer


class LoginFlow:
    """One run of `gh auth login --web`, from its one-time code to its exit."""

    def __init__(self) -> None:
        self.code: str | None = None
        self.url = DEVICE_URL
        self.state = "starting"  # starting → waiting → done | failed
        self.message = ""
        self._proc: asyncio.subprocess.Process | None = None
        self._output: list[str] = []
        self._task: asyncio.Task | None = None

    @staticmethod
    def available() -> bool:
        return shutil.which("gh") is not None

    async def start(self, timeout: float = 20) -> None:
        self._proc = await asyncio.create_subprocess_exec(
            "gh", "auth", "login", "--web", "--hostname", "github.com", "--git-protocol", "https",
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        try:
            await asyncio.wait_for(self._read_until_code(), timeout)
        except asyncio.TimeoutError:
            self.cancel()
            self._fail("The GitHub CLI didn't give us a sign-in code.")
            return
        if self.code:
            self.state = "waiting"
            self._task = asyncio.create_task(self._wait())

    async def _read_until_code(self) -> None:
        async for raw in self._proc.stdout:
            line = raw.decode(errors="replace").strip()
            self._output.append(line)
            if url := _URL_RE.search(line):
                self.url = url.group(0)
            if not self.code and (code := _CODE_RE.search(line)):
                self.code = code.group(1)
                return
        # The CLI exited without a code (e.g. it refused to run).
        await self._proc.wait()
        self._fail()

    async def _wait(self) -> None:
        async for raw in self._proc.stdout:  # keep draining so the CLI never blocks on a full pipe
            self._output.append(raw.decode(errors="replace").strip())
        if await self._proc.wait() == 0:
            self.state = "done"
        else:
            self._fail()

    def _fail(self, message: str = "") -> None:
        self.state = "failed"
        detail = next((line for line in reversed(self._output) if line), "")
        self.message = message or detail or "Signing in with the GitHub CLI failed."

    def cancel(self) -> None:
        if self._proc is not None and self._proc.returncode is None:
            self._proc.kill()
        if self._task is not None:
            self._task.cancel()
