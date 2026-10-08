"""The change graph: one node per changed symbol, and how the changes connect."""

from __future__ import annotations

import ast
import difflib
import re
from pathlib import Path

from .symbols import MODULE, Symbol

MOVE_SIMILARITY = 0.8
MIN_MOVE_BODY = 40  # characters: shorter bodies ("pass", "return self.x") match anything
MOVE_COMPARISONS = 20_000  # full similarity checks per PR, at most
CHANGES_LIMIT = 400  # above this many changes the graph isn't built (the Files view still is)
IMPORTER_SCAN_LIMIT = 500  # unchanged modules scanned for callers


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
        unreadable = path.endswith(".py") and not f["symbols"] and (f["head_src"] is None or f["base_src"] is None) \
            and f["status"] != "added"
        if not path.endswith(".py") or unreadable:  # one node for the whole file
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


def _tokens(body: str) -> list[str]:
    return re.findall(r"\w+|[^\w\s]", body)


def _merge_moves(nodes: list[dict], bodies: dict[str, str]) -> list[dict]:
    """An added symbol whose body matches a removed one is that symbol, moved or renamed.

    Bodies are compared as token lists, cheapest checks first, with a cap on full comparisons
    so a big refactor can't stall the map.
    """
    usable = {i: b for i, b in bodies.items() if len(b) >= MIN_MOVE_BODY}
    removed = [n for n in nodes if n["change"] == "removed" and n["id"] in usable]
    added = [n for n in nodes if n["change"] == "added" and n["id"] in usable]
    tokens = {n["id"]: _tokens(usable[n["id"]]) for n in removed + added}
    pairs = []
    exact = {}
    for r in removed:
        exact.setdefault((r["kind"], usable[r["id"]]), r["id"])
    budget = MOVE_COMPARISONS
    for a in added:
        same = exact.get((a["kind"], usable[a["id"]]))
        if same:
            pairs.append((1.0, a["id"], same))
            continue
        ta = tokens[a["id"]]
        for r in removed:
            tr = tokens[r["id"]]
            if a["kind"] != r["kind"] or 2 * min(len(ta), len(tr)) / (len(ta) + len(tr)) < MOVE_SIMILARITY:
                continue
            matcher = difflib.SequenceMatcher(None, tr, ta, autojunk=False)
            if matcher.real_quick_ratio() < MOVE_SIMILARITY or matcher.quick_ratio() < MOVE_SIMILARITY:
                continue
            if budget <= 0:
                break
            budget -= 1
            ratio = matcher.ratio()
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


# -- edges --------------------------------------------------------------------

SEVERITY = {"breaks-removed": 5, "breaks-signature": 4, "uses": 3, "probable": 2, "tests": 1, "replaced": 0}


class _Scope:
    """What names mean inside one module: its imports and its own top-level definitions."""

    def __init__(self, tree: ast.Module, module: str, is_package: bool, known_modules: set[str]):
        self.module = module
        self.aliases: dict[str, str] = {}  # local name → module
        self.imported: dict[str, tuple[str, str]] = {}  # local name → (module, name)
        self.own = {n.name for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))}
        self.own |= {t.id for n in tree.body if isinstance(n, ast.Assign) for t in n.targets if isinstance(t, ast.Name)}
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for a in node.names:
                    self.aliases[a.asname or a.name.split(".")[0]] = a.name if a.asname else a.name.split(".")[0]
            elif isinstance(node, ast.ImportFrom):
                base = _resolve(module, is_package, node)
                for a in node.names:
                    local = a.asname or a.name
                    if f"{base}.{a.name}" in known_modules:
                        self.aliases[local] = f"{base}.{a.name}"
                    else:
                        self.imported[local] = (base, a.name)

    def resolve(self, expr: ast.expr, cls: str | None) -> list[tuple[str, str]]:
        """Candidate (module, qualname) targets for a Name or Attribute."""
        if isinstance(expr, ast.Name):
            if expr.id in self.imported:
                return [self.imported[expr.id]]
            if expr.id in self.own:
                return [(self.module, expr.id)]
            return []
        if not isinstance(expr, ast.Attribute):
            return []
        parts = _dotted(expr)
        if not parts:
            return []
        root, rest = parts[0], parts[1:]
        if root in ("self", "cls") and cls:
            return [(self.module, f"{cls}.{rest[0]}")]
        if root in self.aliases:
            module = self.aliases[root]
            out = []
            for i in range(len(rest)):  # a.b.c.f → module a.b.c, name f (longest module wins)
                mod = ".".join([module, *rest[:i]])
                out.append((mod, rest[i]))
                if i + 1 < len(rest):
                    out.append((mod, f"{rest[i]}.{rest[i + 1]}"))
            return out
        if root in self.imported:  # SomeClass.method
            mod, name = self.imported[root]
            return [(mod, f"{name}.{rest[0]}")]
        if root in self.own:
            return [(self.module, f"{root}.{rest[0]}")]
        return []

    def receiver_unknown(self, expr: ast.Attribute) -> bool:
        parts = _dotted(expr)
        if not parts:
            return True
        return parts[0] not in ("self", "cls") and parts[0] not in self.aliases and parts[0] not in self.imported and parts[0] not in self.own


