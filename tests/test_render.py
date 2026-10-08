import re

import pytest

from spec_tackle import render
from spec_tackle.github import PRRef, parse_pr_url

PATCH = """@@ -1,3 +1,4 @@
 # Title
-old line
+new line
+another
 tail
@@ -20,2 +21,3 @@ section
 context
+added at 22
 more"""


@pytest.mark.parametrize(
    "value",
    [
        "https://github.com/dimagi/commcare-connect/pull/1569/changes",
        "https://github.com/dimagi/commcare-connect/pull/1569",
        "github.com/dimagi/commcare-connect/pull/1569/files#diff-abc",
        "dimagi/commcare-connect#1569",
    ],
)
def test_parse_pr_url(value):
    assert parse_pr_url(value) == PRRef("dimagi", "commcare-connect", 1569)


def test_parse_pr_url_rejects_other_links():
    with pytest.raises(ValueError):
        parse_pr_url("https://github.com/dimagi/commcare-connect/issues/12")


def test_parse_patch_hunks_and_added_lines():
    hunks, added = render.parse_patch(PATCH)
    assert hunks == [(1, 4), (21, 23)]
    assert added == {2, 3, 22}


def test_resolve_anchor_whole_file_keeps_range():
    assert render.resolve_anchor(5, 9, [], whole_file=True) == {"line": 9, "start_line": 5}
    assert render.resolve_anchor(5, 5, [], whole_file=True) == {"line": 5, "start_line": None}


def test_resolve_anchor_clips_to_first_overlapping_hunk():
    hunks = [(1, 4), (21, 23)]
    assert render.resolve_anchor(3, 10, hunks, False) == {"line": 4, "start_line": 3}
    assert render.resolve_anchor(15, 30, hunks, False) == {"line": 23, "start_line": 21}


def test_resolve_anchor_outside_hunks_is_not_commentable():
    assert render.resolve_anchor(8, 12, [(1, 4), (21, 23)], False) is None


def _render(text, added=None):
    return render.render_markdown(
        text, path="docs/spec.md", raw_base="/raw/o/r/sha", blob_base="https://gh/blob/sha",
        added_lines=added,
    )


def test_markdown_blocks_carry_source_lines():
    html = _render("# Title\n\nPara one\nstill one\n\n- a\n- b\n")
    assert '<h1 data-ls="1" data-le="1"' in html
    assert '<p data-ls="3" data-le="4">' in html
    assert re.search(r'<li data-ls="6" data-le="6"', html)
    assert re.search(r'<li data-ls="7" data-le="7"', html)


def test_markdown_table_rows_are_individually_addressable():
    html = _render("| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n")
    assert '<tr data-ls="3" data-le="3">' in html
    assert '<tr data-ls="4" data-le="4">' in html


def test_markdown_tables_are_wrapped_for_framing_and_scrolling():
    html = _render("| a | b |\n|---|---|\n| 1 | 2 |\n")
    assert re.search(r'<div class="table-wrap"><table data-ls="1"', html)
    assert html.rstrip().endswith("</table>\n</div>")


def test_code_lines_carry_their_indentation():
    html = _render("```python\nif x:\n    y = 1\n\n```\n")
    assert 'style="--indent:0" data-ls="2"' in html
    assert 'style="--indent:4" data-ls="3"' in html


def test_fenced_code_lines_map_to_file_lines():
    html = _render("intro\n\n```python\nx = 1\ny = 2\n```\n")
    assert 'data-ls="4" data-le="4"' in html  # x = 1
    assert 'data-ls="5" data-le="5"' in html  # y = 2


def test_mermaid_is_left_for_the_browser():
    html = _render("```mermaid\ngraph TD; A-->B\n```\n")
    assert '<pre class="mermaid">graph TD; A--&gt;B</pre>' in html


def test_changed_blocks_are_marked():
    html = _render("one\n\ntwo\n", added={3})
    assert '<p data-ls="3" data-le="3" class="is-changed">' in html
    assert '<p data-ls="1" data-le="1">' in html


