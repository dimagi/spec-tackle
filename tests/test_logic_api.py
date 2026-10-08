import json
import time

from spec_tackle import logic
from spec_tackle.app import app

LOGIC = "/api/pr/o/r/7/logic"
MAP = {
    "summary": "Adds a spec.",
    "blocks": [
        {"id": "start", "label": "Read the spec", "kind": "entry", "change": "added", "next": [{"to": "body"}]},
        {"id": "body", "label": "Body", "kind": "step", "change": "added", "next": [],
         "children": [{"id": "leaf", "label": "Lines two and three", "kind": "step", "change": "added", "next": [],
                       "functions": [{"path": "docs/a.md", "symbol": "body", "start": 2, "end": 3}]}]},
    ],
}
GOOD = f"Here is the map.\n```json\n{json.dumps(MAP)}\n```"
BAD = '```json\n{"summary": "", "blocks": []}\n```'


def _events(client, head="abc1234"):
    with client.stream("GET", f"{LOGIC}/events", params={"head": head}) as response:
        assert response.headers["content-type"].startswith("text/event-stream")
        return [json.loads(line[6:]) for line in response.iter_lines() if line.startswith("data: ")]


def _wait(client, head="abc1234"):
    for _ in range(200):
        state = client.get(LOGIC, params={"head": head}).json()
        if not state["running"]:
            return state
        time.sleep(0.02)
    raise AssertionError("run never finished")


def test_nothing_generated_yet(claude_app):
    assert claude_app.get(LOGIC, params={"head": "abc1234"}).json() == {
        "available": True, "map": None, "stale": False, "running": False,
    }


def test_generate_streams_progress_and_stores_the_map(claude_app):
    claude_app.fake_ask.answers = [GOOD]
    started = claude_app.post(LOGIC).json()
    assert started["running"] is True and started["head"] == "abc1234"

    events = _events(claude_app)
    assert events[0] == {"type": "tool", "text": "Cloning o/r…"}
    assert {"type": "tool", "text": "Reading docs/a.md"} in events
    assert events[-1]["type"] == "done" and events[-1]["mapId"]

    state = _wait(claude_app)
    assert state["stale"] is False and state["running"] is False
    assert state["map"]["id"] == events[-1]["mapId"]
    assert state["map"]["summary"] == "Adds a spec." and state["map"]["headSha"] == "abc1234"
    assert state["map"]["blocks"][1]["children"][0]["functions"][0]["path"] == "docs/a.md"

    [call] = claude_app.fake_ask.calls
    assert call["system"] == logic.LOGIC_SYSTEM_PROMPT
    assert call["question"] == logic.LOGIC_REQUEST and call["session_id"] is None
    assert call["cwd"].name == "abc1234" and "Desc" in call["snapshot"]


def test_a_map_for_an_older_head_is_stale(claude_app):
    claude_app.fake_ask.answers = [GOOD]
    claude_app.post(LOGIC)
    _wait(claude_app)
    state = claude_app.get(LOGIC, params={"head": "def5678"}).json()
    assert state["stale"] is True and state["map"]["headSha"] == "abc1234"


def test_an_invalid_answer_gets_one_repair_turn(claude_app):
    claude_app.fake_ask.answers = [BAD, GOOD]
    claude_app.post(LOGIC)
    events = _events(claude_app)
    assert {"type": "tool", "text": "Fixing the map…"} in events
    assert events[-1]["type"] == "done"

    first, second = claude_app.fake_ask.calls
    assert second["session_id"] == "sess-1"
    assert "didn't pass validation" in second["question"]
    assert "summary: must be a non-empty string" in second["question"]
    assert BAD in second["full_prompt"]  # a replay, if the session expired, still sees the first answer


def test_two_invalid_answers_end_in_an_error(claude_app):
    claude_app.fake_ask.answers = [BAD, BAD]
    claude_app.post(LOGIC)
    events = _events(claude_app)
    assert events[-1]["type"] == "error"
    assert events[-1]["text"].startswith("Claude's map didn't pass validation:")
    assert _wait(claude_app)["map"] is None
    assert len(claude_app.fake_ask.calls) == 2


def test_a_second_generate_joins_the_running_one(claude_app):
    claude_app.fake_ask.answers = [GOOD]
    claude_app.fake_ask.delay = 0.3
    claude_app.post(LOGIC)
    assert claude_app.post(LOGIC).json()["running"] is True
    _wait(claude_app)
    assert len(claude_app.fake_ask.calls) == 1


def _generated(client):
    client.fake_ask.answers = [GOOD]
    client.post(LOGIC)
    return _wait(client)["map"]["id"]


def test_functions_of_a_leaf_with_changed_lines(claude_app):
    map_id = _generated(claude_app)
    body = claude_app.get(f"/api/logic/{map_id}/blocks/leaf/functions").json()
    assert body["label"] == "Lines two and three" and body["headSha"] == "abc1234"
    [fn] = body["functions"]
    assert (fn["path"], fn["symbol"], fn["start"], fn["end"], fn["inDiff"]) == ("docs/a.md", "body", 2, 3, True)
    assert [(l["n"], l["changed"]) for l in fn["lines"]] == [(2, True), (3, True)]
    assert "two" in fn["lines"][0]["html"]


def test_functions_refuses_unknown_blocks_parents_and_other_logins(claude_app):
    map_id = _generated(claude_app)
    assert claude_app.get(f"/api/logic/{map_id}/blocks/nope/functions").status_code == 404
    assert claude_app.get(f"/api/logic/{map_id}/blocks/body/functions").status_code == 404
    app.state.session.login_name = "someone-else"
    assert claude_app.get(f"/api/logic/{map_id}/blocks/leaf/functions").status_code == 404
    assert claude_app.get(LOGIC, params={"head": "abc1234"}).json()["map"] is None


def test_without_claude_the_view_is_unavailable(web_app):
    assert web_app.get(LOGIC, params={"head": "abc1234"}).json()["available"] is False
    assert web_app.post(LOGIC).status_code == 404


def test_signed_out_says_so(claude_app):
    app.state.session.signed_in = False
    for response in (claude_app.get(LOGIC, params={"head": "x"}), claude_app.post(LOGIC)):
        assert response.status_code == 401
        assert response.json()["signedOut"] is True
