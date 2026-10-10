# Logic Walkthrough Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Walkthrough panel in the Logic view. The reviewer picks an entry block, gives it
inputs (Claude proposes starting values), and steps leaf by leaf through a trace that
Claude works out by reading the code. Each step shows its input, output, assumptions and
danger flags.

**Architecture:**
- **Backend:**
  - `walkthrough.py` holds the prompt, trace validation and input hashing.
  - `walkthrough_api.py` holds the routes and the background run. It reuses `TurnRunner`,
    `Checkouts`, `claude.ask` (and through it the locked-down `claude._options`), and two
    helpers pulled out of `logic_api.py`.
  - Traces go in a new `logic_traces` table.
- **Frontend:**
  - `lib/walkthrough.ts`: pure path, edge and highlight logic.
  - `pages/logic/useWalk.ts`: data and the progress stream.
  - `pages/logic/WalkthroughPanel.tsx`: the panel.
  - `walk` marks drawn by `FlowChart`, and wiring in `LogicView` and `ReviewPage` (`?walk=`).

**Tech Stack:**
- FastAPI, `claude-agent-sdk` (optional extra), SQLite.
- React 19 and TypeScript, React Query, React Flow and ELK (already lazily loaded), Tailwind 4.
- Tests: pytest, vitest, Playwright.

**Spec:** `docs/specs/2026-10-10-logic-walkthrough-design.md`

## Global Constraints

- **Claude never executes code.** Sessions get exactly `["Read", "Grep", "Glob"]` through
  `claude.ask` → `claude._options` (unchanged). No new tool, no `Bash`, no MCP. The
  walkthrough code path starts no processes beyond what `Checkouts` already runs.
- **Dangerous code is flagged:** kinds are exactly `destructive`, `external`, `unsafe`
  and `irreversible`. Flags show prominently and are never collapsed or hidden.
- **Limits:**
  - 1–60 steps; 1–12 proposed inputs;
  - input name 1–60 characters, description 1–120;
  - each JSON value (input value, step input, step output) at most 4096 bytes as
    `json.dumps(..., ensure_ascii=False)` UTF-8;
  - note 1–200 characters;
  - assumptions ≤ 5 per step, each 1–120 characters;
  - danger flags ≤ 5 per step, each note 1–200 characters;
  - outcome message 1–300 characters.
- `outcome.kind` ∈ `exit error stopped`.
- Exactly one repair turn on invalid output. After that, an `error` event ("Claude's
  walkthrough didn't pass validation: …") and nothing is stored.
- **Run key:** `walk:{login}:{map_id}:{entry_id}`. One run per map and entry at a time.
- Nothing is sent to GitHub. Traces are readable only by their owner, and every route
  returns 404 for another login's map.
- `claude-agent-sdk` is imported only inside functions that need it.
- **Rebuild after any frontend change** (`cd frontend && npm run build`). Commit
  `src/spec_tackle/static/dist/` with the source change, or `tests/test_frontend_bundle.py`
  fails.
- Pin any new frontend dependency exactly. This plan adds none.
- Conventional Commits, each ending with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. **`?walk=` names an entry that isn't in the current map**, for example after
   regenerating or with tests hidden. The panel falls back to the first entry instead of
   requesting an unknown entry over and over (Task 8).
2. **The proposing run fails.** The view must not POST again in a loop. It shows the error
   with **Try again**, once (Task 6).
3. **Claude's values contain markup**, such as `"<img src=x onerror=alert(1)>"` in an output
   or note. It's shown as text, never as HTML (Task 7).
4. **Arrow keys while typing in an input's JSON editor** move the caret, not the step (Task 7).
5. **A trace step that sits in a test block while tests are hidden.** The block is still
   drawn, so the step has a card to ring (Task 8).

## Rulings made while planning

- **Shared run helpers.** `logic_api._ask` becomes `ask_json(..., system, writing)`, and
  `run_logic`'s snapshot code becomes `pr_snapshot(...)`. The walkthrough calls both. This
  is DRY, and the walkthrough's Claude session comes from exactly the same code as the map's.
- **Snapshot for a stale map.** The snapshot is built from the PR as GitHub has it now,
  with `commit=` set to the map's SHA. The worktree, which is what Claude reads, is the
  map's SHA.
- **`?walk=` lives in `ReviewPage`.** `LogicView` gets `walk` and `onWalk` props, because
  its tests render it without a router.
- **Entry order.** `entries()` lists top-level entries first, then nested ones level by
  level (breadth-first). That makes "the first top-level entry" simply `entries(...)[0]`.
- **Fixed-input runs.** Their answer may leave out `inputs`. If it includes them, they must
  equal the given ones. Descriptions for a fixed run come from the starting inputs.
- **Edge highlighting** is worked out in `lib/walkthrough.ts` and applied as edge
  `className`s. The tests check the pure function, because jsdom doesn't render React Flow
  edges reliably.

---

### Task 1: `walkthrough.py`: prompt, validation, input hash

**Files:**
- Create: `src/spec_tackle/walkthrough.py`
- Test: `tests/test_walkthrough.py`

**Interfaces:**
- Consumes: `logic.find_block(blocks, block_id) -> dict | None`, `logic.parse_answer(text)`.
- Produces:
  - `WALK_SYSTEM_PROMPT: str`
  - `DANGER_KINDS = ("destructive", "external", "unsafe", "irreversible")`, `OUTCOMES = ("exit", "error", "stopped")`
  - `entry_ids(blocks: list[dict]) -> list[str]`: every block of kind `entry`, breadth-first
  - `propose_request(blocks: list[dict], entry: dict) -> str`
  - `fixed_request(blocks: list[dict], entry: dict, inputs: list[dict]) -> str`
  - `repair_request(problems: list[str]) -> str`
  - `input_hash(values: dict) -> str`: sha256 hex of canonical JSON
  - `values_of(inputs: list[dict]) -> dict`: `{name: value}`
  - `validate_trace(data: object, *, blocks: list[dict], entry_id: str, inputs: list[dict] | None) -> tuple[dict | None, list[str]]`. It returns `{"inputs", "steps", "outcome"}` or every problem found. `inputs=None` means a proposing run.

- [ ] **Step 1: Write the failing tests**

```python
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
                  step("give-up", danger=[{"kind": "destructive", "note": "Deletes the form (app/retry.py:9)"}])],
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
    assert result["steps"][2]["danger"] == [{"kind": "destructive", "note": "Deletes the form (app/retry.py:9)"}]
    assert "assumed" not in result["steps"][0] and "danger" not in result["steps"][0]
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
    s = step("send", note="", assumed=["a"] * 6, danger=[{"kind": "boom", "note": ""}] + [{"kind": "unsafe", "note": "n"}] * 5)
    del s["output"]
    s["input"] = {"big": "x" * 5000}
    text = problems_for(answer(steps=[s], outcome={"kind": "stopped", "message": "?"}))
    assert "steps[0].note: must be 1 to 200 characters" in text
    assert "steps[0].output: is required" in text
    assert "steps[0].input: must be at most 4096 bytes of JSON" in text
    assert "steps[0].assumed: at most 5" in text
    assert "steps[0].danger: at most 5" in text


def test_rejects_bad_danger_flags():
    s = step("send", danger=[{"kind": "boom", "note": "n"}, {"kind": "unsafe", "note": "x" * 201}])
    text = problems_for(answer(steps=[s], outcome={"kind": "stopped", "message": "?"}))
    assert "steps[0].danger[0].kind: must be one of destructive, external, unsafe, irreversible" in text
    assert "steps[0].danger[1].note: must be 1 to 200 characters" in text


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


def test_the_prompt_forbids_running_code_and_names_every_danger_kind():
    prompt = walk.WALK_SYSTEM_PROMPT
    assert "NEVER run, or try to run, any code" in prompt
    for kind in walk.DANGER_KINDS:
        assert f'"{kind}"' in prompt
    assert "even when these inputs don't reach it" in prompt
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_walkthrough.py -q`
Expected: FAIL (`ModuleNotFoundError: No module named 'spec_tackle.walkthrough'`)

- [ ] **Step 3: Write the implementation**

```python
# src/spec_tackle/walkthrough.py
"""The Logic walkthrough: what Claude is asked for, and checking the trace it sends back.

See docs/specs/2026-10-10-logic-walkthrough-design.md. Claude traces one run through the
map by reading the code. It never runs anything.
"""

from __future__ import annotations

import hashlib
import json

from .logic import find_block

MAX_STEPS = 60
MAX_INPUTS = 12
MAX_NAME = 60
MAX_DESCRIPTION = 120
MAX_VALUE_BYTES = 4096
MAX_NOTE = 200
MAX_ASSUMED = 5
MAX_ASSUMPTION = 120
MAX_DANGER = 5
MAX_MESSAGE = 300
DANGER_KINDS = ("destructive", "external", "unsafe", "irreversible")
OUTCOMES = ("exit", "error", "stopped")

WALK_SYSTEM_PROMPT = f"""\
You are dry-running the logic of a GitHub pull request so a reviewer can follow concrete
values through it. Your working directory is the repository checked out at the commit the
logic map describes. You can read it with Read, Grep and Glob.

NEVER run, or try to run, any code. Don't execute, import, build, install or test anything
from this repository, not even to check a value. You have no tools for it; don't ask for
any. Work out every value by reading the code. When reading isn't enough to tell what
happens next, end the trace with a "stopped" outcome that says why, rather than guess.

You get the PR, its logic map (a tree of pseudo-code blocks; leaves list the real
functions behind them) and one entry block. Trace one run from that entry, leaf by leaf:
the first step is the entry itself if it has no children, or the first leaf inside it.
Follow the flow through the map until an exit block, an error, or a point where you have
to stop. Read the functions behind each leaf to work out what it receives and returns.

Answer with exactly one fenced ```json block and nothing after it, in this shape:

{{
  "inputs": [{{"name": "body", "description": "The JSON request body", "value": {{}}}}],
  "steps": [Step, ...],
  "outcome": {{"kind": "exit" | "error" | "stopped", "message": "..."}}
}}

Step = {{
  "blockId": "leaf-id",              // a leaf of the map
  "input": {{"name": "value"}},        // the values going in
  "output": {{"name": "value"}},       // the values coming out; on an error, {{"raises": "KeyError('x')"}}
  "note": "What happened and why",   // at most {MAX_NOTE} characters
  "assumed": ["Visit 7 exists"],     // optional: every value you made up
  "danger": [{{"kind": "destructive", "note": "..."}}]  // optional: see below
}}

Rules:
- 1 to {MAX_STEPS} steps. A leaf can appear more than once, e.g. in a loop.
- Values that aren't plain JSON (model instances, dates) are short readable strings,
  like "Visit(id=7, status='open')". Keep each value under {MAX_VALUE_BYTES} bytes.
- List under "assumed" everything you couldn't read from the code: database rows, API
  replies, the clock, configuration. At most {MAX_ASSUMED}, each under {MAX_ASSUMPTION} characters.
- Where the code would raise, make that the last step, with the error as its output, and
  use an "error" outcome. An "exit" outcome must end on a block of kind exit.

Dangerous code: on every step, flag each operation in its code that would be dangerous
to run for real, even when these inputs don't reach it, and even when it looks intended.
The reviewer decides whether it's acceptable. Kinds:
- "destructive": deletes or overwrites data (DELETE/DROP/TRUNCATE, bulk updates, removing
  files, clearing caches or queues others rely on);
- "external": effects outside the system (email, SMS, push, payments, webhooks, state-changing
  third-party API calls, publishing messages);
- "unsafe": security risks (shell or eval/exec built from input, SQL built by string
  formatting, deserialising untrusted data, paths built from input without checks, missing
  permission checks, secrets in logs or responses);
- "irreversible": can't be undone some other way (schema or data migrations, revoking
  access, rotating or deleting keys).
Each flag's note says what the code does and where, e.g. "Calls Visit.objects.filter(owner=user).delete()
without a status filter (app/visits/services.py:142)". At most {MAX_DANGER} per step.

