# tests/test_walkthrough_api.py
import asyncio
import json
import subprocess
import time

import pytest

from spec_tackle import claude, walkthrough
from spec_tackle.app import app
from spec_tackle.github import PRRef
from spec_tackle.turns import Busy

BLOCKS = [
    {"id": "send", "label": "Form is sent", "kind": "entry", "change": "unchanged", "next": [{"to": "retry"}]},
    {"id": "retry", "label": "Retry failures", "kind": "loop", "change": "added",
     "next": [{"to": "give-up", "label": "5 tries"}],
     "children": [{"id": "backoff", "label": "Back off and resend", "kind": "step", "change": "added", "next": []}]},
    {"id": "give-up", "label": "Give up", "kind": "exit", "change": "added", "next": []},
]
INPUTS = [{"name": "form", "description": "The submitted form", "value": {"id": 7}}]
STEPS = [
    {"blockId": "send", "input": {"form": {"id": 7}}, "output": {"sent": False}, "note": "The first send fails."},
    {"blockId": "backoff", "input": {"tries": 1}, "output": {"tries": 5}, "note": "Retries five times.",
     "assumed": ["The server stays down"]},
    {"blockId": "give-up", "input": {"tries": 5}, "output": {"status": "failed"}, "note": "Gives up.",
     "danger": [{"kind": "destructive", "note": "Deletes the queued form (app/retry.py:9)"}]},
]
OUTCOME = {"kind": "exit", "message": "Reached exit: Give up"}
PROPOSED = f"```json\n{json.dumps({'inputs': INPUTS, 'steps': STEPS, 'outcome': OUTCOME})}\n```"
FIXED = f"```json\n{json.dumps({'steps': STEPS[:1], 'outcome': {'kind': 'stopped', 'message': 'Unclear'}})}\n```"
BAD = '```json\n{"steps": []}\n```'


@pytest.fixture
def walk(claude_app):
    """The client, plus a stored map at commit old0000 (older than the PR's head, abc1234)."""
    map_id = app.state.store.save_logic_map(login="me", pr=PRRef("o", "r", 7), head_sha="old0000",
                                            summary="Retries.", blocks=BLOCKS, changed_lines={})
    claude_app.map_id = map_id
    claude_app.url = f"/api/logic/{map_id}/walkthrough"
    return claude_app


def _events(client, entry="send"):
    with client.stream("GET", f"{client.url}/events", params={"entry": entry}) as response:
        return [json.loads(line[6:]) for line in response.iter_lines() if line.startswith("data: ")]


def _wait(client, entry="send"):
    for _ in range(200):
        state = client.get(client.url, params={"entry": entry}).json()
        if not state["running"]:
            return state
        time.sleep(0.02)
    raise AssertionError("run never finished")


def _propose(client):
    client.fake_ask.answers = [PROPOSED]
    client.post(client.url, json={"entry": "send"})
    return _wait(client)


# -- never executing code -------------------------------------------------------


