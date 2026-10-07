"""spec-tackle: a reviewer-oriented reading view for GitHub pull requests."""

import argparse
import threading
import webbrowser

import uvicorn

from .github import GitHubError, get_token, parse_pr_url


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="spec-tackle", description="Open a GitHub PR in a reviewer-friendly reading view."
    )
    parser.add_argument("pr", nargs="?", help="PR link, e.g. https://github.com/org/repo/pull/123")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true", help="Don't open a browser tab")
    args = parser.parse_args()

    try:
        get_token()
    except GitHubError as exc:
        parser.exit(1, f"spec-tackle: {exc}\n")

    url = f"http://{args.host}:{args.port}/"
    if args.pr:
        try:
            url += f"pr/{parse_pr_url(args.pr).path}"
        except ValueError as exc:
            parser.exit(2, f"spec-tackle: {exc}\n")

    print(f"spec-tackle → {url}")
    if not args.no_browser:
        threading.Timer(1.0, webbrowser.open, args=(url,)).start()
    uvicorn.run("spec_tackle.app:app", host=args.host, port=args.port, log_level="warning")