The pull request is included at the start of the conversation."""


def entry_ids(blocks: list[dict]) -> list[str]:
    """Every entry block, top level first, then each deeper level."""
    found, level = [], blocks
    while level:
        found += [b["id"] for b in level if b.get("kind") == "entry"]
        level = [c for b in level for c in b.get("children", [])]
    return found


def _context(blocks: list[dict], entry: dict) -> str:
    return (
        f"The logic map:\n```json\n{json.dumps(blocks)}\n```\n\n"
        f'The entry block is "{entry["id"]}" ({entry["label"]}).'
    )


def propose_request(blocks: list[dict], entry: dict) -> str:
    return (
        f"{_context(blocks, entry)}\n\n"
        "Propose realistic inputs for this entry, the kind a typical request or call would "
        "have, then trace them as described. Answer with one ```json block."
    )


def fixed_request(blocks: list[dict], entry: dict, inputs: list[dict]) -> str:
    return (
        f"{_context(blocks, entry)}\n\n"
        f"These inputs are fixed. Trace exactly these, and don't change them:\n"
        f"```json\n{json.dumps(inputs)}\n```\n\n"
        "Answer with one ```json block with steps and outcome; leave inputs out."
    )


def repair_request(problems: list[str]) -> str:
    listed = "\n".join(f"- {p}" for p in problems)
    return (
        "Your trace didn't pass validation:\n"
        f"{listed}\n\n"
        "Fix these problems and answer again with the complete trace in one ```json block."
    )


def input_hash(values: dict) -> str:
    canonical = json.dumps(values, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode()).hexdigest()


def values_of(inputs: list[dict]) -> dict:
    return {i["name"]: i["value"] for i in inputs}


def validate_trace(
    data: object, *, blocks: list[dict], entry_id: str, inputs: list[dict] | None
) -> tuple[dict | None, list[str]]:
    """The trace with unknown keys dropped, or every problem found in it."""
    if not isinstance(data, dict):
        return None, ["the answer must be a JSON object with steps and outcome"]
    problems: list[str] = []
    if inputs is None:
        checked = _inputs(data.get("inputs"), problems)
    else:
        checked = inputs
        given = data.get("inputs")
        if given is not None and (not isinstance(given, list) or _safe_values(given) != values_of(inputs)):
            problems.append("inputs: must be exactly the inputs you were given; don't change them")
    leaves = _leaves(blocks)
    steps = _steps(data.get("steps"), leaves, problems)
    outcome = _outcome(data.get("outcome"), problems)
    entry = find_block(blocks, entry_id)
    if steps and entry is not None and steps[0]["blockId"] not in _leaf_ids(entry):
        problems.append(f'steps[0].blockId: must be the entry "{entry_id}" or a step inside it')
    if steps and outcome and outcome["kind"] == "exit" and leaves.get(steps[-1]["blockId"], {}).get("kind") != "exit":
        problems.append("outcome: an exit outcome must end on a block of kind exit")
    if problems:
        return None, problems
    return {"inputs": checked, "steps": steps, "outcome": outcome}, []


def _text(value, limit: int) -> bool:
    return isinstance(value, str) and 1 <= len(value.strip()) <= limit


def _small(value) -> bool:
    return len(json.dumps(value, ensure_ascii=False).encode()) <= MAX_VALUE_BYTES


def _safe_values(items: list) -> dict | None:
    if not all(isinstance(i, dict) and "name" in i for i in items):
        return None
    return {i["name"]: i.get("value") for i in items}


def _leaves(blocks: list[dict]) -> dict[str, dict]:
    found: dict[str, dict] = {}
    for b in blocks:
        if b.get("children"):
            found |= _leaves(b["children"])
        else:
            found[b["id"]] = b
    return found


def _leaf_ids(block: dict) -> set[str]:
    if not block.get("children"):
        return {block["id"]}
    return set().union(*(_leaf_ids(c) for c in block["children"]))


def _inputs(value, problems: list[str]) -> list[dict]:
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_INPUTS:
        problems.append(f"inputs: must have 1 to {MAX_INPUTS} inputs")
        return []
    out, seen = [], set()
    for i, item in enumerate(value):
        at = f"inputs[{i}]"
        if not isinstance(item, dict):
            problems.append(f"{at}: must be an object")
            continue
        name = item.get("name")
        if not _text(name, MAX_NAME):
            problems.append(f"{at}.name: must be 1 to {MAX_NAME} characters")
        elif name in seen:
            problems.append(f'{at}.name: "{name}" is used more than once')
        else:
            seen.add(name)
        if not _text(item.get("description"), MAX_DESCRIPTION):
            problems.append(f"{at}.description: must be 1 to {MAX_DESCRIPTION} characters")
        if "value" not in item:
            problems.append(f"{at}.value: is required")
        elif not _small(item["value"]):
            problems.append(f"{at}.value: must be at most {MAX_VALUE_BYTES} bytes of JSON")
        out.append({"name": name, "description": item.get("description"), "value": item.get("value")})
    return out


def _steps(value, leaves: dict[str, dict], problems: list[str]) -> list[dict]:
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_STEPS:
        problems.append(f"steps: must have 1 to {MAX_STEPS} steps")
        return []
    return [_step(s, f"steps[{i}]", leaves, problems) for i, s in enumerate(value)]


def _step(s, at: str, leaves: dict[str, dict], problems: list[str]) -> dict:
    if not isinstance(s, dict):
        problems.append(f"{at}: must be an object")
        return {"blockId": None}
    block_id = s.get("blockId")
    if block_id not in leaves:
        problems.append(f'{at}.blockId: "{block_id}" is not a step (leaf) of the map')
    out = {"blockId": block_id}
    for key in ("input", "output"):
        if key not in s:
            problems.append(f"{at}.{key}: is required")
        elif not _small(s[key]):
            problems.append(f"{at}.{key}: must be at most {MAX_VALUE_BYTES} bytes of JSON")
        out[key] = s.get(key)
    if not _text(s.get("note"), MAX_NOTE):
        problems.append(f"{at}.note: must be 1 to {MAX_NOTE} characters")
    out["note"] = s.get("note")
    if "assumed" in s:
        assumed = s["assumed"]
        if not isinstance(assumed, list) or len(assumed) > MAX_ASSUMED:
            problems.append(f"{at}.assumed: at most {MAX_ASSUMED}")
        elif not all(_text(a, MAX_ASSUMPTION) for a in assumed):
            problems.append(f"{at}.assumed: each must be 1 to {MAX_ASSUMPTION} characters")
        elif assumed:
            out["assumed"] = assumed
    if "danger" in s:
        flags = s["danger"]
        if not isinstance(flags, list) or len(flags) > MAX_DANGER:
            problems.append(f"{at}.danger: at most {MAX_DANGER}")
        else:
            kept = []
            for j, flag in enumerate(flags):
                where = f"{at}.danger[{j}]"
                if not isinstance(flag, dict):
                    problems.append(f"{where}: must be an object")
                    continue
                if flag.get("kind") not in DANGER_KINDS:
                    problems.append(f"{where}.kind: must be one of {', '.join(DANGER_KINDS)}")
                if not _text(flag.get("note"), MAX_NOTE):
                    problems.append(f"{where}.note: must be 1 to {MAX_NOTE} characters")
                kept.append({"kind": flag.get("kind"), "note": flag.get("note")})
            if kept:
                out["danger"] = kept
    return out


def _outcome(value, problems: list[str]) -> dict | None:
    if not isinstance(value, dict):
        problems.append("outcome: must be an object with kind and message")
        return None
    if value.get("kind") not in OUTCOMES:
        problems.append(f"outcome.kind: must be one of {', '.join(OUTCOMES)}")
    if not _text(value.get("message"), MAX_MESSAGE):
        problems.append(f"outcome.message: must be 1 to {MAX_MESSAGE} characters")
    return {"kind": value.get("kind"), "message": value.get("message")}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_walkthrough.py -q`
Expected: all PASS. If one fails because a message differs, fix the implementation, not the test. The test messages are the contract the repair turn shows Claude.

- [ ] **Step 5: Commit**

```bash
git add src/spec_tackle/walkthrough.py tests/test_walkthrough.py
git commit -m "feat: validate Logic walkthrough traces

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Store: `logic_traces`

**Files:**
- Modify: `src/spec_tackle/store.py` (add migration 6, trace methods, and trace clean-up in `save_logic_map`)
- Test: `tests/test_store.py` (append)

**Interfaces:**
- Produces, on `Store`:
  - `save_trace(*, login: str, map_id: str, entry_id: str, input_hash: str, inputs: list, steps: list, outcome: dict, proposed: bool) -> str`. Upsert on `(login, map_id, entry_id, input_hash)`; sets `used_at`.
  - `trace(*, login: str, trace_id: str) -> dict | None`
  - `trace_by_hash(*, login: str, map_id: str, entry_id: str, input_hash: str) -> dict | None`
  - `latest_trace(*, login: str, map_id: str, entry_id: str) -> dict | None`: the highest `used_at`
  - `proposed_trace(*, login: str, map_id: str, entry_id: str) -> dict | None`
  - `touch_trace(*, trace_id: str) -> None`
  - A trace dict is `{"id", "mapId", "entryId", "inputs", "steps", "outcome", "proposed": bool, "usedAt"}`.

- [ ] **Step 1: Write the failing tests**

```python
# append to tests/test_store.py
from spec_tackle.github import PRRef as _PR


def _map(store, sha="abc", login="me"):
    return store.save_logic_map(login=login, pr=_PR("o", "r", 7), head_sha=sha, summary="s",
                                blocks=[], changed_lines={})


def _trace(store, map_id, h="h1", proposed=False, login="me", entry="send"):
    return store.save_trace(login=login, map_id=map_id, entry_id=entry, input_hash=h,
                            inputs=[{"name": "a", "description": "d", "value": 1}],
                            steps=[{"blockId": "send", "input": {}, "output": {}, "note": "n"}],
                            outcome={"kind": "stopped", "message": "m"}, proposed=proposed)


def test_traces_round_trip_and_are_private(tmp_path):
    store = Store.open(tmp_path / "s.db")
    map_id = _map(store)
    trace_id = _trace(store, map_id, proposed=True)
    got = store.trace(login="me", trace_id=trace_id)
    assert got["mapId"] == map_id and got["entryId"] == "send" and got["proposed"] is True
    assert got["inputs"][0]["value"] == 1 and got["outcome"]["kind"] == "stopped"
    assert store.trace(login="you", trace_id=trace_id) is None
    assert store.trace_by_hash(login="me", map_id=map_id, entry_id="send", input_hash="h1")["id"] == trace_id
    assert store.proposed_trace(login="me", map_id=map_id, entry_id="send")["id"] == trace_id
    assert store.proposed_trace(login="me", map_id=map_id, entry_id="other") is None


def test_latest_trace_follows_use(tmp_path):
    store = Store.open(tmp_path / "s.db")
    map_id = _map(store)
    first = _trace(store, map_id, "h1")
    second = _trace(store, map_id, "h2")
    assert store.latest_trace(login="me", map_id=map_id, entry_id="send")["id"] == second
    store.touch_trace(trace_id=first)
    assert store.latest_trace(login="me", map_id=map_id, entry_id="send")["id"] == first


def test_regenerating_a_map_for_the_same_commit_drops_its_traces(tmp_path):
    store = Store.open(tmp_path / "s.db")
    old = _map(store, "abc")
    other = _map(store, "def")
    gone = _trace(store, old)
    kept = _trace(store, other)
    new = _map(store, "abc")
    assert new != old
    assert store.trace(login="me", trace_id=gone) is None
    assert store.trace(login="me", trace_id=kept) is not None
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_store.py -q -k trace`
Expected: FAIL (`AttributeError: 'Store' object has no attribute 'save_trace'`)

- [ ] **Step 3: Write the implementation**

Append to `_MIGRATIONS` in `src/spec_tackle/store.py`:

```python
    # 6: Logic walkthrough traces (see docs/specs/2026-10-10-logic-walkthrough-design.md)
    """
    CREATE TABLE logic_traces (
        id TEXT PRIMARY KEY, login TEXT NOT NULL, map_id TEXT NOT NULL, entry_id TEXT NOT NULL,
        input_hash TEXT NOT NULL, inputs TEXT NOT NULL, steps TEXT NOT NULL, outcome TEXT NOT NULL,
        proposed INTEGER NOT NULL, used_at TEXT NOT NULL,
        UNIQUE (login, map_id, entry_id, input_hash)
    );
    """,
```

Below `_now()` add:

```python
def _now_exact() -> str:
    """Like _now, with microseconds: traces used within the same second still order right."""
    return datetime.now(timezone.utc).isoformat()
```

Replace the body of `save_logic_map` with:

```python
        """Store a map; one for the same login, PR and commit is replaced, and its traces dropped."""
        map_id = str(uuid.uuid4())
        self._db.execute("BEGIN")
        try:
            self._db.execute(
                "DELETE FROM logic_traces WHERE map_id IN (SELECT id FROM logic_maps"
                " WHERE login = ? AND owner = ? AND repo = ? AND number = ? AND head_sha = ?)",
                (login, pr.owner, pr.repo, pr.number, head_sha),
            )
            self._db.execute(
                "INSERT OR REPLACE INTO logic_maps (id, login, owner, repo, number, head_sha, summary,"
                " tree, changed_lines, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (map_id, login, pr.owner, pr.repo, pr.number, head_sha, summary,
                 json.dumps(blocks), json.dumps(changed_lines), _now()),
            )
            self._db.execute("COMMIT")
        except BaseException:
            self._db.execute("ROLLBACK")
            raise
        return map_id
```

Add a section after the Logic maps methods:

```python
    # -- Logic walkthrough traces ---------------------------------------------------

    def save_trace(
        self, *, login: str, map_id: str, entry_id: str, input_hash: str, inputs: list,
        steps: list, outcome: dict, proposed: bool,
    ) -> str:
        """Store a trace; one for the same login, map, entry and inputs is replaced."""
        trace_id = str(uuid.uuid4())
        self._db.execute(
            "INSERT OR REPLACE INTO logic_traces (id, login, map_id, entry_id, input_hash, inputs,"
            " steps, outcome, proposed, used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (trace_id, login, map_id, entry_id, input_hash, json.dumps(inputs), json.dumps(steps),
             json.dumps(outcome), int(proposed), _now_exact()),
        )
        return trace_id

    def trace(self, *, login: str, trace_id: str) -> dict | None:
        row = self._db.execute(
            "SELECT * FROM logic_traces WHERE id = ? AND login = ?", (trace_id, login)
        ).fetchone()
        return self._trace(row) if row else None

    def trace_by_hash(self, *, login: str, map_id: str, entry_id: str, input_hash: str) -> dict | None:
        row = self._db.execute(
            "SELECT * FROM logic_traces WHERE login = ? AND map_id = ? AND entry_id = ? AND input_hash = ?",
            (login, map_id, entry_id, input_hash),
        ).fetchone()
        return self._trace(row) if row else None

    def latest_trace(self, *, login: str, map_id: str, entry_id: str) -> dict | None:
        row = self._db.execute(
            "SELECT * FROM logic_traces WHERE login = ? AND map_id = ? AND entry_id = ?"
            " ORDER BY used_at DESC, rowid DESC LIMIT 1",
            (login, map_id, entry_id),
        ).fetchone()
        return self._trace(row) if row else None

    def proposed_trace(self, *, login: str, map_id: str, entry_id: str) -> dict | None:
        row = self._db.execute(
            "SELECT * FROM logic_traces WHERE login = ? AND map_id = ? AND entry_id = ? AND proposed = 1"
            " ORDER BY used_at DESC LIMIT 1",
            (login, map_id, entry_id),
        ).fetchone()
        return self._trace(row) if row else None

    def touch_trace(self, *, trace_id: str) -> None:
        self._db.execute("UPDATE logic_traces SET used_at = ? WHERE id = ?", (_now_exact(), trace_id))

    @staticmethod
    def _trace(row: sqlite3.Row) -> dict:
        return {
            "id": row["id"],
            "mapId": row["map_id"],
            "entryId": row["entry_id"],
            "inputs": json.loads(row["inputs"]),
            "steps": json.loads(row["steps"]),
            "outcome": json.loads(row["outcome"]),
            "proposed": bool(row["proposed"]),
            "usedAt": row["used_at"],
        }
```

- [ ] **Step 4: Run the store and logic tests**

Run: `uv run pytest tests/test_store.py tests/test_logic_api.py -q`
Expected: all PASS. The logic API tests check that `save_logic_map` still works.

- [ ] **Step 5: Commit**

```bash
git add src/spec_tackle/store.py tests/test_store.py
git commit -m "feat: store Logic walkthrough traces

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Walkthrough routes and run

**Files:**
- Modify: `src/spec_tackle/logic_api.py` (extract `pr_snapshot` and `ask_json`; `run_logic` uses them)
- Create: `src/spec_tackle/walkthrough_api.py`
- Modify: `src/spec_tackle/app.py` (import `walkthrough_api`; `app.include_router(walkthrough_api.router)` after `logic_api`)
- Test: `tests/test_walkthrough_api.py`

**Interfaces:**
- Consumes: everything from Task 1 and Task 2; `claude_api._signed_in(request) -> (state, client, login)`, which raises 404 when Claude is unavailable and 401 when signed out; `state.turns` (`TurnRunner`); `state.checkouts.worktree(...)`.
- Produces:
  - `logic_api.pr_snapshot(*, client, pr: PRRef, overview: dict, cwd: Path, sha: str) -> tuple[str, dict[str, list[int]]]`, giving `(snapshot, changed_lines)`.
  - `logic_api.ask_json(*, state, cwd, snapshot, question, full_prompt, session_id, emit, system: str, writing: str) -> tuple[str, str | None]`.
  - Routes (JSON shapes are what the frontend consumes):
    - `GET /api/logic/{map_id}/walkthrough?entry=ID` → `WalkState = {"trace": Trace | None, "starting": Input[] | None, "running": bool, "error": str | None}`
    - `POST /api/logic/{map_id}/walkthrough` with body `{"entry": str, "inputs"?: {name: value}}` → `WalkState`. A cache hit makes `trace` that trace.
    - `GET /api/logic/{map_id}/walkthrough/events?entry=ID` → SSE of `{"type": "tool", "text"}`, `{"type": "done", "traceId"}`, `{"type": "error", "text"}`, or just `{"type": "idle"}`
    - `GET /api/logic/traces/{trace_id}` → `Trace`

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_walkthrough_api.py
import asyncio
import json
import subprocess
import time

import pytest

from spec_tackle import claude, walkthrough
from spec_tackle.app import app
from spec_tackle.github import PRRef

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
    started = walk.post(walk.url, json={"entry": "send"}).json()
    assert started["running"] is True
    walk.fake_ask.answers = [PROPOSED]
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_walkthrough_api.py -q`
Expected: FAIL. Every route returns 404 (or 405), and `test_walkthrough_sessions_are_read_only` passes already, since it only checks the shared options.

- [ ] **Step 3: Extract the shared helpers in `logic_api.py`**

Replace `_ask` with:

```python
async def ask_json(
    *, state, cwd, snapshot: str, question: str, full_prompt: str, session_id, emit,
    system: str = logic.LOGIC_SYSTEM_PROMPT, writing: str = "Writing the map…",
):
    """One Claude turn whose answer is JSON; progress goes to `emit`, the answer comes back.

    Every Claude feature goes through claude.ask, so every session gets the same read-only tools.
    """
    started = False
    async for event in claude.ask(
        cli=state.claude_cli, cwd=cwd, snapshot=snapshot, question=question,
        full_prompt=full_prompt, session_id=session_id, system=system,
    ):
        if event.kind == "tool":
            emit({"type": "tool", "text": event.text})
        elif event.kind == "text" and not started:
            started = True  # the answer itself is JSON; show that it's coming, not the JSON
            emit({"type": "tool", "text": writing})
        elif event.kind == "done":
            return event.text, event.session_id
    return "", None


async def pr_snapshot(*, client, pr: PRRef, overview: dict, cwd, sha: str) -> tuple[str, dict[str, list[int]]]:
    """The PR as Claude sees it at the start of a session, and the lines it adds per file."""
    files = await client.files(pr)
    markdown = {
        f["filename"]: claude.read_lines(root=cwd, path=f["filename"], start=1, end=10**9)
        for f in files
        if render.is_markdown(f["filename"]) and f["status"] != "removed"
    }
    snapshot = claude.build_context(
        overview=overview, files=files, markdown=markdown,
        activity=render.normalize_activity(overview), commit=sha,
    )
    changed = {
        f["filename"]: sorted(render.parse_patch(f.get("patch"))[1])
        for f in files
        if f["status"] != "removed"
    }
    return snapshot, changed
```

In `run_logic`, replace everything from `files = await client.files(pr)` through the `changed = {...}` block with:

```python
        snapshot, changed = await pr_snapshot(client=client, pr=pr, overview=overview, cwd=cwd, sha=sha)
```

Then rename both `_ask(` calls in `run_logic` to `ask_json(`.

Run: `uv run pytest tests/test_logic_api.py -q`
Expected: PASS (no behaviour change).

- [ ] **Step 4: Write `walkthrough_api.py`**

```python
# src/spec_tackle/walkthrough_api.py
"""The Logic walkthrough's routes and its run (see docs/specs/2026-10-10-logic-walkthrough-design.md).

