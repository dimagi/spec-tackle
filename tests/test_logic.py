import json
import os

import pytest

from spec_tackle import logic


@pytest.fixture
def repo(tmp_path):
    root = tmp_path / "wt"
    (root / "app").mkdir(parents=True)
    (root / "app" / "visits.py").write_text("".join(f"line {n}\n" for n in range(1, 21)))
    return root


def leaf(id, label="Save the visit", **over):
    return {"id": id, "label": label, "kind": "step", "change": "added", "next": [], **over}


def good_map():
    return {
        "summary": "Retries failed form submissions.",
        "blocks": [
            {"id": "submit", "label": "Form is submitted", "kind": "entry", "change": "unchanged",
             "next": [{"to": "check"}]},
            {"id": "check", "label": "Is the submission valid?", "kind": "decision", "change": "changed",
             "next": [{"to": "save", "label": "valid"}, {"to": "reject", "label": "invalid"}]},
            {"id": "save", "label": "Save and sync", "kind": "step", "change": "added", "next": [],
             "children": [
                 {"id": "store", "label": "Store the visit", "kind": "step", "change": "added",
                  "next": [{"to": "sync"}],
                  "children": [leaf("write", functions=[{"path": "app/visits.py", "symbol": "save", "start": 3, "end": 8}])]},
                 leaf("sync", "Queue a sync", kind="async", extra="ignored"),
             ]},
            {"id": "reject", "label": "Return field errors", "kind": "exit", "change": "unchanged", "next": []},
        ],
    }


def problems_for(data, repo):
    result, problems = logic.validate_map(data, repo)
    assert result is None
    return "\n".join(problems)


# -- parse_answer --------------------------------------------------------------


def test_parse_answer_takes_the_last_json_block():
    text = 'Here it is:\n```json\n{"a": 1}\n```\nOops, corrected:\n```json\n{"a": 2}\n```\nDone.'
    assert logic.parse_answer(text) == ({"a": 2}, [])


def test_parse_answer_accepts_bare_json():
    assert logic.parse_answer('  {"a": 1} ') == ({"a": 1}, [])


def test_parse_answer_reports_missing_or_broken_json():
    assert logic.parse_answer("I couldn't map this PR.") == (None, ["No JSON block found in the answer"])
    data, problems = logic.parse_answer("```json\n{\"a\": \n```")
    assert data is None and problems[0].startswith("The JSON doesn't parse:")


# -- validate_map ------------------------------------------------------------------


def test_a_good_map_passes_and_unknown_keys_are_dropped(repo):
    result, problems = logic.validate_map(good_map(), repo)
    assert problems == []
    assert result["summary"] == "Retries failed form submissions."
    sync = result["blocks"][2]["children"][1]
    assert "extra" not in sync and sync["kind"] == "async"
    assert result["blocks"][2]["children"][0]["children"][0]["functions"][0]["symbol"] == "save"


def test_rejects_non_objects_and_bad_summaries(repo):
    assert "the answer must be a JSON object" in problems_for([], repo)
    data = good_map() | {"summary": ""}
    assert "summary: must be a non-empty string" in problems_for(data, repo)


def test_rejects_wrong_block_counts(repo):
    assert "blocks: must have 1 to 12 blocks" in problems_for(good_map() | {"blocks": []}, repo)
    many = [leaf(f"b{i}") for i in range(13)]
    assert "blocks: must have 1 to 12 blocks" in problems_for(good_map() | {"blocks": many}, repo)


def test_rejects_bad_and_duplicate_ids(repo):
    data = good_map()
    data["blocks"][0]["id"] = "has space"
    data["blocks"][3]["id"] = "store"  # also used at level 2
    text = problems_for(data, repo)
    assert "blocks[0].id: must match" in text
    assert 'blocks[3].id: "store" is used more than once' in text


def test_rejects_bad_labels_kinds_and_changes(repo):
    data = good_map()
    data["blocks"][0]["label"] = ""
    data["blocks"][1]["label"] = "x" * 81
    data["blocks"][2]["kind"] = "process"
    data["blocks"][3]["change"] = "removed"
    text = problems_for(data, repo)
    assert "blocks[0].label: must be 1 to 80 characters" in text
    assert "blocks[1].label: must be 1 to 80 characters" in text
    assert "blocks[2].kind: must be one of" in text
    assert "blocks[3].change: must be one of" in text


