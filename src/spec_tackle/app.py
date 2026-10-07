"""FastAPI app: page rendering plus a small JSON API the review UI talks to."""

from __future__ import annotations

import asyncio
import mimetypes
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import quote

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel

from . import render
from .auth import LoginFlow, NotSignedIn, Session
from .github import GitHub, GitHubError, PRRef, parse_pr_url

HERE = Path(__file__).parent
templates = Jinja2Templates(directory=HERE / "templates")


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.session = Session()
    yield
    await app.state.session.aclose()


app = FastAPI(lifespan=lifespan)
app.mount("/static", StaticFiles(directory=HERE / "static"), name="static")


@app.exception_handler(GitHubError)
async def github_error(request: Request, exc: GitHubError):
    signed_out = exc.status == 401
    if signed_out and not isinstance(exc, NotSignedIn):
        # GitHub rejected the token (revoked or expired): sign out so the page offers sign-in.
        await session(request).drop()
        exc = NotSignedIn("GitHub no longer accepts your sign-in. Please sign in again.")
    if request.url.path.startswith(("/api/", "/auth/")):
        return JSONResponse({"error": str(exc), "signedOut": signed_out}, status_code=exc.status)
    return await index_page(
        request, error=None if signed_out else str(exc), notice=str(exc) if signed_out else None,
        next_url=request.url.path, status_code=exc.status,
    )


def session(request: Request) -> Session:
    return request.app.state.session


async def gh(request: Request) -> GitHub:
    return await session(request).client()


async def index_page(request: Request, *, status_code: int = 200, **context) -> HTMLResponse:
    viewer = await session(request).viewer()
    return templates.TemplateResponse(
        request,
        "index.html",
        {"viewer": viewer, "gh_cli": LoginFlow.available(), **context},
        status_code=status_code,
    )


# -- pages -----------------------------------------------------------------


@app.get("/", response_class=HTMLResponse)
async def index(request: Request, url: str | None = None, next: str | None = None):
    if url:
        try:
            pr = parse_pr_url(url)
        except ValueError as exc:
            return await index_page(request, error=str(exc), url=url, status_code=400)
        return RedirectResponse(f"/pr/{pr.path}", status_code=303)
    # Only ever send people back to a page on this app.
    next_url = next if next and next.startswith("/") and not next.startswith("//") else None
    return await index_page(request, next_url=next_url)


@app.get("/pr/{owner}/{repo}/{number}", response_class=HTMLResponse)
async def review_page(request: Request, owner: str, repo: str, number: int):
    pr = PRRef(owner, repo, number)
    client = await gh(request)
    overview, files = await asyncio.gather(client.overview(pr), client.files(pr))
    head = overview["headRefOid"]

    async def build(file: dict) -> dict:
        path = file["filename"]
        hunks, added = render.parse_patch(file.get("patch"))
        entry = {
            "path": path,
            "status": file["status"],
            "additions": file["additions"],
            "deletions": file["deletions"],
            "hunks": hunks,
            "wholeFile": file["status"] == "added",
            "markdown": render.is_markdown(path),
            "rendered": None,
            "diff": render.render_diff(file["patch"], path) if file.get("patch") else None,
            "outline": [],
            "githubUrl": f"{overview['url']}/files",
        }
        if entry["markdown"] and file["status"] != "removed":
            text = (await client.raw_file(owner, repo, path, head)).decode("utf-8", "replace")
            html = render.render_markdown(
                text,
                path=path,
                raw_base=f"/raw/{owner}/{repo}/{head}",
                blob_base=f"https://github.com/{owner}/{repo}/blob/{head}",
                # In a brand-new file every line is "added"; highlighting it all is noise.
                added_lines=set() if entry["wholeFile"] else added,
            )
            entry["rendered"] = html
            entry["outline"] = render.outline(html)
        return entry

    built = await asyncio.gather(*(build(f) for f in files))
    # Specs first: rendered markdown is what reviewers came for.
    built.sort(key=lambda f: (not f["rendered"], f["path"]))

    activity = render.normalize_activity(overview)
    client_files = {
        f["path"]: {"hunks": f["hunks"], "wholeFile": f["wholeFile"], "markdown": f["markdown"]}
        for f in built
    }
    return templates.TemplateResponse(
        request,
        "review.html",
        {
            "pr": pr,
            "viewer": await session(request).viewer(),
            "overview": overview,
            "files": built,
            "boot": {
                "pr": {"owner": owner, "repo": repo, "number": number, "url": overview["url"]},
                "files": client_files,
                "activity": activity,
            },
        },
    )


@app.get("/raw/{owner}/{repo}/{ref}/{path:path}")
async def raw(request: Request, owner: str, repo: str, ref: str, path: str):
    """Proxy repo files (e.g. images in a spec) so private repos work too."""
    client = await gh(request)
    content = await client.raw_file(owner, repo, quote(path), ref)
    media_type = mimetypes.guess_type(path)[0] or "application/octet-stream"
    if media_type in ("text/html", "image/svg+xml"):
        # Never let repo content run script on our origin.
        return Response(
            content,
            media_type=media_type,
            headers={"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox"},
        )
    return Response(content, media_type=media_type)


