from repo_fixture import SHOP, added_patch, write_repo

from spec_tackle.analysis.build import build_map

SYNC_PATCH = """@@ -1,5 +1,5 @@
 from .models import Order
 
 
-def send(order):
+def send(order, retries=3):
     return order.total()"""


def shop_files():
    return [
        {"path": "shop/sync.py", "status": "modified", "additions": 1, "deletions": 1, "patch": SYNC_PATCH},
        {"path": "shop/models.py", "status": "added", "additions": 3, "deletions": 0, "patch": added_patch(SHOP["shop/models.py"])},
        {"path": "README.md", "status": "modified", "additions": 2, "deletions": 0, "patch": "@@ -1 +1,3 @@\n x\n+y\n+z"},
    ]


# The checkout is the PR's head, so sync.py has the new signature.
HEAD_SHOP = {**SHOP, "shop/sync.py": SHOP["shop/sync.py"].replace("def send(order):", "def send(order, retries=3):")}


def node(result, path):
    return next(n for n in result["nodes"] if n["id"] == path)


def test_a_full_map(tmp_path):
    root = write_repo(tmp_path, HEAD_SHOP)

    result = build_map(root, shop_files())

    assert result["status"] == "ready"
    assert result["limits"] == {"importGraph": True, "graphTruncated": False, "baseMissing": False}
    sync = node(result, "shop/sync.py")
    assert (sync["hop"], sync["phase"], sync["tag"]) == (0, "core", "contract")
    assert sync["symbols"] == [{"name": "send", "kind": "function", "change": "modified", "signatureChanged": True}]
    assert node(result, "shop/models.py")["tag"] == "contract"  # data phase
    assert node(result, "README.md")["phase"] == "other"

    tasks = node(result, "shop/tasks.py")
    assert (tasks["hop"], tasks["references"], tasks["imports"]) == (1, ["send"], ["shop/sync.py"])
    views = node(result, "shop/views.py")
    assert (views["indirectCount"], views["indirect"]) == (2, ["shop/admin.py", "shop/urls.py"])

    edges = {(e["from"], e["to"]): e["symbols"] for e in result["edges"]}
    assert edges[("shop/sync.py", "shop/models.py")] == ["Order"]
    assert edges[("shop/tasks.py", "shop/sync.py")] == ["send"]

    assert result["readingPath"] == [
        {"phase": "data", "files": ["shop/models.py"]},
        {"phase": "core", "files": ["shop/sync.py"]},
        {"phase": "other", "files": ["README.md"]},
    ]


def test_no_packages_is_partial(tmp_path):
    root = write_repo(tmp_path, {"docs/a.md": "x\n"})

    result = build_map(root, [{"path": "docs/a.md", "status": "modified", "additions": 1, "deletions": 0, "patch": "@@ -1 +1 @@\n-y\n+x"}])

    assert result["status"] == "ready"
    assert result["limits"]["importGraph"] is False
    assert result["readingPath"] == [{"phase": "other", "files": ["docs/a.md"]}]
    assert result["edges"] == []


def test_the_graph_can_be_switched_off(tmp_path, monkeypatch):
    monkeypatch.setenv("SPEC_TACKLE_NO_GRAPH", "1")
    result = build_map(write_repo(tmp_path, SHOP), shop_files())
    assert result["limits"]["importGraph"] is False
    assert all(n["hop"] == 0 for n in result["nodes"])


def test_syntax_errors_are_skipped_but_still_listed(tmp_path):
    root = write_repo(tmp_path, {**SHOP, "shop/broken.py": "def (:\n"})
    files = [{"path": "shop/broken.py", "status": "added", "additions": 1, "deletions": 0, "patch": added_patch("def (:\n")}]

    result = build_map(root, files)

    assert result["skipped"] == [{"path": "shop/broken.py", "reason": "syntax error"}]
    assert result["limits"]["importGraph"] is True  # the rest of the package still maps
    assert result["readingPath"] == [{"phase": "core", "files": ["shop/broken.py"]}]


def test_a_file_without_a_patch_marks_the_base_missing(tmp_path):
    files = [{**shop_files()[0], "patch": None}]
    result = build_map(write_repo(tmp_path, SHOP), files)
    assert result["limits"]["baseMissing"] is True
    assert node(result, "shop/sync.py")["symbols"] == []


def test_big_prs_draw_only_the_largest_files(tmp_path):
    files = {f"big/m{i}.py": "x = 1\n" for i in range(160)}
    root = write_repo(tmp_path, {"big/__init__.py": "", **files})
    pr = [{"path": p, "status": "added", "additions": i + 1, "deletions": 0, "patch": added_patch("x = 1\n")} for i, p in enumerate(files)]

    result = build_map(root, pr)

    drawn = [n for n in result["nodes"] if n["inGraph"]]
    assert result["limits"]["graphTruncated"] is True
    assert len(drawn) == 40
    assert min(n["additions"] for n in drawn) == 121
    assert sum(len(p["files"]) for p in result["readingPath"]) == 160


def test_a_pure_rename_has_nothing_missing(tmp_path):
    root = write_repo(tmp_path, {**SHOP, "shop/orders.py": SHOP["shop/models.py"]})
    files = [{"path": "shop/orders.py", "status": "renamed", "additions": 0, "deletions": 0, "patch": None}]
    result = build_map(root, files)
    assert result["limits"]["baseMissing"] is False
    assert node(result, "shop/orders.py")["symbols"] == []


def test_other_files_are_not_drawn(tmp_path):
    result = build_map(write_repo(tmp_path, HEAD_SHOP), shop_files())
    assert node(result, "README.md")["inGraph"] is False
    assert node(result, "shop/sync.py")["inGraph"] is True


def test_truncated_prs_never_list_a_changed_file_as_a_dependent(tmp_path):
    files = {f"big/m{i}.py": "x = 1\n" for i in range(160)}
    files["big/small.py"] = "from big import m159\n"
    root = write_repo(tmp_path, {"big/__init__.py": "", **files})
    pr = [{"path": p, "status": "added", "additions": i + 1, "deletions": 0, "patch": added_patch(t)} for i, (p, t) in enumerate(files.items())]
    pr[-1]["additions"] = 1  # small.py is too small to be drawn, but it imports a drawn module

    result = build_map(root, pr)

    ids = [n["id"] for n in result["nodes"]]
    assert len(ids) == len(set(ids))


def test_symlinked_files_are_not_read(tmp_path):
    root = write_repo(tmp_path, SHOP)
    (root / "shop" / "evil.py").symlink_to("/dev/zero")
    files = [{"path": "shop/evil.py", "status": "added", "additions": 1, "deletions": 0, "patch": "@@ -0,0 +1 @@\n+x"}]
    result = build_map(root, files)  # must return, not hang on /dev/zero
    assert result["status"] == "ready"
