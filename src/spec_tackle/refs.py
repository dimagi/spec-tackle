"""Cross-references in a document: what Claude is asked for, and checking what it sends back.

See docs/specs/2026-10-09-doc-references-design.md. Claude reads one markdown file and
lists the phrases that point at something else: another part of the same file, or lines
in another file of the repository, with the lines they point at.
"""

from __future__ import annotations

import difflib
import re
from pathlib import Path

from .claude import inside
from .logic import parse_answer

MAX_REFS = 300
MAX_TEXT = 120
MAX_NOTE = 80

REFS_SYSTEM_PROMPT = f"""\
You are helping a reviewer read a markdown document from a GitHub pull request, usually
a spec or design doc. Your working directory is the repository checked out at the PR's
commit. You can read it with Read, Grep and Glob; you cannot edit files or run commands.

Find every phrase in the document that refers to something the reviewer would want to
look up: another part of the same document, or something in another file of the
repository (a section of another doc, a constant, an error code, a function, a config
setting, a table). Search the repository to find what each phrase points at.

Examples: "see section 3.2", "as described in Goals", "requirement R4", "step 2 above",
"the limits in retry-policy.md", "error 4012", "MAX_RETRIES", "the SyncQueue class",
"the sync_interval setting". Skip mentions of external websites, things you can't find
in the repository, and generic words that happen to match something.

The document is given with a line number before each line. Answer with exactly one
fenced ```json block and nothing after it, in this shape:

{{
  "refs": [
    {{
      "line": 12,                  // the document line where the phrase starts
      "text": "section 3.2",       // the phrase as a reader sees it, at most {MAX_TEXT} characters
      "targetPath": null,          // null for this document, else a repo-relative path like "app/codes.py"
      "targetStart": 40,           // first line of what it points at, 1-based, in that file
      "targetEnd": 52,             // last line of what it points at
      "note": "3.2 Retry policy"   // a short label for the target, at most {MAX_NOTE} characters
    }}
  ]
}}

Rules:
- Copy "text" exactly from the document, without markdown syntax such as ** or [](...).
  Keep it short: just the words that name the target.
- Point at the smallest range that answers the reference: one list item for "R4", a
  whole section (heading to the line before the next heading of the same level) for
  "see section 3", a constant's definition line, or a function's whole body.
- Line numbers in other files must come from reading them; never guess.
- A target in this document never contains the reference's own line.
- List every occurrence, even when the same phrase appears on several lines.
- If there are no references, answer with {{"refs": []}}.

The document is included at the start of the conversation."""

REFS_REQUEST = (
    "List the references in this document as described. Search the repository for what they "
    "point at, then answer with one ```json block."
)

# Markdown syntax a reader doesn't see: link targets, then emphasis, code and brackets.
_LINK_TARGET = re.compile(r"\]\([^)]*\)")
_MARKUP = re.compile(r"[*_`~\[\]]")
_SPACE = re.compile(r"\s+")


def numbered(text: str) -> str:
    """The document with each line prefixed by its 1-based number."""
    lines = text.splitlines()
    width = len(str(len(lines)))
    return "\n".join(f"{n:>{width}}| {line}" for n, line in enumerate(lines, start=1))


def snapshot(*, path: str, text: str) -> str:
    return f"The document is {path}:\n\n{numbered(text)}"


def repair_request(problems: list[str]) -> str:
    listed = "\n".join(f"- {p}" for p in problems)
    return (
        "Your answer couldn't be read:\n"
        f"{listed}\n\n"
        'Answer again with the complete list in one ```json block shaped like {"refs": [...]}.'
    )


def _plain(text: str) -> str:
    """What a reader sees of some markdown, for comparing phrases: no markup, one case, single spaces."""
    text = _MARKUP.sub("", _LINK_TARGET.sub("", text))
    return _SPACE.sub(" ", text).strip().casefold()


def parse(text: str) -> tuple[list | None, list[str]]:
    """The list of references in Claude's answer, or why it couldn't be read."""
    data, problems = parse_answer(text)
    if problems:
        return None, problems
    if not isinstance(data, dict) or not isinstance(data.get("refs"), list):
        return None, ['the answer must be a JSON object with a "refs" list']
    return data["refs"], []


