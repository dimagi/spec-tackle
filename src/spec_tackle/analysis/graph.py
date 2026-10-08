"""The import graph of the repo at head, and who imports the changed modules."""

from __future__ import annotations

import ast
import importlib
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
    # grimp finds packages with importlib, which answers from sys.modules for anything
    # already imported (e.g. spec_tackle itself): hide those so the checkout is found.
    hidden = {name: mod for name, mod in sys.modules.items() if any(name == p or name.startswith(p + ".") for p in packages)}
    for name in hidden:
        del sys.modules[name]
    sys.path.insert(0, str(import_root))
    importlib.invalidate_caches()
    try:
        return grimp.build_graph(*packages, cache_dir=None)
    finally:
        sys.path.remove(str(import_root))
        for name in [n for n in sys.modules if any(n == p or n.startswith(p + ".") for p in packages)]:
            del sys.modules[name]
        sys.modules.update(hidden)
        importlib.invalidate_caches()


def _has_symlinks(import_root: Path, packages: list[str]) -> bool:
    return any(
        os.path.islink(os.path.join(dirpath, name))
        for p in packages
        for dirpath, dirnames, names in os.walk(import_root / p)
        for name in [*names, *dirnames]
    )


def _mirror(src: Path, dst: Path) -> None:
    """Hardlink (or copy) a package tree, so files can be blanked without touching the original."""
    for dirpath, _, names in os.walk(src):
        target = dst / Path(dirpath).relative_to(src)
        target.mkdir(parents=True, exist_ok=True)
        for name in names:
            if name.endswith(".py") and not os.path.islink(Path(dirpath) / name):
                try:
                    os.link(Path(dirpath) / name, target / name)
                except OSError:
                    shutil.copy2(Path(dirpath) / name, target / name)


def build_graph(import_root: Path, packages: list[str]) -> grimp.ImportGraph:
    """The import graph. grimp stops at a file it can't parse (e.g. Python 2), so those are
    blanked in a throwaway mirror of the packages and the build retried."""
    error: SourceSyntaxError | None = None
    if not _has_symlinks(import_root, packages):  # symlinks could point anywhere: map a mirror without them
        try:
            return _grimp(import_root, packages)
        except SourceSyntaxError as first:
            error = first
    with tempfile.TemporaryDirectory(prefix="spec-tackle-graph-", dir=import_root.parent) as tmp:
        shadow = Path(tmp)
        for name in packages:
            _mirror(import_root / name, shadow / name)
        if error is None:
            try:
                return _grimp(shadow, packages)
            except SourceSyntaxError as first:
                error = first
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
    exclude: set[str] | None = None,
) -> list[dict]:
    """Modules outside `exclude` (default: `changed`) that directly import a changed module,
    with what they use from it."""
    repo_root = repo_root or import_root
    exclude = changed if exclude is None else exclude | changed
    targets = {m: {s.name.split(".")[0] for s in symbols.get(m, []) if s.kind != "module"} for m in changed}
    importers: dict[str, list[str]] = {}
    for module in sorted(changed & graph.modules):
        for importer in graph.find_modules_that_directly_import(module):
            if importer not in exclude:
                importers.setdefault(importer, []).append(module)
    deps = []
    for importer in sorted(importers):
        path = module_path(import_root, importer)
        try:
            if path.is_symlink():
                raise OSError("symlink")
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
