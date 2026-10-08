from spec_tackle.analysis.graph import build_graph, find_packages, hop1, indirect, module_name
from spec_tackle.analysis.reading import phase_for, reading_order, tag_for
from spec_tackle.analysis.symbols import Symbol
from repo_fixture import SHOP, write_repo


def test_phase_rules_in_precedence_order():
    assert phase_for("tests/models.py") == "tests"
    assert phase_for("shop/test_sync.py") == "tests"
    assert phase_for("shop/conftest.py") == "tests"
    assert phase_for("shop/models.py") == "data"
    assert phase_for("shop/models/order.py") == "data"
    assert phase_for("shop/migrations/0001_initial.py") == "data"
    assert phase_for("shop/views.py") == "edges"
    assert phase_for("shop/api/orders.py") == "edges"
    assert phase_for("shop/management/commands/sync.py") == "edges"
    assert phase_for("shop/sync.py") == "core"
    assert phase_for("README.md") == "other"


def test_tags():
    sym = lambda **kw: Symbol(**{"name": "f", "kind": "function", "change": "modified", "signature_changed": False, "lines": (1, 2), **kw})
    file = {"status": "modified", "additions": 30, "deletions": 0}
    assert tag_for(file, "data", []) == "contract"
    assert tag_for(file, "core", [sym(signature_changed=True)]) == "contract"
    assert tag_for(file, "core", [sym(change="removed")]) == "contract"
    assert tag_for({**file, "status": "added"}, "core", []) == "new"
    assert tag_for(file, "tests", []) == "test"
    assert tag_for({**file, "additions": 3, "deletions": 2}, "core", []) == "small"
    assert tag_for(file, "core", [sym()]) is None


def test_find_packages_at_root_and_under_src(tmp_path):
    write_repo(tmp_path / "a", {"pkg/__init__.py": "", "docs/x.md": ""})
    write_repo(tmp_path / "b", {"src/lib/__init__.py": ""})
    assert find_packages(tmp_path / "a") == (tmp_path / "a", ["pkg"])
    assert find_packages(tmp_path / "b") == (tmp_path / "b" / "src", ["lib"])
    assert find_packages(tmp_path / "none") == (tmp_path / "none", [])


def test_module_names():
    assert module_name("shop/sync.py") == "shop.sync"
    assert module_name("shop/__init__.py") == "shop"
    assert module_name("src/lib/a.py", prefix="src") == "lib.a"
    assert module_name("README.md") is None


def test_hop1_lists_unchanged_direct_importers_with_references(tmp_path):
    root = write_repo(tmp_path, SHOP)
    graph = build_graph(root, ["shop"])
    syms = {"shop.sync": [Symbol("send", "function", "modified", True, (4, 5))]}

    deps = {d["module"]: d for d in hop1(graph, {"shop.sync"}, root, syms)}

    assert set(deps) == {"shop.tasks", "shop.views"}
    assert deps["shop.tasks"]["references"] == ["send"]
    assert deps["shop.views"]["references"] == ["send"]  # via sync.send
    assert deps["shop.tasks"]["path"] == "shop/tasks.py"


def test_relative_imports_resolve(tmp_path):
    root = write_repo(tmp_path, SHOP)
    graph = build_graph(root, ["shop"])
    syms = {"shop.models": [Symbol("Order", "class", "modified", False, (1, 3))]}

    deps = hop1(graph, {"shop.models"}, root, syms)

    assert [(d["module"], d["references"]) for d in deps] == [("shop.sync", ["Order"])]


def test_indirect_skips_hop0_and_hop1(tmp_path):
    graph = build_graph(write_repo(tmp_path, SHOP), ["shop"])
    assert indirect(graph, {"shop.views"}, exclude={"shop.sync", "shop.views"}) == {"shop.views": ["shop.admin", "shop.urls"]}


def test_reading_order_puts_dependencies_first(tmp_path):
    graph = build_graph(write_repo(tmp_path, SHOP), ["shop"])
    files = [{"path": p, "module": module_name(p)} for p in ["shop/views.py", "shop/sync.py", "shop/models.py", "README.md", "shop/tasks.py"]]

    order = reading_order(files, graph)

    assert order == [
        {"phase": "data", "files": ["shop/models.py"]},
        {"phase": "core", "files": ["shop/sync.py"]},
        {"phase": "edges", "files": ["shop/tasks.py", "shop/views.py"]},
        {"phase": "other", "files": ["README.md"]},
    ]


def test_reading_order_survives_a_cycle(tmp_path):
    root = write_repo(tmp_path, {
        "c/__init__.py": "",
        "c/a.py": "from c import b\n",
        "c/b.py": "from c import a\n",
        "c/base.py": "",
        "c/z.py": "from c import base\n",
    })
    graph = build_graph(root, ["c"])
    files = [{"path": p, "module": module_name(p)} for p in ["c/z.py", "c/b.py", "c/a.py", "c/base.py"]]

    [core] = reading_order(files, graph)

    assert core["files"].index("c/base.py") < core["files"].index("c/z.py")
    assert sorted(core["files"]) == ["c/a.py", "c/b.py", "c/base.py", "c/z.py"]


def test_reading_order_without_a_graph_uses_paths():
    files = [{"path": "b.py", "module": "b"}, {"path": "a.py", "module": "a"}]
    assert reading_order(files, None) == [{"phase": "core", "files": ["a.py", "b.py"]}]


def test_graph_survives_unparseable_files_without_touching_the_checkout(tmp_path):
    root = write_repo(tmp_path, {**SHOP, "shop/py2.py": "print 'hi'\n"})

    graph = build_graph(root, ["shop"])

    assert "shop.sync" in graph.modules
    assert (root / "shop" / "py2.py").read_text() == "print 'hi'\n"


def test_graph_survives_several_unparseable_files(tmp_path):
    root = write_repo(tmp_path, {**SHOP, "shop/py2.py": "print 'hi'\n", "shop/py2b.py": "exec 'x'\n"})
    assert "shop.sync" in build_graph(root, ["shop"]).modules
