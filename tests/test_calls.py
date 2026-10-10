from pathlib import Path
from textwrap import dedent

from spec_tackle import calls


def repo(root: Path, files: dict[str, str]) -> Path:
    for path, text in files.items():
        file = root / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(dedent(text).lstrip("\n"))
    return root


# -- index -------------------------------------------------------------------


def test_module_names_come_from_paths():
    assert calls.module_name("a/b/c.py") == "a.b.c"
    assert calls.module_name("a/b/__init__.py") == "a.b"
    assert calls.module_name("top.py") == "top"


def test_definitions_are_indexed_with_spans_and_kinds(tmp_path):
    repo(tmp_path, {"app/visits.py": '''
        import functools


        @functools.cache
        def load(visit_id):
            return visit_id


        async def sync():
            pass


        class Service:
            def save(
                self,
                visit,
            ):
                def check():
                    return visit
                return check()
    '''})
    index = calls.build_index(tmp_path)
    defs = index.modules["app/visits.py"].defs

    load = defs["load"]
    assert load.id == "app/visits.py::load" and load.kind == "function"
    assert (load.start, load.end) == (4, 6)  # from the decorator
    assert load.header == (4, 5)
    assert load.decorators == ("functools.cache",)

    assert defs["sync"].kind == "function"
    assert defs["Service"].kind == "class"

    save = defs["Service.save"]
    assert save.kind == "method" and save.parent == "app/visits.py::Service"
    assert save.header == (14, 17)  # a signature over several lines

    inner = defs["Service.save.<locals>.check"]
    assert inner.kind == "function" and inner.parent == save.id
    assert index.defs[inner.id] is inner


def test_conditional_definitions_are_indexed_and_the_first_wins(tmp_path):
    repo(tmp_path, {"m.py": '''
        try:
            def parse(x):
                return 1
        except ImportError:
            def parse(x):
                return 2
    '''})
    parse = calls.build_index(tmp_path).modules["m.py"].defs["parse"]
    assert parse.start == 2


def test_imports_are_resolved_to_dotted_names(tmp_path):
    repo(tmp_path, {
        "pkg/__init__.py": "",
        "pkg/sub/__init__.py": "",
        "pkg/sub/mod.py": '''
            import os
            import pkg.render as r
            from pkg.render import draw as d, paint
            from . import sibling
            from .. import render
            from ..render import draw
        ''',
    })
    imports = calls.build_index(tmp_path).modules["pkg/sub/mod.py"].imports
    assert imports["os"] == "os"
    assert imports["r"] == "pkg.render"
    assert imports["d"] == "pkg.render.draw"
    assert imports["paint"] == "pkg.render.paint"
    assert imports["sibling"] == "pkg.sub.sibling"
    assert imports["render"] == "pkg.render"
    assert imports["draw"] == "pkg.render.draw"


def test_relative_imports_in_a_package_init(tmp_path):
    repo(tmp_path, {"pkg/__init__.py": "from .service import save\n", "pkg/service.py": "def save(): pass\n"})
    assert calls.build_index(tmp_path).modules["pkg/__init__.py"].imports["save"] == "pkg.service.save"


def test_find_module_matches_a_suffix_of_the_path(tmp_path):
    repo(tmp_path, {
        "src/spec_tackle/__init__.py": "",
        "src/spec_tackle/render.py": "",
        "a/utils.py": "",
        "b/utils.py": "",
    })
    index = calls.build_index(tmp_path)
    assert index.find_module("spec_tackle.render").path == "src/spec_tackle/render.py"
    assert index.find_module("spec_tackle").path == "src/spec_tackle/__init__.py"
    assert index.find_module("utils") is None  # two files end that way: no guess
    assert index.find_module("a.utils").path == "a/utils.py"
    assert index.find_module("os") is None


def test_lookup_finds_a_definition_through_a_package_reexport(tmp_path):
    repo(tmp_path, {
        "pkg/__init__.py": "from .service import save\n",
        "pkg/service.py": "class Visit:\n    def save(self):\n        pass\n\ndef save():\n    pass\n",
    })
    index = calls.build_index(tmp_path)
    assert index.lookup("pkg.service.save").id == "pkg/service.py::save"
    assert index.lookup("pkg.service.Visit.save").id == "pkg/service.py::Visit.save"
    assert index.lookup("pkg.save").id == "pkg/service.py::save"
    assert index.lookup("pkg.missing") is None


