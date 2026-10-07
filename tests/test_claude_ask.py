import asyncio

import pytest
from claude_agent_sdk import (
    AssistantMessage, ResultError, ResultMessage, StreamEvent, TextBlock, ToolUseBlock,
)

from spec_tackle import claude


def _result(session_id="sess-1"):
    return ResultMessage(subtype="success", duration_ms=1, duration_api_ms=1, is_error=False,
                         num_turns=1, session_id=session_id)


def _delta(text):
    return StreamEvent(uuid="u", session_id="s",
                       event={"type": "content_block_delta", "delta": {"type": "text_delta", "text": text}})


class FakeQuery:
    """Stands in for claude_agent_sdk.query; records each call's prompt and options."""

    def __init__(self, *runs):
        self.runs = list(runs)
        self.calls = []

    def __call__(self, *, prompt, options):
        self.calls.append((prompt, options))
        run = self.runs.pop(0)

        async def gen():
            if isinstance(run, Exception):
                raise run
            for message in run:
                yield message
        return gen()


def _collect(fake, tmp_path, **kwargs):
    async def go():
        args = dict(cli="/bin/claude", cwd=tmp_path, snapshot="SNAP", question="Q?",
                    full_prompt="FULL", session_id=None, query=fake)
        args.update(kwargs)
        return [e async for e in claude.ask(**args)]
    return asyncio.run(go())


def test_streams_text_tools_and_done(tmp_path):
    fake = FakeQuery([
        _delta("Hel"), _delta("lo"),
        AssistantMessage(content=[ToolUseBlock(id="t", name="Read", input={"file_path": str(tmp_path / "a.md")})], model="m"),
        AssistantMessage(content=[TextBlock(text="Hello")], model="m"),
        _result("sess-9"),
    ])
    events = _collect(fake, tmp_path)
    assert [(e.kind, e.text) for e in events] == [
        ("text", "Hel"), ("text", "lo"), ("tool", "Reading a.md"), ("done", "Hello"),
    ]
    assert events[-1].session_id == "sess-9"


def test_options_lock_claude_down(tmp_path):
    fake = FakeQuery([_result()])
    _collect(fake, tmp_path)
    prompt, options = fake.calls[0]
    assert prompt.startswith("SNAP") and "FULL" in prompt
    assert options.cli_path == "/bin/claude"
    assert options.cwd == str(tmp_path)
    assert options.tools == ["Read", "Grep", "Glob"] == options.allowed_tools
    assert options.setting_sources == ["user"]
    assert options.include_partial_messages is True
    assert options.resume is None
    assert options.system_prompt["preset"] == "claude_code"
    assert "SNAP" not in options.system_prompt["append"]
    assert options.verbatim_prompts is True
    [guard] = options.hooks["PreToolUse"][0].hooks
    outside = {"tool_name": "Read", "tool_input": {"file_path": "/etc/passwd"}, "cwd": str(tmp_path)}
    decision = asyncio.run(guard(outside, None, None))
    assert decision["hookSpecificOutput"]["permissionDecision"] == "deny"


def test_large_snapshot_stays_out_of_the_command_line(tmp_path):
    fake = FakeQuery([_result()])
    _collect(fake, tmp_path, snapshot="x" * 300_000)
    prompt, options = fake.calls[0]
    assert len(options.system_prompt["append"].encode()) < 100_000
    assert prompt.startswith("x" * 300_000)


def test_follow_up_resumes_with_just_the_question(tmp_path):
    fake = FakeQuery([_result()])
    _collect(fake, tmp_path, session_id="sess-1")
    prompt, options = fake.calls[0]
    assert (prompt, options.resume) == ("Q?", "sess-1")


def test_expired_session_falls_back_to_full_prompt(tmp_path):
    gone = ResultError("No conversation found with session ID: sess-1")
    fake = FakeQuery(gone, [AssistantMessage(content=[TextBlock(text="ok")], model="m"), _result("sess-2")])
    events = _collect(fake, tmp_path, session_id="sess-1")
    assert fake.calls[0][0] == "Q?"
    assert fake.calls[1][0].startswith("SNAP") and "FULL" in fake.calls[1][0]
    assert fake.calls[1][1].resume is None
    assert events[-1].session_id == "sess-2"


def test_other_errors_propagate(tmp_path):
    fake = FakeQuery(ResultError("API Error: overloaded"))
    with pytest.raises(ResultError):
        _collect(fake, tmp_path, session_id="sess-1")