Claude traces the code by reading it. Nothing here runs code from the repository: the
session comes from claude.ask with Read/Grep/Glob only, and the only processes are the git
commands Checkouts already runs.
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from . import claude, logic, walkthrough
from .checkout import CheckoutError, CommitGone
from .claude_api import _signed_in
from .github import GitHubError, PRRef
from .logic_api import ask_json, pr_snapshot

router = APIRouter()

# The last failure per run key, so a run that failed with nobody watching still says so.
_last_errors: dict[str, str] = {}


class WalkRequest(BaseModel):
    entry: str
    inputs: dict[str, Any] | None = None


def _key(*, login: str, map_id: str, entry: str) -> str:
    return f"walk:{login}:{map_id}:{entry}"


async def _walk_map(request: Request, map_id: str, entry: str):
    """The signed-in user's map and a valid entry in it, or 404."""
    state, client, login = await _signed_in(request)
    saved = state.store.logic_map(login=login, map_id=map_id)
    if not saved or entry not in walkthrough.entry_ids(saved["blocks"]):
        raise HTTPException(404, "No such map or entry")
    return state, client, login, saved


def _state(*, state, login: str, map_id: str, entry: str) -> dict:
    key = _key(login=login, map_id=map_id, entry=entry)
    running = state.turns.running(key)
    proposed = state.store.proposed_trace(login=login, map_id=map_id, entry_id=entry)
    return {
        "trace": state.store.latest_trace(login=login, map_id=map_id, entry_id=entry),
        "starting": proposed["inputs"] if proposed else None,
        "running": running,
        "error": None if running else _last_errors.get(key),
    }


def _check(text: str, saved: dict, entry: str, inputs: list[dict] | None):
    data, problems = logic.parse_answer(text)
    if problems:
        return None, problems
    return walkthrough.validate_trace(data, blocks=saved["blocks"], entry_id=entry, inputs=inputs)


async def run_walk(*, state, client, token: str, login: str, saved: dict, entry: str,
                   inputs: list[dict] | None, emit) -> None:
    pr = PRRef(saved["owner"], saved["repo"], saved["number"])
    sha = saved["headSha"]
    key = _key(login=login, map_id=saved["id"], entry=entry)

    def fail(message: str) -> None:
        _last_errors[key] = message
        emit({"type": "error", "text": message})

    try:
        if not state.checkouts.has_clone(owner=pr.owner, repo=pr.repo):
            emit({"type": "tool", "text": f"Cloning {pr.owner}/{pr.repo}…"})
        cwd = await state.checkouts.worktree(owner=pr.owner, repo=pr.repo, sha=sha, token=token)
        emit({"type": "tool", "text": "Reading the PR…"})
        overview = await client.overview(pr)
        snapshot, _ = await pr_snapshot(client=client, pr=pr, overview=overview, cwd=cwd, sha=sha)
        block = logic.find_block(saved["blocks"], entry)
        ask = (walkthrough.propose_request(saved["blocks"], block) if inputs is None
               else walkthrough.fixed_request(saved["blocks"], block, inputs))
        common = dict(state=state, cwd=cwd, snapshot=snapshot, emit=emit,
                      system=walkthrough.WALK_SYSTEM_PROMPT, writing="Writing the trace…")

        text, session = await ask_json(question=ask, full_prompt=ask, session_id=None, **common)
        result, problems = _check(text, saved, entry, inputs)
        if problems:
            emit({"type": "tool", "text": "Fixing the trace…"})
            repair = walkthrough.repair_request(problems)
            # If the session has expired, the replay still needs the first answer to fix it.
            full = f"{ask}\n\nYour previous answer:\n{text}\n\n{repair}"
            text, session = await ask_json(question=repair, full_prompt=full, session_id=session, **common)
            result, problems = _check(text, saved, entry, inputs)
        if problems:
            shown = "; ".join(problems[:5]) + (f" (and {len(problems) - 5} more)" if len(problems) > 5 else "")
            fail(f"Claude's walkthrough didn't pass validation: {shown}")
            return
        trace_id = state.store.save_trace(
            login=login, map_id=saved["id"], entry_id=entry,
            input_hash=walkthrough.input_hash(walkthrough.values_of(result["inputs"])),
            inputs=result["inputs"], steps=result["steps"], outcome=result["outcome"],
            proposed=inputs is None,
        )
        emit({"type": "done", "traceId": trace_id})
    except CommitGone as exc:
        fail(str(exc))
    except CheckoutError as exc:
        fail(f"Couldn't fetch the repository: {exc}")
    except GitHubError as exc:
        fail(f"Couldn't read the PR from GitHub: {exc}")
    except Exception as exc:  # noqa: BLE001 — any SDK failure is shown in the panel
        fail(claude.describe_error(exc))


@router.get("/api/logic/{map_id}/walkthrough")
async def walk_state(request: Request, map_id: str, entry: str):
    state, _, login, _ = await _walk_map(request, map_id, entry)
    return _state(state=state, login=login, map_id=map_id, entry=entry)


@router.post("/api/logic/{map_id}/walkthrough")
async def walk_run(request: Request, map_id: str, body: WalkRequest):
    state, client, login, saved = await _walk_map(request, map_id, body.entry)
    key = _key(login=login, map_id=map_id, entry=body.entry)
    if state.turns.running(key):
        return _state(state=state, login=login, map_id=map_id, entry=body.entry)

    inputs = None
    if body.inputs is not None:
        proposed = state.store.proposed_trace(login=login, map_id=map_id, entry_id=body.entry)
        if not proposed:
            raise HTTPException(400, "This entry has no starting inputs yet")
        if set(body.inputs) != {i["name"] for i in proposed["inputs"]}:
            raise HTTPException(400, "The inputs must have the same names as the starting inputs")
        cached = state.store.trace_by_hash(login=login, map_id=map_id, entry_id=body.entry,
                                           input_hash=walkthrough.input_hash(body.inputs))
        if cached:
            state.store.touch_trace(trace_id=cached["id"])
            return _state(state=state, login=login, map_id=map_id, entry=body.entry)
        inputs = [{**i, "value": body.inputs[i["name"]]} for i in proposed["inputs"]]
    else:
        proposed = state.store.proposed_trace(login=login, map_id=map_id, entry_id=body.entry)
        if proposed:
            state.store.touch_trace(trace_id=proposed["id"])
            return _state(state=state, login=login, map_id=map_id, entry=body.entry)

    _last_errors.pop(key, None)
    token = await state.session.token()
    state.turns.start(
        thread_id=key,
        work=lambda emit: run_walk(state=state, client=client, token=token, login=login, saved=saved,
                                   entry=body.entry, inputs=inputs, emit=emit),
    )
    return _state(state=state, login=login, map_id=map_id, entry=body.entry)


@router.get("/api/logic/{map_id}/walkthrough/events")
async def walk_events(request: Request, map_id: str, entry: str):
    state, _, login, _ = await _walk_map(request, map_id, entry)
    key = _key(login=login, map_id=map_id, entry=entry)

    async def stream():
        if not state.turns.running(key):
            yield f"data: {json.dumps({'type': 'idle'})}\n\n"
            return
        async for event in state.turns.subscribe(key):
            yield f"data: {json.dumps(event)}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


@router.get("/api/logic/traces/{trace_id}")
async def get_trace(request: Request, trace_id: str):
    state, _, login = await _signed_in(request)
    trace = state.store.trace(login=login, trace_id=trace_id)
    if not trace:
        raise HTTPException(404, "No such trace")
    return trace
