import textwrap

import pytest

from spec_tackle.analysis.patches import base_text, changed_lines
from spec_tackle.analysis.symbols import changed_symbols

BASE = textwrap.dedent('''\
    import os


    def keep(a):
        return a


    def edit(a):
        return a + 1


    def gone():
        pass


    class Model:
        size = 1

        def save(self):
            return 1
    ''')

HEAD = textwrap.dedent('''\
    import os
    import sys


    def keep(a):
        return a


    def edit(a):
        return a + 2


    @cached
    def fresh(x, y):
        return x


    class Model:
        size = 2

        def save(self, force=False):
            return 1
    ''')

PATCH = """@@ -1,4 +1,5 @@
 import os
+import sys
 
 
 def keep(a):
@@ -8,13 +9,14 @@ def keep(a):
 def edit(a):
-    return a + 1
+    return a + 2
 
 
-def gone():
-    pass
+@cached
+def fresh(x, y):
+    return x
 
 
 class Model:
-    size = 1
+    size = 2
 
-    def save(self):
+    def save(self, force=False):
         return 1
"""


def test_base_text_reverses_the_patch():
    assert base_text(HEAD, PATCH, "modified") == BASE


def test_added_file_has_an_empty_base():
    assert base_text("x = 1\n", "@@ -0,0 +1 @@\n+x = 1", "added") == ""


def test_missing_patch_has_no_base():
    assert base_text(HEAD, None, "modified") is None


def test_changed_lines_are_numbered_on_each_side():
    added, removed = changed_lines(PATCH)
    assert 2 in added and 10 in added
    assert 9 in removed and 12 in removed


def symbols():
    added, removed = changed_lines(PATCH)
    return {s.name: s for s in changed_symbols(BASE, HEAD, added, removed)}


def test_a_body_edit_is_modified_without_a_signature_change():
    s = symbols()["edit"]
    assert (s.kind, s.change, s.signature_changed) == ("function", "modified", False)


def test_new_and_deleted_functions():
    s = symbols()
    assert s["fresh"].change == "added"
    assert s["gone"].change == "removed"


def test_a_new_parameter_changes_the_method_signature():
    s = symbols()["Model.save"]
    assert (s.kind, s.change, s.signature_changed) == ("method", "modified", True)


def test_class_attributes_are_their_own_symbols():
    s = symbols()["Model.size"]
    assert (s.kind, s.change) == ("attribute", "modified")


def test_import_changes_are_module_level():
    s = symbols()["<module>"]
    assert (s.kind, s.change) == ("module", "modified")


def test_a_new_decorator_changes_the_signature():
    base = "def f(x):\n    return x\n"
    head = "@retry\ndef f(x):\n    return x\n"
    [s] = changed_symbols(base, head, {1}, set())
    assert s.signature_changed is True


def test_without_a_base_nothing_is_removed_or_re_signed():
    added, removed = changed_lines(PATCH)
    s = {x.name: x for x in changed_symbols(None, HEAD, added, removed)}
    assert "gone" not in s
    assert s["Model.save"].signature_changed is False


def test_unparseable_head_raises():
    with pytest.raises(SyntaxError):
        changed_symbols("", "def (:\n", {1}, set())


def test_form_feeds_dont_shift_line_numbers():
    base = "import os\n\x0c\n\ndef f(a):\n    return a\n\n\ndef g():\n    return 1\n"
    head = "import os\n\x0c\n\ndef f(a, b):\n    return a\n\n\ndef g():\n    return 1\n"
    patch = "@@ -1,7 +1,7 @@\n import os\n \x0c\n \n-def f(a):\n+def f(a, b):\n     return a\n \n "
    assert base_text(head, patch, "modified") == base
    assert changed_lines(patch) == ({4}, {4})
