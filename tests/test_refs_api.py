import json
import time

from spec_tackle import refs
from spec_tackle.github import PRRef

REFS = "/api/pr/o/r/7/refs"
PATH = "docs/a.md"
# FakeCheckouts writes docs/a.md as "one\ntwo\nthree\nfour\n", and app/codes.py.
FOUND = [
    {"line": 3, "text": "three", "targetStart": 1, "targetEnd": 1, "note": "One"},
    {"line": 4, "text": "nowhere", "targetStart": 1, "targetEnd": 1},
    {"line": 2, "text": "two", "targetPath": "app/codes.py", "targetStart": 2, "targetEnd": 3, "note": "RETRY"},
    {"line": 1, "text": "one", "targetPath": "docs/b.md", "targetStart": 1, "targetEnd": 1},
]
GOOD = f"```json\n{json.dumps({'refs': FOUND})}\n```"


def _get(client, head="abc1234", path=PATH):
    return client.get(REFS, params={"path": path, "head": head}).json()


def _events(client, head="abc1234"):
    with client.stream("GET", f"{REFS}/events", params={"path": PATH, "head": head}) as response:
        return [json.loads(line[6:]) for line in response.iter_lines() if line.startswith("data: ")]


def _wait(client, head="abc1234", path=PATH):
    for _ in range(200):
        state = _get(client, head, path)
        if not state["running"]:
            return state
        time.sleep(0.02)
    raise AssertionError("run never finished")


def test_unavailable_without_claude(web_app):
    assert web_app.get(REFS, params={"path": PATH}).json()["available"] is False


def test_nothing_generated_yet(claude_app):
    assert _get(claude_app) == {"available": True, "refs": None, "stale": False, "running": False, "error": None}


def test_generate_reads_the_checkout_and_stores_the_refs_that_check_out(claude_app):
    claude_app.fake_ask.answers = [GOOD]
    started = claude_app.post(REFS, json={"path": PATH, "head": "abc1234"}).json()
    assert started["running"] is True

    events = _events(claude_app)
    assert events[0] == {"type": "tool", "text": "Cloning o/r…"}
    assert {"type": "tool", "text": f"Reading {PATH}…"} in events
    assert {"type": "tool", "text": "Reading docs/a.md"} in events  # Claude's own tool use
    assert events[-1]["type"] == "done"

    state = _wait(claude_app)
    assert state["stale"] is False
    assert state["refs"]["headSha"] == "abc1234" and state["refs"]["path"] == PATH
    assert state["refs"]["refs"] == [
        {"line": 2, "text": "two", "targetPath": "app/codes.py", "targetStart": 2, "targetEnd": 3,
         "note": "RETRY", "changed": [], "inDiff": False},
        {"line": 3, "text": "three", "targetPath": None, "targetStart": 1, "targetEnd": 1, "note": "One"},
    ]

    [call] = claude_app.fake_ask.calls
    assert call["system"] == refs.REFS_SYSTEM_PROMPT and "tools" not in call  # the default read-only tools
    assert call["cwd"].name == "abc1234"
    assert "3| three" in call["snapshot"] and call["question"] == refs.REFS_REQUEST


def _generated(client):
    client.fake_ask.answers = [GOOD]
    client.post(REFS, json={"path": PATH, "head": "abc1234"})
    return _wait(client)["refs"]["id"]


def test_the_target_of_a_ref_to_a_code_file(claude_app):
    refs_id = _generated(claude_app)
    body = claude_app.get(f"/api/refs/{refs_id}/0/target").json()
    assert body["kind"] == "code" and body["path"] == "app/codes.py"
    assert (body["start"], body["end"], body["truncated"]) == (2, 3, False)
    assert [line["n"] for line in body["lines"]] == [2, 3]
    assert "4012" in body["lines"][0]["html"]
    assert body["githubUrl"] == "https://github.com/o/r/blob/abc1234/app/codes.py#L2-L3"


