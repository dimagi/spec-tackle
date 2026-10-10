"""The call tree: how the Python functions a PR changes are called, found with `ast`.

See docs/specs/2026-10-10-call-tree-design.md. Everything here is pure: it reads a
checkout and the PR's patches, and returns plain data. No Claude, no network.
"""

from __future__ import annotations

import ast
import os
import re
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path

MAX_FILES = 5000
MAX_BYTES = 1_000_000
MAX_HOPS = 3
MAX_NODES = 400
SKIP_DIRS = {".git", "node_modules", ".venv", "venv", "__pycache__", "build", "dist", "site-packages"}

_DEF = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)


@dataclass(frozen=True)
class Definition:
    id: str  # "path::Qual.name"
    path: str
    module: str
    qualname: str
    kind: str  # "function" | "method" | "class"
    start: int  # the first decorator, or the def line
    end: int
    header: tuple[int, int]  # decorators through the line with the ":"
    decorators: tuple[str, ...]
    parent: str | None  # the enclosing class (methods) or function (nested defs)
    node: ast.AST = field(compare=False, hash=False, repr=False)


@dataclass
class Module:
    path: str
    name: str
    package: str  # what relative imports resolve against
    tree: ast.Module
    imports: dict[str, str] = field(default_factory=dict)  # local name -> dotted target
    defs: dict[str, Definition] = field(default_factory=dict)  # qualname -> definition


@dataclass
class Index:
    modules: dict[str, Module] = field(default_factory=dict)  # by path
    defs: dict[str, Definition] = field(default_factory=dict)  # by id
    skipped: list[dict] = field(default_factory=list)
    truncated: bool = False
    _suffixes: dict[str, list[Module]] | None = field(default=None, repr=False)

    def find_module(self, dotted: str) -> Module | None:
        """The repo module a dotted name means, matched on the end of its path; None when unsure."""
        if self._suffixes is None:
            self._suffixes = {}
            for m in self.modules.values():
                parts = m.name.split(".")
                for i in range(len(parts)):
                    self._suffixes.setdefault(".".join(parts[i:]), []).append(m)
        found = self._suffixes.get(dotted, [])
        if len(found) == 1:
            return found[0]
        exact = [m for m in found if m.name == dotted]
        return exact[0] if len(exact) == 1 else None

    def lookup(self, dotted: str, _hops: int = 0) -> Definition | None:
        """The definition a dotted name means: a module, then a qualified name inside it.

        A name a package's `__init__.py` imports from elsewhere is followed there.
        """
        parts = dotted.split(".")
        for i in range(len(parts) - 1, 0, -1):
            module = self.find_module(".".join(parts[:i]))
            if module is None:
                continue
            rest = parts[i:]
            found = module.defs.get(".".join(rest))
            if found:
                return found
            target = module.imports.get(rest[0])
            if target and _hops < 3:
                return self.lookup(".".join([target, *rest[1:]]), _hops + 1)
            return None
        return None


def module_name(path: str) -> str:
    parts = path[: -len(".py")].split("/")
    if parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts)


def build_index(root: Path, max_files: int | None = None, max_bytes: int | None = None) -> Index:
    max_files = MAX_FILES if max_files is None else max_files
    max_bytes = MAX_BYTES if max_bytes is None else max_bytes
    index = Index()
    for path in _python_files(Path(root)):
        if len(index.modules) >= max_files:
            index.truncated = True
            break
        file = Path(root) / path
        if file.stat().st_size > max_bytes:
            index.skipped.append({"path": path, "reason": "too large"})
            continue
        try:
            tree = ast.parse(file.read_text("utf-8", "replace"), filename=path)
        except SyntaxError as exc:
            index.skipped.append({"path": path, "reason": f"syntax error: line {exc.lineno}: {exc.msg}"})
            continue
        except ValueError as exc:  # e.g. null bytes
            index.skipped.append({"path": path, "reason": f"syntax error: {exc}"})
            continue
        name = module_name(path)
        package = name if path.endswith("__init__.py") else name.rpartition(".")[0]
        module = Module(path=path, name=name, package=package, tree=tree)
        _read_imports(module)
        _read_defs(module, tree.body, prefix="", parent=None, parent_kind=None)
        index.modules[path] = module
        for d in module.defs.values():
            index.defs[d.id] = d
    return index