def test_rejects_bad_edges(repo):
    data = good_map()
    data["blocks"][0]["next"] = [{"to": "store"}]  # not a sibling
    data["blocks"][3]["next"] = [{"to": "reject"}]  # itself
    data["blocks"][1]["next"][0]["label"] = "y" * 41
    text = problems_for(data, repo)
    assert 'blocks[0].next[0].to: "store" is not a sibling' in text
    assert "blocks[3].next[0].to: a block can't point at itself" in text
    assert "blocks[1].next[0].label: must be at most 40 characters" in text


def test_rejects_bad_children(repo):
    data = good_map()
    data["blocks"][0]["children"] = []
    data["blocks"][3] |= {"children": [leaf("r1")], "functions": []}
    write = data["blocks"][2]["children"][0]["children"][0]
    write["children"] = [leaf("deep")]
    del write["functions"]
    text = problems_for(data, repo)
    assert "blocks[0].children: must not be empty" in text
    assert "blocks[3]: a block can't have both children and functions" in text
    assert "blocks[2].children[0].children[0].children: the map can be at most 3 levels deep" in text


def test_rejects_bad_function_refs(repo, tmp_path):
    (tmp_path / "secret.py").write_text("x\n")
    os.symlink(tmp_path / "secret.py", repo / "app" / "link.py")
    fn = {"symbol": "f", "start": 1, "end": 2}
    refs = [
        {**fn, "path": "/etc/passwd"},
        {**fn, "path": "../secret.py"},
        {**fn, "path": "app/link.py"},
        {**fn, "path": "app/missing.py"},
        {**fn, "path": "app/visits.py", "start": 0},
        {**fn, "path": "app/visits.py", "start": 5, "end": 4},
        {**fn, "path": "app/visits.py", "end": 21},
    ]
    data = good_map()
    data["blocks"][3]["functions"] = refs
    text = problems_for(data, repo)
    for i in range(3):
        assert f"blocks[3].functions[{i}].path: must be a file inside the repository" in text
    assert "blocks[3].functions[3].path: app/missing.py doesn't exist" in text
    assert "blocks[3].functions[4]: start and end must be 1-based lines with start <= end" in text
    assert "blocks[3].functions[5]: start and end must be 1-based lines with start <= end" in text
    assert "blocks[3].functions[6]: app/visits.py has only 20 lines" in text


def test_rejects_too_many_functions(repo):
    data = good_map()
    data["blocks"][3]["functions"] = [{"path": "app/visits.py", "symbol": "f", "start": 1, "end": 1}] * 9
    assert "blocks[3].functions: at most 8 functions per block" in problems_for(data, repo)


def test_repair_request_lists_the_problems():
    text = logic.repair_request(["blocks: must have 1 to 12 blocks", "summary: must be a non-empty string"])
    assert "- blocks: must have 1 to 12 blocks" in text and "```json" in text


# -- find_block and function_source --------------------------------------------------


def test_find_block_searches_all_levels():
    assert logic.find_block(good_map()["blocks"], "write")["label"] == "Save the visit"
    assert logic.find_block(good_map()["blocks"], "nope") is None


def test_function_source_marks_changed_lines(repo):
    ref = {"path": "app/visits.py", "symbol": "save", "start": 3, "end": 5}
    out = logic.function_source(repo, ref, changed={4, 9})
    assert out["path"] == "app/visits.py" and out["symbol"] == "save"
    assert [(l["n"], l["changed"]) for l in out["lines"]] == [(3, False), (4, True), (5, False)]
    assert "line" in out["lines"][0]["html"] and "missing" not in out


def test_function_source_handles_missing_and_outside_files(repo):
    out = logic.function_source(repo, {"path": "app/gone.py", "symbol": "f", "start": 1, "end": 2}, changed=set())
    assert out["missing"] == "File not found in the checkout" and out["lines"] == []
    with pytest.raises(ValueError):
        logic.function_source(repo, {"path": "../x.py", "symbol": "f", "start": 1, "end": 1}, changed=set())


def test_prompts_mention_the_limits():
    assert "3 levels" in logic.LOGIC_SYSTEM_PROMPT and "12" in logic.LOGIC_SYSTEM_PROMPT
    assert "```json" in logic.LOGIC_REQUEST
    json.loads(json.dumps(good_map()))  # the fixture itself is valid JSON
