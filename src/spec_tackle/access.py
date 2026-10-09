"""Who may use the server: only a browser that opened the link spec-tackle printed.

The server acts on GitHub as you, so anything that can reach its port could too: other
users on this machine, or the network when started with a non-loopback --host. Each
start makes a one-time launch code; the link carrying it trades it for a cookie holding
a secret kept in the data directory, so the cookie still works after a restart.
"""

from __future__ import annotations

import hmac
import json
import os
import secrets
from html import escape
from urllib.parse import parse_qsl, quote, urlencode

from .store import data_dir, make_private

COOKIE = "spec_tackle_key"
CODE_PARAM = "key"
COOKIE_MAX_AGE = 365 * 24 * 3600

LOCKED_MESSAGE = (
    "Open the link spec-tackle printed in the terminal where you started it. "
    "Each link works once; restart spec-tackle for a new one."
)


class Access:
    def __init__(self, secret: str):
        self.secret = secret
        self._codes: set[str] = set()

    @classmethod
    def load(cls) -> Access:
        """The secret from the data directory, made on first use; in memory if that fails."""
        path = data_dir() / "key"
        try:
            make_private(data_dir())
            try:
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                secret = path.read_text().strip()
                if secret:
                    return cls(secret)
                raise OSError(f"{path} is empty") from None
            secret = secrets.token_urlsafe(32)
            with os.fdopen(fd, "w") as f:
                f.write(secret)
            return cls(secret)
        except OSError:
            return cls(secrets.token_urlsafe(32))

    def launch_code(self) -> str:
        code = secrets.token_urlsafe(16)
        self._codes.add(code)
        return code

    def redeem(self, code: str) -> bool:
        if code in self._codes:
            self._codes.discard(code)
            return True
        return False

    def allows(self, cookie: str | None) -> bool:
        return cookie is not None and hmac.compare_digest(cookie.encode(), self.secret.encode())


def _cookie(headers: dict[bytes, bytes]) -> str | None:
    for part in headers.get(b"cookie", b"").decode("latin-1").split(";"):
        name, _, value = part.strip().partition("=")
        if name == COOKIE:
            return value
    return None


class Gate:
    """ASGI middleware: requests without the cookie get a "use the printed link" answer.

    The bundled JS and CSS under /static are public; they hold nothing private.
    """

    def __init__(self, app, access):
        self.app = app
        self._access = access  # a callable, so tests and `main()` can swap the instance

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["path"].startswith("/static/"):
            await self.app(scope, receive, send)
            return
        access = self._access()
        headers = dict(scope["headers"])
        query = parse_qsl(scope["query_string"].decode("latin-1"), keep_blank_values=True)
        codes = [v for k, v in query if k == CODE_PARAM]
        allowed = access.allows(_cookie(headers))
        if codes and scope["method"] == "GET" and (allowed or access.redeem(codes[0])):
            # Drop the code from the address bar (and history) once it has done its job.
            rest = urlencode([(k, v) for k, v in query if k != CODE_PARAM])
            await _send(send, 303, b"", [
                # One leading slash: "//host" would be a redirect to another site.
                (b"location", ("/" + quote(scope["path"].lstrip("/")) + (f"?{rest}" if rest else "")).encode()),
                (b"set-cookie", (
                    f"{COOKIE}={access.secret}; Path=/; Max-Age={COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax"
                ).encode()),
            ])
            return
        if allowed:
            await self.app(scope, receive, send)
            return
        if scope["path"].startswith(("/api/", "/auth/")):
            body = json.dumps({"error": LOCKED_MESSAGE, "locked": True}).encode()
            await _send(send, 403, body, [(b"content-type", b"application/json")])
            return
        page = (
            "<!doctype html><meta charset=utf-8><title>spec-tackle</title>"
            "<body style='font:16px system-ui;max-width:32em;margin:15vh auto;padding:0 1em'>"
            f"<h1 style='font-size:1.3em'>spec-tackle is locked</h1><p>{escape(LOCKED_MESSAGE)}</p>"
        )
        await _send(send, 403, page.encode(), [(b"content-type", b"text/html; charset=utf-8")])


async def _send(send, status: int, body: bytes, headers: list[tuple[bytes, bytes]]) -> None:
    headers = [*headers, (b"content-length", str(len(body)).encode()), (b"cache-control", b"no-store")]
    await send({"type": "http.response.start", "status": status, "headers": headers})
    await send({"type": "http.response.body", "body": body})
