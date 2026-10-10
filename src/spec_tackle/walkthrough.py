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
    if not all(isinstance(i, dict) and isinstance(i.get("name"), str) for i in items):
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
    if not isinstance(block_id, str):
        block_id = None
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