```

In `src/spec_tackle/app.py`, add `walkthrough_api` to the `from . import ...` line, and add `app.include_router(walkthrough_api.router)` right after `app.include_router(logic_api.router)`.

- [ ] **Step 5: Run the tests**

Run: `uv run pytest tests/test_walkthrough_api.py tests/test_logic_api.py -q`
Expected: all PASS. If `test_without_claude_there_is_no_walkthrough` gets 401 or 500, look at how `_signed_in` handles `claude_cli is None` (`logic_api.generate` depends on the same behaviour) and match it.

- [ ] **Step 6: Run the whole backend suite**

Run: `uv run pytest -q`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/spec_tackle/logic_api.py src/spec_tackle/walkthrough_api.py src/spec_tackle/app.py tests/test_walkthrough_api.py
git commit -m "feat: run Logic walkthroughs in the background

Claude traces an entry's inputs by reading the code, through the same
read-only session as the map. Traces are cached per map, entry and
input values.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Frontend types, queries and `lib/walkthrough.ts`

**Files:**
- Modify: `frontend/src/api/types.ts` (append the walkthrough types)
- Modify: `frontend/src/api/queries.ts` (append `walkKey` and `useWalkthrough`)
- Modify: `frontend/src/lib/logicFlow.ts` (export `edgeId`; `withoutTests` takes an optional `keep` set)
- Create: `frontend/src/lib/walkthrough.ts`
- Test: `frontend/src/lib/walkthrough.test.ts`, `frontend/src/lib/logicFlow.test.ts` (append)

**Interfaces:**
- Produces (types):
  ```ts
  export type WalkInput = { name: string; description: string; value: unknown };
  export type DangerKind = "destructive" | "external" | "unsafe" | "irreversible";
  export type Danger = { kind: DangerKind; note: string };
  export type WalkStep = { blockId: string; input: unknown; output: unknown; note: string; assumed?: string[]; danger?: Danger[] };
  export type WalkOutcome = { kind: "exit" | "error" | "stopped"; message: string };
  export type Trace = { id: string; mapId: string; entryId: string; inputs: WalkInput[]; steps: WalkStep[]; outcome: WalkOutcome; proposed: boolean; usedAt: string };
  export type WalkState = { trace: Trace | null; starting: WalkInput[] | null; running: boolean; error: string | null };
  ```
- Produces (queries): `walkKey(mapId: string, entry: string)`, `useWalkthrough(mapId: string, entry: string | null)`
- Produces (`lib/logicFlow.ts`): `export const edgeId`; `withoutTests(blocks, keep?: Set<string>)`. A test block is kept when it, or any block inside it, is in `keep`.
- Produces (`lib/walkthrough.ts`):
  - `entries(blocks: LogicBlock[]): LogicBlock[]`: breadth-first
  - `pathBlocks(blocks: LogicBlock[], steps: WalkStep[]): Set<string>`: the step leaves and all their ancestors
  - `containing(blocks: LogicBlock[], steps: WalkStep[]): Set<string>`: the ancestors only (blocks to expand)
  - `takenEdges(blocks: LogicBlock[], steps: WalkStep[], upTo: number): Set<string>`: edge ids
  - `edgeWalkClass(id: string, taken: Set<string>, path: Set<string>): string`: `"walk-taken"`, `"walk-dim"` or `""`
  - `type Highlight = Set<string> | "all" | null`; `changedKeys(input: unknown, output: unknown): Highlight`
  - `stepForBlock(steps: WalkStep[], blockId: string, reached: number): number | null`
  - `dangerSteps(steps: WalkStep[]): { index: number; kinds: DangerKind[] }[]`
  - `type WalkMark = { current: boolean; visited: boolean; step: number | null; dim: boolean; danger: DangerKind[] }`
  - `walkMarks(blocks: LogicBlock[], steps: WalkStep[], current: number): Map<string, WalkMark>`
  - `DANGER_LABEL: Record<DangerKind, string>`

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/src/lib/walkthrough.test.ts
import type { LogicBlock, WalkStep } from "../api/types";
import { changedKeys, containing, dangerSteps, edgeWalkClass, entries, pathBlocks, stepForBlock, takenEdges, walkMarks } from "./walkthrough";

const b = (id: string, over: Partial<LogicBlock> = {}): LogicBlock => ({ id, label: id, kind: "step", change: "added", next: [], ...over });
// send -> retry[ job(entry) -> backoff ] -> give-up ; retry also -> alt
const BLOCKS: LogicBlock[] = [
  b("send", { kind: "entry", next: [{ to: "retry" }] }),
  b("retry", { kind: "loop", next: [{ to: "give-up", label: "5 tries" }, { to: "alt" }], children: [
    b("job", { kind: "entry", next: [{ to: "backoff" }] }),
    b("backoff"),
  ] }),
  b("give-up", { kind: "exit" }),
  b("alt"),
];
const s = (blockId: string, over: Partial<WalkStep> = {}): WalkStep => ({ blockId, input: {}, output: {}, note: "n", ...over });
const STEPS = [s("send"), s("job"), s("backoff"), s("backoff"), s("give-up", { danger: [{ kind: "destructive", note: "d" }] })];

test("entries are listed top level first", () => {
  expect(entries(BLOCKS).map((e) => e.id)).toEqual(["send", "job"]);
});

test("path blocks include ancestors; containing is only the ancestors", () => {
  expect([...pathBlocks(BLOCKS, STEPS)].sort()).toEqual(["backoff", "give-up", "job", "retry", "send"]);
  expect([...containing(BLOCKS, STEPS)]).toEqual(["retry"]);
});

test("taken edges join steps across levels, skip repeats and missing edges", () => {
  expect([...takenEdges(BLOCKS, STEPS, 4)].sort()).toEqual(["job>backoff#0", "retry>give-up#0", "send>retry#0"]);
  expect([...takenEdges(BLOCKS, STEPS, 1)]).toEqual(["send>retry#0"]);
  expect([...takenEdges(BLOCKS, [s("give-up"), s("send")], 1)]).toEqual([]); // no such edge
});

test("edge classes", () => {
  const taken = new Set(["a"]);
  const path = new Set(["a", "b"]);
  expect(edgeWalkClass("a", taken, path)).toBe("walk-taken");
  expect(edgeWalkClass("b", taken, path)).toBe("");
  expect(edgeWalkClass("c", taken, path)).toBe("walk-dim");
});

test("changed keys", () => {
  expect(changedKeys({ a: 1, b: { x: 1, y: 2 } }, { a: 1, b: { y: 2, x: 1 }, c: 3 })).toEqual(new Set(["c"]));
  expect(changedKeys({ a: 1 }, { a: 2 })).toEqual(new Set(["a"]));
  expect(changedKeys("x", "y")).toBe("all");
  expect(changedKeys([1], [1])).toBeNull();
  expect(changedKeys({ a: 1 }, [1])).toBe("all");
});

test("a block's step is its latest visit up to the furthest step reached", () => {
  expect(stepForBlock(STEPS, "backoff", 4)).toBe(3);
  expect(stepForBlock(STEPS, "backoff", 2)).toBe(2);
  expect(stepForBlock(STEPS, "give-up", 3)).toBeNull();
  expect(stepForBlock(STEPS, "alt", 4)).toBeNull();
});

test("danger steps", () => {
  expect(dangerSteps(STEPS)).toEqual([{ index: 4, kinds: ["destructive"] }]);
});

test("walk marks", () => {
  const marks = walkMarks(BLOCKS, STEPS, 3);
  expect(marks.get("backoff")).toEqual({ current: true, visited: true, step: 4, dim: false, danger: [] });
  expect(marks.get("send")).toMatchObject({ current: false, visited: true, step: 1 });
  expect(marks.get("give-up")).toEqual({ current: false, visited: false, step: null, dim: false, danger: ["destructive"] });
  expect(marks.get("alt")).toMatchObject({ dim: true, visited: false });
  expect(marks.get("retry")).toMatchObject({ dim: false, visited: false });
});
```

Append to `frontend/src/lib/logicFlow.test.ts`:

```ts
test("withoutTests keeps test blocks that are in the keep set", () => {
  const blocks: LogicBlock[] = [
    { id: "a", label: "A", kind: "entry", change: "added", next: [{ to: "t" }] },
    { id: "t", label: "Test: it works", kind: "step", change: "added", next: [] },
  ];
  expect(withoutTests(blocks).blocks.map((x) => x.id)).toEqual(["a"]);
  const kept = withoutTests(blocks, new Set(["t"]));
  expect(kept.blocks.map((x) => x.id)).toEqual(["a", "t"]);
  expect(kept.blocks[0].next).toEqual([{ to: "t" }]);
});
```

If `LogicBlock` or `withoutTests` isn't already imported at the top of `logicFlow.test.ts`, add them to the existing imports.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/lib/walkthrough.test.ts src/lib/logicFlow.test.ts`
Expected: FAIL (cannot resolve `./walkthrough`; `withoutTests` ignores `keep`)

- [ ] **Step 3: Add the types and queries**

Append to `frontend/src/api/types.ts`:

```ts
/** The Logic walkthrough: one traced run from an entry block (docs/specs/2026-10-10-logic-walkthrough-design.md). */
export type WalkInput = { name: string; description: string; value: unknown };
export type DangerKind = "destructive" | "external" | "unsafe" | "irreversible";
export type Danger = { kind: DangerKind; note: string };
export type WalkStep = { blockId: string; input: unknown; output: unknown; note: string; assumed?: string[]; danger?: Danger[] };
export type WalkOutcome = { kind: "exit" | "error" | "stopped"; message: string };
export type Trace = {
  id: string; mapId: string; entryId: string; inputs: WalkInput[]; steps: WalkStep[];
  outcome: WalkOutcome; proposed: boolean; usedAt: string;
};
/** GET/POST /api/logic/{map}/walkthrough. `starting` holds Claude's proposed inputs, which Reset restores. */
export type WalkState = { trace: Trace | null; starting: WalkInput[] | null; running: boolean; error: string | null };
```

Append to `frontend/src/api/queries.ts`, and add `WalkState` to the type import at the top:

```ts
export const walkKey = (mapId: string, entry: string) => ["walk", mapId, entry];

/** The walkthrough for one entry of a map: its latest trace, starting inputs and run state. */
export function useWalkthrough(mapId: string, entry: string | null) {
  return useQuery({
    queryKey: walkKey(mapId, entry ?? ""),
    queryFn: () => request<WalkState>("GET", `/api/logic/${encodeURIComponent(mapId)}/walkthrough?entry=${encodeURIComponent(entry!)}`),
    enabled: !!entry,
  });
}
```

- [ ] **Step 4: Update `logicFlow.ts`**

Change `const edgeId = ...` to `export const edgeId = ...`. Replace `withoutTests` with:

```ts
/**
 * The tree without test blocks (at any level) and without edges to them; `hidden` counts what was dropped.
 * Blocks in `keep`, or holding one, stay: a walkthrough's path is drawn even when it runs through tests.
 */
export function withoutTests(blocks: LogicBlock[], keep: Set<string> = new Set()): { blocks: LogicBlock[]; hidden: number } {
  let hidden = 0;
  const holds = (b: LogicBlock): boolean => keep.has(b.id) || (b.children ?? []).some(holds);
  const prune = (list: LogicBlock[]): LogicBlock[] => {
    const kept = list.filter((b) => {
      if (!isTestBlock(b) || holds(b)) return true;
      hidden += 1;
      return false;
    });
    const ids = new Set(kept.map((b) => b.id));
    return kept.map((b) => ({
      ...b,
      next: b.next.filter((e) => ids.has(e.to)),
      ...(b.children ? { children: prune(b.children) } : {}),
    }));
  };
  return { blocks: prune(blocks), hidden };
}
```

- [ ] **Step 5: Write `lib/walkthrough.ts`**

```ts
/** The Logic walkthrough's path through the map: what to expand, ring, dim and highlight. Pure; no React. */
import type { DangerKind, LogicBlock, WalkStep } from "../api/types";
import { edgeId } from "./logicFlow";

export const DANGER_LABEL: Record<DangerKind, string> = {
  destructive: "Destructive", external: "External effect", unsafe: "Unsafe", irreversible: "Irreversible",
};

/** Every entry block, top level first, then each deeper level. */
export function entries(blocks: LogicBlock[]): LogicBlock[] {
  const found: LogicBlock[] = [];
  for (let level = blocks; level.length; level = level.flatMap((b) => b.children ?? [])) {
    found.push(...level.filter((b) => b.kind === "entry"));
  }
  return found;
}

/** Each block's parent id (top-level blocks map to null), and each block by id. */
function index(blocks: LogicBlock[]) {
  const parent = new Map<string, string | null>();
  const byId = new Map<string, LogicBlock>();
  const walk = (list: LogicBlock[], up: string | null) => list.forEach((b) => {
    parent.set(b.id, up);
    byId.set(b.id, b);
    walk(b.children ?? [], b.id);
  });
  walk(blocks, null);
  return { parent, byId };
}

/** `id` and every block above it, innermost first. */
function chain(parent: Map<string, string | null>, id: string): string[] {
  const out: string[] = [];
  for (let at: string | null | undefined = id; at; at = parent.get(at)) out.push(at);
  return out;
}

export function pathBlocks(blocks: LogicBlock[], steps: WalkStep[]): Set<string> {
  const { parent } = index(blocks);
  return new Set(steps.flatMap((s) => (parent.has(s.blockId) ? chain(parent, s.blockId) : [])));
}

export function containing(blocks: LogicBlock[], steps: WalkStep[]): Set<string> {
  const leaves = new Set(steps.map((s) => s.blockId));
  return new Set([...pathBlocks(blocks, steps)].filter((id) => !leaves.has(id)));
}

/**
 * The edges walked between consecutive steps up to `upTo`: for steps a then b, the edge from a's
 * ancestor to b's ancestor in the lowest list holding both (an ancestor includes the block itself).
 */
export function takenEdges(blocks: LogicBlock[], steps: WalkStep[], upTo: number): Set<string> {
  const { parent, byId } = index(blocks);
  const taken = new Set<string>();
  for (let i = 1; i <= Math.min(upTo, steps.length - 1); i++) {
    const a = steps[i - 1].blockId;
    const b = steps[i].blockId;
    if (a === b || !parent.has(a) || !parent.has(b)) continue;
    const chainB = chain(parent, b);
    for (const x of chain(parent, a)) {
      const y = chainB.find((id) => parent.get(id) === parent.get(x));
      if (y === undefined) continue;
      if (y !== x) {
        const at = byId.get(x)!.next.findIndex((e) => e.to === y);
        if (at >= 0) taken.add(edgeId(x, y, at));
      }
      break;
    }
  }
  return taken;
}

export function edgeWalkClass(id: string, taken: Set<string>, path: Set<string>): string {
  if (taken.has(id)) return "walk-taken";
  return path.has(id) ? "" : "walk-dim";
}

export type Highlight = Set<string> | "all" | null;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** JSON with object keys sorted, so key order never counts as a change. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (isObject(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

/** Output keys that are new or differ from the input; "all" when either isn't an object and they differ. */
export function changedKeys(input: unknown, output: unknown): Highlight {
  if (isObject(input) && isObject(output)) {
    return new Set(Object.keys(output).filter((k) => !(k in input) || stable(input[k]) !== stable(output[k])));
  }
  return stable(input) === stable(output) ? null : "all";
}

/** The latest step on `blockId` at or before `reached`, or null if it hasn't been visited yet. */
export function stepForBlock(steps: WalkStep[], blockId: string, reached: number): number | null {
  for (let i = Math.min(reached, steps.length - 1); i >= 0; i--) if (steps[i].blockId === blockId) return i;
  return null;
}

export function dangerSteps(steps: WalkStep[]): { index: number; kinds: DangerKind[] }[] {
  return steps.flatMap((s, index) =>
    s.danger?.length ? [{ index, kinds: [...new Set(s.danger.map((d) => d.kind))] }] : []);
}

export type WalkMark = { current: boolean; visited: boolean; step: number | null; dim: boolean; danger: DangerKind[] };

/** How each block of the map is drawn while the walkthrough is at step `current`. */
export function walkMarks(blocks: LogicBlock[], steps: WalkStep[], current: number): Map<string, WalkMark> {
  const { byId } = index(blocks);
  const path = pathBlocks(blocks, steps);
  const marks = new Map<string, WalkMark>();
  for (const id of byId.keys()) {
    const step = stepForBlock(steps, id, current);
    const danger = [...new Set(steps.filter((s) => s.blockId === id).flatMap((s) => (s.danger ?? []).map((d) => d.kind)))];
    marks.set(id, {
      current: steps[current]?.blockId === id,
      visited: step !== null,
      step: step === null ? null : step + 1,
      dim: !path.has(id),
      danger,
    });
  }
  return marks;
}
```

