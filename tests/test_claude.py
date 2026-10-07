import asyncio
import os

import pytest

from spec_tackle import claude


# -- path guard --------------------------------------------------------------


@pytest.fixture
def root(tmp_path):
    wt = tmp_path / "wt"
    (wt / "docs").mkdir(parents=True)
    (wt / "docs" / "a.md").write_text("one\ntwo\nthree\nfour\n")
    (tmp_path / "secret").write_text("nope")
    os.symlink(tmp_path / "secret", wt / "link")
    return wt


@pytest.mark.parametrize("target, ok", [
    ("docs/a.md", True),
    ("{root}/docs/a.md", True),
    ("{root}", True),
    ("../secret", False),
    ("/etc/passwd", False),
    ("link", False),            # symlink pointing outside
    ("docs/../../secret", False),
    ("~", False),
    ("~/x", False),
    ("~/.ssh/id_rsa", False),
])
def test_inside(root, target, ok):
    assert claude.inside(root=root, target=target.format(root=root)) is ok


BAD_PATTERNS = ["{..,x}/*", "{/etc,x}/*", "{~,x}/*", "[.][.]/*", "@(..)/*", "x/{..,y}",
                "/etc/*", "../*", "~/*", "docs\\..\\*"]
GOOD_PATTERNS = ["**/*.md", "*.{md,py}", "docs/**/*.md", "src/[a-z]*.py", "docs/*"]


def _hook(root, tool, cwd=None, **tool_input):
    guard = claude.make_guard(root)
    data = {"tool_name": tool, "tool_input": tool_input, "cwd": str(cwd or root)}
    return asyncio.run(guard(data, "id", None))


def test_guard_allows_reads_inside(root):
    assert _hook(root, "Read", file_path=str(root / "docs/a.md")) == {}
    assert _hook(root, "Grep", pattern="x") == {}  # no path: searches the worktree


def test_guard_denies_outside_paths_and_other_tools(root):
    for result in (
        _hook(root, "Read", file_path="/etc/passwd"),
        _hook(root, "Read", file_path=str(root / "link")),
        _hook(root, "Glob", pattern="*", path=".."),
        _hook(root, "Bash", command="ls"),
        _hook(root, "Read", file_path="~/.ssh/id_rsa"),
        _hook(root, "Grep", pattern="x", path="~"),
        _hook(root, "Grep", pattern="x", file_path=str(root), path="/etc"),  # mismatched keys
        _hook(root, "Read", file_path="../secret"),  # relative, resolved against cwd
        _hook(root, "Read", file_path="a\x00b"),
        _hook(root, "Read", file_path=123),
        _hook(root, "Grep", pattern="x", path=["/etc"]),
        _hook(root, "Glob", pattern="/etc/*"),
        _hook(root, "Glob", pattern="../../**/*"),
        _hook(root, "Glob", pattern="docs/../../*"),
        _hook(root, "Glob", pattern="~/*"),
        _hook(root, "Grep", pattern="x", glob="/etc/*"),
        _hook(root, "Grep", pattern="x", glob="../**"),
        *[_hook(root, "Glob", pattern=bad) for bad in BAD_PATTERNS],
        *[_hook(root, "Grep", pattern="x", glob=bad) for bad in BAD_PATTERNS],
    ):
        assert result["hookSpecificOutput"]["permissionDecision"] == "deny"


def test_guard_resolves_relative_paths_against_cwd(root):
    docs = root / "docs"
    assert _hook(root, "Read", cwd=docs, file_path="a.md") == {}
    assert _hook(root, "Read", cwd=docs, file_path="../../secret")["hookSpecificOutput"]
    assert _hook(root, "Read", cwd=docs, file_path="../docs/a.md") == {}


def test_guard_treats_none_paths_as_absent(root):
    assert _hook(root, "Grep", pattern="x", path=None, file_path=None, notebook_path=None) == {}
    assert _hook(root, "Glob", pattern="*.md", path=None) == {}


def test_guard_allows_normal_patterns(root):
    for good in GOOD_PATTERNS:
        assert _hook(root, "Glob", pattern=good) == {}, good
        assert _hook(root, "Grep", pattern="x", glob=good) == {}, good


def test_guard_allows_relative_paths_and_patterns_inside(root):
    assert _hook(root, "Read", file_path="docs/a.md") == {}
    assert _hook(root, "Glob", pattern="**/*.md") == {}
    assert _hook(root, "Grep", pattern="x", glob="*.md", path="docs") == {}