def test_relative_images_and_links_are_rewritten():
    html = _render("![d](img/a.png) [other](../b.md#x) [ext](https://x.y)")
    assert 'src="/raw/o/r/sha/docs/img/a.png"' in html
    assert 'href="https://gh/blob/sha/b.md#x"' in html
    assert 'href="https://x.y"' in html


def test_raw_html_is_escaped():
    assert "<script>" not in _render("<script>alert(1)</script>")


def test_outline_extracts_headings_with_lines():
    html = _render("# Top\n\n## Goals\n\ntext\n\n## Goals\n")
    items = render.outline(html)
    assert [(i["level"], i["line"], i["text"]) for i in items] == [
        (1, 1, "Top"), (2, 3, "Goals"), (2, 7, "Goals"),
    ]
    assert len({i["id"] for i in items}) == 3


def test_outline_text_is_plain_text_not_html():
    items = render.outline(_render("## A `b` -> [c](x) & d\n"))
    assert items[0]["text"] == "A b -> c & d"


def test_diff_marks_new_side_lines_only():
    html = render.render_diff(PATCH, "spec.md")
    assert 'class="diff-add" data-ls="2"' in html
    assert 'class="diff-ctx" data-ls="21"' in html
    assert "diff-del" in html and 'diff-del" data-ls' not in html


def test_inline_code_can_break_after_slashes_and_dots():
    html = _render("Call `/api/c/<id>` or `a.b`.\n")
    assert "<code>/<wbr>api/<wbr>c/<wbr>&lt;id&gt;</code>" in html
    assert "<code>a.<wbr>b</code>" in html


def _activity_payload():
    author = {"__typename": "User", "login": "ann", "avatarUrl": ""}
    comment = {"databaseId": 1, "author": author, "body": "**hi**", "bodyHTML": "<b>hi</b>",
               "createdAt": "2026-01-01T00:00:00Z", "url": "u", "replyTo": None}
    return {
        "headRefOid": "abc", "state": "OPEN", "isDraft": False, "merged": False,
        "viewer": {"login": "me", "avatarUrl": ""},
        "reviewThreads": {"nodes": [{
            "id": "T1", "isResolved": False, "isOutdated": False, "path": "a.md", "line": 3,
            "startLine": None, "originalLine": 3, "originalStartLine": None, "diffSide": "RIGHT",
            "subjectType": "LINE", "resolvedBy": None, "comments": {"nodes": [comment]},
        }]},
        "comments": {"nodes": [{"databaseId": 2, "author": author, "body": "general",
                                "bodyHTML": "<p>general</p>", "createdAt": "2026-01-02T00:00:00Z", "url": "u"}]},
        "reviews": {"nodes": [{"databaseId": 3, "state": "COMMENTED", "author": author, "body": "lgtm",
                               "bodyHTML": "<p>lgtm</p>", "submittedAt": "2026-01-03T00:00:00Z", "url": "u"}]},
    }


def test_normalize_activity_keeps_markdown_bodies():
    activity = render.normalize_activity(_activity_payload())
    assert activity["threads"][0]["comments"][0]["body"] == "**hi**"
    assert [c["body"] for c in activity["conversation"]] == ["general", "lgtm"]


def test_queries_ask_for_markdown_bodies():
    from spec_tackle import github
    assert "body bodyHTML" in github._ACTIVITY_FIELDS
    assert "url body bodyHTML" in github._OVERVIEW_QUERY


def test_render_answer_formats_markdown():
    html = render.render_answer("**Yes**, see `app.py`.\n\n```python\nx = 1\n```")
    assert "<strong>Yes</strong>" in html and "<code>app.py</code>" in html
    assert "<pre" in html and "x" in html


def test_render_answer_neutralises_html_images_and_js_links():
    html = render.render_answer(
        '<img src=x onerror=alert(1)>\n\n![secret](https://evil.example/?leak=1)\n\n'
        '[click](javascript:alert(1)) [docs](https://example.com)'
    )
    assert "<img" not in html
    assert "&lt;img" in html
    assert "secret (https://evil.example/?leak=1)" in html
    assert 'href="javascript' not in html
    assert '<a href="https://example.com" target="_blank" rel="noopener noreferrer">docs</a>' in html