def _python_files(root: Path):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
        for name in sorted(filenames):
            if name.endswith(".py"):
                yield (Path(dirpath) / name).relative_to(root).as_posix()


def _read_imports(module: Module) -> None:
    # Breadth first, so a module-level import wins over one inside a function.
    for node in ast.walk(module.tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.asname:
                    module.imports.setdefault(alias.asname, alias.name)
                else:
                    top = alias.name.split(".")[0]
                    module.imports.setdefault(top, top)
        elif isinstance(node, ast.ImportFrom):
            base = _absolute(module, node.module, node.level)
            if base is None:
                continue
            for alias in node.names:
                if alias.name != "*":
                    module.imports.setdefault(alias.asname or alias.name, f"{base}.{alias.name}" if base else alias.name)


def _absolute(module: Module, name: str | None, level: int) -> str | None:
    if not level:
        return name
    parts = module.package.split(".") if module.package else []
    if level - 1 > len(parts):
        return None
    base = parts[: len(parts) - (level - 1)]
    return ".".join([*base, *([name] if name else [])])


def _read_defs(module: Module, body: list[ast.stmt], prefix: str, parent: str | None, parent_kind: str | None) -> None:
    for node in body:
        if isinstance(node, _DEF):
            qual = prefix + node.name
            if qual in module.defs:  # a second, conditional definition: the first wins
                continue
            kind = "class" if isinstance(node, ast.ClassDef) else "method" if parent_kind == "class" else "function"
            start = min([node.lineno, *(d.lineno for d in node.decorator_list)])
            body_line = node.body[0].lineno
            definition = Definition(
                id=f"{module.path}::{qual}", path=module.path, module=module.name, qualname=qual, kind=kind,
                start=start, end=node.end_lineno or node.lineno,
                header=(start, body_line - 1 if body_line > node.lineno else node.lineno),
                decorators=tuple(ast.unparse(d) for d in node.decorator_list),
                parent=parent, node=node,
            )
            module.defs[qual] = definition
            inner = f"{qual}." if kind == "class" else f"{qual}.<locals>."
            _read_defs(module, node.body, inner, definition.id, kind)
        else:
            # Definitions under `if`, `try`, `with` and loops still count.
            for block in _blocks(node):
                _read_defs(module, block, prefix, parent, parent_kind)


def _blocks(node: ast.stmt) -> list[list[ast.stmt]]:
    blocks = [getattr(node, name, None) for name in ("body", "orelse", "finalbody")]
    blocks += [h.body for h in getattr(node, "handlers", [])]
    blocks += [c.body for c in getattr(node, "cases", [])]
    return [b for b in blocks if isinstance(b, list) and b and isinstance(b[0], ast.stmt)]


# -- resolving calls ---------------------------------------------------------

_RANK = {"call": 0, "ref": 1, "probable": 2}


@dataclass(frozen=True)
class Edge:
    caller: str
    callee: str
    kind: str  # "call" | "ref" | "probable"
    lines: tuple[int, ...]


def resolve_edges(index: Index) -> list[Edge]:
    """Every call and reference from one repo definition to another that `ast` can pin down."""
    resolver = _Resolver(index)
    found: dict[tuple[str, str], tuple[str, set[int]]] = {}

    def add(caller: Definition, callee: Definition, kind: str, line: int) -> None:
        key = (caller.id, callee.id)
        old_kind, lines = found.get(key, (kind, set()))
        lines.add(line)
        found[key] = (min(old_kind, kind, key=_RANK.__getitem__), lines)

    for module in index.modules.values():
        for d in module.defs.values():
            for callee, kind, line in resolver.uses(module, d):
                add(d, callee, kind, line)
    return [Edge(caller, callee, kind, tuple(sorted(lines))) for (caller, callee), (kind, lines) in found.items()]


class _Resolver:
    def __init__(self, index: Index):
        self.index = index
        self.methods: dict[str, list[Definition]] = {}
        for d in index.defs.values():
            name = d.qualname.rpartition(".")[2]
            if d.kind == "method" and not (name.startswith("__") and name.endswith("__")):
                self.methods.setdefault(name, []).append(d)

    def uses(self, module: Module, d: Definition):
        """(callee, kind, line) for each use in `d`'s own body; nested definitions are their own callers."""
        chain = self._chain(d)
        if d.kind == "class":
            for base in d.node.bases:
                target = self._expr(module, chain[1:], base)
                if target:
                    yield target, "ref", base.lineno
        for node in _own_nodes(d.node):
            if isinstance(node, ast.Call):
                target = self._call(module, chain, node.func)
                if target:
                    yield target[0], target[1], node.lineno
                for arg in [*node.args, *(k.value for k in node.keywords)]:
                    yield from self._refs(module, chain, arg)
            elif isinstance(node, (ast.Assign, ast.AnnAssign)) and node.value is not None:
                yield from self._refs(module, chain, node.value)

    def _refs(self, module, chain, expr):
        for value in _values(expr):
            target = self._expr(module, chain, value)
            if target:
                yield target, "ref", value.lineno

    def _call(self, module: Module, chain: list[Definition], func: ast.expr) -> tuple[Definition, str] | None:
        target = self._expr(module, chain, func)
        if target and target.kind == "class":
            return self._member(target, "__init__") or target, "call"
        if target:
            return target, "call"
        if isinstance(func, ast.Attribute) and not self._known_base(module, chain, func.value):
            candidates = self.methods.get(func.attr, [])
            if len(candidates) == 1:
                return candidates[0], "probable"
        return None

    def _expr(self, module: Module, chain: list[Definition], expr: ast.expr) -> Definition | None:
        """The definition an expression names, if any."""
        if isinstance(expr, ast.Name):
            return self._name(module, chain, expr.id)
        if not isinstance(expr, ast.Attribute):
            return None
        cls = next((c for c in chain if c.kind == "class"), None)
        base = expr.value
        if isinstance(base, ast.Name) and base.id in ("self", "cls") and cls:
            return self._member(cls, expr.attr)
        if isinstance(base, ast.Call) and isinstance(base.func, ast.Name) and base.func.id == "super" and cls:
            return self._member(cls, expr.attr, skip_self=True)
        parts = _dotted(expr)
        if not parts:
            return None
        first = self._name(module, chain, parts[0], imports=False)
        if first is not None:
            return self._member(first, parts[1]) if first.kind == "class" and len(parts) == 2 else None
        target = module.imports.get(parts[0])
        return self.index.lookup(".".join([target, *parts[1:]])) if target else None

    def _name(self, module: Module, chain: list[Definition], name: str, imports: bool = True) -> Definition | None:
        for scope in chain:
            if scope.kind != "class":  # a class body's names aren't visible inside its methods
                found = module.defs.get(f"{scope.qualname}.<locals>.{name}")
                if found:
                    return found
        found = module.defs.get(name)
        if found:
            return found
        target = module.imports.get(name) if imports else None
        return self.index.lookup(target) if target else None

    def _member(self, cls: Definition, name: str, skip_self: bool = False, seen=None) -> Definition | None:
        """`name` on a class or, in order, its repo base classes."""
        seen = seen or set()
        if cls.id in seen:
            return None
        seen.add(cls.id)
        module = self.index.modules[cls.path]
        if not skip_self:
            found = module.defs.get(f"{cls.qualname}.{name}")
            if found:
                return found
        for base in cls.node.bases:
            parent = self._expr(module, self._chain(cls)[1:], base)
            if parent and parent.kind == "class":
                found = self._member(parent, name, seen=seen)
                if found:
                    return found
        return None

    def _known_base(self, module: Module, chain: list[Definition], expr: ast.expr) -> bool:
        """True when a receiver is a module, class or other known name: then a miss isn't 'probable'."""
        parts = _dotted(expr) if isinstance(expr, ast.Attribute) else [expr.id] if isinstance(expr, ast.Name) else None
        if not parts:
            return False
        return parts[0] in module.imports or self._name(module, chain, parts[0], imports=False) is not None

    def _chain(self, d: Definition) -> list[Definition]:
        chain = [d]
        while chain[-1].parent:
            chain.append(self.index.defs[chain[-1].parent])
        return chain


def _own_nodes(node: ast.AST):
    """Every node in a definition's body, without descending into nested definitions."""
    stack = list(reversed(node.body))
    while stack:
        current = stack.pop()
        if isinstance(current, _DEF):
            continue
        yield current
        stack.extend(reversed(list(ast.iter_child_nodes(current))))


def _values(expr: ast.expr):
    """The names in an expression used as values: itself, or the items of a literal list, tuple, set or dict."""
    if isinstance(expr, (ast.Name, ast.Attribute)):
        yield expr
    elif isinstance(expr, (ast.List, ast.Tuple, ast.Set)):
        for item in expr.elts:
            yield from _values(item)
    elif isinstance(expr, ast.Dict):
        for item in expr.values:
            yield from _values(item)
    elif isinstance(expr, ast.Starred):
        yield from _values(expr.value)


def _dotted(expr: ast.Attribute) -> list[str] | None:
    parts = []
    while isinstance(expr, ast.Attribute):
        parts.append(expr.attr)
        expr = expr.value
    if not isinstance(expr, ast.Name):
        return None
    return [expr.id, *reversed(parts)]


# -- what the PR changed -----------------------------------------------------

_HUNK = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@")

# The same rule as the Logic view's isTestPath (frontend/src/lib/logicFlow.ts).
_TEST_PATHS = [
    re.compile(r"(^|/)(tests?|__tests__|e2e)/"),
    re.compile(r"(^|/)test_[^/]+\.py$"),
    re.compile(r"_test\.(py|go|rb)$"),
    re.compile(r"(^|/)conftest\.py$"),
]


def is_test_path(path: str) -> bool:
    return any(p.search(path) for p in _TEST_PATHS)


def changed_lines(patch: str | None) -> tuple[set[int], set[int]]:
    """(lines the patch adds, new-side lines that deleted lines sat just before)."""
    added: set[int] = set()
    deleted: set[int] = set()
    line = 0
    for row in (patch or "").splitlines():
        hunk = _HUNK.match(row)
        if hunk:
            line = int(hunk.group(1))
        elif row.startswith("+"):
            added.add(line)
            line += 1
        elif row.startswith("-"):
            deleted.add(line)
        elif row.startswith(" "):
            line += 1
    return added, deleted


def _own_lines(index: Index, d: Definition) -> set[int]:
    """A definition's lines; a class's leave out its methods and nested classes."""
    lines = set(range(d.start, d.end + 1))
    if d.kind == "class":
        for child in index.modules[d.path].defs.values():
            if child.parent == d.id:
                lines -= set(range(child.start, child.end + 1))
    return lines


def roots(index: Index, changes: dict[str, tuple[set[int], set[int]]], added_files: set[str]) -> dict[str, dict]:
    """The definitions the PR adds or changes: id -> {change, signatureChanged}."""
    found: dict[str, dict] = {}
    for path, (added, deleted) in changes.items():
        module = index.modules.get(path)
        if module is None:
            continue
        for d in module.defs.values():
            span = set(range(d.start, d.end + 1))
            if path in added_files or (span <= added and not span & deleted):
                found[d.id] = {"change": "added", "signatureChanged": False}
                continue
            touched = _own_lines(index, d) & (added | deleted)
            if touched:
                header = set(range(d.header[0], d.header[1] + 1))
                found[d.id] = {"change": "changed", "signatureChanged": bool(touched & header)}
    return found


def neighbourhood(
    edges: list[Edge], root_ids: set[str], up: int = MAX_HOPS, down: int = MAX_HOPS, max_nodes: int = MAX_NODES,
) -> tuple[dict[str, tuple[int | None, int | None]], tuple[int, int], bool]:
    """Hop distances from the roots: (callers above, callees below), with the farthest cut to fit `max_nodes`."""
    callers: dict[str, set[str]] = {}
    callees: dict[str, set[str]] = {}
    for e in edges:
        callers.setdefault(e.callee, set()).add(e.caller)
        callees.setdefault(e.caller, set()).add(e.callee)
    above = _hops(root_ids, callers, up)
    below = _hops(root_ids, callees, down)

    def pick(u: int, d: int) -> dict[str, tuple[int | None, int | None]]:
        ids = {i for i, n in above.items() if n <= u} | {i for i, n in below.items() if n <= d}
        return {i: (above.get(i) if above.get(i, u + 1) <= u else None, below.get(i) if below.get(i, d + 1) <= d else None)
                for i in ids}

    cut = False
    picked = pick(up, down)
    while len(picked) > max_nodes and (up or down):
        cut = True
        if down >= up:
            down -= 1
        else:
            up -= 1
        picked = pick(up, down)
    for r in root_ids:
        picked[r] = (0, 0)
    return picked, (up, down), cut


def _hops(start: set[str], graph: dict[str, set[str]], limit: int) -> dict[str, int]:
    dist = {s: 0 for s in start}
    queue = deque(start)
    while queue:
        current = queue.popleft()
        if dist[current] >= limit:
            continue
        for nxt in graph.get(current, ()):
            if nxt not in dist:
                dist[nxt] = dist[current] + 1
                queue.append(nxt)
    return dist


def analyse(root: Path, files: list[dict]) -> dict:
    """The call tree for a PR: its changed definitions, their callers and callees, and what wasn't analysed."""
    index = build_index(root)
    changes = {f["filename"]: changed_lines(f.get("patch")) for f in files
               if f["status"] != "removed" and f["filename"].endswith(".py")}
    added_files = {f["filename"] for f in files if f["status"] == "added"}
    changed = roots(index, changes, added_files)

    owner = {d.id: _owner(index, d).id for d in index.defs.values()}
    root_ids = {i for i in changed if owner[i] == i}
    merged: dict[tuple[str, str], tuple[str, set[int]]] = {}
    for e in resolve_edges(index):
        a, b = owner[e.caller], owner[e.callee]
        if a == b and e.caller != e.callee:
            continue  # a parent calling its own nested function
        kind, lines = merged.get((a, b), (e.kind, set()))
        merged[(a, b)] = (min(kind, e.kind, key=_RANK.__getitem__), lines | set(e.lines))
    edges = [Edge(a, b, kind, tuple(sorted(lines))) for (a, b), (kind, lines) in merged.items()]

    dist, (up, down), cut = neighbourhood(edges, root_ids)
    nodes = []
    for i, (u, d) in dist.items():
        definition = index.defs[i]
        info = changed.get(i, {"change": "unchanged", "signatureChanged": False})
        nodes.append({
            "id": i, "path": definition.path, "symbol": definition.qualname,
            "start": definition.start, "end": definition.end, "kind": definition.kind,
            "change": info["change"], "signatureChanged": info["signatureChanged"],
            "decorators": list(definition.decorators), "test": is_test_path(definition.path),
            "up": u, "down": d,
        })
    nodes.sort(key=lambda n: (n["path"], n["start"]))
    return {
        "nodes": nodes,
        "edges": [
            {"from": e.caller, "to": e.callee, "kind": e.kind, "lines": list(e.lines),
             "notUpdated": e.caller not in root_ids and changed.get(e.callee, {}).get("signatureChanged", False)}
            for e in edges if e.caller in dist and e.callee in dist
        ],
        "other": _other(index, files, changes),
        "truncated": "nodes" if cut else "files" if index.truncated else None,
        "depth": {"up": up, "down": down},
    }


def _owner(index: Index, d: Definition) -> Definition:
    """What a definition is shown as: nested functions (and classes inside functions) fold into the outermost function."""
    chain = [d]
    while chain[-1].parent:
        chain.append(index.defs[chain[-1].parent])
    functions = [c for c in chain if c.kind != "class"]
    return functions[-1] if functions else d


def _other(index: Index, files: list[dict], changes: dict[str, tuple[set[int], set[int]]]) -> list[dict]:
    skipped = {s["path"]: "too large" if s["reason"] == "too large" else "syntax error" for s in index.skipped}
    other = []
    for f in files:
        path = f["filename"]
        if f["status"] == "removed":
            continue
        if not path.endswith(".py"):
            other.append({"path": path, "reason": "not Python"})
        elif path in skipped:
            other.append({"path": path, "reason": skipped[path]})
        elif path in index.modules:
            added, deleted = changes[path]
            inside = set().union(*(range(d.start, d.end + 1) for d in index.modules[path].defs.values()))
            if (added | deleted) - inside:
                other.append({"path": path, "reason": "module level"})
    return other
