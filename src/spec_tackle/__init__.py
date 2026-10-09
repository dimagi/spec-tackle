"""spec-tackle: a reviewer-oriented reading view for GitHub pull requests."""

import argparse
import ipaddress
import threading
import webbrowser

import uvicorn

from .github import find_token, parse_pr_url


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="spec-tackle", description="Open a GitHub PR in a reviewer-friendly reading view."
    )
    parser.add_argument("pr", nargs="?", help="PR link, e.g. https://github.com/org/repo/pull/123")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true", help="Don't open a browser tab")
    args = parser.parse_args()

    if not find_token():
        print("spec-tackle: not signed in to GitHub. You can sign in from the page.")

    from .claude import find_cli, sdk_installed

    if not find_cli():
        print("spec-tackle: Claude Code not found; Ask Claude is off.")
    elif not sdk_installed():
        print("spec-tackle: install spec-tackle[claude] to turn on Ask Claude.")

    url = f"http://{args.host}:{args.port}/"
    if args.pr:
        try:
            url += f"pr/{parse_pr_url(args.pr).path}"
        except ValueError as exc:
            parser.exit(2, f"spec-tackle: {exc}\n")

    from .app import access, allowed_hosts

    allowed_hosts.add(args.host.lower())
    url += f"?key={access().launch_code()}"
    if not _is_loopback(args.host):
        print(
            f"spec-tackle: warning: listening on {args.host}, not just this machine. Traffic is"
            " unencrypted, so others on the network could read your PRs or the sign-in cookie."
        )

    print(f"spec-tackle → {url}")
    if not args.no_browser:
        threading.Timer(1.0, webbrowser.open, args=(url,)).start()
    uvicorn.run(
        "spec_tackle.app:app",
        host=args.host,
        port=args.port,
        log_level="warning",
        timeout_graceful_shutdown=3,  # open answer streams would otherwise block Ctrl+C
    )


def _is_loopback(host: str) -> bool:
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False
