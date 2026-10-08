"""Unified diff helpers: which lines changed, and the file as it was before the PR."""

from __future__ import annotations

import re

_HUNK = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")


def _rows(text: str) -> list[str]:
    """Lines split on "\n" only: git counts nothing else (str.splitlines also splits on form feeds)."""
    rows = text.split("\n")
    return rows[:-1] if rows and rows[-1] == "" else rows


def _lines(text: str) -> list[str]:
    """Like splitlines(keepends=True), but only "\n" ends a line."""
    return [row + "\n" for row in text.split("\n")[:-1]] + ([text.rsplit("\n", 1)[-1]] if not text.endswith("\n") and text else [])


def changed_lines(patch: str | None) -> tuple[set[int], set[int]]:
    """(added head line numbers, removed base line numbers) in a unified patch."""
    added: set[int] = set()
    removed: set[int] = set()
    old = new = 0
    for row in _rows(patch or ""):
        match = _HUNK.match(row)
        if match:
            old, new = int(match.group(1)), int(match.group(3))
        elif row.startswith("+"):
            added.add(new)
            new += 1
        elif row.startswith("-"):
            removed.add(old)
            old += 1
        elif row.startswith(" ") or row == "":
            old += 1
            new += 1
    return added, removed


def base_text(head_text: str, patch: str | None, status: str) -> str | None:
    """The file before the PR, rebuilt by undoing the patch; None when GitHub sent no patch."""
    if status == "added":
        return ""
    if not patch:
        return None
    head = _lines(head_text)
    base: list[str] = []
    cursor = 0  # next head line (0-based) not yet copied
    for row in _rows(patch):
        match = _HUNK.match(row)
        if match:
            start = int(match.group(3)) - 1 if int(match.group(4) or 1) else int(match.group(3))
            base.extend(head[cursor:start])
            cursor = start
        elif row.startswith("+"):
            cursor += 1
        elif row.startswith("-"):
            base.append(row[1:] + "\n")
        elif row.startswith("\\"):
            continue  # "\ No newline at end of file"
        else:
            if cursor < len(head):
                base.append(head[cursor])
            cursor += 1
    base.extend(head[cursor:])
    return "".join(base)