def validate(refs: list, lines: list[str], *, path: str, root: Path) -> list[dict]:
    """The references that check out against the document and the checkout; the rest are dropped.

    `lines` is the document at `path`; `root` is the checkout other files are read from.
    """
    sizes: dict[str, int | None] = {}

    def size(target: str) -> int | None:
        """How many lines a file in the checkout has, or None if it isn't a readable file."""
        if target not in sizes:
            file = Path(root) / target
            ok = not target.startswith("/") and inside(root=root, target=target) and file.is_file()
            sizes[target] = len(file.read_text("utf-8", "replace").splitlines()) if ok else None
        return sizes[target]

    kept: list[dict] = []
    seen: set[tuple] = set()
    for ref in refs:
        if not isinstance(ref, dict):
            continue
        line, start, end = ref.get("line"), ref.get("targetStart"), ref.get("targetEnd")
        text, note, target = ref.get("text"), ref.get("note", ""), ref.get("targetPath")
        if not all(isinstance(n, int) and not isinstance(n, bool) for n in (line, start, end)):
            continue
        if not 1 <= line <= len(lines):
            continue
        if target in (None, "", path):
            target = None
            if not 1 <= start <= end <= len(lines) or start <= line <= end:
                continue
        else:
            if not isinstance(target, str):
                continue
            target = target.removeprefix("./")
            count = size(target)
            if count is None or not 1 <= start <= end <= count:
                continue
        if not isinstance(text, str) or not 1 <= len(text.strip()) <= MAX_TEXT:
            continue
        phrase = _plain(text)
        # A phrase can wrap onto the next line in the middle of a paragraph.
        if not phrase or phrase not in _plain(" ".join(lines[line - 1:line + 1])):
            continue
        key = (line, phrase, target, start, end)
        if key in seen:
            continue
        seen.add(key)
        note = note.strip()[:MAX_NOTE] if isinstance(note, str) else ""
        kept.append({
            "line": line, "text": text.strip(), "targetPath": target,
            "targetStart": start, "targetEnd": end, "note": note,
        })
        if len(kept) == MAX_REFS:
            break
    kept.sort(key=lambda r: r["line"])
    return kept


# -- a newer commit ----------------------------------------------------------


def line_map(old: list[str], new: list[str]) -> dict[int, int]:
    """Where each unchanged line of `old` is in `new`, 1-based. Changed and deleted lines are missing."""
    matcher = difflib.SequenceMatcher(a=old, b=new, autojunk=False)
    mapped: dict[int, int] = {}
    for tag, a0, a1, b0, _ in matcher.get_opcodes():
        if tag == "equal":
            for i in range(a1 - a0):
                mapped[a0 + i + 1] = b0 + i + 1
    return mapped


def carry(
    refs: list[dict], *, path: str, old: dict[str, list[str] | None], new: dict[str, list[str] | None],
) -> tuple[list[dict], list[int], int]:
    """Move references found at an older commit onto a newer one.

    `old` and `new` hold each file's lines at the two commits (None when it's missing):
    the document at `path` and every other file a reference points at. Returns the
    references that still hold, with their lines moved; the document lines that need
    checking again (new or changed lines, and phrases whose target changed); and how
    many references were dropped as outdated.
    """
    maps = {p: line_map(old[p] or [], new.get(p) or []) for p in old}
    doc = maps[path]
    kept: list[dict] = []
    recheck: set[int] = set()
    outdated = 0
    for ref in refs:
        line = doc.get(ref["line"])
        if line is None:  # the phrase's line changed: its new version is checked as a changed line
            outdated += 1
            continue
        target = maps[ref["targetPath"] or path]
        start, end = target.get(ref["targetStart"]), target.get(ref["targetEnd"])
        span = ref["targetEnd"] - ref["targetStart"]
        whole = start is not None and end is not None and end - start == span and all(
            n in target for n in range(ref["targetStart"], ref["targetEnd"] + 1)
        )
        if not whole:  # the phrase is still there, but what it points at changed
            outdated += 1
            recheck.add(line)
            continue
        moved = {**ref, "line": line, "targetStart": start, "targetEnd": end}
        if "changed" in ref:
            moved["changed"] = sorted(target[n] for n in ref["changed"] if n in target)
        kept.append(moved)
    unmapped = set(range(1, len(new[path] or []) + 1)) - set(doc.values())
    pending = sorted(unmapped | recheck)
    return kept, pending, outdated


def _ranges(lines: list[int]) -> str:
    """1, 2, 3, 7, 9, 10 → "1–3, 7, 9–10"."""
    parts: list[str] = []
    for n in lines:
        if parts and int(parts[-1].split("–")[-1]) == n - 1:
            parts[-1] = f"{parts[-1].split('–')[0]}–{n}"
        else:
            parts.append(str(n))
    return ", ".join(parts)


def partial_request(lines: list[int]) -> str:
    return (
        "This document changed since its references were last found. List only the references "
        f"whose phrase starts on one of these lines: {_ranges(lines)}. Search the repository for "
        "what they point at, then answer with one ```json block."
    )
