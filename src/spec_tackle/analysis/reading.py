"""Which phase a file belongs to, its tag, and the order to read the PR in."""

from __future__ import annotations

from typing import Literal

from .symbols import Symbol

Phase = Literal["data", "core", "edges", "tests", "other"]
PHASES: list[Phase] = ["data", "core", "edges", "tests", "other"]


def phase_for(path: str) -> Phase:
    parts = path.split("/")
    name, dirs = parts[-1], parts[:-1]
    if "tests" in dirs or name.startswith("test_") or name.endswith("_test.py") or name == "conftest.py":
        return "tests"
    if not name.endswith(".py"):
        return "other"
    if name in ("models.py", "schemas.py", "serializers.py") or "models" in dirs or "migrations" in dirs:
        return "data"
    if name in ("views.py", "urls.py", "tasks.py", "signals.py") or "api" in dirs or "management" in dirs:
        return "edges"
    return "core"


def tag_for(file: dict, phase: Phase, symbols: list[Symbol]) -> str | None:
    if phase == "data" or any(s.signature_changed or s.change == "removed" for s in symbols):
        return "contract"
    if file["status"] == "added":
        return "new"
    if phase == "tests":
        return "test"
    if file["additions"] + file["deletions"] <= 5:
        return "small"
    return None


def _components(nodes: list[str], deps: dict[str, set[str]]) -> list[list[str]]:
    """Strongly connected components (Tarjan), so import cycles read as one step."""
    index: dict[str, int] = {}
    low: dict[str, int] = {}
    stack: list[str] = []
    on_stack: set[str] = set()
    out: list[list[str]] = []

    def visit(v: str) -> None:
        index[v] = low[v] = len(index)
        stack.append(v)
        on_stack.add(v)
        for w in sorted(deps[v]):
            if w not in index:
                visit(w)
                low[v] = min(low[v], low[w])
            elif w in on_stack:
                low[v] = min(low[v], index[w])
        if low[v] == index[v]:
            comp = []
            while True:
                w = stack.pop()
                on_stack.discard(w)
                comp.append(w)
                if w == v:
                    break
            out.append(sorted(comp))

    for v in sorted(nodes):
        if v not in index:
            visit(v)
    return out


def _dependency_order(paths: list[str], deps: dict[str, set[str]]) -> list[str]:
    """Paths with what they import first; ties and cycles broken by path."""
    comps = _components(paths, deps)
    comp_of = {p: i for i, c in enumerate(comps) for p in c}
    waiting = {i: {comp_of[d] for p in c for d in deps[p]} - {i} for i, c in enumerate(comps)}
    order: list[str] = []
    done: set[int] = set()
    while len(done) < len(comps):
        ready = [i for i in waiting if i not in done and waiting[i] <= done]
        first = min(ready, key=lambda i: comps[i][0])
        done.add(first)
        order.extend(comps[first])
    return order


def reading_order(files: list[dict], graph) -> list[dict]:
    """[{phase, files}] in phase order; within a phase, dependencies before their users."""
    paths = sorted(f["path"] for f in files)
    module_of = {f["path"]: f.get("module") for f in files}
    if graph is not None:
        by_module = {m: p for p, m in module_of.items() if m and m in graph.modules}
        deps = {
            p: {by_module[d] for d in graph.find_modules_directly_imported_by(m) if d in by_module}
            if (m := module_of[p]) in by_module else set()
            for p in paths
        }
        ordered = _dependency_order(paths, deps)
    else:
        ordered = paths
    phases = {p: phase_for(p) for p in ordered}
    return [{"phase": ph, "files": [p for p in ordered if phases[p] == ph]} for ph in PHASES if ph in phases.values()]
