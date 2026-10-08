"""Regression tests from the change graph's final review."""

import time

from repo_fixture import make_pr

from spec_tackle.analysis.build import build_map
from spec_tackle.analysis.changes import change_nodes

PKG = {"pkg/__init__.py": ""}


def changes(tmp_path, base, head):
    result = build_map(tmp_path, make_pr(tmp_path, base, head))
    return result["changes"]


def edges(ch):
    return {(e["from"], e["to"]): e["type"] for e in ch["edges"]}


def test_a_deleted_module_breaks_its_importers(tmp_path):
    base = {**PKG, "pkg/old.py": "def f():\n    return 1\n", "pkg/b.py": "from pkg.old import f\n\n\ndef g():\n    return f()\n"}
    head = {k: v for k, v in base.items() if k != "pkg/old.py"}
    e = edges(changes(tmp_path, base, head))
    assert e[("pkg/b.py::g", "pkg/old.py::f")] == "breaks-removed"


def test_a_renamed_module_breaks_importers_of_the_old_name(tmp_path):
    base = {**PKG, "pkg/old.py": "def f():\n    total = 0\n    for i in range(10):\n        total += i * i\n    return total\n",
            "pkg/b.py": "from pkg import old\n\n\ndef g():\n    return old.f()\n"}
    head = {**PKG, "pkg/new.py": base["pkg/old.py"], "pkg/b.py": base["pkg/b.py"]}
    ch = changes(tmp_path, base, head)
    assert ("pkg/b.py::g", "pkg/new.py::f") in edges(ch)
    assert edges(ch)[("pkg/b.py::g", "pkg/new.py::f")] == "breaks-removed"


def test_a_move_that_is_re_exported_still_works(tmp_path):
    body = "def f(items):\n    total = 0\n    for item in items:\n        total += item.price\n    return total\n"
    base = {**PKG, "pkg/a.py": body, "pkg/b.py": "", "pkg/c.py": "from pkg.a import f\n\n\ndef g(x):\n    return f(x)\n"}
    head = {**base, "pkg/a.py": "from pkg.b import f  # noqa: F401\n", "pkg/b.py": body}
    e = edges(changes(tmp_path, base, head))
    assert "breaks-removed" not in e.values()


def test_a_test_that_uses_removed_code_is_flagged_red(tmp_path):
    base = {**PKG, "pkg/a.py": "def old():\n    return 1\n\n\ndef keep():\n    return 2\n",
            "pkg/tests/__init__.py": "", "pkg/tests/test_a.py": "from pkg.a import old\n\n\ndef test_old():\n    assert old()\n"}
    head = {**base, "pkg/a.py": "def keep():\n    return 2\n"}
    e = edges(changes(tmp_path, base, head))
    assert e[("pkg/tests/test_a.py::test_old", "pkg/a.py::old")] == "breaks-removed"


def test_unparseable_and_patchless_python_files_still_appear(tmp_path):
    base = {**PKG, "pkg/a.py": "x = 1\n"}
    head = {**PKG, "pkg/a.py": "def (:\n"}
    files = make_pr(tmp_path, base, head)
    ch = build_map(tmp_path, files)["changes"]
    assert [n["kind"] for n in ch["nodes"] if n["file"] == "pkg/a.py"] == ["file"]

    files[0]["patch"] = None
    (tmp_path / "pkg/a.py").write_text("y = 2\n")
    ch = build_map(tmp_path, files)["changes"]
    assert [n["kind"] for n in ch["nodes"] if n["file"] == "pkg/a.py"] == ["file"]


def test_tiny_bodies_are_never_called_moves(tmp_path):
    base = {**PKG, "pkg/a.py": "def close():\n    pass\n"}
    head = {**PKG, "pkg/a.py": "def open_all(paths, mode):\n    pass\n"}
    kinds = {n["label"]: n["change"] for n in changes(tmp_path, base, head)["nodes"]}
    assert kinds == {"close()": "removed", "open_all()": "added"}


def test_move_detection_is_fast_on_big_refactors():
    def entry(path, status, prefix, n):
        src = "".join(f"def {prefix}{i}(x):\n" + "".join(f"    v{j} = x * {i} + {j}\n" for j in range(30)) + "    return v0\n\n" for i in range(n))
        from spec_tackle.analysis.patches import changed_lines  # noqa: F401
        from spec_tackle.analysis.symbols import changed_symbols
        lines = set(range(1, src.count("\n") + 1))
        syms = changed_symbols("" if status == "added" else src, src if status == "added" else "", lines if status == "added" else set(), lines if status == "removed" else set())
        return {"path": path, "status": status, "head_src": src if status == "added" else "", "base_src": "" if status == "added" else src,
                "added": lines if status == "added" else set(), "removed": lines if status == "removed" else set(), "symbols": syms}

    files = [entry("old.py", "removed", "a", 200), entry("new.py", "added", "b", 200)]
    start = time.monotonic()
    change_nodes(files)
    assert time.monotonic() - start < 5


def test_probable_calls_from_unchanged_code_add_no_callers(tmp_path):
    base = {**PKG, "pkg/repo.py": "class Repo:\n    def get(self, k):\n        return k\n",
            "pkg/b.py": "from pkg import repo\n\n\ndef f(d):\n    return d.get(1)\n"}
    head = {**base, "pkg/repo.py": "class Repo:\n    def get(self, k, default=None):\n        return k\n"}
    ch = changes(tmp_path, base, head)
    assert not any(n["change"] == "caller" for n in ch["nodes"])


def test_too_many_changes_skips_the_graph(tmp_path, monkeypatch):
    monkeypatch.setattr("spec_tackle.analysis.changes.CHANGES_LIMIT", 3)
    base = {**PKG, "pkg/a.py": ""}
    head = {**PKG, "pkg/a.py": "".join(f"def f{i}():\n    return {i}\n\n" for i in range(5))}
    ch = changes(tmp_path, base, head)
    assert ch["tooMany"] == 6  # five functions plus the module-level blank lines between them
    assert ch["nodes"] == [] and ch["edges"] == []


def test_symlinked_importers_are_not_read(tmp_path):
    base = {**PKG, "pkg/a.py": "def f():\n    return 1\n"}
    head = {**PKG, "pkg/a.py": "def f(x):\n    return 1\n"}
    files = make_pr(tmp_path, base, head)
    (tmp_path / "pkg" / "evil.py").symlink_to("/dev/zero")
    assert build_map(tmp_path, files)["status"] == "ready"  # returns instead of hanging
