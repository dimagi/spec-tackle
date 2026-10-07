"""Asking Claude about a PR: the context it gets, the files it may read, and the SDK call.

The SDK is an optional extra and is imported only inside `ask()`, so everything else
here works without it.
"""

from __future__ import annotations

import importlib.util
import os
import shutil
from pathlib import Path

TOOLS = ["Read", "Grep", "Glob"]
SNAPSHOT_LIMIT = 400_000
GITHUB_PAGE = 100  # the GraphQL queries fetch at most this many threads/comments/reviews

SYSTEM_PROMPT = """\
You are helping a reviewer understand a GitHub pull request, usually a spec or design doc.
Your working directory is the repository checked out at the PR's commit. You can read it
with Read, Grep and Glob; you cannot edit files or run commands, so never offer to.
Answer the reviewer's question directly and concisely. Cite files as path:line.
When the question is about whether the spec matches the existing code, check the code.

The pull request follows."""


def find_cli() -> str | None:
    return shutil.which("claude")


def sdk_installed() -> bool:
    return importlib.util.find_spec("claude_agent_sdk") is not None


# -- file access -------------------------------------------------------------


def inside(*, root: Path, target: str, base: str | None = None) -> bool:
    """True when `target` (relative to `base`, default `root`) resolves inside `root`."""
    # Relative targets resolve against the hook's `cwd`, which the SDK call sets to the worktree.
    if target.startswith("~"):  # Claude Code expands "~" to the home directory
        return False
    real_root = os.path.realpath(root)
    real = os.path.realpath(os.path.join(base or real_root, target))
    return real == real_root or real.startswith(real_root + os.sep)


def _pattern_ok(pattern: str) -> bool:
    """True unless the glob is absolute, starts with "~", or has a ".." segment."""
    return not (
        pattern.startswith(("/", "~", "\\"))
        or ".." in pattern.replace("\\", "/").split("/")
        or os.path.isabs(pattern)
    )


def _allowed(*, root: Path, input_data: dict) -> bool:
    tool = input_data.get("tool_name")
    tool_input = input_data.get("tool_input") or {}
    if tool not in TOOLS:
        return False
    paths = [tool_input[k] for k in ("file_path", "path", "notebook_path") if k in tool_input]
    if not paths:
        paths = ["."]
    if not all(isinstance(p, str) and inside(root=root, target=p, base=input_data.get("cwd")) for p in paths):
        return False
    for key in ("pattern", "glob"):
        if (tool, key) in (("Glob", "pattern"), ("Grep", "glob")) and key in tool_input:
            value = tool_input[key]
            if not isinstance(value, str) or not _pattern_ok(value):
                return False
    return True


def make_guard(root: Path):
    """A PreToolUse hook that only lets Read/Grep/Glob touch files inside `root`."""

    # The SDK calls hook callbacks positionally, so these parameters can't be keyword-only.
    async def guard(input_data: dict, tool_use_id: str | None, context) -> dict:
        try:
            allowed = _allowed(root=root, input_data=input_data)
        except Exception:  # anything unexpected in the input is a denial
            allowed = False
        if allowed:
            return {}
        return {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": "Only files inside the PR checkout can be read.",
            }
        }

    return guard


def read_lines(*, root: Path, path: str, start: int, end: int) -> str:
    """Lines `start` to `end` (1-based, inclusive) of `path`; ValueError if outside `root`."""
    if not inside(root=root, target=path):
        raise ValueError(f"{path} is outside the checkout")
    try:
        lines = (Path(root) / path).read_text("utf-8", "replace").splitlines()
    except OSError:
        return "(these lines couldn't be read from the checkout)"
    return "\n".join(lines[start - 1 : end])


# -- the PR snapshot ---------------------------------------------------------


def _range(*, start: int | None, end: int | None) -> str:
    if end is None:
        return "file"
    return f"line {end}" if not start or start == end else f"lines {start}–{end}"


