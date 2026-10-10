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
    assert reasons["broken.py"].startswith("syntax error")
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