- [ ] **Step 6: Run the tests and the typecheck**

Run: `cd frontend && npx vitest run src/lib && npm run typecheck`
Expected: PASS

- [ ] **Step 7: Rebuild and commit**

```bash
cd frontend && npm run build && cd ..
git add frontend/src/api frontend/src/lib src/spec_tackle/static/dist
git commit -m "feat(frontend): work out a walkthrough's path through the Logic map

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Draw walk marks on the chart

**Files:**
- Modify: `frontend/src/pages/logic/FlowChart.tsx`
- Modify: `frontend/src/styles/app.css` (walkthrough styles after the `.logic-item` rules)
- Test: `frontend/src/pages/logic/FlowChart.test.tsx` (new)

**Interfaces:**
- Consumes: `WalkMark`, `edgeWalkClass`, `DANGER_LABEL` from Task 4.
- Produces: the `FlowChart` prop `walk?: Walk | null`, where
  `export type Walk = { marks: Map<string, WalkMark>; taken: Set<string>; path: Set<string> }`,
  exported from `lib/walkthrough.ts` so `LogicView` doesn't import the lazily loaded chart.
  `blockLabel(b, expanded, danger?: DangerKind[])` appends `; flagged as dangerous: <labels>`.

- [ ] **Step 1: Add the `Walk` type to `lib/walkthrough.ts`**

```ts
/** What the chart needs to draw a walkthrough: per-block marks, edges walked so far, and the whole path's edges. */
export type Walk = { marks: Map<string, WalkMark>; taken: Set<string>; path: Set<string> };
```

- [ ] **Step 2: Write the failing test**

```tsx
// frontend/src/pages/logic/FlowChart.test.tsx
import { render, screen } from "@testing-library/react";
import type { LogicBlock } from "../../api/types";
import { walkMarks } from "../../lib/walkthrough";
import { stubReactFlowEnvironment } from "../../test/reactFlow";
import FlowChart from "./FlowChart";

const BLOCKS: LogicBlock[] = [
  { id: "send", label: "Form is sent", kind: "entry", change: "unchanged", next: [{ to: "drop" }] },
  { id: "drop", label: "Drop the queue", kind: "exit", change: "added", next: [] },
  { id: "alt", label: "Another path", kind: "step", change: "added", next: [] },
];
const STEPS = [
  { blockId: "send", input: {}, output: {}, note: "n" },
  { blockId: "drop", input: {}, output: {}, note: "n", danger: [{ kind: "destructive" as const, note: "Deletes it" }] },
];

beforeEach(() => stubReactFlowEnvironment());
afterEach(() => vi.unstubAllGlobals());

test("walk marks ring the current step, number visited ones, flag danger and dim the rest", async () => {
  const walk = { marks: walkMarks(BLOCKS, STEPS, 0), taken: new Set<string>(), path: new Set(["send>drop#0"]) };
  render(<FlowChart blocks={BLOCKS} expanded={new Set()} selected={null} walk={walk} onActivate={vi.fn()} onFailed={vi.fn()} />);

  const send = await screen.findByRole("button", { name: /^Form is sent/ });
  expect(send).toHaveClass("walk-current");
  expect(send.querySelector(".walk-step")).toHaveTextContent("1");

  const drop = screen.getByRole("button", { name: /^Drop the queue/ });
  expect(drop).not.toHaveClass("walk-visited");
  expect(drop.querySelector(".walk-danger")).toHaveTextContent("⚠");
  expect(drop).toHaveAccessibleName(/flagged as dangerous: Destructive/);

  expect(screen.getByRole("button", { name: /^Another path/ })).toHaveClass("walk-dim");
});