def test_the_target_of_a_ref_to_a_markdown_file(claude_app):
    refs_id = claude_app.app.state.store.save_doc_refs(
        login="me", pr=PRRef("o", "r", 7), path="docs/b.md", head_sha="abc1234",
        refs=[{"line": 1, "text": "one", "targetPath": "docs/a.md", "targetStart": 2, "targetEnd": 3, "note": ""}],
    )
    body = claude_app.get(f"/api/refs/{refs_id}/0/target").json()
    assert body["kind"] == "markdown"
    assert "two" in body["html"] and "three" in body["html"] and "four" not in body["html"]


def test_a_file_missing_from_the_checkout_fails_the_run(claude_app):
    claude_app.post(REFS, json={"path": "docs/other.md", "head": "abc1234"})
    state = _wait(claude_app, path="docs/other.md")
    assert state["error"] == "docs/other.md isn't in the checkout at abc1234."
    assert claude_app.fake_ask.calls == []


def test_same_file_refs_and_unknown_ids_have_no_target(claude_app):
    refs_id = _generated(claude_app)
    assert claude_app.get(f"/api/refs/{refs_id}/1/target").status_code == 404
    assert claude_app.get(f"/api/refs/{refs_id}/9/target").status_code == 404
    assert claude_app.get("/api/refs/nope/0/target").status_code == 404


def _found_at_old_commit(client):
    client.fake_ask.answers = [GOOD]
    client.post(REFS, json={"path": PATH, "head": "abc1234"})
    _wait(client)


def test_refs_carry_over_to_a_commit_that_changed_nothing_they_use(claude_app):
    _found_at_old_commit(claude_app)
    state = _get(claude_app, head="def5678")
    assert state["stale"] is False
    carried = state["refs"]
    assert (carried["headSha"], carried["basedOn"], carried["pending"], carried["outdated"]) == (
        "def5678", "abc1234", [], 0)
    assert [r["line"] for r in carried["refs"]] == [2, 3]
    assert len(claude_app.fake_ask.calls) == 1  # no Claude call to carry them


def test_changed_lines_drop_their_refs_and_are_left_to_check(claude_app):
    _found_at_old_commit(claude_app)
    # A line added at the top, and "three" (a ref's own line) changed.
    claude_app.app.state.checkouts.files["def5678"] = {"docs/a.md": "zero\none\ntwo\nthree!\nfour\n"}
    carried = _get(claude_app, head="def5678")["refs"]
    assert [(r["line"], r["text"]) for r in carried["refs"]] == [(3, "two")]
    assert carried["pending"] == [1, 4] and carried["outdated"] == 1


def test_a_ref_whose_target_changed_is_dropped_and_its_line_checked_again(claude_app):
    _found_at_old_commit(claude_app)
    claude_app.app.state.checkouts.files["def5678"] = {"app/codes.py": "OK = 0\nRETRY = 5000\nGIVE_UP = 4013\n"}
    carried = _get(claude_app, head="def5678")["refs"]
    assert [r["text"] for r in carried["refs"]] == ["three"]
    assert carried["pending"] == [2] and carried["outdated"] == 1


def test_a_target_that_moved_moves_with_it(claude_app):
    _found_at_old_commit(claude_app)
    claude_app.app.state.checkouts.files["def5678"] = {"app/codes.py": "# codes\nOK = 0\nRETRY = 4012\nGIVE_UP = 4013\n"}
    carried = _get(claude_app, head="def5678")["refs"]
    elsewhere = next(r for r in carried["refs"] if r["targetPath"])
    assert (elsewhere["targetStart"], elsewhere["targetEnd"]) == (3, 4)


