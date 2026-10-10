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