def _resolve(importer: str, is_package: bool, node: ast.ImportFrom) -> str:
    if not node.level:
        return node.module or ""
    parts = importer.split(".")
    package = parts if is_package else parts[:-1]
    package = package[: len(package) - (node.level - 1)]
    return ".".join(package + ([node.module] if node.module else []))


def _dotted(expr: ast.expr) -> list[str] | None:
    parts = []
    while isinstance(expr, ast.Attribute):
        parts.append(expr.attr)
        expr = expr.value
    if not isinstance(expr, ast.Name):
        return None
    return [expr.id, *reversed(parts)]


def _units(tree: ast.Module) -> list[tuple[str, list[ast.AST], str | None]]:
    """(qualname, statements, enclosing class) for every function, method, class attribute
    and the module-level code of a file."""
    units: list[tuple[str, list[ast.AST], str | None]] = []
    module_level: list[ast.AST] = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            units.append((node.name, [node], None))
        elif isinstance(node, ast.ClassDef):
            for item in node.body:
                if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    units.append((f"{node.name}.{item.name}", [item], node.name))
                elif isinstance(item, (ast.Assign, ast.AnnAssign)):
                    targets = item.targets if isinstance(item, ast.Assign) else [item.target]
                    for t in targets:
                        if isinstance(t, ast.Name):
                            units.append((f"{node.name}.{t.id}", [item], node.name))
        else:
            module_level.append(node)
    units.append((MODULE, module_level, None))
    return units


def _references(scope: _Scope, statements: list[ast.AST], cls: str | None):
    """Yield (kind, payload, line): ("ref", [(module, qual)…]), ("import", (module, name)) or ("method", name)."""
    for stmt in statements:
        for node in ast.walk(stmt):
            if isinstance(node, ast.ImportFrom):
                for a in node.names:
                    local = a.asname or a.name
                    if local in scope.imported:
                        yield "import", scope.imported[local], node.lineno
            elif isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and scope.receiver_unknown(node.func):
                yield "method", node.func.attr, node.lineno
            elif isinstance(node, (ast.Name, ast.Attribute)) and not isinstance(getattr(node, "ctx", None), ast.Store):
                found = scope.resolve(node, cls)
                if found:
                    yield "ref", found, node.lineno


