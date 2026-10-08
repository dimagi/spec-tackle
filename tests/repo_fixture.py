"""Small Python repos on disk for analysis tests."""

from __future__ import annotations

import textwrap
from pathlib import Path


def write_repo(root: Path, files: dict[str, str]) -> Path:
    for path, text in files.items():
        target = root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(textwrap.dedent(text))
    return root


def added_patch(text: str) -> str:
    """The patch GitHub sends for a brand-new file."""
    lines = textwrap.dedent(text).rstrip("\n").split("\n")
    return f"@@ -0,0 +1,{len(lines)} @@\n" + "\n".join(f"+{line}" for line in lines)


# A shop: models ← sync ← (tasks, views); tests use sync.
SHOP = {
    "shop/__init__.py": "",
    "shop/models.py": """\
        class Order:
            def total(self):
                return 1
        """,
    "shop/sync.py": """\
        from .models import Order


        def send(order):
            return order.total()
        """,
    "shop/tasks.py": """\
        from shop.sync import send


        def run():
            return send(None)
        """,
    "shop/views.py": """\
        from shop import sync


        def view():
            return sync.send(None)
        """,
    "shop/admin.py": """\
        from shop.views import view
        """,
    "shop/urls.py": """\
        from shop.admin import view
        """,
    "tests/test_sync.py": """\
        from shop.sync import send
        """,
}


def make_pr(root: Path, base: dict[str, str], head: dict[str, str]) -> list[dict]:
    """Write `head` as the checkout and return the PR's files (with patches) against `base`."""
    import difflib

    write_repo(root, head)
    files = []
    for path in sorted(set(base) | set(head)):
        old = textwrap.dedent(base[path]) if path in base else ""
        new = textwrap.dedent(head[path]) if path in head else ""
        if old == new:
            continue
        diff = list(difflib.unified_diff(old.splitlines(), new.splitlines(), lineterm="", n=3))[2:]
        status = "added" if path not in base else "removed" if path not in head else "modified"
        files.append({
            "path": path, "status": status, "patch": "\n".join(diff),
            "additions": sum(1 for d in diff if d.startswith("+")),
            "deletions": sum(1 for d in diff if d.startswith("-")),
        })
    return files