def test_ignored_directories_big_files_and_syntax_errors_are_skipped(tmp_path):
    repo(tmp_path, {
        "app.py": "def ok(): pass\n",
        "node_modules/x.py": "def no(): pass\n",
        ".venv/lib/y.py": "def no(): pass\n",
        "pkg/__pycache__/z.py": "def no(): pass\n",
        "broken.py": "def (:\n",
        "big.py": "x = 1\n" * 10,
    })
    index = calls.build_index(tmp_path, max_bytes=50)
    assert set(index.modules) == {"app.py"}
    reasons = {s["path"]: s["reason"] for s in index.skipped}
    assert reasons["broken.py"] == "syntax error"
    assert reasons["big.py"] == "too large"
    assert index.truncated is False


def test_indexing_stops_at_the_file_cap(tmp_path):
    repo(tmp_path, {f"m{i}.py": "" for i in range(5)})
    index = calls.build_index(tmp_path, max_files=3)
    assert len(index.modules) == 3 and index.truncated is True


# -- resolving calls ---------------------------------------------------------


def edges(root: Path) -> set[tuple[str, str, str]]:
    return {(e.caller, e.callee, e.kind) for e in calls.resolve_edges(calls.build_index(root))}


def test_plain_names_resolve_in_the_module_and_through_imports(tmp_path):
    repo(tmp_path, {
        "app/util.py": "def clean(x):\n    return x\n",
        "app/visits.py": '''
            import os
            from app.util import clean
            from app import util
            import app.util as u


            def helper():
                return os.path.join("a", "b")


            def save():
                helper()
                clean(1)
                util.clean(2)
                u.clean(3)
                print("done")
        ''',
    })
    assert edges(tmp_path) == {
        ("app/visits.py::save", "app/visits.py::helper", "call"),
        ("app/visits.py::save", "app/util.py::clean", "call"),
    }


def test_calls_record_every_call_site_line(tmp_path):
    repo(tmp_path, {"m.py": "def a():\n    pass\n\ndef b():\n    a()\n    a()\n"})
    [edge] = calls.resolve_edges(calls.build_index(tmp_path))
    assert edge.lines == (5, 6)


def test_self_cls_and_super_resolve_through_the_class_and_its_bases(tmp_path):
    repo(tmp_path, {
        "base.py": '''
            class Base:
                def validate(self):
                    pass

                def save(self):
                    pass
        ''',
        "child.py": '''
            from base import Base


            class Child(Base):
                @classmethod
                def make(cls):
                    return cls.build()

                @classmethod
                def build(cls):
                    pass

                def save(self):
                    self.validate()
                    super().save()
        ''',
    })
    got = edges(tmp_path)
    assert ("child.py::Child.make", "child.py::Child.build", "call") in got
    assert ("child.py::Child.save", "base.py::Base.validate", "call") in got
    assert ("child.py::Child.save", "base.py::Base.save", "call") in got
    assert ("child.py::Child.save", "child.py::Child.save", "call") not in got  # super() skips the class itself


def test_instantiating_a_class_calls_its_init(tmp_path):
    repo(tmp_path, {"m.py": '''
        class Plain:
            pass


        class WithInit:
            def __init__(self):
                pass


        class Sub(WithInit):
            pass


        def make():
            Plain()
            WithInit()
            Sub()
    '''})
    got = edges(tmp_path)
    assert ("m.py::make", "m.py::Plain", "call") in got
    assert ("m.py::make", "m.py::WithInit.__init__", "call") in got
    assert ("m.py::make", "m.py::Sub", "call") not in got
    assert sum(1 for e in got if e[0] == "m.py::make" and e[1] == "m.py::WithInit.__init__") == 1


