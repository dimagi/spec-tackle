"""The Logic view: what Claude is asked for, and checking what it sends back.

See docs/specs/2026-10-08-logic-view-design.md. The map is a tree of pseudo-code
blocks; leaves point at the real functions in the checkout.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from . import render
from .claude import inside

MAX_DEPTH = 3
MAX_BLOCKS = 12
MAX_LABEL = 80
MAX_EDGE_LABEL = 40
MAX_FUNCTIONS = 8
KINDS = ("entry", "step", "decision", "loop", "async", "exit")
CHANGES = ("added", "changed", "unchanged")
_ID = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
_FENCE = re.compile(r"```(?:json)?[ \t]*\n(.*?)```", re.DOTALL)

LOGIC_SYSTEM_PROMPT = f"""\
You are mapping the logic of a GitHub pull request so a reviewer can understand it
without reading the diff line by line. Your working directory is the repository checked
out at the PR's head commit. You can read it with Read, Grep and Glob; you cannot edit
files or run commands.

Describe what the code changed by this PR does, end to end, as a flowchart of short
pseudo-code blocks. Start from the entry points (requests, jobs, commands, UI events)
and follow the behaviour the PR adds or changes. Read the code to find the real
functions behind each step.

Answer with exactly one fenced ```json block and nothing after it, in this shape:

{{
  "summary": "One or two sentences on what the PR does.",
  "blocks": [Block, ...]
}}

Block = {{
  "id": "short-unique-id",          // letters, digits, - or _; unique in the whole map
  "label": "Validate the submission", // pseudo-code, at most {MAX_LABEL} characters
  "kind": "entry" | "step" | "decision" | "loop" | "async" | "exit",
  "change": "added" | "changed" | "unchanged",  // how this PR affects this logic
  "next": [{{"to": "sibling-id", "label": "valid"}}],  // flow to blocks in the same list; label optional, at most {MAX_EDGE_LABEL} characters
  "children": [Block, ...],          // optional: the finer steps inside this block
  "functions": [{{"path": "app/visits.py", "symbol": "VisitService.save", "start": 40, "end": 72}}]
}}

Rules:
- At most {MAX_DEPTH} levels deep, and 1 to {MAX_BLOCKS} blocks in any one list.
- A block has either "children" or "functions", never both. Leaves should list the
  functions (1-based, inclusive line ranges at the head commit; at most {MAX_FUNCTIONS})
  that implement them, unless no single function does (for example a config change).
- "next" only links blocks in the same list. A decision has one edge per outcome,
  labelled. A loop's body goes in its children.
- Mark unchanged context as "unchanged"; keep it to what's needed to follow the flow.
- Every path must exist in the checkout, and every line range must be inside its file.

The pull request is included at the start of the conversation."""

LOGIC_REQUEST = (
    "Map the logic of this pull request as described. Read the code you need, then answer "
    "with one ```json block."
)


def repair_request(problems: list[str]) -> str:
    listed = "\n".join(f"- {p}" for p in problems)
    return (
        "Your map didn't pass validation:\n"
        f"{listed}\n\n"
        "Fix these problems and answer again with the complete map in one ```json block."
    )


def parse_answer(text: str) -> tuple[dict | None, list[str]]:
    """The JSON from Claude's answer: the last fenced block, or the whole text."""
    blocks = _FENCE.findall(text)
    candidate = blocks[-1] if blocks else text.strip()
    try:
        return json.loads(candidate), []
    except ValueError as exc:
        if not blocks:
            return None, ["No JSON block found in the answer"]
        return None, [f"The JSON doesn't parse: {exc}"]


def validate_map(data: object, root: Path) -> tuple[dict | None, list[str]]:
    """The map with unknown keys dropped, or every problem found in it."""
    problems: list[str] = []
    if not isinstance(data, dict):
        return None, ["the answer must be a JSON object with summary and blocks"]
    summary = data.get("summary")
    if not isinstance(summary, str) or not summary.strip():
        problems.append("summary: must be a non-empty string")
    seen: set[str] = set()
    blocks = _blocks(data.get("blocks"), "blocks", 1, root, seen, problems)
    if problems:
        return None, problems
    return {"summary": summary.strip(), "blocks": blocks}, []


def _blocks(value, where: str, level: int, root: Path, seen: set[str], problems: list[str]) -> list[dict]:
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_BLOCKS:
        problems.append(f"{where}: must have 1 to {MAX_BLOCKS} blocks")
        return []
    siblings = {b.get("id") for b in value if isinstance(b, dict)}
    return [_block(b, f"{where}[{i}]", level, root, seen, siblings, problems) for i, b in enumerate(value)]


