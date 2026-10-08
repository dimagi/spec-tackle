"""Building the review page's data: shared by the JSON API and (until the switch) the template."""

from __future__ import annotations

import asyncio

from . import render
from .github import GitHub, PRRef

_ACTIVITY_KEYS = ("reviewThreads", "comments", "reviews")


async def build_page(client: GitHub, pr: PRRef) -> dict:
    overview, files = await asyncio.gather(client.overview(pr), client.files(pr))
    head = overview["headRefOid"]
    owner, repo = pr.owner, pr.repo

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
    return {
        "pr": {"owner": owner, "repo": repo, "number": pr.number, "url": overview["url"]},
        "overview": overview,
        "files": built,
        "activity": render.normalize_activity(overview),
    }


def public_overview(overview: dict) -> dict:
    """The overview without the activity it also carries (that goes out normalized)."""
    return {k: v for k, v in overview.items() if k not in _ACTIVITY_KEYS}