test("without a walk nothing is marked", async () => {
  render(<FlowChart blocks={BLOCKS} expanded={new Set()} selected={null} onActivate={vi.fn()} onFailed={vi.fn()} />);
  const send = await screen.findByRole("button", { name: /^Form is sent/ });
  expect(send.className).not.toMatch(/walk-/);
  expect(document.querySelector(".walk-step, .walk-danger")).toBeNull();
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd frontend && npx vitest run src/pages/logic/FlowChart.test.tsx`
Expected: FAIL (no `walk-current` class)

- [ ] **Step 4: Implement in `FlowChart.tsx`**

1. Imports:
   - add `type DangerKind` to the `../../api/types` import;
   - add `import { DANGER_LABEL, edgeWalkClass, type Walk, type WalkMark } from "../../lib/walkthrough";`.
2. Add `walk?: Walk | null;` to `Props`, documented as `/** A walkthrough's marks, while its panel is open. */`.
3. Replace `blockLabel`:

```ts
/** What a screen reader hears, and what a hover shows. */
export function blockLabel(b: LogicBlock, expanded: boolean, danger: DangerKind[] = []): string {
  const flagged = danger.length ? `; flagged as dangerous: ${danger.map((k) => DANGER_LABEL[k]).join(", ")}` : "";
  if (expanded) return `⊖ ${b.label}: show its code; Ctrl-click to collapse${flagged}`;
  const more = !!b.children?.length;
  return `${b.label}${more ? " ⊕" : ""}: ${b.kind}, show its code${more ? "; Ctrl-click to expand" : ""}${flagged}`;
}
```

4. Add `walk: Walk | null` to the `Ctx` type and pass it through the provider:
   - in `FlowChart`, destructure `walk = null`;
   - write `const ctx = useMemo(() => ({ selected, onActivate, activated, walk }), [selected, onActivate, walk]);`;
   - pass `walk={walk}` to `<Flow>`.
5. Add the helpers:

```tsx
function walkClass(m: WalkMark | undefined): string {
  if (!m) return "";
  return [m.current && "walk-current", m.visited && !m.current && "walk-visited", m.dim && "walk-dim"].filter(Boolean).join(" ");
}

function WalkBadges({ mark }: { mark: WalkMark | undefined }) {
  if (!mark) return null;
  return (
    <>
      {mark.step !== null && <span className="walk-step" aria-hidden="true">{mark.step}</span>}
      {mark.danger.length > 0 && <span className="walk-danger" aria-hidden="true">⚠</span>}
    </>
  );
}
```

6. In `Card`:
   - read `const { walk } = useContext(FlowCtx); const mark = walk?.marks.get(b.id);`;
   - use `const label = blockLabel(b, false, mark?.danger);`;
   - append `${walkClass(mark)}` to the `className`;
   - render `<WalkBadges mark={mark} />` right after `<Handles />`.
7. In `Box`, do the same as in `Card`, with `blockLabel(b, true, mark?.danger)`.
8. Edges: `Flow` takes `walk` as a prop. Inside the `edges` `useMemo`, compute
   `const cls = walk ? edgeWalkClass(e.id, walk.taken, walk.path) : "";`. Each edge gets:
   - `className: cls || undefined`;
   - `markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, ...(cls === "walk-taken" ? { color: "#2563eb" } : {}) }`;
   - `style: cls === "walk-taken" ? { strokeWidth: 3, stroke: "#2563eb" } : { strokeWidth: 1.5 }`.

   Add `walk` to the memo's dependency list.

Append to `frontend/src/styles/app.css`:

```css
/* Logic walkthrough (docs/specs/2026-10-10-logic-walkthrough-design.md) */
.logic-flow .logic-card, .logic-flow .logic-box { position: relative; } /* anchors the step and danger badges */
.logic-flow .walk-current { box-shadow: 0 0 0 4px #2563eb, 0 6px 18px rgba(37, 99, 235, .35); }
.logic-flow .walk-visited { box-shadow: 0 0 0 3px rgba(37, 99, 235, .35); }
.logic-flow .walk-dim { opacity: .3; }
.logic-flow .react-flow__edge.walk-dim { opacity: .25; }
.walk-step, .walk-danger { position: absolute; top: -10px; display: flex; align-items: center; justify-content: center; height: 20px; min-width: 20px; padding: 0 5px; border-radius: 999px; font-size: 11px; font-weight: 700; color: #fff; }
.walk-step { left: -10px; background: #2563eb; }
.walk-danger { right: -10px; background: #dc2626; }
.walk-json { margin: 0; overflow-x: auto; border-radius: .5rem; border: 1px solid var(--paper-border); background: var(--code-bg); font-size: 12px; line-height: 1.5; padding: .25rem 0; }
.walk-json > div { white-space: pre; padding: 0 .75rem; }
.walk-json > div.changed { background: rgba(16, 185, 129, .12); box-shadow: inset 3px 0 0 #10b981; }
.walk-json.error { border-color: #f87171; background: #fef2f2; }
:root.dark .walk-json.error { background: rgba(127, 29, 29, .35); }
```

- [ ] **Step 5: Run the logic tests and the typecheck**

Run: `cd frontend && npx vitest run src/pages/logic && npm run typecheck`
Expected: PASS. The existing `LogicView.test.tsx` must stay green, and `blockLabel` without danger is unchanged.

- [ ] **Step 6: Rebuild and commit**

```bash
cd frontend && npm run build && cd ..
git add frontend/src src/spec_tackle/static/dist
git commit -m "feat(frontend): draw a walkthrough's path on the Logic map

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: `useWalk`: data, runs and progress

**Files:**
- Create: `frontend/src/pages/logic/useWalk.ts`
- Test: `frontend/src/pages/logic/useWalk.test.tsx`

**Interfaces:**
- Consumes: `useWalkthrough` and `walkKey` (Task 4); `request` from `../../api/request`.
- Produces:
  ```ts
  export type WalkRun = {
    data: WalkState | undefined;
    loadError: Error | null;
    progress: string | null;   // non-null while a run is going
    error: string | null;      // this tab's failure, or the server's last one
    posting: boolean;
    run: (inputs?: Record<string, unknown>) => Promise<void>;
  };
  export function useWalk(mapId: string, entry: string | null): WalkRun;
  ```
  - When the entry has no starting inputs and nothing is running or failed, it POSTs once to propose, once per map and entry per mount.
  - It streams `/api/logic/{map}/walkthrough/events?entry=` while running.
  - On `done`, `error` or `idle` it refetches the state.

- [ ] **Step 1: Write the failing tests**

```tsx
// frontend/src/pages/logic/useWalk.test.tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { WalkState } from "../../api/types";
import { useWalk } from "./useWalk";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  constructor(public url: string) { FakeEventSource.instances.push(this); }
  send(event: object) { act(() => this.onmessage?.({ data: JSON.stringify(event) })); }
}

const URL_ = "/api/logic/m1/walkthrough";
const empty: WalkState = { trace: null, starting: null, running: false, error: null };
let current: WalkState;
let posts: unknown[];

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  current = empty;
  posts = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ ...current, running: true }));
    }
    if (url === `${URL_}?entry=send`) return new Response(JSON.stringify(current));
    return new Response("{}", { status: 404 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
);

test("an entry without starting inputs proposes once, and follows the run", async () => {
  const { result } = renderHook(() => useWalk("m1", "send"), { wrapper });
  await waitFor(() => expect(posts).toEqual([{ entry: "send" }]));
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  const source = FakeEventSource.instances[0];
  expect(source.url).toBe(`${URL_}/events?entry=send`);
  source.send({ type: "tool", text: "Reading app/visits.py" });
  expect(result.current.progress).toBe("Reading app/visits.py");
  current = { ...empty, starting: [{ name: "a", description: "d", value: 1 }] };
  source.send({ type: "done", traceId: "t1" });
  await waitFor(() => expect(result.current.data?.starting).toHaveLength(1));
  expect(result.current.progress).toBeNull();
  expect(posts).toHaveLength(1);
});

test("a failed proposal is shown and not retried by itself", async () => {
  const { result } = renderHook(() => useWalk("m1", "send"), { wrapper });
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  current = { ...empty, error: "Claude's walkthrough didn't pass validation: x" };
  FakeEventSource.instances[0].send({ type: "error", text: "Claude's walkthrough didn't pass validation: x" });
  await waitFor(() => expect(result.current.error).toMatch(/didn't pass validation/));
  await new Promise((r) => setTimeout(r, 50));
  expect(posts).toHaveLength(1);
});

test("run sends the inputs", async () => {
  current = { ...empty, starting: [{ name: "a", description: "d", value: 1 }] };
  const { result } = renderHook(() => useWalk("m1", "send"), { wrapper });
  await waitFor(() => expect(result.current.data).toBeDefined());
  await act(() => result.current.run({ a: 2 }));
  expect(posts).toEqual([{ entry: "send", inputs: { a: 2 } }]);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd frontend && npx vitest run src/pages/logic/useWalk.test.tsx`
Expected: FAIL (cannot resolve `./useWalk`)

- [ ] **Step 3: Write `useWalk.ts`**

```ts
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useWalkthrough, walkKey } from "../../api/queries";
import { request } from "../../api/request";
import type { WalkState } from "../../api/types";

export type WalkRun = {
  data: WalkState | undefined;
  loadError: Error | null;
  /** Claude's latest activity while a run is going; null otherwise. */
  progress: string | null;
  error: string | null;
  posting: boolean;
  run: (inputs?: Record<string, unknown>) => Promise<void>;
};

/** One entry's walkthrough: its state, a run (proposing without inputs), and the run's progress. */
export function useWalk(mapId: string, entry: string | null): WalkRun {
  const query = useWalkthrough(mapId, entry);
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  // Each entry proposes by itself at most once per mount; after a failure, Try again does it.
  const proposed = useRef(new Set<string>());
  const url = `/api/logic/${encodeURIComponent(mapId)}/walkthrough`;

  useEffect(() => { setProgress(null); setError(null); }, [mapId, entry]);

  const run = async (inputs?: Record<string, unknown>) => {
    if (!entry) return;
    setError(null);
    setPosting(true);
    try {
      const state = await request<WalkState>("POST", url, inputs === undefined ? { entry } : { entry, inputs });
      queryClient.setQueryData(walkKey(mapId, entry), state);
      if (state.running) setProgress("Starting…");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPosting(false);
    }
  };

  const data = query.data;
  // Rejoin a run that's already going (another tab, or before a reload).
  useEffect(() => {
    if (data?.running && progress === null) setProgress("Working…");
  }, [data?.running, progress]);

  useEffect(() => {
    if (!entry || !data || data.starting || data.running || data.error || posting || progress !== null) return;
    const key = `${mapId}:${entry}`;
    if (proposed.current.has(key)) return;
    proposed.current.add(key);
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, entry, mapId, posting, progress]);

  const streaming = progress !== null;
  useEffect(() => {
    if (!streaming || !entry) return;
    const source = new EventSource(`${url}/events?entry=${encodeURIComponent(entry)}`);
    const end = () => {
      source.close();
      // Until the refetch lands, the cached state still says running; without this, the
      // rejoin effect above would open the stream again.
      queryClient.setQueryData<WalkState>(walkKey(mapId, entry), (old) => old && { ...old, running: false });
      setProgress(null);
      void queryClient.invalidateQueries({ queryKey: walkKey(mapId, entry) });
    };
    source.onmessage = (e) => {
      const event = JSON.parse(e.data) as { type: string; text?: string };
      if (event.type === "tool") setProgress(event.text ?? "Working…");
      else {
        if (event.type === "error") setError(event.text ?? "The walkthrough failed");
        end();
      }
    };
    source.onerror = end;
    return () => source.close();
  }, [streaming, entry, mapId, url, queryClient]);

  return {
    data,
    loadError: (query.error as Error | null) ?? null,
    progress,
    error: progress ? null : error ?? data?.error ?? null,
    posting,
    run,
  };
}
```

Check that `request(method, url, body)` in `frontend/src/api/request.ts` takes a body as its third argument and sends it as JSON. If its signature differs, adapt the call.

- [ ] **Step 4: Run the tests**

Run: `cd frontend && npx vitest run src/pages/logic/useWalk.test.tsx && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Rebuild and commit**

```bash
cd frontend && npm run build && cd ..
git add frontend/src src/spec_tackle/static/dist
git commit -m "feat(frontend): load, run and follow Logic walkthroughs

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: `WalkthroughPanel`

**Files:**
- Create: `frontend/src/pages/logic/WalkthroughPanel.tsx`
- Test: `frontend/src/pages/logic/WalkthroughPanel.test.tsx`

**Interfaces:**
- Consumes: `WalkRun` (Task 6); `changedKeys`, `dangerSteps`, `DANGER_LABEL` (Task 4); `LogicBlock`, `Trace`, `WalkInput` types.
- Produces:
  ```ts
  type Props = {
    entries: LogicBlock[];        // for the picker
    entry: string;
    onEntry: (id: string) => void;
    blocks: Map<string, LogicBlock>;  // every block of the map by id, for step labels
    walk: WalkRun;
    step: number;
    onStep: (n: number) => void;
    onShowCode: (block: LogicBlock) => void;
    onClose: () => void;
  };
  export function WalkthroughPanel(props: Props): JSX.Element;
  ```
  It renders `<aside aria-label="Walkthrough">`.

- [ ] **Step 1: Write the failing tests**

```tsx
// frontend/src/pages/logic/WalkthroughPanel.test.tsx
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { LogicBlock, Trace, WalkInput, WalkState } from "../../api/types";
import type { WalkRun } from "./useWalk";
import { WalkthroughPanel } from "./WalkthroughPanel";

const b = (id: string, label: string, kind: LogicBlock["kind"] = "step"): LogicBlock => ({ id, label, kind, change: "added", next: [] });
const BLOCKS = [b("send", "Form is sent", "entry"), b("save", "Save the visit"), b("drop", "Drop the queue", "exit"), b("job", "Nightly job", "entry")];
const BY_ID = new Map(BLOCKS.map((x) => [x.id, x]));
const STARTING: WalkInput[] = [
  { name: "body", description: "The JSON request body", value: { status: "final" } },
  { name: "user", description: "The signed-in user", value: { id: 12 } },
];
const TRACE: Trace = {
  id: "t1", mapId: "m1", entryId: "send", inputs: STARTING, proposed: true, usedAt: "",
  steps: [
    { blockId: "send", input: { body: { status: "final" } }, output: { payload: "<img src=x onerror=alert(1)>" }, note: "Parses <b>the</b> body." },
    { blockId: "save", input: { visit: 7 }, output: { visit: 7, saved: true }, note: "Saves it.", assumed: ["Visit 7 exists"] },
    { blockId: "drop", input: {}, output: { raises: "KeyError('q')" }, note: "Clears it.",
      danger: [{ kind: "destructive", note: "Deletes every queued form (app/q.py:9)" }] },
  ],
  outcome: { kind: "error", message: "Raised KeyError: 'q'" },
};

function walkRun(over: Partial<WalkRun> = {}, data: Partial<WalkState> = {}): WalkRun {
  return {
    data: { trace: TRACE, starting: STARTING, running: false, error: null, ...data },
    loadError: null, progress: null, error: null, posting: false, run: vi.fn(async () => {}), ...over,
  };
}

function Harness({ walk, onShowCode = vi.fn(), onEntry = vi.fn() }: { walk: WalkRun; onShowCode?: () => void; onEntry?: () => void }) {
  const [step, setStep] = useState(0);
  return (
    <WalkthroughPanel entries={[BLOCKS[0], BLOCKS[3]]} entry="send" onEntry={onEntry} blocks={BY_ID} walk={walk}
      step={step} onStep={setStep} onShowCode={onShowCode} onClose={vi.fn()} />
  );
}

const panel = () => screen.getByRole("complementary", { name: "Walkthrough" });

test("proposing shows progress and the privacy note", () => {
  render(<Harness walk={walkRun({ progress: "Reading app/visits.py" }, { trace: null, starting: null, running: true })} />);
  expect(screen.getByText("Reading app/visits.py")).toBeInTheDocument();
  expect(screen.getByText(/Private: runs on your machine/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Next/ })).toBeNull();
});

test("tracing new inputs keeps the old trace and disables Run", async () => {
  render(<Harness walk={walkRun({ progress: "Writing the trace…" })} />);
  expect(screen.getByText("Writing the trace…")).toBeInTheDocument();
  expect(screen.getByText("Parses <b>the</b> body.")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /^Inputs/ }));
  expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
});

test("failure shows the error and Try again", async () => {
  const walk = walkRun({ error: "Claude's walkthrough didn't pass validation: x" }, { trace: null });
  render(<Harness walk={walk} />);
  expect(screen.getByText(/didn't pass validation/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(walk.run).toHaveBeenCalledWith({ body: { status: "final" }, user: { id: 12 } });
});

test("stepping with buttons and arrow keys, ignoring keys while typing", async () => {
  render(<Harness walk={walkRun()} />);
  expect(screen.getByText("Step 1 of 3")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Prev/ })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: /Next/ }));
  expect(screen.getByText("Step 2 of 3")).toBeInTheDocument();
  await userEvent.keyboard("{ArrowRight}");
  expect(screen.getByText("Step 3 of 3")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Next/ })).toBeDisabled();
  await userEvent.keyboard("{ArrowLeft}");
  expect(screen.getByText("Step 2 of 3")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: /^Inputs/ }));
  const box = screen.getByRole("textbox", { name: "body" });
  await userEvent.click(box);
  await userEvent.keyboard("{ArrowRight}{ArrowLeft}");
  expect(screen.getByText("Step 2 of 3")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Back to step 1" }));
  expect(screen.getByText("Step 1 of 3")).toBeInTheDocument();
});

test("inputs are collapsed with a trace, invalid JSON disables Run, edits show, Reset restores", async () => {
  const walk = walkRun();
  render(<Harness walk={walk} />);
  const toggle = screen.getByRole("button", { name: /^Inputs/ });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(toggle).toHaveTextContent("2 values · proposed by Claude");
  await userEvent.click(toggle);

  const box = screen.getByRole("textbox", { name: "user" });
  await userEvent.clear(box);
  await userEvent.type(box, "{{");
  expect(screen.getByText("Not valid JSON")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();

  await userEvent.clear(box);
  await userEvent.type(box, '{{"id": 13}');
  expect(toggle).toHaveTextContent("· edited");
  await userEvent.click(screen.getByRole("button", { name: "Run" }));
  expect(walk.run).toHaveBeenLastCalledWith({ body: { status: "final" }, user: { id: 13 } });

  await userEvent.click(screen.getByRole("button", { name: "Reset" }));
  expect(walk.run).toHaveBeenLastCalledWith({ body: { status: "final" }, user: { id: 12 } });
  expect(toggle).toHaveTextContent("proposed by Claude");
});

test("inputs are open when there's no trace yet", () => {
  render(<Harness walk={walkRun({ error: "failed" }, { trace: null })} />);
  expect(screen.getByRole("button", { name: /^Inputs/ })).toHaveAttribute("aria-expanded", "true");
});

test("step card: note, assumptions, changed keys, values as text, outcome", async () => {
  render(<Harness walk={walkRun()} />);
  // Claude's text is never HTML.
  expect(screen.getByText("Parses <b>the</b> body.")).toBeInTheDocument();
  expect(screen.getByText(/<img src=x onerror=alert\(1\)>/)).toBeInTheDocument();
  expect(document.querySelector(".walk-json img")).toBeNull();

  await userEvent.click(screen.getByRole("button", { name: /Next/ }));
  expect(screen.getByText("assumed: Visit 7 exists")).toBeInTheDocument();
  const output = screen.getByLabelText("Output");
  expect(within(output).getByText(/"saved": true/).closest("div")).toHaveClass("changed");
  expect(within(output).getByText(/"visit": 7/).closest("div")).not.toHaveClass("changed");

  await userEvent.click(screen.getByRole("button", { name: /Next/ }));
  expect(screen.getByText("Raised KeyError: 'q'")).toBeInTheDocument();
  expect(screen.getByLabelText("Output")).toHaveClass("error");
});

test("danger: flag on the step card and a banner on every step that jumps to it", async () => {
  render(<Harness walk={walkRun()} />);
  const banner = screen.getByRole("alert");
  expect(banner).toHaveTextContent("⚠ 1 step flagged as dangerous");
  await userEvent.click(within(banner).getByRole("button", { name: /Drop the queue · Destructive/ }));
  expect(screen.getByText("Step 3 of 3")).toBeInTheDocument();
  const flag = screen.getByText("Deletes every queued form (app/q.py:9)").closest(".walk-flag")!;
  expect(flag).toHaveTextContent("Destructive");
});

test("no banner when nothing is flagged", () => {
  render(<Harness walk={walkRun({}, { trace: { ...TRACE, steps: TRACE.steps.slice(0, 2) } })} />);
  expect(screen.queryByRole("alert")).toBeNull();
});

test("Show code and the entry picker", async () => {
  const onShowCode = vi.fn();
  const onEntry = vi.fn();
  render(<Harness walk={walkRun()} onShowCode={onShowCode} onEntry={onEntry} />);
  await userEvent.click(within(panel()).getByRole("button", { name: /Show code/ }));
  expect(onShowCode).toHaveBeenCalledWith(BLOCKS[0]);
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Entry" }), "job");
  expect(onEntry).toHaveBeenCalledWith("job");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd frontend && npx vitest run src/pages/logic/WalkthroughPanel.test.tsx`
Expected: FAIL (cannot resolve `./WalkthroughPanel`)

- [ ] **Step 3: Write `WalkthroughPanel.tsx`**

```tsx
import { useEffect, useState } from "react";
import type { LogicBlock, Trace, WalkInput, WalkStep } from "../../api/types";
import { changedKeys, DANGER_LABEL, dangerSteps, type Highlight } from "../../lib/walkthrough";
import type { WalkRun } from "./useWalk";

type Props = {
  entries: LogicBlock[];
  entry: string;
  onEntry: (id: string) => void;
  blocks: Map<string, LogicBlock>;
  walk: WalkRun;
  step: number;
  onStep: (n: number) => void;
  onShowCode: (block: LogicBlock) => void;
  onClose: () => void;
};

const ICON: Record<LogicBlock["kind"], string> = { entry: "▶", step: "▸", decision: "◇", loop: "↻", async: "⚡", exit: "■" };
const show = (v: unknown) => JSON.stringify(v, null, 2);
const valuesOf = (inputs: WalkInput[]) => Object.fromEntries(inputs.map((i) => [i.name, i.value]));

/** The walkthrough beside the Logic map: pick an entry, set its inputs, step through the trace. */
export function WalkthroughPanel({ entries, entry, onEntry, blocks, walk, step, onStep, onShowCode, onClose }: Props) {
  const { data, progress, error, posting } = walk;
  const trace = data?.trace ?? null;
  const starting = data?.starting ?? null;
  const last = trace ? trace.steps.length - 1 : 0;

  useEffect(() => {
    if (!trace) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.altKey || e.ctrlKey || e.metaKey || t?.closest("input, textarea, select, [contenteditable]")) return;
      if (e.key === "ArrowRight" && step < last) onStep(step + 1);
      if (e.key === "ArrowLeft" && step > 0) onStep(step - 1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [trace, step, last, onStep]);

  const flagged = trace ? dangerSteps(trace.steps) : [];
  const current = trace?.steps[step];

  return (
    <aside aria-label="Walkthrough"
      className="sticky top-20 max-h-[calc(100vh-6rem)] w-[40%] shrink-0 overflow-y-auto rounded-xl border border-stone-200 bg-white shadow-sm dark:border-stone-800 dark:bg-stone-900">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-stone-200 bg-white/95 px-4 py-3 backdrop-blur dark:border-stone-800 dark:bg-stone-900/95">
        <h2 className="flex-1 text-sm font-semibold">Walkthrough</h2>
        <button type="button" aria-label="Close" onClick={onClose} className="rounded px-1.5 text-stone-400 hover:bg-stone-200 hover:text-stone-700 dark:hover:bg-stone-800">×</button>
      </div>

      <div className="space-y-3 border-b border-stone-200 px-4 py-3 dark:border-stone-800">
        <label className="block text-xs font-semibold uppercase tracking-wider text-stone-500">
          Entry
          <select aria-label="Entry" value={entry} onChange={(e) => onEntry(e.target.value)}
            className="mt-1 block w-full rounded-lg border border-stone-300 bg-white px-2 py-1.5 text-sm font-normal normal-case tracking-normal text-stone-900 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100">
            {entries.map((e) => <option key={e.id} value={e.id}>▶ {e.label}</option>)}
          </select>
        </label>
        {flagged.length > 0 && (
          <div role="alert" className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/60 dark:text-red-200">
            <p className="font-semibold">⚠ {flagged.length} step{flagged.length === 1 ? "" : "s"} flagged as dangerous</p>
            <ul className="mt-1 space-y-0.5">
              {flagged.map((f) => (
                <li key={f.index}>
                  <button type="button" className="text-left hover:underline" onClick={() => onStep(f.index)}>
                    {blocks.get(trace!.steps[f.index].blockId)?.label ?? trace!.steps[f.index].blockId} · {f.kinds.map((k) => DANGER_LABEL[k]).join(", ")}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {!data && !walk.loadError && <p className="p-4 text-sm text-stone-500">Loading…</p>}
      {walk.loadError && <p className="p-4 text-sm text-red-700 dark:text-red-300">Couldn't load the walkthrough: {walk.loadError.message}</p>}

      {progress && (
        <div className="m-4 rounded-xl border border-violet-200 bg-violet-50 px-4 py-3 text-sm dark:border-violet-900 dark:bg-violet-950/40">
          <div className="flex items-center gap-3"><span className="spinner" aria-hidden="true" /><span className="font-medium">{progress}</span></div>
          {!trace && <p className="mt-1 text-xs text-stone-500">Private: runs on your machine with your Claude Code. Takes a minute or two.</p>}
        </div>
      )}
      {error && (
        <div className="m-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          <p>{error}</p>
          <button type="button" className="mt-2 font-semibold underline" disabled={posting}
            onClick={() => walk.run(starting ? valuesOf(trace?.inputs ?? starting) : undefined)}>Try again</button>
        </div>
      )}

      {starting && (
        <Inputs key={trace?.id ?? "none"} trace={trace} starting={starting} busy={!!progress || posting} onRun={walk.run} />
      )}

      {trace && current && (
        <>
          <div className="sticky top-[49px] z-10 flex items-center gap-2 border-b border-stone-200 bg-stone-50 px-4 py-2 dark:border-stone-800 dark:bg-stone-950">
            <button type="button" className="nav-btn" disabled={step === 0} onClick={() => onStep(step - 1)}>◀ Prev</button>
            <span className="flex-1 text-center text-sm font-semibold">
              Step {step + 1} of {trace.steps.length}
              <span className="block text-[10px] font-normal text-stone-500">← → to step</span>
            </span>
            <button type="button" className="nav-btn" disabled={step >= last} onClick={() => onStep(step + 1)}>Next ▶</button>
            <button type="button" className="nav-btn" aria-label="Back to step 1" onClick={() => onStep(0)}>↺</button>
          </div>
          <StepCard step={current} block={blocks.get(current.blockId)} trace={trace} isLast={step === last} onShowCode={onShowCode} />
        </>
      )}
    </aside>
  );
}

function Inputs({ trace, starting, busy, onRun }: {
  trace: Trace | null; starting: WalkInput[]; busy: boolean; onRun: WalkRun["run"];
}) {
  const shown = trace?.inputs ?? starting;
  const [drafts, setDrafts] = useState(() => Object.fromEntries(shown.map((i) => [i.name, show(i.value)])));
  const [open, setOpen] = useState(!trace);
  const parsed = Object.fromEntries(Object.entries(drafts).map(([k, v]) => {
    try { return [k, { ok: true, value: JSON.parse(v) as unknown }]; } catch { return [k, { ok: false, value: undefined }]; }
  }));
  const bad = Object.values(parsed).some((p) => !p.ok);
  const edited = starting.some((i) => !parsed[i.name]?.ok || show(parsed[i.name].value) !== show(i.value));
  const values = () => Object.fromEntries(Object.entries(parsed).map(([k, p]) => [k, p.value]));
  const reset = () => {
    setDrafts(Object.fromEntries(starting.map((i) => [i.name, show(i.value)])));
    void onRun(valuesOf(starting));
  };

  return (
    <section className="border-b border-stone-200 px-4 py-3 dark:border-stone-800">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between text-xs font-semibold uppercase tracking-wider text-stone-500">
        <span>Inputs {open ? "▾" : "▸"}</span>
        <span className="font-normal normal-case tracking-normal">
          {starting.length} value{starting.length === 1 ? "" : "s"} · {edited ? "edited" : "proposed by Claude"}
        </span>
      </button>
      {open && (
        <div className="mt-3 space-y-3">
          {starting.map((i) => (
            <label key={i.name} className="block">
              <span className="font-mono text-xs font-semibold">{i.name}</span>
              <span className="block text-xs text-stone-500">{i.description}</span>
              <textarea aria-label={i.name} value={drafts[i.name] ?? ""} spellCheck={false}
                rows={Math.min(8, (drafts[i.name] ?? "").split("\n").length)}
                onChange={(e) => setDrafts({ ...drafts, [i.name]: e.target.value })}
                className={`mt-1 block w-full rounded-lg border px-2 py-1 font-mono text-xs ${parsed[i.name]?.ok === false ? "border-red-500 bg-red-50 dark:bg-red-950/40" : "border-stone-300 dark:border-stone-700 dark:bg-stone-950"}`} />
              {parsed[i.name]?.ok === false && <span className="text-xs text-red-700 dark:text-red-300">Not valid JSON</span>}
            </label>
          ))}
          <div className="flex gap-2">
            <button type="button" className="rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
              disabled={bad || busy} onClick={() => onRun(values())}>Run</button>
            <button type="button" className="nav-btn" disabled={busy} onClick={reset}>Reset</button>
          </div>
        </div>
      )}
    </section>
  );
}

function StepCard({ step, block, trace, isLast, onShowCode }: {
  step: WalkStep; block: LogicBlock | undefined; trace: Trace; isLast: boolean; onShowCode: (b: LogicBlock) => void;
}) {
  const failed = isLast && trace.outcome.kind === "error";
  const outcomeTone = {
    exit: "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-200",
    error: "border-red-300 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/60 dark:text-red-200",
    stopped: "border-stone-300 bg-stone-100 text-stone-800 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-200",
  }[trace.outcome.kind];
  const outcomeIcon = { exit: "■", error: "✕", stopped: "⏸" }[trace.outcome.kind];
  return (
    <div className="space-y-3 p-4">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold">
        <span aria-hidden="true" className="text-stone-500">{block ? ICON[block.kind] : "▸"}</span>{block?.label ?? step.blockId}
      </h3>
      <p className="text-sm">{step.note}</p>
      {step.danger?.map((d, i) => (
        <div key={i} className="walk-flag rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/60 dark:text-red-200">
          <span className="font-semibold">⚠ {DANGER_LABEL[d.kind]}</span> <span>{d.note}</span>
        </div>
      ))}
      {step.assumed?.length ? (
        <div className="flex flex-wrap gap-1">
          {step.assumed.map((a, i) => (
            <span key={i} title="Claude couldn't read this from the code, so it assumed it"
              className="rounded-full border border-orange-300 bg-orange-50 px-2 py-0.5 text-xs text-orange-900 dark:border-orange-800 dark:bg-orange-950/50 dark:text-orange-200">
              assumed: {a}
            </span>
          ))}
        </div>
      ) : null}
      <Json label="Input" value={step.input} highlight={null} />
      <Json label="Output" value={step.output} highlight={changedKeys(step.input, step.output)} error={failed} />
      {block && (
        <button type="button" className="text-xs font-semibold text-violet-700 hover:underline dark:text-violet-300" onClick={() => onShowCode(block)}>
          Show code →
        </button>
      )}
      {isLast && <div className={`rounded-lg border px-3 py-2 text-sm font-semibold ${outcomeTone}`}>{outcomeIcon} {trace.outcome.message}</div>}
    </div>
  );
}

/** A value as formatted JSON; top-level keys in `highlight` (or all of it) are marked as changed. */
function Json({ label, value, highlight, error = false }: { label: string; value: unknown; highlight: Highlight; error?: boolean }) {
  const isObject = typeof value === "object" && value !== null && !Array.isArray(value);
  const id = `walk-${label.toLowerCase()}`;
  return (
    <div>
      <div id={id} className="mb-1 text-xs font-semibold uppercase tracking-wider text-stone-500">{label}</div>
      <pre aria-labelledby={id} className={`walk-json${error ? " error" : ""}`}>
        {isObject ? (
          <>
            <div>{"{"}</div>
            {Object.entries(value as Record<string, unknown>).map(([k, v], i, all) => (
              <div key={k} className={highlight instanceof Set && highlight.has(k) ? "changed" : undefined}>
                {`  ${JSON.stringify(k)}: ${show(v).replace(/\n/g, "\n  ")}${i < all.length - 1 ? "," : ""}`}
              </div>
            ))}
            <div>{"}"}</div>
          </>
        ) : (
          <div className={highlight === "all" ? "changed" : undefined}>{show(value)}</div>
        )}
      </pre>
    </div>
  );
}
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `cd frontend && npx vitest run src/pages/logic/WalkthroughPanel.test.tsx && npm run typecheck`
Expected: PASS. Two likely fixes:
- If `getByLabelText("Output")` doesn't find the `<pre>`, make sure `aria-labelledby` points at the label's `id`. Ids must be unique per panel, and only one step card is shown at a time.
- If the sticky stepper's `top-[49px]` doesn't line up under the header in the browser, adjust it during Task 9's manual check.

- [ ] **Step 5: Rebuild and commit**

```bash
cd frontend && npm run build && cd ..
git add frontend/src src/spec_tackle/static/dist
git commit -m "feat(frontend): the Logic walkthrough panel

Pick an entry, edit its inputs, and step through the trace with each
block's input, output, assumptions and danger flags.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Wire it into `LogicView` and `ReviewPage`

**Files:**
- Modify: `frontend/src/pages/logic/LogicView.tsx`
- Modify: `frontend/src/pages/logic/FunctionPanel.tsx` (optional `onBack`)
- Modify: `frontend/src/pages/review/ReviewPage.tsx` (`?walk=`)
- Test: `frontend/src/pages/logic/LogicView.test.tsx` (append), `frontend/src/pages/review/ReviewPage.test.tsx` (append)

**Interfaces:**
- Consumes: `useWalk` (Task 6), `WalkthroughPanel` (Task 7), and from `lib/walkthrough.ts` (Tasks 4 and 5) `entries`, `containing`, `pathBlocks`, `takenEdges`, `walkMarks`, `stepForBlock` and the `Walk` type.
- Produces:
  - `LogicView` props gain `walk: string | null` and `onWalk: (entry: string | null) => void`.
  - `FunctionPanel` gains `onBack?: () => void`, rendered as "← Back to walkthrough".

- [ ] **Step 1: Write the failing tests**

In `LogicView.test.tsx`:
- change `setup` so it renders a wrapper that owns `walk` state (code below);
- add the walkthrough routes to `beforeEach`;
- append the tests.

```tsx
// replace setup() in LogicView.test.tsx
function setup(onShowInReview = vi.fn(), initialWalk: string | null = null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper() {
    const [walk, setWalk] = useState<string | null>(initialWalk);
    return <LogicView pr={PR} head={HEAD} walk={walk} onWalk={setWalk} onShowInReview={onShowInReview} />;
  }
  const view = render(<QueryClientProvider client={client}><Wrapper /></QueryClientProvider>);
  return { ...view, onShowInReview };
}
```

Add `useState` to a React import at the top (`import { useState } from "react";`), and add `Trace` to the type import. Then:

```tsx
const TRACE: Trace = {
  id: "t1", mapId: "m1", entryId: "start", proposed: true, usedAt: "",
  inputs: [{ name: "form", description: "The form", value: { id: 7 } }],
  steps: [
    { blockId: "start", input: { form: { id: 7 } }, output: { ok: true }, note: "Accepts the form." },
    { blockId: "store", input: { id: 7 }, output: { saved: true }, note: "Stores it." },
    { blockId: "sync", input: { id: 7 }, output: { queued: true }, note: "Queues it.",
      danger: [{ kind: "external", note: "Posts to the sync webhook" }] },
  ],
  outcome: { kind: "stopped", message: "The sync job runs elsewhere" },
};
const WALK = "/api/logic/m1/walkthrough";
// in beforeEach, add:
//   [`GET ${WALK}?entry=start`]: { trace: TRACE, starting: TRACE.inputs, running: false, error: null },

test("the Walkthrough button opens the panel on the first entry and expands the path without saving it", async () => {
  setup();
  await userEvent.click(await screen.findByRole("button", { name: /Walkthrough/ }));
  const panel = await screen.findByRole("complementary", { name: "Walkthrough" });
  expect(await within(panel).findByText("Accepts the form.")).toBeInTheDocument();
  // "Save and sync" holds steps of the trace, so it's expanded for the walkthrough...
  expect(await node(/⊖ Save and sync/)).toBeInTheDocument();
  // ...without touching the reviewer's saved choice.
  expect(loadPref(PR, "logicExpanded", [])).toEqual([]);
  expect((await node(/^Form is submitted/)).className).toMatch(/walk-current/);
  expect((await node(/^Queue a sync/))).toHaveAccessibleName(/flagged as dangerous: External effect/);

  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("complementary", { name: "Walkthrough" })).toBeNull();
  expect(await node(/^Save and sync ⊕/)).toBeInTheDocument();
  expect(document.querySelector(".walk-current, .walk-step")).toBeNull();
});

test("clicking a visited block jumps to its step; others open their code", async () => {
  setup(vi.fn(), "start");
  const panel = await screen.findByRole("complementary", { name: "Walkthrough" });
  await within(panel).findByText("Step 1 of 3");
  await userEvent.click(within(panel).getByRole("button", { name: /Next/ }));
  await userEvent.click(within(panel).getByRole("button", { name: /Next/ }));
  await userEvent.click(await node(/^Store the visit/));
  expect(within(panel).getByText("Step 2 of 3")).toBeInTheDocument();
});

test("Show code opens the function panel, and Back returns to the same step", async () => {
  setup(vi.fn(), "start");
  const panel = await screen.findByRole("complementary", { name: "Walkthrough" });
  await userEvent.click(await within(panel).findByRole("button", { name: /Next/ }));
  await userEvent.click(within(panel).getByRole("button", { name: /Show code/ }));
  const code = await screen.findByRole("complementary", { name: "Store the visit" });
  await userEvent.click(within(code).getByRole("button", { name: /Back to walkthrough/ }));
  expect(await screen.findByText("Step 2 of 3")).toBeInTheDocument();
});

test("an unknown ?walk= entry falls back to the first entry", async () => {
  setup(vi.fn(), "gone");
  const panel = await screen.findByRole("complementary", { name: "Walkthrough" });
  expect(within(panel).getByRole("combobox", { name: "Entry" })).toHaveValue("start");
  await within(panel).findByText("Accepts the form.");
  expect(calls).not.toContain(`GET ${WALK}?entry=gone`);
});

test("a step in a hidden test block is still drawn", async () => {
  routes[`GET ${WALK}?entry=start`] = {
    trace: { ...TRACE, steps: [TRACE.steps[0], { blockId: "spec", input: {}, output: {}, note: "Runs the test." }] },
    starting: TRACE.inputs, running: false, error: null,
  };
  setup(vi.fn(), "start");
  expect(await node(/^Test: retries are tried five times/)).toBeInTheDocument();
});

test("with no entry blocks the Walkthrough button is disabled", async () => {
  routes[`GET ${LOGIC}?head=${HEAD}`] = state({ map: { ...MAP, blocks: [{ ...BLOCKS[1] }] } });
  setup();
  const button = await screen.findByRole("button", { name: /Walkthrough/ });
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute("title", "This map has no entry blocks");
});
```

Update existing `setup()` callers that pass only `onShowInReview`. They keep working, because
`initialWalk` defaults to null.

Append to `ReviewPage.test.tsx`:

```tsx
test("the walkthrough's entry is kept in ?walk= next to ?view=logic", async () => {
  const router = renderReview(makePage({ claude: true }));
  await router.navigate("/pr/o/r/7?view=logic&walk=start");
  expect(router.state.location.search).toBe("?view=logic&walk=start");
});
```

That test only proves the param survives navigation. The `walk` → `LogicView` wiring is
covered by Playwright in Task 9.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd frontend && npx vitest run src/pages/logic/LogicView.test.tsx`
Expected: the new tests FAIL (no Walkthrough button). The typecheck fails on the new props until Step 3.

- [ ] **Step 3: `FunctionPanel` gets `onBack`**

Add `onBack?: () => void;` to `Props` and destructure it. In the sticky header, before the `<h2>`, add:

```tsx
{onBack && (
  <button type="button" onClick={onBack} className="shrink-0 text-xs font-semibold text-violet-700 hover:underline dark:text-violet-300">
    ← Back to walkthrough
  </button>
)}
```

- [ ] **Step 4: `LogicView` and `MapView`**

1. `Props` gains:

```ts
  /** The walkthrough's entry block id (`?walk=`), or null when its panel is closed. */
  walk: string | null;
  onWalk: (entry: string | null) => void;
```

   Pass both through: `<MapView ... walk={walk} onWalk={onWalk} />`. Destructure them in `LogicView`.

2. In `MapView`, add the imports `import { useWalk } from "./useWalk";` and
   `import { WalkthroughPanel } from "./WalkthroughPanel";`, plus the functions and the
   `Walk` type from `../../lib/walkthrough`. Then:

```tsx
  // -- the walkthrough ----------------------------------------------------------
  const entryList = useMemo(() => entries(showTests ? map.blocks : withoutTests(map.blocks).blocks), [map.blocks, showTests]);
  // An entry that's no longer in the map (regenerated, or a hidden test) falls back to the first.
  const entry = walk === null ? null : entryList.some((e) => e.id === walk) ? walk : entryList[0]?.id ?? null;
  const walkRun = useWalk(map.id, entry);
  const trace = entry ? walkRun.data?.trace ?? null : null;
  const [step, setStep] = useState(0);
  const [reached, setReached] = useState(0);
  useEffect(() => { setStep(0); setReached(0); }, [trace?.id]);
  const goTo = (n: number) => { setStep(n); setReached((r) => Math.max(r, n)); };
  const steps = trace?.steps ?? [];
  const onPath = useMemo(() => pathBlocks(map.blocks, steps), [map.blocks, steps]);
  const byId = useMemo(() => {
    const m = new Map<string, LogicBlock>();
    const add = (list: LogicBlock[]) => list.forEach((b) => { m.set(b.id, b); add(b.children ?? []); });
    add(map.blocks);
    return m;
  }, [map.blocks]);
```

3. Replace the `pruned` and `blocks` lines with:

```tsx
  const pruned = useMemo(() => withoutTests(map.blocks, onPath), [map.blocks, onPath]);
  const blocks = showTests ? map.blocks : pruned.blocks;
```

   The "Show tests (N)" count now excludes kept path blocks, which is correct: they're showing.

4. Expanded set for the chart, and the walk marks:

```tsx
  const shownExpanded = useMemo(
    () => (trace ? new Set([...expanded, ...containing(map.blocks, steps)]) : expanded),
    [expanded, trace, map.blocks, steps],
  );
  const walkMarksFor: Walk | null = useMemo(() => trace && {
    marks: walkMarks(blocks, steps, step),
    taken: takenEdges(blocks, steps, step),
    path: takenEdges(blocks, steps, steps.length - 1),
  }, [trace, blocks, steps, step]);
```

5. In `activate`, before `setSelected(block)`, jump to a visited block:

```tsx
    } else {
      const at = trace && !block.children?.length ? stepForBlock(steps, block.id, reached) : null;
      if (at !== null) goTo(at);
      else setSelected(block);
    }
```

6. Esc: replace the existing effect with one that closes the function panel first, then the walkthrough:

```tsx
  useEffect(() => {
    if (!selected && entry === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (selected) setSelected(null);
      else onWalk(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selected, entry, onWalk]);
```

7. The toolbar: before "Expand all", add:

```tsx
            <button type="button" className="nav-btn" aria-pressed={entry !== null}
              disabled={!entryList.length} title={entryList.length ? undefined : "This map has no entry blocks"}
              onClick={() => onWalk(entry === null ? entryList[0].id : null)}>
              ⏵ Walkthrough
            </button>
```

8. The chart:
   - pass `expanded={shownExpanded}` and `walk={walkMarksFor}` to `<FlowChart>`;
   - pass `expanded={shownExpanded}` to `<BlockList>` too.

9. The side panel: replace the `{selected && <FunctionPanel ... />}` block with:

```tsx
      {selected ? (
        <FunctionPanel pr={pr} mapId={map.id} block={selected} headSha={map.headSha}
          onClose={() => setSelected(null)} onShowInReview={onShowInReview}
          onBack={entry !== null ? () => setSelected(null) : undefined} />
      ) : entry !== null && (
        <WalkthroughPanel entries={entryList} entry={entry} onEntry={(id) => onWalk(id)} blocks={byId}
          walk={walkRun} step={step} onStep={goTo} onShowCode={setSelected} onClose={() => onWalk(null)} />
      )}
```

   `MapView`'s parameter type gains `walk` and `onWalk` (reuse `Props["walk"]` and `Props["onWalk"]`).

- [ ] **Step 5: `ReviewPage` passes `?walk=`**

```tsx
  const walk = tab === "logic" ? params.get("walk") : null;
  const setWalk = (entry: string | null) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (entry) next.set("walk", entry);
      else next.delete("walk");
      return next;
    });
```

Put this after `setTab`. In `setTab`, when leaving Logic (`else next.delete("view");`), also call `next.delete("walk");`. Pass `walk={walk} onWalk={setWalk}` to `<LogicView>`.

- [ ] **Step 6: Run the frontend tests and the typecheck**

Run: `cd frontend && npm test && npm run typecheck`
Expected: all PASS.

- [ ] **Step 7: Rebuild and commit**

```bash
cd frontend && npm run build && cd ..
git add frontend/src src/spec_tackle/static/dist
git commit -m "feat(frontend): open the walkthrough from the Logic view

The path's blocks expand while the panel is open, visited blocks jump to
their step, and ?walk= keeps the entry across reloads.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Playwright, full verification

**Files:**
- Modify: `tests/e2e_server.py` (a canned trace for the walkthrough prompt)
- Modify: `frontend/e2e/logic.spec.ts` (append)

**Interfaces:**
- Consumes: `walkthrough.WALK_SYSTEM_PROMPT`; the e2e `LOGIC_MAP` (`send` → `retry`[`backoff`] → `give-up`).

- [ ] **Step 1: Canned traces in the e2e server**

Add `walkthrough` to `from spec_tackle import app as web, claude_api, logic, refs`. Then add, above `fake_ask`:

```python
WALK_INPUTS = [{"name": "form", "description": "The submitted form", "value": {"id": 7, "tries": 0}}]
WALK_STEPS = [
    {"blockId": "send", "input": {"form": {"id": 7}}, "output": {"sent": False}, "note": "The first send fails."},
    {"blockId": "backoff", "input": {"tries": 1}, "output": {"tries": 5}, "note": "Backs off and resends four more times.",
     "assumed": ["The server stays down"]},
    {"blockId": "give-up", "input": {"tries": 5}, "output": {"status": "failed"}, "note": "Gives up after five tries.",
     "danger": [{"kind": "destructive", "note": "Deletes the queued form (app/retry.py:2)"}]},
]
```

At the top of `fake_ask`, add:

```python
    if kwargs.get("system") == walkthrough.WALK_SYSTEM_PROMPT:
        yield Event(kind="tool", text="Reading app/retry.py")
        await asyncio.sleep(0.3)
        if "These inputs are fixed" in kwargs["question"]:
            body = {"steps": WALK_STEPS[:1], "outcome": {"kind": "stopped", "message": "Sent on the first try"}}
        else:
            body = {"inputs": WALK_INPUTS, "steps": WALK_STEPS, "outcome": {"kind": "exit", "message": "Reached exit: Give up"}}
        yield Event(kind="done", text=f"```json\n{json.dumps(body)}\n```", session_id="e2e-walk")
        return
```

- [ ] **Step 2: Write the Playwright test**

```ts
// append to frontend/e2e/logic.spec.ts
test("walk through the map, see danger, edit inputs and hit the cache", async ({ page }) => {
  await page.goto("/pr/o/r/7?view=logic");
  await page.getByRole("button", { name: "Generate logic map" }).click();
  await expect(page.getByText("Failed form submissions are retried with backoff")).toBeVisible();

  await page.getByRole("button", { name: /Walkthrough/ }).click();
  await expect(page).toHaveURL(/walk=send/);
  const panel = page.getByRole("complementary", { name: "Walkthrough" });
  await expect(panel.getByText("The first send fails.")).toBeVisible();
  const chart = page.locator(".logic-flow");
  await expect(chart.getByRole("button", { name: /^Form is sent/ })).toHaveClass(/walk-current/);
  // The loop holding step 2 is expanded for the walkthrough.
  await expect(chart.getByRole("button", { name: /⊖ Retry failures/ })).toBeVisible();

  // Danger is visible before it's reached, and the banner jumps to it.
  await expect(chart.getByRole("button", { name: /^Give up/ })).toHaveAccessibleName(/flagged as dangerous: Destructive/);
  await panel.getByRole("alert").getByRole("button", { name: /Give up · Destructive/ }).click();
  await expect(panel.getByText("Step 3 of 3")).toBeVisible();
  await expect(panel.getByText("Deletes the queued form (app/retry.py:2)")).toBeVisible();
  await expect(panel.getByText("Reached exit: Give up")).toBeVisible();

  await page.keyboard.press("ArrowLeft");
  await expect(panel.getByText("Step 2 of 3")).toBeVisible();
  await expect(panel.getByText("assumed: The server stays down")).toBeVisible();

  // A reload comes back to the same walkthrough.
  await page.reload();
  await expect(page.getByRole("complementary", { name: "Walkthrough" }).getByText("Step 1 of 3")).toBeVisible();

  // New inputs: a fresh run.
  await panel.getByRole("button", { name: /^Inputs/ }).click();
  await panel.getByRole("textbox", { name: "form" }).fill('{"id": 7, "tries": 4}');
  await panel.getByRole("button", { name: "Run" }).click();
  await expect(panel.getByText("Sent on the first try")).toBeVisible();

  // Reset: the starting values' trace comes straight from the cache, with no progress card.
  await panel.getByRole("button", { name: /^Inputs/ }).click();
  await panel.getByRole("button", { name: "Reset" }).click();
  await expect(panel.getByText("The first send fails.")).toBeVisible();
  await expect(panel.getByText("Reading app/retry.py")).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(page).not.toHaveURL(/walk=/);
});
```

After Run, the Inputs section collapses because a new trace loaded, so it has to be reopened for Reset. If it stays open in practice, drop the second toggle click.

- [ ] **Step 3: Run Playwright**

Run: `cd frontend && npm run build && npm run e2e`
Expected: all PASS, including the existing logic, review, refs and switcher specs.

- [ ] **Step 4: Run everything**

Run: `uv run pytest -q && cd frontend && npm test && npm run typecheck`
Expected: all PASS. `test_frontend_bundle.py` confirms `dist/` matches the source.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e_server.py frontend/e2e/logic.spec.ts src/spec_tackle/static/dist
git commit -m "test: walk through a Logic map in Playwright

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6: Manual check (for the reviewer)**

Run `uv run spec-tackle <a real code PR URL>` and generate a map. Then:
- open the walkthrough with the proposed inputs and step through;
- edit one value into an edge case (null, empty, wrong role) and run it;
- try a PR with a known destructive or external call, and confirm it's flagged;
- check that the stepper sits right under the panel header, the badges sit on the card corners, and the dark mode colours read well.