# -- snapshot ----------------------------------------------------------------


def _overview(threads=1):
    author = {"__typename": "User", "login": "ann", "avatarUrl": ""}
    comment = {"databaseId": 1, "author": author, "body": "Is **this** right?", "bodyHTML": "",
               "createdAt": "2026-01-01T00:00:00Z", "url": "u", "replyTo": None}
    thread = {"id": "T", "isResolved": True, "isOutdated": False, "path": "docs/a.md", "line": 3,
              "startLine": 2, "originalLine": 3, "originalStartLine": 2, "diffSide": "RIGHT",
              "subjectType": "LINE", "resolvedBy": None, "comments": {"nodes": [comment]}}
    return {
        "title": "Add spec", "number": 7, "url": "https://github.com/o/r/pull/7",
        "body": "The PR description.", "author": author,
        "baseRefName": "main", "headRefName": "spec", "headRefOid": "abc1234",
        "state": "OPEN", "isDraft": True, "merged": False, "viewer": {"login": "me", "avatarUrl": ""},
        "reviewThreads": {"nodes": [thread] * threads},
        "comments": {"nodes": [{"databaseId": 2, "author": author, "body": "General note",
                                "bodyHTML": "", "createdAt": "2026-01-02T00:00:00Z", "url": "u"}]},
        "reviews": {"nodes": []},
    }


FILES = [
    {"filename": "docs/a.md", "status": "added", "patch": "@@ -0,0 +1,4 @@\n+one"},
    {"filename": "app/x.py", "status": "modified", "patch": "@@ -1 +1 @@\n-old\n+new" + "\n context" * 20},
]


def _context(**kwargs):
    from spec_tackle import render
    overview = kwargs.pop("overview", _overview())
    return claude.build_context(
        overview=overview, files=FILES, markdown={"docs/a.md": "one\ntwo\n"},
        activity=render.normalize_activity(overview), commit="abc1234", **kwargs,
    )


def test_context_includes_everything():
    text = _context()
    for expected in ("Add spec", "The PR description.", "draft", "main", "abc1234",
                     "docs/a.md", "+new", "one\ntwo", "Is **this** right?", "lines 2–3",
                     "resolved", "General note", "@ann"):
        assert expected in text, expected


def test_context_drops_code_patches_first_when_too_big():
    text = _context(limit=600)
    assert "+new" not in text
    assert "app/x.py" in text and "read it from the checkout" in text
    assert "one\ntwo" in text  # markdown kept


def test_context_notes_when_github_limits_were_hit():
    assert "only the first 100" in _context(overview=_overview(threads=100))


# -- prompts, labels, errors -------------------------------------------------


def _thread(messages):
    return {"path": "docs/a.md", "startLine": 2, "endLine": 3, "anchorText": "two\nthree",
            "messages": messages}


def test_turn_prompt_first_question():
    prompt = claude.turn_prompt(thread=_thread([]), question="Why two?")
    assert "docs/a.md" in prompt and "lines 2–3" in prompt and "two\nthree" in prompt
    assert prompt.rstrip().endswith("Why two?")
    assert "Earlier in this conversation" not in prompt


def test_turn_prompt_replays_history_but_not_errors():
    history = [{"role": "user", "body": "Q1"}, {"role": "assistant", "body": "A1"},
               {"role": "error", "body": "boom"}]
    prompt = claude.turn_prompt(thread=_thread(history), question="Q2")
    assert "Earlier in this conversation" in prompt and "A1" in prompt and "boom" not in prompt


def test_read_lines(root):
    assert claude.read_lines(root=root, path="docs/a.md", start=2, end=3) == "two\nthree"
    with pytest.raises(ValueError):
        claude.read_lines(root=root, path="../secret", start=1, end=1)


def test_tool_label(root):
    read = claude.tool_label(name="Read", tool_input={"file_path": str(root / "docs/a.md")}, root=root)
    assert read == "Reading docs/a.md"
    grep = claude.tool_label(name="Grep", tool_input={"pattern": "foo"}, root=root)
    assert grep == "Searching for “foo”"
    glob = claude.tool_label(name="Glob", tool_input={"pattern": "**/*.py"}, root=root)
    assert glob == "Listing **/*.py"


def test_describe_error_spots_sign_in_problems():
    assert "isn't signed in" in claude.describe_error(RuntimeError("Invalid API key · Please run /login"))
    assert claude.describe_error(RuntimeError("boom")) == "Claude failed: boom"