def test_functions_passed_as_values_are_references(tmp_path):
    repo(tmp_path, {"m.py": '''
        def get_user():
            pass


        def on_save():
            pass


        class Model:
            pass


        def route(depends=None):
            handlers = [on_save]
            callback = on_save
            route(depends=get_user)
            return isinstance(handlers, Model)
    '''})
    got = edges(tmp_path)
    assert ("m.py::route", "m.py::get_user", "ref") in got
    assert ("m.py::route", "m.py::on_save", "ref") in got
    assert ("m.py::route", "m.py::Model", "ref") in got
    assert ("m.py::route", "m.py::route", "call") in got  # recursion is kept


def test_a_subclass_refers_to_its_base(tmp_path):
    repo(tmp_path, {"m.py": "class A:\n    pass\n\nclass B(A):\n    pass\n"})
    assert edges(tmp_path) == {("m.py::B", "m.py::A", "ref")}


def test_a_call_and_a_reference_to_the_same_function_merge_into_one_call(tmp_path):
    repo(tmp_path, {"m.py": "def a():\n    pass\n\ndef b():\n    x = a\n    a()\n"})
    [edge] = calls.resolve_edges(calls.build_index(tmp_path))
    assert (edge.kind, edge.lines) == ("call", (5, 6))


def test_unknown_receivers_are_probable_only_when_the_method_name_is_unique(tmp_path):
    repo(tmp_path, {"m.py": '''
        class Visit:
            def submit(self):
                pass

            def save(self):
                pass

            def __len__(self):
                return 0


        class Form:
            def save(self):
                pass

            def __len__(self):
                return 0


        def handle(obj):
            obj.submit()
            obj.save()
            obj.__len__()
    '''})
    got = {e for e in edges(tmp_path) if e[0] == "m.py::handle"}
    assert got == {("m.py::handle", "m.py::Visit.submit", "probable")}


def test_star_imports_and_getattr_give_no_edge(tmp_path):
    repo(tmp_path, {
        "lib.py": "def hidden():\n    pass\n",
        "m.py": "from lib import *\n\ndef go(obj):\n    hidden()\n    getattr(obj, 'hidden')()\n",
    })
    assert edges(tmp_path) == set()


def test_calls_through_a_package_reexport_resolve(tmp_path):
    repo(tmp_path, {
        "pkg/__init__.py": "from .service import save\n",
        "pkg/service.py": "def save():\n    pass\n",
        "app.py": "from pkg import save\nimport pkg\n\ndef go():\n    save()\n    pkg.save()\n",
    })
    assert edges(tmp_path) == {("app.py::go", "pkg/service.py::save", "call")}


def test_nested_functions_are_callers_of_their_own(tmp_path):
    repo(tmp_path, {"m.py": '''
        def target():
            pass


        def outer():
            def inner():
                target()
            return inner()
    '''})
    assert edges(tmp_path) == {
        ("m.py::outer.<locals>.inner", "m.py::target", "call"),
        ("m.py::outer", "m.py::outer.<locals>.inner", "call"),
    }


# -- roots, neighbourhood, analyse -------------------------------------------


def patch(*hunks: str) -> str:
    return "\n".join(dedent(h).strip("\n") for h in hunks)


def test_changed_lines_reports_additions_and_where_lines_were_deleted():
    added, deleted = calls.changed_lines(patch("""
        @@ -1,4 +1,4 @@
         a
        -b
        +B
         c
        @@ -10,3 +10,2 @@
         x
        -y
         z
    """))
    assert added == {2}
    assert deleted == {2: ["b"], 11: ["y"]}
    assert calls.changed_lines(None) == (set(), {})


SOURCE = '''
    def untouched():
        return 1


    def body_edit(x):
        y = x
        return y


    @decorator
    def header_edit(x, y):
        return x


    def deleted_from(x):
        return x


    class Visit:
        kind = "home"

        def save(self):
            return 1


    class Form(Base):
        def submit(self):
            return 2


    def outer():
        def inner():
            return 3
        return inner()
'''


def roots_for(tmp_path, added=(), deleted=(), new_file=False):
    """`deleted` is positions (an indented statement was deleted there) or {position: rows}."""
    repo(tmp_path, {"m.py": SOURCE})
    index = calls.build_index(tmp_path)
    rows = deleted if isinstance(deleted, dict) else {p: ["        x = 1"] for p in deleted}
    return calls.roots(index, {"m.py": (set(added), rows)}, {"m.py"} if new_file else set())


