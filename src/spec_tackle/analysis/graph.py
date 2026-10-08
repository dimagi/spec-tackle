"""The import graph of the repo at head, and who imports the changed modules."""

from __future__ import annotations

import ast
import os
import shutil
import sys
import tempfile
from pathlib import Path

import grimp
from grimp.exceptions import SourceSyntaxError

from .symbols import Symbol


def find_packages(root: Path) -> tuple[Path, list[str]]:
    """(directory to import from, top-level package names): at the root, else under src/."""
    for base in (root, root / "src"):
        if base.is_dir():
            names = sorted(d.name for d in base.iterdir() if d.is_dir() and (d / "__init__.py").exists())
            if names:
                return base, names
    return root, []


def module_name(path: str, prefix: str = "") -> str | None:
    """Dotted module for a repo path; `prefix` is the import root relative to the repo (e.g. "src")."""
    if not path.endswith(".py"):
        return None
    if prefix:
        if not path.startswith(prefix + "/"):
            return None
        path = path[len(prefix) + 1 :]
    parts = path[:-3].split("/")
    if parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts) or None


MAX_UNPARSEABLE = 10


def _grimp(import_root: Path, packages: list[str]) -> grimp.ImportGraph:
    sys.path.insert(0, str(import_root))
    try:
        return grimp.build_graph(*packages, cache_dir=None)
    finally:
        sys.path.remove(str(import_root))


def _mirror(src: Path, dst: Path) -> None:
    """Hardlink (or copy) a package tree, so files can be blanked without touching the original."""
    for dirpath, _, names in os.walk(src):
        target = dst / Path(dirpath).relative_to(src)
        target.mkdir(parents=True, exist_ok=True)
        for name in names:
            if name.endswith(".py"):
                try:
                    os.link(Path(dirpath) / name, target / name)
                except OSError:
                    shutil.copy2(Path(dirpath) / name, target / name)


def build_graph(import_root: Path, packages: list[str]) -> grimp.ImportGraph:
    """The import graph. grimp stops at a file it can't parse (e.g. Python 2), so those are
    blanked in a throwaway mirror of the packages and the build retried."""
    try:
        return _grimp(import_root, packages)
    except SourceSyntaxError as first:
        error: SourceSyntaxError | None = first
    with tempfile.TemporaryDirectory(prefix="spec-tackle-graph-", dir=import_root.parent) as tmp:
        shadow = Path(tmp)
        for name in packages:
            _mirror(import_root / name, shadow / name)
        for _ in range(MAX_UNPARSEABLE):
            reported = Path(error.filename)
            inside = shadow if reported.is_relative_to(shadow) else import_root
            broken = shadow / reported.relative_to(inside)
            broken.unlink()  # break the hardlink before writing
            broken.write_text("")
            try:
                return _grimp(shadow, packages)
            except SourceSyntaxError as again:
                error = again
        raise error


def module_path(import_root: Path, module: str) -> Path:
    base = import_root.joinpath(*module.split("."))
    package = base / "__init__.py"
    return package if package.exists() else base.with_suffix(".py")


def _resolve(importer: str, is_package: bool, node: ast.ImportFrom) -> str:
    if not node.level:
        return node.module or ""
    parts = importer.split(".")
    package = parts if is_package else parts[:-1]
    package = package[: len(package) - (node.level - 1)]
    return ".".join(package + ([node.module] if node.module else []))


def references(source: str, importer: str, is_package: bool, targets: dict[str, set[str]]) -> list[str]:
    """Names from `targets` ({module: top-level names}) that `source` imports or uses."""
    tree = ast.parse(source)
    found: set[str] = set()
    aliases: dict[str, str] = {}  # local name → target module
    imported: dict[str, str] = {}  # local name → symbol of a target module
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                if a.name in targets:
                    aliases[a.asname or a.name] = a.name
        elif isinstance(node, ast.ImportFrom):
            base = _resolve(importer, is_package, node)
            for a in node.names:
                local = a.asname or a.name
                if base in targets and a.name in targets[base]:
                    imported[local] = a.name
                    found.add(a.name)
                elif f"{base}.{a.name}" in targets:
                    aliases[local] = f"{base}.{a.name}"
    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id in aliases:
            if node.attr in targets[aliases[node.value.id]]:
                found.add(node.attr)
        elif isinstance(node, ast.Name) and node.id in imported:
            found.add(imported[node.id])
    return sorted(found)


def hop1(
    graph: grimp.ImportGraph,
    changed: set[str],
    import_root: Path,
    symbols: dict[str, list[Symbol]],
    repo_root: Path | None = None,
) -> list[dict]:
    """Unchanged modules that directly import a changed module, with what they use from it."""
    repo_root = repo_root or import_root
    targets = {m: {s.name.split(".")[0] for s in symbols.get(m, []) if s.kind != "module"} for m in changed}
    importers: dict[str, list[str]] = {}
    for module in sorted(changed & graph.modules):
        for importer in graph.find_modules_that_directly_import(module):
            if importer not in changed:
                importers.setdefault(importer, []).append(module)
    deps = []
    for importer in sorted(importers):
        path = module_path(import_root, importer)
        try:
            refs = references(path.read_text(), importer, path.name == "__init__.py", targets)
        except (OSError, SyntaxError, UnicodeDecodeError):
            refs = []
        deps.append({
            "module": importer,
            "path": path.relative_to(repo_root).as_posix(),
            "imports": sorted(importers[importer]),
            "references": refs,
        })
    return deps


def indirect(graph: grimp.ImportGraph, hop1_modules: set[str], exclude: set[str]) -> dict[str, list[str]]:
    """For each hop-1 module, everything that imports it indirectly (hop 2+)."""
    skip = exclude | hop1_modules
    return {m: sorted(graph.find_downstream_modules(m) - skip) for m in sorted(hop1_modules)}