def test_walkthrough_sessions_are_read_only(tmp_path):
    pytest.importorskip("claude_agent_sdk")
    options = claude._options(cli="/bin/claude", cwd=tmp_path, resume=None, system=walkthrough.WALK_SYSTEM_PROMPT)
    assert options.tools == ["Read", "Grep", "Glob"] == options.allowed_tools
    assert options.strict_mcp_config is True and options.mcp_servers == {}
    [guard] = options.hooks["PreToolUse"][0].hooks
    for tool in ("Bash", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch", "Task", "mcp__github__create_issue"):
        decision = asyncio.run(guard({"tool_name": tool, "tool_input": {}, "cwd": str(tmp_path)}, None, None))
        assert decision["hookSpecificOutput"]["permissionDecision"] == "deny", tool


def test_a_run_goes_through_claude_ask_and_starts_no_process(walk, monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("the walkthrough must not start a process")

    for module, name in ((asyncio, "create_subprocess_exec"), (asyncio, "create_subprocess_shell"),
                         (subprocess, "Popen"), (subprocess, "run")):
        monkeypatch.setattr(module, name, forbidden)
    walk.fake_ask.answers = [PROPOSED]
    walk.post(walk.url, json={"entry": "send"})
    assert _events(walk)[-1]["type"] == "done"
    [call] = walk.fake_ask.calls
    assert call["system"] == walkthrough.WALK_SYSTEM_PROMPT


# -- runs --------------------------------------------------------------------------


def test_nothing_yet(walk):
    assert walk.get(walk.url, params={"entry": "send"}).json() == {
        "trace": None, "starting": None, "running": False, "error": None,
    }


def test_a_proposing_run_stores_the_starting_trace(walk):
    walk.fake_ask.answers = [PROPOSED]
    started = walk.post(walk.url, json={"entry": "send"}).json()
    assert started["running"] is True
    events = _events(walk)
    assert {"type": "tool", "text": "Reading docs/a.md"} in events
    assert events[-1]["type"] == "done" and events[-1]["traceId"]

    state = _wait(walk)
    assert state["starting"] == INPUTS and state["error"] is None
    trace = state["trace"]
    assert trace["proposed"] is True and trace["entryId"] == "send" and trace["mapId"] == walk.map_id
    assert trace["steps"][2]["danger"][0]["kind"] == "destructive"
    assert walk.get(f"/api/logic/traces/{trace['id']}").json() == trace

    [call] = walk.fake_ask.calls
    assert call["cwd"].name == "old0000"  # the map's commit, not the PR's head
    assert "Propose realistic inputs" in call["question"] and json.dumps(BLOCKS) in call["question"]


def test_a_fixed_input_run_stores_the_given_inputs(walk):
    _propose(walk)
    walk.fake_ask.answers = [FIXED]
    started = walk.post(walk.url, json={"entry": "send", "inputs": {"form": {"id": "<b>8</b>"}}}).json()
    assert started["running"] is True
    state = _wait(walk)
    assert state["trace"]["inputs"] == [{"name": "form", "description": "The submitted form", "value": {"id": "<b>8</b>"}}]
    assert state["trace"]["proposed"] is False and state["starting"] == INPUTS
    assert '"<b>8</b>"' in walk.fake_ask.calls[-1]["question"]


def test_values_already_traced_come_back_from_the_cache(walk):
    first = _propose(walk)["trace"]
    walk.fake_ask.answers = [FIXED]
    walk.post(walk.url, json={"entry": "send", "inputs": {"form": {"id": 8}}})
    _wait(walk)
    calls = len(walk.fake_ask.calls)
    again = walk.post(walk.url, json={"entry": "send", "inputs": {"form": {"id": 7}}}).json()
    assert again["running"] is False and again["trace"]["id"] == first["id"]
    assert len(walk.fake_ask.calls) == calls
    assert walk.get(walk.url, params={"entry": "send"}).json()["trace"]["id"] == first["id"]


def test_key_order_doesnt_matter_for_the_cache(walk):
    walk.fake_ask.answers = [f"```json\n{json.dumps({'inputs': [{'name': 'form', 'description': 'd', 'value': {'a': 1, 'b': 2}}], 'steps': STEPS, 'outcome': OUTCOME})}\n```"]
    walk.post(walk.url, json={"entry": "send"})
    first = _wait(walk)["trace"]
    hit = walk.post(walk.url, json={"entry": "send", "inputs": {"form": {"b": 2, "a": 1}}}).json()
    assert hit["running"] is False and hit["trace"]["id"] == first["id"]


def test_input_names_must_match_the_starting_inputs(walk):
    assert walk.post(walk.url, json={"entry": "send", "inputs": {"form": 1}}).status_code == 400  # nothing proposed yet
    _propose(walk)
    for inputs in ({"other": 1}, {"form": 1, "extra": 2}, {}):
        assert walk.post(walk.url, json={"entry": "send", "inputs": inputs}).status_code == 400


def test_an_invalid_answer_gets_one_repair_turn(walk):
    walk.fake_ask.answers = [BAD, PROPOSED]
    walk.post(walk.url, json={"entry": "send"})
    events = _events(walk)
    assert {"type": "tool", "text": "Fixing the trace…"} in events and events[-1]["type"] == "done"
    second = walk.fake_ask.calls[1]
    assert second["session_id"] == "sess-1" and "didn't pass validation" in second["question"]
    assert BAD in second["full_prompt"]


def test_two_invalid_answers_end_in_an_error(walk):
    walk.fake_ask.answers = [BAD, BAD]
    walk.post(walk.url, json={"entry": "send"})
    assert _events(walk)[-1]["text"].startswith("Claude's walkthrough didn't pass validation:")
    state = _wait(walk)
    assert state["trace"] is None and state["error"].startswith("Claude's walkthrough didn't pass validation:")


def test_a_second_post_joins_the_running_one(walk):
    walk.fake_ask.answers = [PROPOSED]
    walk.fake_ask.delay = 0.3
    walk.post(walk.url, json={"entry": "send"})
    assert walk.post(walk.url, json={"entry": "send"}).json()["running"] is True
    _wait(walk)
    assert len(walk.fake_ask.calls) == 1


def test_a_failed_fixed_run_is_cleared_by_posting_cached_values(walk):
    first = _propose(walk)["trace"]
    walk.fake_ask.answers = [BAD, BAD, BAD, BAD]
    for _ in range(2):
        walk.post(walk.url, json={"entry": "send", "inputs": {"form": {"id": 8}}})
        assert _wait(walk)["error"].startswith("Claude's walkthrough didn't pass validation:")
    back = walk.post(walk.url, json={"entry": "send", "inputs": {"form": {"id": 7}}}).json()
    assert back["trace"]["id"] == first["id"] and back["error"] is None
    assert walk.get(walk.url, params={"entry": "send"}).json()["error"] is None


def test_a_proposing_cache_hit_clears_an_old_error(walk):
    _propose(walk)
    walk.fake_ask.answers = [BAD, BAD]
    walk.post(walk.url, json={"entry": "send", "inputs": {"form": {"id": 8}}})
    assert _wait(walk)["error"]
    assert walk.post(walk.url, json={"entry": "send"}).json()["error"] is None


def test_whole_number_floats_still_hit_the_proposed_trace(walk):
    answer = {"inputs": [{"name": "n", "description": "d", "value": 1.0}], "steps": STEPS, "outcome": OUTCOME}
    walk.fake_ask.answers = [f"```json\n{json.dumps(answer)}\n```"]
    walk.post(walk.url, json={"entry": "send"})
    first = _wait(walk)["trace"]
    hit = walk.post(walk.url, json={"entry": "send", "inputs": {"n": 1}}).json()
    assert hit["running"] is False and hit["trace"]["id"] == first["id"]
    assert len(walk.fake_ask.calls) == 1


def test_posted_values_have_a_size_limit(walk):
    _propose(walk)
    big = "x" * (walkthrough.MAX_VALUE_BYTES + 1)
    assert walk.post(walk.url, json={"entry": "send", "inputs": {"form": big}}).status_code == 400
    wide = "é" * (walkthrough.MAX_VALUE_BYTES // 2)  # under the limit in characters, over in bytes
    assert walk.post(walk.url, json={"entry": "send", "inputs": {"form": wide}}).status_code == 400


def test_a_post_that_loses_the_start_race_joins_the_other(walk, monkeypatch):
    def busy(**kwargs):
        raise Busy(kwargs["thread_id"])

    monkeypatch.setattr(app.state.turns, "start", busy)
    response = walk.post(walk.url, json={"entry": "send"})
    assert response.status_code == 200 and response.json()["trace"] is None


def test_events_with_nothing_running_end_at_once(walk):
    assert _events(walk) == [{"type": "idle"}]


# -- access ----------------------------------------------------------------------


def test_unknown_maps_entries_and_other_logins_get_404(walk):
    trace_id = _propose(walk)["trace"]["id"]
    assert walk.get(walk.url, params={"entry": "backoff"}).status_code == 404  # not an entry
    assert walk.get("/api/logic/nope/walkthrough", params={"entry": "send"}).status_code == 404
    app.state.session.login_name = "someone-else"
    assert walk.get(walk.url, params={"entry": "send"}).status_code == 404
    assert walk.post(walk.url, json={"entry": "send"}).status_code == 404
    assert walk.get(f"{walk.url}/events", params={"entry": "send"}).status_code == 404
    assert walk.get(f"/api/logic/traces/{trace_id}").status_code == 404


def test_without_claude_there_is_no_walkthrough(web_app):
    assert web_app.get("/api/logic/m/walkthrough", params={"entry": "send"}).status_code == 404
    assert web_app.post("/api/logic/m/walkthrough", json={"entry": "send"}).status_code == 404
