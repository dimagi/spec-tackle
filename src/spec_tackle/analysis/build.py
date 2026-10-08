"""Assemble the Map for a PR from a head checkout and the PR's file list."""

from __future__ import annotations

import os
from dataclasses import asdict
from pathlib import Path

from .graph import build_graph, find_packages, hop1, indirect, module_name, module_path, references
from .patches import base_text, changed_lines
from .reading import phase_for, reading_order, tag_for
from .symbols import Symbol, changed_symbols

GRAPH_FILE_LIMIT = 150  # above this many changed files, draw only the largest
GRAPH_DRAWN = 40


def _symbol_json(s: Symbol) -> dict:
    d = asdict(s)
    return {"name": d["name"], "kind": d["kind"], "change": d["change"], "signatureChanged": d["signature_changed"]}


def build_map(worktree: Path, files: list[dict]) -> dict:
    """The /map payload: nodes, edges, reading path, limits and skipped files."""
    import_root, packages = find_packages(worktree)
    prefix = import_root.relative_to(worktree).as_posix() if import_root != worktree else ""
    skipped: list[dict] = []
    symbols: dict[str, list[Symbol]] = {}
    base_missing = False
    modules: dict[str, str | None] = {}

    for f in files:
        path = f["path"]
        modules[path] = module_name(path, prefix)
        if not path.endswith(".py"):
            continue
        head = "" if f["status"] == "removed" else _read(worktree / path)
        if f["status"] == "renamed" and not f.get("patch") and not f["additions"] + f["deletions"]:
            base = head  # moved without edits: GitHub sends no patch, and nothing changed
        else:
            base = base_text(head, f.get("patch"), f["status"])
        if base is None and f["status"] != "added":
            base_missing = True
            symbols[path] = []
            continue
        added, removed = changed_lines(f.get("patch"))
        try:
            symbols[path] = changed_symbols(base, head, added, removed)
        except SyntaxError:
            skipped.append({"path": path, "reason": "syntax error"})
            symbols[path] = []

    graph = None
    if packages and not os.environ.get("SPEC_TACKLE_NO_GRAPH"):
        try:
            graph = build_graph(import_root, packages)
        except Exception as exc:  # grimp can't build: fall back to path order
            skipped.append({"path": "", "reason": f"import graph: {exc}"})

    by_size = sorted(files, key=lambda f: -(f["additions"] + f["deletions"]))
    truncated = len(files) > GRAPH_FILE_LIMIT
    drawn = {f["path"] for f in (by_size[:GRAPH_DRAWN] if truncated else files)}

    nodes = []
    for f in files:
        phase = phase_for(f["path"])
        nodes.append({
            "id": f["path"], "hop": 0, "status": f["status"], "additions": f["additions"], "deletions": f["deletions"],
            "phase": phase, "tag": tag_for(f, phase, symbols.get(f["path"], [])), "module": modules[f["path"]],
            "symbols": [_symbol_json(s) for s in symbols.get(f["path"], [])],
            "inGraph": f["path"] in drawn and phase != "other",  # docs and config only appear in the reading path
        })

    edges: list[dict] = []
    if graph is not None:
        path_of = {m: p for p, m in modules.items() if m and m in graph.modules}
        changed = set(path_of)
        drawn_modules = {m for m, p in path_of.items() if p in drawn}
        sym_names = {m: {s.name.split(".")[0] for s in symbols.get(p, []) if s.kind != "module"} for m, p in path_of.items()}

        for m in sorted(drawn_modules):
            source = _read(worktree / path_of[m])
            for d in sorted(graph.find_modules_directly_imported_by(m) & drawn_modules):
                refs = _refs(source, m, path_of[m], {d: sym_names[d]})
                edges.append({"from": path_of[m], "to": path_of[d], "symbols": refs})

        deps = hop1(graph, drawn_modules, import_root, {m: symbols.get(path_of[m], []) for m in drawn_modules}, worktree, exclude=changed)
        more = indirect(graph, {d["module"] for d in deps}, exclude=changed)
        for d in deps:
            hop2 = [module_path(import_root, m).relative_to(worktree).as_posix() for m in more[d["module"]]]
            nodes.append({
                "id": d["path"], "hop": 1, "phase": phase_for(d["path"]), "module": d["module"],
                "imports": [path_of[m] for m in d["imports"]], "references": d["references"],
                "indirectCount": len(hop2), "indirect": hop2, "inGraph": True,
            })
            for m in d["imports"]:
                edges.append({"from": d["path"], "to": path_of[m], "symbols": d["references"]})

    return {
        "status": "ready",
        "nodes": nodes,
        "edges": edges,
        "readingPath": reading_order([{"path": f["path"], "module": modules[f["path"]]} for f in files], graph),
        "limits": {"importGraph": graph is not None, "graphTruncated": truncated, "baseMissing": base_missing},
        "skipped": skipped,
    }


def _read(path: Path) -> str:
    """A checkout file's text; never follows a symlink (a PR could point one at /dev/zero)."""
    if path.is_symlink() or not path.is_file():
        return ""
    try:
        return path.read_text()
    except (OSError, UnicodeDecodeError):
        return ""


def _refs(source: str, module: str, path: str, targets: dict[str, set[str]]) -> list[str]:
    try:
        return references(source, module, path.endswith("__init__.py"), targets)
    except SyntaxError:
        return []
