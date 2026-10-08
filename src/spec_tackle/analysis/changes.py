"""The change graph: one node per changed symbol, and how the changes connect."""

from __future__ import annotations

import difflib
import re

from .symbols import MODULE, Symbol

MOVE_SIMILARITY = 0.8


def _label(s: Symbol) -> str:
    if s.kind == "module":
        return "module-level"
    return f"{s.name}()" if s.kind in ("function", "method") else s.name


def _segment(src: str | None, span: tuple[int, int] | None) -> list[str]:
    if not src or not span:
        return []
    return src.splitlines()[span[0] - 1 : span[1]]


def _body(lines: list[str]) -> str:
    """A symbol's body with its def/decorator lines dropped and whitespace collapsed."""
    start = next((i + 1 for i, line in enumerate(lines) if re.match(r"\s*(async\s+)?(def|class)\s", line)), 0)
    return " ".join(" ".join(lines[start:]).split())


def _count(lines: set[int], span: tuple[int, int] | None) -> int:
    return sum(1 for n in lines if span and span[0] <= n <= span[1]) if span else 0


def change_nodes(files: list[dict]) -> list[dict]:
    """Nodes for every changed symbol in the PR, with renames and moves merged into one node.

    Each file is {path, status, head_src, base_src, added, removed, symbols}.
    """
    nodes: list[dict] = []
    bodies: dict[str, str] = {}
    for f in files:
        path = f["path"]
        if not path.endswith(".py"):
            nodes.append({
                "id": f"{path}::", "file": path, "label": path.split("/")[-1], "kind": "file",
                "change": {"added": "added", "removed": "removed"}.get(f["status"], "modified"),
                "signatureChanged": False, "additions": len(f["added"]), "deletions": len(f["removed"]),
                "lines": None, "baseLines": None,
            })
            continue
        in_symbols_added = in_symbols_removed = 0
        file_nodes = []
        for s in f["symbols"]:
            if s.kind == "module":
                continue
            head_span = s.lines if s.change != "removed" else None
            adds, dels = _count(f["added"], head_span), _count(f["removed"], s.base_lines)
            in_symbols_added += adds
            in_symbols_removed += dels
            node = {
                "id": f"{path}::{s.name}", "file": path, "label": _label(s), "kind": s.kind, "change": s.change,
                "signatureChanged": s.signature_changed, "additions": adds, "deletions": dels,
                "lines": list(head_span) if head_span else None, "baseLines": list(s.base_lines) if s.base_lines else None,
                "name": s.name,
            }
            file_nodes.append(node)
            if s.kind in ("function", "method", "class"):
                src = f["head_src"] if s.change != "removed" else f["base_src"]
                bodies[node["id"]] = _body(_segment(src, head_span or s.base_lines))
        if any(s.name == MODULE for s in f["symbols"]):
            file_nodes.insert(0, {
                "id": f"{path}::{MODULE}", "file": path, "label": "module-level", "kind": "module", "change": "modified",
                "signatureChanged": False, "additions": max(0, len(f["added"]) - in_symbols_added),
                "deletions": max(0, len(f["removed"]) - in_symbols_removed), "lines": None, "baseLines": None, "name": MODULE,
            })
        nodes.extend(file_nodes)
    return _merge_moves(nodes, bodies)


def _merge_moves(nodes: list[dict], bodies: dict[str, str]) -> list[dict]:
    """An added symbol whose body matches a removed one is that symbol, moved or renamed."""
    removed = [n for n in nodes if n["change"] == "removed" and n["id"] in bodies]
    added = [n for n in nodes if n["change"] == "added" and n["id"] in bodies]
    pairs = []
    for a in added:
        for r in removed:
            if a["kind"] != r["kind"] or not bodies[a["id"]]:
                continue
            ratio = difflib.SequenceMatcher(None, bodies[r["id"]], bodies[a["id"]]).ratio()
            if ratio >= MOVE_SIMILARITY:
                pairs.append((ratio, a["id"], r["id"]))
    gone: set[str] = set()
    used: set[str] = set()
    by_id = {n["id"]: n for n in nodes}
    for _, a_id, r_id in sorted(pairs, reverse=True):
        if a_id in used or r_id in gone:
            continue
        a, r = by_id[a_id], by_id[r_id]
        a["change"] = "moved"
        a["from"] = {"file": r["file"], "name": r["name"]}
        a["deletions"] += r["deletions"]
        used.add(a_id)
        gone.add(r_id)
    return [n for n in nodes if n["id"] not in gone]