def _discussion(*, overview: dict, activity: dict) -> list[str]:
    out = ["## Review threads"]
    for t in activity["threads"]:
        if t["isFileLevel"]:
            where = "file"
        else:
            where = _range(
                start=t["startLine"] or t["originalStartLine"], end=t["line"] or t["originalLine"]
            )
        flags = [f for f, on in (("resolved", t["isResolved"]), ("outdated", t["isOutdated"])) if on]
        out.append(f"\n### {t['path']} ({where}){' [' + ', '.join(flags) + ']' if flags else ''}")
        out += [f"- @{c['author']['login']}: {c['body']}" for c in t["comments"]]
    if not activity["threads"]:
        out.append("(none)")
    out.append("\n## Conversation and review summaries")
    for c in activity["conversation"]:
        verdict = f" ({c['state'].lower()})" if c["kind"] == "review" else ""
        out.append(f"- @{c['author']['login']}{verdict}: {c['body'] or '(no text)'}")
    if not activity["conversation"]:
        out.append("(none)")
    capped = [
        name
        for name, nodes in (
            ("review threads", overview["reviewThreads"]["nodes"]),
            ("comments", overview["comments"]["nodes"]),
            ("reviews", overview["reviews"]["nodes"]),
        )
        if len(nodes) >= GITHUB_PAGE
    ]
    if capped:
        out.append(f"\n(Note: only the first {GITHUB_PAGE} {', '.join(capped)} are included.)")
    return out


def build_context(
    *,
    overview: dict,
    files: list[dict],
    markdown: dict[str, str],
    activity: dict,
    commit: str,
    limit: int = SNAPSHOT_LIMIT,
) -> str:
    """Everything about the PR, as text for Claude's system prompt."""
    author = (overview.get("author") or {}).get("login", "ghost")
    state = activity["state"].lower() + (" (draft)" if activity["isDraft"] else "")
    head = [
        f"# PR #{overview['number']}: {overview['title']}",
        f"URL: {overview['url']}",
        f"Author: @{author} · State: {state}",
        f"Base: {overview['baseRefName']} ← Head: {overview['headRefName']}",
        f"Checked-out commit: {commit}"
        + ("" if activity["headSha"] == commit else f" (the PR head is now {activity['headSha']})"),
        "",
        "## Description",
        overview.get("body") or "(no description)",
        "",
    ]
    docs = [f"## Full text of {path}\n```markdown\n{text}\n```\n" for path, text in markdown.items()]

    def patches(include_code: bool) -> list[str]:
        out = ["## Changed files"]
        for f in files:
            name, status = f["filename"], f["status"]
            if name in markdown:
                out.append(f"\n### {name} ({status}): full text above")
            elif not include_code:
                out.append(f"\n### {name} ({status}): diff left out for size; read it from the checkout")
            else:
                patch = f.get("patch") or "(no diff: binary or too large)"
                out.append(f"\n### {name} ({status})\n```diff\n{patch}\n```")
        return out

    discussion = _discussion(overview=overview, activity=activity)
    for include_code in (True, False):
        text = "\n".join(head + docs + patches(include_code) + [""] + discussion)
        if len(text) <= limit:
            break
    return text


# -- prompts -----------------------------------------------------------------


def turn_prompt(*, thread: dict, question: str) -> str:
    """The user message for a turn: what the question is about, earlier turns, the question."""
    parts = [
        f"The reviewer is asking about {thread['path']}, "
        f"{_range(start=thread['startLine'], end=thread['endLine'])}:",
        f"```\n{thread['anchorText'] or ''}\n```",
    ]
    history = [m for m in thread["messages"] if m["role"] in ("user", "assistant")]
    if history:
        parts.append("Earlier in this conversation:")
        parts += [f"{'Reviewer' if m['role'] == 'user' else 'You'}: {m['body']}" for m in history]
    parts.append(f"Question: {question}")
    return "\n\n".join(parts)


def tool_label(*, name: str, tool_input: dict, root: Path) -> str:
    """A short status line for a tool call, e.g. "Reading docs/a.md"."""
    if name == "Read":
        path = tool_input.get("file_path", "")
        try:
            path = os.path.relpath(os.path.realpath(path), os.path.realpath(root))
        except ValueError:
            pass
        return f"Reading {path}"
    if name == "Grep":
        return f"Searching for “{tool_input.get('pattern', '')}”"
    if name == "Glob":
        return f"Listing {tool_input.get('pattern', '')}"
    return name


def describe_error(exc: BaseException) -> str:
    text = str(exc)
    lowered = text.lower()
    if any(s in lowered for s in ("/login", "not logged in", "invalid api key", "authentication")):
        return "Claude Code isn't signed in. Run `claude` in a terminal to sign in, then ask again."
    return f"Claude failed: {text}"
