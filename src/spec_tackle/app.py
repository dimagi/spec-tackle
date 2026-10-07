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
from .github import GitHub, GitHubError, PRRef, get_token, parse_pr_url

HERE = Path(__file__).parent
templates = Jinja2Templates(directory=HERE / "templates")


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.gh = GitHub(get_token())
    yield
    await app.state.gh.aclose()


app = FastAPI(lifespan=lifespan)
app.mount("/static", StaticFiles(directory=HERE / "static"), name="static")


@app.exception_handler(GitHubError)
async def github_error(request: Request, exc: GitHubError):
    if request.url.path.startswith("/api/"):
        return JSONResponse({"error": str(exc)}, status_code=exc.status)
    return templates.TemplateResponse(
        request, "index.html", {"error": str(exc)}, status_code=exc.status
    )


def gh(request: Request) -> GitHub:
    return request.app.state.gh


# -- pages -----------------------------------------------------------------


@app.get("/", response_class=HTMLResponse)
async def index(request: Request, url: str | None = None):
    if url:
        try:
            pr = parse_pr_url(url)
        except ValueError as exc:
            return templates.TemplateResponse(
                request, "index.html", {"error": str(exc), "url": url}, status_code=400
            )
        return RedirectResponse(f"/pr/{pr.path}", status_code=303)
    return templates.TemplateResponse(request, "index.html", {})


@app.get("/pr/{owner}/{repo}/{number}", response_class=HTMLResponse)
async def review_page(request: Request, owner: str, repo: str, number: int):
    pr = PRRef(owner, repo, number)
    client = gh(request)
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
    content = await gh(request).raw_file(owner, repo, quote(path), ref)
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
    data = await gh(request).activity(PRRef(owner, repo, number))
    return render.normalize_activity(data)


@app.post("/api/pr/{owner}/{repo}/{number}/comments")
async def create_comment(request: Request, owner: str, repo: str, number: int, c: NewComment):
    pr = PRRef(owner, repo, number)
    client = gh(request)
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
    return await gh(request).reply(PRRef(owner, repo, number), r.commentId, _require_body(r.body))


@app.post("/api/pr/{owner}/{repo}/{number}/conversation")
async def conversation(request: Request, owner: str, repo: str, number: int, b: Body):
    return await gh(request).conversation_comment(PRRef(owner, repo, number), _require_body(b.body))


@app.post("/api/pr/{owner}/{repo}/{number}/review")
async def review(request: Request, owner: str, repo: str, number: int, r: Review):
    if r.event not in ("APPROVE", "REQUEST_CHANGES", "COMMENT"):
        raise HTTPException(400, "Unknown review type")
    if r.event != "APPROVE":
        _require_body(r.body)
    return await gh(request).submit_review(PRRef(owner, repo, number), r.event, r.body)


@app.post("/api/pr/{owner}/{repo}/{number}/preview")
async def preview(request: Request, owner: str, repo: str, number: int, b: Body):
    html = await gh(request).render_markdown(PRRef(owner, repo, number), b.body)
    return {"html": html}


@app.post("/api/threads/{thread_id}/resolve")
async def resolve(request: Request, thread_id: str, r: Resolve):
    await gh(request).set_thread_resolved(thread_id, r.resolved)
    return {"ok": True}
