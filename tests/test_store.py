import sqlite3

import pytest

from spec_tackle.github import PRRef
from spec_tackle.store import Store, StoreError, data_dir

PR = PRRef("o", "r", 7)


@pytest.fixture
def store(tmp_path):
    s = Store.open(tmp_path / "state.db")
    yield s
    s.close()


def _new_thread(store, login="me"):
    return store.create_thread(login=login, pr=PR, path="docs/a.md", start=3, end=5, commit="abc123")


def test_default_location_follows_xdg_data_home(isolated_data_home):
    assert data_dir() == isolated_data_home / "spec-tackle"
    Store.open().close()
    assert (isolated_data_home / "spec-tackle" / "state.db").exists()


def test_default_location_is_private(isolated_data_home):
    (isolated_data_home / "spec-tackle").mkdir(parents=True, mode=0o755)
    Store.open().close()
    assert (isolated_data_home / "spec-tackle").stat().st_mode & 0o777 == 0o700


def test_thread_round_trip(store):
    thread_id = _new_thread(store)
    store.add_message(thread_id=thread_id, role="user", body="Why?")
    store.add_message(thread_id=thread_id, role="assistant", body="Because.")
    store.set_thread_context(thread_id=thread_id, anchor_text="line 3", snapshot="PR text")
    store.set_session(thread_id=thread_id, session_id="sess-1")

    t = store.thread(login="me", thread_id=thread_id)
    assert (t["owner"], t["repo"], t["number"], t["path"]) == ("o", "r", 7, "docs/a.md")
    assert (t["startLine"], t["endLine"], t["commit"]) == (3, 5, "abc123")
    assert (t["anchorText"], t["snapshot"], t["sessionId"]) == ("line 3", "PR text", "sess-1")
    assert [(m["role"], m["body"]) for m in t["messages"]] == [("user", "Why?"), ("assistant", "Because.")]


def test_new_thread_has_no_context_yet(store):
    t = store.thread(login="me", thread_id=_new_thread(store))
    assert t["anchorText"] is None and t["snapshot"] is None and t["sessionId"] is None
    assert t["messages"] == []


def test_threads_are_scoped_to_login_and_pr(store):
    mine = _new_thread(store)
    _new_thread(store, login="someone-else")
    store.create_thread(login="me", pr=PRRef("o", "r", 8), path="x.md", start=1, end=1, commit="c")

    assert [t["id"] for t in store.threads_for_pr(login="me", pr=PR)] == [mine]
    assert store.thread(login="someone-else", thread_id=mine) is None


def test_delete_cascades_to_messages(store, tmp_path):
    thread_id = _new_thread(store)
    store.add_message(thread_id=thread_id, role="user", body="q")
    assert store.delete_thread(login="someone-else", thread_id=thread_id) is False
    assert store.delete_thread(login="me", thread_id=thread_id) is True
    rows = sqlite3.connect(tmp_path / "state.db").execute("SELECT COUNT(*) FROM claude_messages").fetchone()
    assert rows == (0,)


def test_migrates_an_old_database(tmp_path):
    path = tmp_path / "old.db"
    conn = sqlite3.connect(path)
    conn.executescript(
        "CREATE TABLE recent_prs (login TEXT NOT NULL, owner TEXT NOT NULL, repo TEXT NOT NULL,"
        " number INTEGER NOT NULL, title TEXT NOT NULL, opened_at TEXT NOT NULL,"
        " PRIMARY KEY (login, owner, repo, number)); PRAGMA user_version = 1;"
    )
    conn.close()
    s = Store.open(path)
    assert s.threads_for_pr(login="me", pr=PR) == []
    s.close()
    assert sqlite3.connect(path).execute("PRAGMA user_version").fetchone() == (3,)
    s = Store.open(path)
    assert s.latest_logic_map(login="me", pr=PR) is None
    s.close()


def test_unopenable_path_raises_store_error(tmp_path):
    blocker = tmp_path / "file"
    blocker.write_text("not a directory")
    with pytest.raises(StoreError):
        Store.open(blocker / "state.db")


BLOCKS = [{"id": "a", "label": "Start", "kind": "entry", "change": "added", "next": []}]


def _save_map(store, sha="abc123", login="me", summary="Does a thing."):
    return store.save_logic_map(login=login, pr=PR, head_sha=sha, summary=summary, blocks=BLOCKS,
                                changed_lines={"app/x.py": [3, 4]})


def test_logic_map_round_trip(store):
    map_id = _save_map(store)
    saved = store.logic_map(login="me", map_id=map_id)
    assert saved["id"] == map_id and saved["headSha"] == "abc123"
    assert saved["summary"] == "Does a thing." and saved["blocks"] == BLOCKS
    assert saved["changedLines"] == {"app/x.py": [3, 4]}
    assert (saved["owner"], saved["repo"], saved["number"]) == ("o", "r", 7)
    assert store.latest_logic_map(login="me", pr=PR)["id"] == map_id


def test_regenerating_for_the_same_commit_replaces_the_map(store):
    _save_map(store, summary="First.")
    _save_map(store, summary="Second.")
    assert store.latest_logic_map(login="me", pr=PR)["summary"] == "Second."
    assert store._db.execute("SELECT COUNT(*) FROM logic_maps").fetchone()[0] == 1


def test_latest_logic_map_is_the_newest_commit(store, monkeypatch):
    from spec_tackle import store as store_module

    monkeypatch.setattr(store_module, "_now", lambda: "2026-10-08T09:00:00+00:00")
    _save_map(store, sha="old")
    monkeypatch.setattr(store_module, "_now", lambda: "2026-10-08T10:00:00+00:00")
    _save_map(store, sha="new")
    assert store.latest_logic_map(login="me", pr=PR)["headSha"] == "new"


def test_logic_maps_are_private_to_their_login(store):
    map_id = _save_map(store)
    assert store.logic_map(login="someone", map_id=map_id) is None
    assert store.latest_logic_map(login="someone", pr=PR) is None