def test_a_body_edit_changes_a_function(tmp_path):
    assert roots_for(tmp_path, added=[6]) == {"m.py::body_edit": {"change": "changed", "signatureChanged": False}}


def test_a_header_or_decorator_edit_changes_the_signature(tmp_path):
    for line in (10, 11):
        assert roots_for(tmp_path, added=[line]) == {"m.py::header_edit": {"change": "changed", "signatureChanged": True}}


def test_deleting_lines_inside_a_function_changes_it(tmp_path):
    assert roots_for(tmp_path, deleted=[16]) == {"m.py::deleted_from": {"change": "changed", "signatureChanged": False}}


def test_deleting_the_last_lines_of_a_function_changes_it(tmp_path):
    # Line 8 is the blank line after body_edit: the deleted rows sat at its end.
    assert roots_for(tmp_path, deleted={8: ["    log(y)"]}) == {"m.py::body_edit": {"change": "changed", "signatureChanged": False}}


def test_deleting_a_whole_function_changes_neither_neighbour(tmp_path):
    # A function removed just before header_edit's decorator, and one removed after body_edit.
    removed = ["def old():", "    pass", "", ""]
    assert roots_for(tmp_path, deleted={10: removed, 8: ["", "", *removed]}) == {}


def test_deleting_a_decorator_changes_the_signature(tmp_path):
    assert roots_for(tmp_path, deleted={11: ["@cached"]}) == {"m.py::header_edit": {"change": "changed", "signatureChanged": True}}


def test_deleting_a_method_changes_its_class(tmp_path):
    # A method removed between kind = "home" and save(): it sat where save starts.
    got = roots_for(tmp_path, deleted={22: ["    def old(self):", "        pass", ""]})
    assert got == {"m.py::Visit": {"change": "changed", "signatureChanged": False}}


def test_a_function_whose_lines_are_all_added_is_added(tmp_path):
    # A new function has no old callers to break, so its signature isn't "changed".
    assert roots_for(tmp_path, added=[5, 6, 7]) == {"m.py::body_edit": {"change": "added", "signatureChanged": False}}


def test_a_function_rewritten_line_for_line_is_changed_not_added(tmp_path):
    got = roots_for(tmp_path, added=[5, 6, 7], deleted={5: ["def body_edit(y):", "    return y"]})
    assert got == {"m.py::body_edit": {"change": "changed", "signatureChanged": True}}


def test_a_method_edit_changes_the_method_not_the_class(tmp_path):
    assert roots_for(tmp_path, added=[23]) == {"m.py::Visit.save": {"change": "changed", "signatureChanged": False}}


def test_a_class_attribute_edit_changes_the_class(tmp_path):
    assert roots_for(tmp_path, added=[20]) == {"m.py::Visit": {"change": "changed", "signatureChanged": False}}


def test_a_base_class_edit_changes_the_class_signature(tmp_path):
    assert roots_for(tmp_path, added=[26]) == {"m.py::Form": {"change": "changed", "signatureChanged": True}}


def test_a_new_file_makes_every_definition_added(tmp_path):
    got = roots_for(tmp_path, new_file=True)
    assert got["m.py::Visit"]["change"] == "added" and got["m.py::Visit.save"]["change"] == "added"
    assert got["m.py::untouched"]["change"] == "added"


def test_a_nested_function_edit_changes_the_outer_function(tmp_path):
    got = roots_for(tmp_path, added=[33])
    assert got["m.py::outer"] == {"change": "changed", "signatureChanged": False}


E = calls.Edge


def test_neighbourhood_measures_hops_up_and_down():
    edges = [E("a", "b", "call", (1,)), E("b", "root", "call", (1,)), E("root", "c", "call", (1,)), E("c", "d", "call", (1,))]
    dist, depth, cut = calls.neighbourhood(edges, {"root"}, up=1, down=3)
    assert dist == {"root": (0, 0), "b": (1, None), "c": (None, 1), "d": (None, 2)}
    assert depth == (1, 3) and cut is False