def _block(b, where: str, level: int, root: Path, seen: set[str], siblings: set, problems: list[str]) -> dict:
    if not isinstance(b, dict):
        problems.append(f"{where}: must be an object")
        return {}
    block_id = b.get("id")
    if not isinstance(block_id, str) or not _ID.match(block_id):
        problems.append(f"{where}.id: must match {_ID.pattern}")
    elif block_id in seen:
        problems.append(f'{where}.id: "{block_id}" is used more than once')
    else:
        seen.add(block_id)
    label = b.get("label")
    if not isinstance(label, str) or not 1 <= len(label.strip()) <= MAX_LABEL:
        problems.append(f"{where}.label: must be 1 to {MAX_LABEL} characters")
    for key, allowed in (("kind", KINDS), ("change", CHANGES)):
        if b.get(key) not in allowed:
            problems.append(f"{where}.{key}: must be one of {', '.join(allowed)}")

    out = {
        "id": block_id,
        "label": label.strip() if isinstance(label, str) else label,
        "kind": b.get("kind"),
        "change": b.get("change"),
        "next": _edges(b.get("next", []), where, block_id, siblings, problems),
    }
    if "children" in b and "functions" in b:
        problems.append(f"{where}: a block can't have both children and functions")
    if "children" in b:
        if level >= MAX_DEPTH:
            problems.append(f"{where}.children: the map can be at most {MAX_DEPTH} levels deep")
        elif isinstance(b["children"], list) and not b["children"]:
            problems.append(f"{where}.children: must not be empty")
        else:
            out["children"] = _blocks(b["children"], f"{where}.children", level + 1, root, seen, problems)
    if "functions" in b:
        out["functions"] = _functions(b["functions"], f"{where}.functions", root, problems)
    return out


def _edges(value, where: str, block_id, siblings: set, problems: list[str]) -> list[dict]:
    if not isinstance(value, list):
        problems.append(f"{where}.next: must be a list")
        return []
    edges = []
    for i, edge in enumerate(value):
        at = f"{where}.next[{i}]"
        if not isinstance(edge, dict) or not isinstance(edge.get("to"), str):
            problems.append(f"{at}: must be an object with a \"to\" id")
            continue
        if edge["to"] == block_id:
            problems.append(f"{at}.to: a block can't point at itself")
        elif edge["to"] not in siblings:
            problems.append(f'{at}.to: "{edge["to"]}" is not a sibling of this block')
        out = {"to": edge["to"]}
        if "label" in edge:
            if not isinstance(edge["label"], str) or len(edge["label"]) > MAX_EDGE_LABEL:
                problems.append(f"{at}.label: must be at most {MAX_EDGE_LABEL} characters")
            else:
                out["label"] = edge["label"]
        edges.append(out)
    return edges


def _functions(value, where: str, root: Path, problems: list[str]) -> list[dict]:
    if not isinstance(value, list):
        problems.append(f"{where}: must be a list")
        return []
    if len(value) > MAX_FUNCTIONS:
        problems.append(f"{where}: at most {MAX_FUNCTIONS} functions per block")
        return []
    out = []
    for i, ref in enumerate(value):
        at = f"{where}[{i}]"
        if not isinstance(ref, dict):
            problems.append(f"{at}: must be an object")
            continue
        path, start, end = ref.get("path"), ref.get("start"), ref.get("end")
        if not isinstance(path, str) or path.startswith("/") or not inside(root=root, target=path):
            problems.append(f"{at}.path: must be a file inside the repository")
            continue
        file = Path(root) / path
        if not file.is_file():
            problems.append(f"{at}.path: {path} doesn't exist")
            continue
        if not isinstance(ref.get("symbol"), str) or not ref["symbol"].strip():
            problems.append(f"{at}.symbol: must be a non-empty string")
        if not (isinstance(start, int) and isinstance(end, int) and 1 <= start <= end):
            problems.append(f"{at}: start and end must be 1-based lines with start <= end")
            continue
        count = len(file.read_text("utf-8", "replace").splitlines())
        if end > count:
            problems.append(f"{at}: {path} has only {count} lines")
            continue
        out.append({"path": path, "symbol": ref.get("symbol"), "start": start, "end": end})
    return out


def find_block(blocks: list[dict], block_id: str) -> dict | None:
    for block in blocks:
        if block["id"] == block_id:
            return block
        found = find_block(block.get("children", []), block_id)
        if found:
            return found
    return None


def function_source(root: Path, ref: dict, changed: set[int]) -> dict:
    """One function's lines from the checkout, highlighted, with the PR's changes marked."""
    path, start, end = ref["path"], ref["start"], ref["end"]
    if not inside(root=root, target=path):
        raise ValueError(f"{path} is outside the checkout")
    out = {"path": path, "symbol": ref["symbol"], "start": start, "end": end, "lines": []}
    file = Path(root) / path
    if not file.is_file():
        return {**out, "missing": "File not found in the checkout"}
    code = file.read_text("utf-8", "replace")
    # Highlight the whole file so a range that starts inside a string or comment still colours right.
    html = render._highlight_lines(code, render._lexer_for(path))
    out["lines"] = [
        {"n": n, "html": html[n - 1], "changed": n in changed}
        for n in range(start, min(end, len(html)) + 1)
    ]
    return out