def change_graph(prepared: list[dict], nodes: list[dict], graph, import_root, worktree, module_of) -> dict:
    """Edges between changes, unchanged callers, and the order to read the changes in.

    `prepared` are the PR's files as passed to change_nodes; `module_of` maps paths to modules.
    """
    from .graph import module_name, module_path
    from .reading import PHASES, _dependency_order, phase_for

    prefix = import_root.relative_to(worktree).as_posix() if import_root != worktree else ""
    count = sum(1 for n in nodes if n["change"] != "caller")
    if count > CHANGES_LIMIT:
        return {"nodes": [], "edges": [], "readingPath": [], "tooMany": count}

    by_id = {n["id"]: n for n in nodes}
    path_of_module = {m: p for p, m in module_of.items() if m}
    live: dict[tuple[str, str], str] = {}  # (module, qualname) → node id, as the code is now
    gone: dict[tuple[str, str], str] = {}  # (module, old qualname) → node id of what was removed or moved
    methods: dict[str, list[str]] = {}
    for n in nodes:
        module = module_of.get(n["file"])
        if not module or n["kind"] in ("file", "module"):
            continue
        if n["change"] == "removed":
            gone[(module, n["name"])] = n["id"]
        else:
            live[(module, n["name"])] = n["id"]
            if n["kind"] == "method":
                methods.setdefault(n["name"].split(".")[-1], []).append(n["id"])
        if n["change"] == "moved":
            gone[(module_of.get(n["from"]["file"]) or "", n["from"]["name"])] = n["id"]
    # A renamed file's symbols are all gone from the old module name.
    for f in prepared:
        old = f.get("previous_path")
        old_module = old and module_name(old, prefix)
        if old_module:
            for n in nodes:
                if n["file"] == f["path"] and n.get("name") and n["kind"] not in ("file", "module"):
                    gone.setdefault((old_module, n["name"]), n["id"])
    gone_modules = {m for m, _ in gone}
    known = (set(graph.modules) if graph is not None else set(path_of_module)) | gone_modules

    # Names a PR module still binds (a re-export after a move) aren't gone.
    for f in prepared:
        module = module_of.get(f["path"])
        if not module or not f["head_src"]:
            continue
        try:
            scope = _Scope(ast.parse(f["head_src"]), module, f["path"].endswith("__init__.py"), known)
        except SyntaxError:
            continue
        for name in list(scope.imported) + list(scope.own):
            if (module, name) in gone:
                target = scope.imported.get(name)
                if target in live:
                    live[(module, name)] = live[target]
                del gone[(module, name)]

    edges: dict[tuple[str, str], dict] = {}
    callers: dict[str, dict] = {}

    def add(src: str, dst: str, kind: str, line: int) -> None:
        if src == dst:
            return
        key = (src, dst)
        if key not in edges or SEVERITY[kind] > SEVERITY[edges[key]["type"]]:
            edges[key] = {"from": src, "to": dst, "type": kind, "line": line}

    def scan(path: str, module: str, source: str) -> None:
        try:
            tree = ast.parse(source)
        except SyntaxError:
            return
        scope = _Scope(tree, module, path.endswith("__init__.py"), known)
        testing = phase_for(path) == "tests"
        for qual, statements, cls in _units(tree):
            unit_id = f"{path}::{qual}"
            changed = unit_id in by_id and by_id[unit_id]["change"] != "removed"
            for kind, payload, line in _references(scope, statements, cls):
                target, broken = None, False
                if kind == "method":
                    found = methods.get(payload, [])
                    if len(found) == 1:
                        target = found[0]
                elif kind == "import":
                    if payload in gone and payload not in live:
                        target, broken = gone[payload], True
                else:
                    for cand in payload:
                        if cand in live:
                            target = live[cand]
                            break
                        if cand in gone:
                            target, broken = gone[cand], True
                            break
                if target is None or target == unit_id:
                    continue
                if kind == "method" and not changed:
                    continue  # a guess about unchanged code would add callers for every d.get(...)
                if kind == "method":
                    edge = "probable"
                elif broken:  # even in a test: it will fail
                    edge = "breaks-removed"
                elif testing:
                    edge = "tests"
                elif not changed and by_id[target]["signatureChanged"]:
                    edge = "breaks-signature"
                else:
                    edge = "uses"
                if not changed:
                    callers.setdefault(unit_id, {
                        "id": unit_id, "file": path, "label": "module-level" if qual == MODULE else (
                            f"{qual}()" if not any(isinstance(s, ast.Assign) for s in statements) else qual),
                        "kind": "caller", "change": "caller", "signatureChanged": False,
                        "additions": 0, "deletions": 0, "lines": None, "baseLines": None, "name": qual,
                    })
                add(unit_id, target, edge, line)

    # The PR's own files, then unchanged modules that import a changed one.
    for f in prepared:
        module = module_of.get(f["path"])
        if module and f["head_src"]:
            scan(f["path"], module, f["head_src"])
    pr_paths = {f["path"] for f in prepared}
    to_scan: dict[str, Path] = {}
    if graph is not None:
        changed_modules = {module_of[f["path"]] for f in prepared if module_of.get(f["path"])} & set(graph.modules)
        for m in changed_modules:
            for importer in graph.find_modules_that_directly_import(m):
                if importer not in changed_modules:
                    to_scan[importer] = module_path(import_root, importer)
    # Deleted or renamed modules aren't in the head graph: find who still names them in the text.
    missing = gone_modules - (set(graph.modules) if graph is not None else set())
    if missing:
        needles = {m.rsplit(".", 1)[-1] for m in missing}
        for path in sorted(import_root.rglob("*.py")):
            rel = path.relative_to(worktree).as_posix()
            if rel in pr_paths or path.is_symlink() or not path.is_file():
                continue
            text = _read_text(path)
            if any(needle in text for needle in needles):
                to_scan.setdefault(module_name(rel, prefix) or rel, path)
    truncated = len(to_scan) > IMPORTER_SCAN_LIMIT
    for m in sorted(to_scan)[:IMPORTER_SCAN_LIMIT]:
        path = to_scan[m]
        rel = path.relative_to(worktree).as_posix()
        if rel in pr_paths or path.is_symlink():
            continue
        source = _read_text(path)
        if source:
            scan(rel, module_name(rel, prefix) or m, source)

    _replacements(prepared, by_id, module_of, known, live, gone, add)

    ids = [n["id"] for n in nodes]
    deps = {i: set() for i in ids}
    for e in edges.values():
        if e["type"] in ("uses", "probable") and e["from"] in deps and e["to"] in deps:
            deps[e["from"]].add(e["to"])
    ordered = _dependency_order(ids, deps)
    phase = {n["id"]: phase_for(n["file"]) for n in nodes}
    reading = [{"phase": p, "ids": [i for i in ordered if phase[i] == p]} for p in PHASES if p in phase.values()]
    if callers:
        reading.append({"phase": "check", "ids": sorted(callers)})
    result = {"nodes": nodes + list(callers.values()), "edges": list(edges.values()), "readingPath": reading}
    if truncated:
        result["callersTruncated"] = True
    return result


