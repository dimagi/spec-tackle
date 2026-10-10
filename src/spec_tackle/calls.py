"""The call tree: how the Python functions a PR changes are called, found with `ast`.

See docs/specs/2026-10-10-call-tree-design.md. Everything here is pure: it reads a
checkout and the PR's patches, and returns plain data. No Claude, no network.
"""

from __future__ import annotations

import ast
import os
from dataclasses import dataclass, field
from pathlib import Path

MAX_FILES = 5000
MAX_BYTES = 1_000_000
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


def build_index(root: Path, max_files: int = MAX_FILES, max_bytes: int = MAX_BYTES) -> Index:
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