def test_checking_changed_lines_asks_only_about_them_and_merges(claude_app):
    _found_at_old_commit(claude_app)
    claude_app.app.state.checkouts.files["def5678"] = {"docs/a.md": "zero\none\ntwo\nthree!\nfour\n"}
    _get(claude_app, head="def5678")
    new = [
        {"line": 4, "text": "three", "targetStart": 1, "targetEnd": 1, "note": "Zero"},
        {"line": 5, "text": "four", "targetStart": 1, "targetEnd": 1},  # not a pending line: dropped
    ]
    claude_app.fake_ask.answers = [f"```json\n{json.dumps({'refs': new})}\n```"]
    claude_app.post(REFS, json={"path": PATH, "head": "def5678", "scope": "changed"})
    state = _wait(claude_app, head="def5678")
    assert [(r["line"], r["text"]) for r in state["refs"]["refs"]] == [(3, "two"), (4, "three")]
    assert state["refs"]["pending"] == [] and state["refs"]["outdated"] == 0
    question = claude_app.fake_ask.calls[-1]["question"]
    assert question == refs.partial_request([1, 4]) and "1, 4" in question


def test_a_full_search_replaces_a_carried_set(claude_app):
    _found_at_old_commit(claude_app)
    _get(claude_app, head="def5678")
    claude_app.fake_ask.answers = ['```json\n{"refs": []}\n```']
    claude_app.post(REFS, json={"path": PATH, "head": "def5678"})
    state = _wait(claude_app, head="def5678")
    assert state["refs"]["refs"] == [] and state["refs"]["basedOn"] is None
    assert claude_app.fake_ask.calls[-1]["question"] == refs.REFS_REQUEST


def test_refs_from_a_commit_that_is_gone_stay_stale(claude_app):
    _found_at_old_commit(claude_app)
    claude_app.app.state.checkouts.gone = {"abc1234"}
    state = _get(claude_app, head="def5678")
    assert state["stale"] is True and state["refs"]["headSha"] == "abc1234"


def test_a_failed_fetch_is_an_error_and_the_carry_is_tried_again(claude_app):
    _found_at_old_commit(claude_app)
    claude_app.app.state.checkouts.offline = True
    state = _get(claude_app, head="def5678")
    assert state["error"] == "Couldn't fetch the repository: network down"
    assert state["refs"]["headSha"] == "abc1234"
    claude_app.app.state.checkouts.offline = False
    state = _get(claude_app, head="def5678")
    assert (state["error"], state["stale"], state["refs"]["headSha"]) == (None, False, "def5678")


def test_an_unreadable_answer_gets_one_repair_turn(claude_app):
    claude_app.fake_ask.answers = ["Sorry, no JSON.", GOOD]
    claude_app.post(REFS, json={"path": PATH, "head": "abc1234"})
    events = _events(claude_app)
    assert {"type": "tool", "text": "Fixing the answer…"} in events
    assert events[-1]["type"] == "done"
    second = claude_app.fake_ask.calls[1]
    assert second["session_id"] == "sess-1" and "couldn't be read" in second["question"]
    assert "Sorry, no JSON." in second["full_prompt"]


def test_two_unreadable_answers_end_in_an_error(claude_app):
    claude_app.fake_ask.answers = ["nope", "still nope"]
    claude_app.post(REFS, json={"path": PATH, "head": "abc1234"})
    assert _events(claude_app)[-1]["type"] == "error"
    state = _wait(claude_app)
    assert state["refs"] is None and state["error"].startswith("Claude's answer couldn't be read")


def test_a_second_click_joins_the_running_one(claude_app):
    claude_app.fake_ask.answers = [GOOD]
    claude_app.fake_ask.delay = 0.3
    claude_app.post(REFS, json={"path": PATH, "head": "abc1234"})
    assert claude_app.post(REFS, json={"path": PATH, "head": "abc1234"}).json()["running"] is True
    _wait(claude_app)
    assert len(claude_app.fake_ask.calls) == 1


def test_only_markdown_files(claude_app):
    response = claude_app.post(REFS, json={"path": "app.py", "head": "abc1234"})
    assert response.status_code == 400


def test_at_most_two_files_are_searched_at_once(claude_app):
    claude_app.fake_ask.answers = [GOOD] * 3
    claude_app.fake_ask.delay = 0.3
    for head in ("aaa1111", "bbb2222", "ccc3333"):
        claude_app.post(REFS, json={"path": PATH, "head": head})
    events = _events(claude_app, head="ccc3333")
    assert events[0] == {"type": "tool", "text": "Queued behind other files…"}
    assert events[-1]["type"] == "done"