# -- API -------------------------------------------------------------------


class NewComment(BaseModel):
    path: str
    start: int
    end: int
    body: str
    commit: str


class Reply(BaseModel):
    commentId: int
    body: str


class Body(BaseModel):
    body: str


class Resolve(BaseModel):
    resolved: bool


class Review(BaseModel):
    event: str
    body: str = ""


def _require_body(body: str) -> str:
    if not body.strip():
        raise HTTPException(400, "Comment cannot be empty")
    return body


@app.get("/api/pr/{owner}/{repo}/{number}/activity")
async def activity(request: Request, owner: str, repo: str, number: int):
    client = await gh(request)
    data = await client.activity(PRRef(owner, repo, number))
    return render.normalize_activity(data)


@app.post("/api/pr/{owner}/{repo}/{number}/comments")
async def create_comment(request: Request, owner: str, repo: str, number: int, c: NewComment):
    pr = PRRef(owner, repo, number)
    client = await gh(request)
    _require_body(c.body)
    files = {f["filename"]: f for f in await client.files(pr)}
    file = files.get(c.path)
    if file is None:
        raise HTTPException(404, f"{c.path} is not part of this PR")
    hunks, _ = render.parse_patch(file.get("patch"))
    anchor = render.resolve_anchor(c.start, c.end, hunks, file["status"] == "added")
    payload = {"body": c.body, "commit_id": c.commit, "path": c.path}
    if anchor:
        payload.update(side="RIGHT", line=anchor["line"])
        if anchor["start_line"]:
            payload.update(start_side="RIGHT", start_line=anchor["start_line"])
    else:
        # Unchanged text can't take a line comment; fall back to a file-level one.
        lines = f"line {c.start}" if c.start == c.end else f"lines {c.start}–{c.end}"
        payload.update(subject_type="file", body=f"**Re: {lines}**\n\n{c.body}")
    return await client.create_review_comment(pr, payload)


@app.post("/api/pr/{owner}/{repo}/{number}/replies")
async def reply(request: Request, owner: str, repo: str, number: int, r: Reply):
    client = await gh(request)
    return await client.reply(PRRef(owner, repo, number), r.commentId, _require_body(r.body))


@app.post("/api/pr/{owner}/{repo}/{number}/conversation")
async def conversation(request: Request, owner: str, repo: str, number: int, b: Body):
    client = await gh(request)
    return await client.conversation_comment(PRRef(owner, repo, number), _require_body(b.body))


@app.post("/api/pr/{owner}/{repo}/{number}/review")
async def review(request: Request, owner: str, repo: str, number: int, r: Review):
    if r.event not in ("APPROVE", "REQUEST_CHANGES", "COMMENT"):
        raise HTTPException(400, "Unknown review type")
    if r.event != "APPROVE":
        _require_body(r.body)
    client = await gh(request)
    return await client.submit_review(PRRef(owner, repo, number), r.event, r.body)


@app.post("/api/pr/{owner}/{repo}/{number}/preview")
async def preview(request: Request, owner: str, repo: str, number: int, b: Body):
    client = await gh(request)
    html = await client.render_markdown(PRRef(owner, repo, number), b.body)
    return {"html": html}


@app.post("/api/threads/{thread_id}/resolve")
async def resolve(request: Request, thread_id: str, r: Resolve):
    client = await gh(request)
    await client.set_thread_resolved(thread_id, r.resolved)
    return {"ok": True}


# -- sign-in ---------------------------------------------------------------


class Token(BaseModel):
    token: str


def _login_status(flow: LoginFlow) -> dict:
    return {"state": flow.state, "code": flow.code, "url": flow.url, "message": flow.message}


@app.post("/auth/login")
async def start_login(request: Request):
    """Start `gh auth login --web` and hand its one-time code to the page."""
    if not LoginFlow.available():
        raise HTTPException(400, "The GitHub CLI (gh) isn't installed. Paste a token instead.")
    s = session(request)
    if s.login is not None:
        s.login.cancel()
    s.login = LoginFlow()
    await s.login.start()
    return _login_status(s.login)


@app.get("/auth/login")
async def login_status(request: Request):
    s = session(request)
    if s.login is None:
        raise HTTPException(404, "No sign-in in progress")
    status = _login_status(s.login)
    if s.login.state == "done":
        try:
            status["viewer"] = await s.use_cli_token()
        except GitHubError as exc:
            status.update(state="failed", message=str(exc))
        s.login = None
    return status


@app.post("/auth/token")
async def use_token(request: Request, t: Token):
    token = t.token.strip()
    if not token:
        raise HTTPException(400, "Paste a token first")
    return {"viewer": await session(request).use_token(token)}