def _read_text(path) -> str:
    try:
        return "" if path.is_symlink() else path.read_text()
    except (OSError, UnicodeDecodeError):
        return ""


def _replacements(prepared, by_id, module_of, known, live, gone, add) -> None:
    """A removed symbol whose former users now use a newly added one: "replaced by?"."""
    for f in prepared:
        module = module_of.get(f["path"])
        if not module or not f["head_src"] or not f["base_src"]:
            continue
        try:
            head, base = ast.parse(f["head_src"]), ast.parse(f["base_src"])
        except SyntaxError:
            continue
        is_pkg = f["path"].endswith("__init__.py")
        head_scope, base_scope = _Scope(head, module, is_pkg, known), _Scope(base, module, is_pkg, known)
        base_units = {q: (s, c) for q, s, c in _units(base)}
        for qual, statements, cls in _units(head):
            node = by_id.get(f"{f['path']}::{qual}")
            if not node or node["change"] != "modified" or qual not in base_units:
                continue
            was = {gone[c] for k, p, _ in _references(base_scope, *base_units[qual]) if k == "ref" for c in p if c in gone}
            now = {live[c] for k, p, _ in _references(head_scope, statements, cls) if k == "ref" for c in p
                   if c in live and by_id[live[c]]["change"] == "added"}
            for r in was:
                if by_id[r]["change"] == "removed":
                    for a in now:
                        add(r, a, "replaced", 0)
