import textwrap

from repo_fixture import make_pr

from spec_tackle.analysis.build import build_map

BASE = {
    "shop/__init__.py": "",
    "shop/models.py": """\
        class Order:
            def total(self):
                return 1

            def save(self):
                return self.total()
        """,
    "shop/sync.py": """\
        from .models import Order


        def send(order):
            return order.total()


        def resubmit(order):
            return send(order)


        def batch(orders):
            return [resubmit(o) for o in orders]
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
        from shop.sync import resubmit


        def again(o):
            return resubmit(o)
        """,
    "shop/cart.py": """\
        class Cart:
            def save(self):
                return 2
        """,
    "tests/test_sync.py": """\
        from shop.sync import send


        def test_send():
            assert send(None)
        """,
}

HEAD = {
    **BASE,
    "shop/models.py": """\
        class Order:
            def total(self):
                return 2

            def save(self):
                return self.total()
        """,
    "shop/sync.py": """\
        from .models import Order
        from .retry import with_retry


        def send(order, retries=3):
            return with_retry(lambda: order.total(), retries)


        def batch(orders):
            return [send(o) for o in orders]


        def flush(queue):
            return queue.persist()
        """,
    "shop/retry.py": """\
        def with_retry(fn, retries):
            return fn()


        class Queue:
            def persist(self):
                return 1
        """,
    "tests/test_sync.py": """\
        from shop.sync import send


        def test_send():
            assert send(None, retries=1)
        """,
}


def changes(tmp_path, base=BASE, head=HEAD):
    files = make_pr(tmp_path, base, head)
    result = build_map(tmp_path, files)
    assert result["skipped"] == [], "fixture code must parse"
    return result["changes"]


def edges(ch):
    return {(e["from"], e["to"]): e["type"] for e in ch["edges"]}


def test_uses_through_imports_and_same_module_names(tmp_path):
    e = edges(changes(tmp_path))
    assert e[("shop/sync.py::send", "shop/retry.py::with_retry")] == "uses"
    assert e[("shop/sync.py::send", "shop/models.py::Order.total")] == "probable"  # order.total(): receiver unknown
    assert e[("shop/sync.py::batch", "shop/sync.py::send")] == "uses"


def test_self_method_calls_resolve(tmp_path):
    head = {**HEAD, "shop/models.py": HEAD["shop/models.py"].replace("return self.total()", "return self.total() + 0")}
    e = edges(changes(tmp_path, head=head))
    assert e[("shop/models.py::Order.save", "shop/models.py::Order.total")] == "uses"


def test_probable_needs_a_unique_name(tmp_path):
    # Two changed classes both define save(): obj.save() is ambiguous.
    head = {
        **HEAD,
        "shop/cart.py": "class Cart:\n    def save(self):\n        return 3\n",
        "shop/models.py": HEAD["shop/models.py"].replace("return self.total()", "return 9"),
        "shop/retry.py": textwrap.dedent(HEAD["shop/retry.py"]) + "\n\ndef go(x):\n    return x.save()\n",
    }
    e = edges(changes(tmp_path, head=head))
    assert not any(src == "shop/retry.py::go" for src, _ in e)


def test_probable_with_a_unique_method(tmp_path):
    e = edges(changes(tmp_path))
    assert e[("shop/sync.py::flush", "shop/retry.py::Queue.persist")] == "probable"


def test_an_unchanged_caller_of_a_re_signed_function_may_break(tmp_path):
    ch = changes(tmp_path)
    e = edges(ch)
    assert e[("shop/tasks.py::run", "shop/sync.py::send")] == "breaks-signature"
    assert e[("shop/views.py::view", "shop/sync.py::send")] == "breaks-signature"
    caller = next(n for n in ch["nodes"] if n["id"] == "shop/tasks.py::run")
    assert (caller["change"], caller["label"]) == ("caller", "run()")


def test_import_of_removed_symbol_breaks(tmp_path):
    e = edges(changes(tmp_path))
    assert e[("shop/admin.py::<module>", "shop/sync.py::resubmit")] == "breaks-removed"
    assert e[("shop/admin.py::again", "shop/sync.py::resubmit")] == "breaks-removed"


def test_a_removed_function_replaced_by_a_new_one(tmp_path):
    base = {**BASE, "shop/sync.py": textwrap.dedent(BASE["shop/sync.py"]) + "\n\ndef old_flush(q):\n    for item in list(q.items):\n        item.write(force=True)\n    q.items.clear()\n    return len(q.items)\n\n\ndef drain(q):\n    return old_flush(q)\n"}
    head = {**HEAD, "shop/sync.py": textwrap.dedent(HEAD["shop/sync.py"]) + "\n\ndef drain(q):\n    return flush(q)\n"}
    e = edges(changes(tmp_path, base=base, head=head))
    assert e[("shop/sync.py::old_flush", "shop/sync.py::flush")] == "replaced"


def test_tests_that_use_a_change(tmp_path):
    e = edges(changes(tmp_path))
    assert e[("tests/test_sync.py::test_send", "shop/sync.py::send")] == "tests"


def test_duplicate_edges_keep_the_most_severe(tmp_path):
    head = {**BASE, "shop/sync.py": BASE["shop/sync.py"].replace("def send(order):", "def send(order, x=1):"),
            "shop/tasks.py": "from shop.sync import send\n\n\ndef run():\n    send(None)\n    return send(None)\n"}
    ch = changes(tmp_path, head=head)
    runs = [e for e in ch["edges"] if e["from"] == "shop/tasks.py::run"]
    assert [e["type"] for e in runs] == ["uses"]  # run changed too, so it's updated code, not a caller


def test_reading_order_lists_dependencies_first_and_callers_to_check(tmp_path):
    path = changes(tmp_path)["readingPath"]
    flat = [i for group in path for i in group["ids"]]
    assert flat.index("shop/retry.py::with_retry") < flat.index("shop/sync.py::send")
    assert flat.index("shop/sync.py::send") < flat.index("shop/sync.py::batch")
    check = next(g for g in path if g["phase"] == "check")
    assert "shop/tasks.py::run" in check["ids"]