def test_neighbourhood_survives_recursion_and_cycles():
    edges = [E("root", "root", "call", (1,)), E("root", "a", "call", (1,)), E("a", "root", "call", (1,))]
    dist, _, _ = calls.neighbourhood(edges, {"root"})
    assert dist == {"root": (0, 0), "a": (1, 1)}


def test_neighbourhood_cuts_the_farthest_callees_first():
    edges = [E("up1", "root", "call", (1,)), E("up2", "up1", "call", (1,)),
             E("root", "dn1", "call", (1,)), E("dn1", "dn2", "call", (1,))]
    dist, depth, cut = calls.neighbourhood(edges, {"root"}, max_nodes=4)
    assert set(dist) == {"root", "up1", "up2", "dn1"}
    assert depth == (2, 1) and cut is True


def test_analyse_builds_the_tree_for_a_pr(tmp_path):
    repo(tmp_path, {
        "app/retry.py": '''
            def backoff(tries, base):
                return base * 2 ** tries


            def resend(form):
                return backoff(1, 2)
        ''',
        "app/forms.py": '''
            from app.retry import backoff, resend


            def send(form):
                return backoff(3, 1)


            def submit(form):
                return resend(form)
        ''',
        "tests/test_retry.py": '''
            from app.retry import backoff


            def test_backoff():
                assert backoff(1, 1) == 2
        ''',
        "docs/retry.md": "# Retry\n",
    })
    files = [
        {"filename": "app/retry.py", "status": "modified",
         "patch": "@@ -1,2 +1,2 @@\n-def backoff(tries):\n-    return 2 ** tries\n+def backoff(tries, base):\n+    return base * 2 ** tries\n"},
        {"filename": "docs/retry.md", "status": "added", "patch": "@@ -0,0 +1 @@\n+# Retry"},
        {"filename": "app/gone.py", "status": "removed", "patch": "@@ -1 +0,0 @@\n-x = 1"},
    ]
    tree = calls.analyse(tmp_path, files)
    nodes = {n["id"]: n for n in tree["nodes"]}
    assert set(nodes) == {
        "app/retry.py::backoff", "app/retry.py::resend", "app/forms.py::send", "app/forms.py::submit",
        "tests/test_retry.py::test_backoff",
    }
    backoff = nodes["app/retry.py::backoff"]
    assert backoff == {
        "id": "app/retry.py::backoff", "path": "app/retry.py", "symbol": "backoff", "start": 1, "end": 2,
        "kind": "function", "change": "changed", "signatureChanged": True, "decorators": [], "test": False,
        "up": 0, "down": 0,
    }
    assert nodes["app/forms.py::submit"]["up"] == 2 and nodes["app/forms.py::submit"]["down"] is None
    assert nodes["tests/test_retry.py::test_backoff"]["test"] is True

    edges = {(e["from"], e["to"]): e for e in tree["edges"]}
    assert edges[("app/forms.py::send", "app/retry.py::backoff")]["notUpdated"] is True
    assert edges[("app/forms.py::send", "app/retry.py::backoff")]["lines"] == [5]
    assert edges[("app/forms.py::submit", "app/retry.py::resend")]["notUpdated"] is False
    assert tree["other"] == [{"path": "docs/retry.md", "reason": "not Python"}]
    assert tree["truncated"] is None and tree["depth"] == {"up": 3, "down": 3}


def test_a_changed_caller_of_a_changed_signature_is_updated(tmp_path):
    repo(tmp_path, {"m.py": "def a(x, y):\n    pass\n\ndef b():\n    a(1, 2)\n"})
    files = [{"filename": "m.py", "status": "modified", "patch": "@@ -1,5 +1,5 @@\n-def a(x):\n+def a(x, y):\n     pass\n \n def b():\n-    a(1)\n+    a(1, 2)"}]
    [edge] = calls.analyse(tmp_path, files)["edges"]
    assert edge["notUpdated"] is False


