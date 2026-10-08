import textwrap

from spec_tackle.analysis.changes import change_nodes
from spec_tackle.analysis.patches import changed_lines
from spec_tackle.analysis.symbols import changed_symbols

BODY = """\
    total = 0
    for item in items:
        total += item.price * item.qty
    return round(total, 2)
"""


def file(path, base, head, status="modified"):
    """A PR file entry as build_map prepares it, with lines diffed by difflib."""
    import difflib

    base, head = textwrap.dedent(base), textwrap.dedent(head)
    diff = list(difflib.unified_diff(base.splitlines(), head.splitlines(), lineterm="", n=3))[2:]
    patch = "\n".join(diff)
    added, removed = changed_lines(patch)
    return {
        "path": path, "status": status, "head_src": head, "base_src": base,
        "added": added, "removed": removed, "symbols": changed_symbols(base, head, added, removed),
    }


def by_label(nodes):
    return {n["label"]: n for n in nodes}


def test_nodes_for_functions_methods_attributes_and_module_code():
    base = "import os\n\nclass Model:\n    size = 1\n\n    def save(self):\n        return 1\n"
    head = "import os\nimport sys\n\nclass Model:\n    size = 2\n\n    def save(self, force=False):\n        return 1\n\ndef helper():\n    return 2\n"

    nodes = by_label(change_nodes([file("app/models.py", base, head)]))

    assert set(nodes) == {"module-level", "Model.size", "Model.save()", "helper()"}
    assert nodes["Model.save()"]["signatureChanged"] is True
    assert nodes["helper()"]["change"] == "added"
    assert nodes["Model.size"]["kind"] == "attribute"
    assert nodes["helper()"]["id"] == "app/models.py::helper"


def test_counts_come_from_the_lines_inside_each_symbol():
    base = "def a():\n    return 1\n\ndef b():\n    return 2\n"
    head = "def a():\n    x = 1\n    return x\n\ndef b():\n    return 2\n"

    a = by_label(change_nodes([file("m.py", base, head)]))["a()"]

    assert (a["additions"], a["deletions"]) == (2, 1)
    assert a["lines"] == [1, 3]


def test_rename_is_one_moved_node():
    base = f"def total(items):\n{BODY}"
    head = f"def order_total(items):\n{BODY}"

    nodes = change_nodes([file("shop/cart.py", base, head)])

    assert len(nodes) == 1
    [n] = nodes
    assert (n["label"], n["change"]) == ("order_total()", "moved")
    assert n["from"] == {"file": "shop/cart.py", "name": "total"}


def test_a_move_across_files_keeps_where_it_came_from():
    nodes = change_nodes([
        file("shop/cart.py", f"def total(items):\n{BODY}", ""),
        file("shop/pricing.py", "", f"def total(items):\n{BODY}", status="added"),
    ])

    [n] = nodes
    assert (n["file"], n["change"], n["from"]) == ("shop/pricing.py", "moved", {"file": "shop/cart.py", "name": "total"})


def test_a_rewrite_stays_removed_plus_added():
    other = "    return sum(i.price for i in items)\n"
    nodes = by_label(change_nodes([file("c.py", f"def total(items):\n{BODY}", f"def subtotal(items):\n{other}")]))

    assert nodes["total()"]["change"] == "removed"
    assert nodes["subtotal()"]["change"] == "added"


def test_non_python_files_are_one_node():
    [n] = change_nodes([{"path": "README.md", "status": "modified", "head_src": None, "base_src": None,
                         "added": {1}, "removed": set(), "symbols": []}])
    assert (n["label"], n["kind"], n["id"]) == ("README.md", "file", "README.md::")
