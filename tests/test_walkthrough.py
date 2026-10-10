# tests/test_walkthrough.py
import json

from spec_tackle import walkthrough as walk

BLOCKS = [
    {"id": "send", "label": "Form is sent", "kind": "entry", "change": "unchanged", "next": [{"to": "retry"}]},
    {"id": "retry", "label": "Retry failures", "kind": "loop", "change": "added",
     "next": [{"to": "give-up", "label": "5 tries"}],
     "children": [
         {"id": "job", "label": "Nightly job", "kind": "entry", "change": "added", "next": [{"to": "backoff"}]},
         {"id": "backoff", "label": "Back off and resend", "kind": "step", "change": "added", "next": []},
     ]},
    {"id": "give-up", "label": "Give up", "kind": "exit", "change": "added", "next": []},
]
INPUTS = [{"name": "form", "description": "The submitted form", "value": {"id": 7}}]


def step(block_id, **over):
    return {"blockId": block_id, "input": {"a": 1}, "output": {"a": 2}, "note": "Does a thing.", **over}


def answer(**over):
    return {
        "inputs": INPUTS,
        "steps": [step("send"), step("backoff", assumed=["The server is down"]),
                  step("give-up", danger=[{"note": "Posts the form to an unknown host (app/retry.py:9)"}],
                       effects=[{"kind": "destructive", "note": "Deletes the form (app/retry.py:9)"}])],
        "outcome": {"kind": "exit", "message": "Reached exit: Give up"},
        **over,
    }


def problems_for(data, inputs=None, entry="send"):
    result, problems = walk.validate_trace(data, blocks=BLOCKS, entry_id=entry, inputs=inputs)
    assert result is None
    return "\n".join(problems)


def test_entry_ids_are_breadth_first():
    assert walk.entry_ids(BLOCKS) == ["send", "job"]


def test_a_good_proposing_answer_passes_and_keeps_flags():
    result, problems = walk.validate_trace(answer(extra="dropped"), blocks=BLOCKS, entry_id="send", inputs=None)
    assert problems == []
    assert result["inputs"] == INPUTS
    assert [s["blockId"] for s in result["steps"]] == ["send", "backoff", "give-up"]
    assert result["steps"][1]["assumed"] == ["The server is down"]
    assert result["steps"][2]["danger"] == [{"note": "Posts the form to an unknown host (app/retry.py:9)"}]
    assert result["steps"][2]["effects"] == [{"kind": "destructive", "note": "Deletes the form (app/retry.py:9)"}]
    for key in ("assumed", "danger", "effects"):
        assert key not in result["steps"][0]
    assert set(result) == {"inputs", "steps", "outcome"}


def test_a_fixed_run_keeps_the_given_inputs():
    given = [{"name": "form", "description": "The submitted form", "value": {"id": 8}}]
    data = answer()
    del data["inputs"]
    result, problems = walk.validate_trace(data, blocks=BLOCKS, entry_id="send", inputs=given)
    assert problems == [] and result["inputs"] == given


def test_a_fixed_run_must_not_change_the_inputs():
    given = [{"name": "form", "description": "The submitted form", "value": {"id": 8}}]
    assert "inputs: must be exactly the inputs you were given" in problems_for(answer(), inputs=given)


def test_rejects_non_objects():
    assert "the answer must be a JSON object" in problems_for([])


def test_rejects_bad_inputs():
    assert "inputs: must have 1 to 12 inputs" in problems_for(answer(inputs=[]))
    many = [{"name": f"n{i}", "description": "d", "value": i} for i in range(13)]
    assert "inputs: must have 1 to 12 inputs" in problems_for(answer(inputs=many))
    twice = [INPUTS[0], INPUTS[0]]
    assert 'inputs[1].name: "form" is used more than once' in problems_for(answer(inputs=twice))
    bad = [{"name": "x" * 61, "description": "", "value": "v" * 5000}]
    text = problems_for(answer(inputs=bad))
    assert "inputs[0].name: must be 1 to 60 characters" in text
    assert "inputs[0].description: must be 1 to 120 characters" in text
    assert "inputs[0].value: must be at most 4096 bytes of JSON" in text


def test_rejects_bad_step_counts_and_blocks():
    assert "steps: must have 1 to 60 steps" in problems_for(answer(steps=[]))
    assert "steps: must have 1 to 60 steps" in problems_for(answer(steps=[step("send")] * 61))
    text = problems_for(answer(steps=[step("send"), step("retry"), step("nope")]))
    assert 'steps[1].blockId: "retry" is not a step (leaf) of the map' in text
    assert 'steps[2].blockId: "nope" is not a step (leaf) of the map' in text


def test_rejects_bad_step_fields():
    s = step("send", note="", assumed=["a"] * 6, danger=[{"note": "n"}] * 6,
            effects=[{"kind": "unsafe", "note": "n"}] * 6)
    del s["output"]
    s["input"] = {"big": "x" * 5000}
    text = problems_for(answer(steps=[s], outcome={"kind": "stopped", "message": "?"}))
    assert "steps[0].note: must be 1 to 200 characters" in text
    assert "steps[0].output: is required" in text
    assert "steps[0].input: must be at most 4096 bytes of JSON" in text
    assert "steps[0].assumed: at most 5" in text
    assert "steps[0].danger: at most 5" in text
    assert "steps[0].effects: at most 5" in text