def test_nested_functions_fold_into_their_parent(tmp_path):
    repo(tmp_path, {"m.py": "def target():\n    pass\n\ndef outer():\n    def inner():\n        target()\n    return inner()\n"})
    files = [{"filename": "m.py", "status": "modified", "patch": "@@ -6,1 +6,1 @@\n-        pass\n+        target()"}]
    tree = calls.analyse(tmp_path, files)
    assert {n["id"] for n in tree["nodes"]} == {"m.py::outer", "m.py::target"}
    assert [(e["from"], e["to"]) for e in tree["edges"]] == [("m.py::outer", "m.py::target")]


def test_module_level_changes_and_broken_files_are_listed_as_other(tmp_path):
    repo(tmp_path, {"m.py": "X = 1\n\ndef f():\n    pass\n", "broken.py": "def (:\n"})
    files = [
        {"filename": "m.py", "status": "modified", "patch": "@@ -1 +1 @@\n-X = 0\n+X = 1"},
        {"filename": "broken.py", "status": "added", "patch": "@@ -0,0 +1 @@\n+def (:"},
    ]
    tree = calls.analyse(tmp_path, files)
    assert tree["nodes"] == [] and tree["edges"] == []
    assert sorted(tree["other"], key=lambda o: o["path"]) == [
        {"path": "broken.py", "reason": "syntax error"},
        {"path": "m.py", "reason": "module level"},
    ]


def test_a_pr_without_python_changes_has_no_nodes(tmp_path):
    repo(tmp_path, {"m.py": "def f():\n    pass\n"})
    tree = calls.analyse(tmp_path, [{"filename": "a.md", "status": "added", "patch": "@@ -0,0 +1 @@\n+x"}])
    assert tree["nodes"] == [] and tree["other"] == [{"path": "a.md", "reason": "not Python"}]


def test_a_file_too_large_to_analyse_says_so(tmp_path, monkeypatch):
    monkeypatch.setattr(calls, "MAX_BYTES", 10)
    repo(tmp_path, {"big.py": "def f():\n    return 1\n"})
    tree = calls.analyse(tmp_path, [{"filename": "big.py", "status": "added", "patch": "@@ -0,0 +1 @@\n+def f():"}])
    assert tree["other"] == [{"path": "big.py", "reason": "too large"}]


def test_a_removed_function_flags_no_callers_in_analyse(tmp_path):
    repo(tmp_path, {"m.py": "def a():\n    pass\n\n\ndef b():\n    pass\n\n\ndef c():\n    b()\n"})
    files = [{"filename": "m.py", "status": "modified",
              "patch": "@@ -3,8 +3,4 @@\n \n \n-def old():\n-    pass\n-\n-\n def b():\n     pass"}]
    tree = calls.analyse(tmp_path, files)
    assert tree["nodes"] == [] and tree["edges"] == []


def test_a_stdlib_import_never_resolves_into_a_repo_package(tmp_path):
    repo(tmp_path, {
        "core/__init__.py": "",
        "core/logging.py": "def getLogger():\n    pass\n",
        "app.py": "import logging\n\ndef go():\n    logging.getLogger()\n",
    })
    assert edges(tmp_path) == set()
    assert calls.build_index(tmp_path).find_module("logging") is None


def test_one_pathological_file_is_skipped_rather_than_failing_the_tree(tmp_path):
    deep = "x = " + " + ".join(["1"] * 30000) + "\n"
    elifs = "def f(x):\n    if x == 0:\n        pass\n" + "".join(f"    elif x == {i}:\n        pass\n" for i in range(1, 3000))
    repo(tmp_path, {"deep.py": deep, "elifs.py": elifs, "ok.py": "def ok():\n    pass\n"})
    index = calls.build_index(tmp_path)
    assert "ok.py" in index.modules and "elifs.py::f" in index.defs
    assert {s["path"] for s in index.skipped} == {"deep.py"}


def test_base_classes_that_point_at_each_other_do_not_recurse_forever(tmp_path):
    repo(tmp_path, {"m.py": "class A(B.Inner):\n    def go(self):\n        self.missing()\n\nclass B(A.Inner):\n    pass\n"})
    calls.resolve_edges(calls.build_index(tmp_path))  # no RecursionError