def test_rejects_bad_danger_flags():
    s = step("send", danger=[{"note": ""}, {"note": "x" * 201}, "nope"])
    text = problems_for(answer(steps=[s], outcome={"kind": "stopped", "message": "?"}))
    assert "steps[0].danger[0].note: must be 1 to 200 characters" in text
    assert "steps[0].danger[1].note: must be 1 to 200 characters" in text
    assert "steps[0].danger[2]: must be an object" in text


def test_danger_keeps_only_the_note():
    s = step("send", danger=[{"kind": "external", "note": "Steals keys (a.py:1)"}])
    result, problems = walk.validate_trace(
        answer(steps=[s], outcome={"kind": "stopped", "message": "?"}), blocks=BLOCKS, entry_id="send", inputs=None)
    assert problems == []
    assert result["steps"][0]["danger"] == [{"note": "Steals keys (a.py:1)"}]


def test_effects_are_kept_with_kind_and_note():
    kinds = [{"kind": k, "note": f"does {k}"} for k in walk.EFFECT_KINDS]
    result, problems = walk.validate_trace(
        answer(steps=[step("send", effects=kinds)], outcome={"kind": "stopped", "message": "?"}),
        blocks=BLOCKS, entry_id="send", inputs=None)
    assert problems == [] and result["steps"][0]["effects"] == kinds


def test_rejects_bad_effects():
    s = step("send", effects=[{"kind": "external", "note": "ok"}, {"kind": "boom", "note": "n"},
                              {"kind": "unsafe", "note": "x" * 201}, {"kind": "unsafe", "note": ""}, 7])
    text = problems_for(answer(steps=[s], outcome={"kind": "stopped", "message": "?"}))
    assert "steps[0].effects[1].kind: must be one of external, destructive, unsafe, irreversible" in text
    assert "steps[0].effects[2].note: must be 1 to 200 characters" in text
    assert "steps[0].effects[3].note: must be 1 to 200 characters" in text
    assert "steps[0].effects[4]: must be an object" in text
    assert "steps[0].effects[0]" not in text


def test_non_list_danger_and_effects_are_problems_not_crashes():
    text = problems_for(answer(steps=[step("send", danger="x", effects={"a": 1})],
                               outcome={"kind": "stopped", "message": "?"}))
    assert "steps[0].danger: at most 5" in text and "steps[0].effects: at most 5" in text


def test_rejects_bad_outcomes():
    assert "outcome.kind: must be one of exit, error, stopped" in problems_for(answer(outcome={"kind": "done", "message": "m"}))
    assert "outcome.message: must be 1 to 300 characters" in problems_for(answer(outcome={"kind": "error", "message": ""}))
    ends_early = answer(steps=[step("send")])
    assert "outcome: an exit outcome must end on a block of kind exit" in problems_for(ends_early)


def test_the_first_step_must_be_in_the_entry():
    assert 'steps[0].blockId: must be the entry "send" or a step inside it' in problems_for(
        answer(steps=[step("backoff"), step("give-up")]))
    # A nested entry that is itself a leaf.
    result, problems = walk.validate_trace(
        answer(steps=[step("job"), step("backoff"), step("give-up")]), blocks=BLOCKS, entry_id="job", inputs=None)
    assert problems == []


def test_input_hash_ignores_key_order():
    assert walk.input_hash({"a": 1, "b": {"x": 1, "y": 2}}) == walk.input_hash({"b": {"y": 2, "x": 1}, "a": 1})
    assert walk.input_hash({"a": 1}) != walk.input_hash({"a": 2})


def test_requests_carry_the_map_entry_and_inputs_verbatim():
    entry = BLOCKS[0]
    proposing = walk.propose_request(BLOCKS, entry)
    assert json.dumps(BLOCKS) in proposing and '"send"' in proposing and "Propose" in proposing
    fixed = walk.fixed_request(BLOCKS, entry, [{"name": "form", "description": "d", "value": "<b>7</b>"}])
    assert '"<b>7</b>"' in fixed and "These inputs are fixed" in fixed


def test_the_prompt_forbids_running_code_defines_danger_as_malicious_and_names_effect_kinds():
    prompt = walk.WALK_SYSTEM_PROMPT
    assert "NEVER run, or try to run, any code" in prompt
    assert "meant to cause harm" in prompt
    assert "Risky isn't malicious" in prompt
    for kind in walk.EFFECT_KINDS:
        assert f'"{kind}"' in prompt
    assert "even when these inputs don't reach it" in prompt


def test_a_non_string_block_id_is_a_problem_not_a_crash():
    for bad in (["x"], 5, {"id": "send"}):
        text = problems_for(answer(steps=[step(bad), step("give-up")]))
        assert "is not a step (leaf) of the map" in text


def test_a_fixed_run_with_an_unhashable_input_name_is_a_problem_not_a_crash():
    given = [{"name": "form", "description": "The submitted form", "value": {"id": 8}}]
    text = problems_for(answer(inputs=[{"name": ["x"], "value": 1}]), inputs=given)
    assert "inputs: must be exactly the inputs you were given; don't change them" in text
