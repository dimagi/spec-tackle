import pytest

from spec_tackle import refs

DOC = [
    "# Spec",                                  # 1
    "",                                        # 2
    "Forms retry as in **section 2**, and",    # 3
    "see the [Limits](#limits) part.",         # 4
    "## 2 Retries",                            # 5
    "Back off.",                               # 6
    "## Limits",                               # 7
    "Five tries.",                             # 8
]


@pytest.fixture
def root(tmp_path):
    (tmp_path / "app").mkdir()
    (tmp_path / "app" / "codes.py").write_text("OK = 0\nRETRY = 4012\n")
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "spec.md").write_text("\n".join(DOC))
    return tmp_path


def check(found, root):
    return refs.validate(found, DOC, path="docs/spec.md", root=root)


def ref(**overrides):
    return {"line": 3, "text": "section 2", "targetStart": 5, "targetEnd": 6, "note": "2 Retries", "targetPath": None, **overrides}


def test_numbered_pads_line_numbers():
    text = "\n".join(f"l{n}" for n in range(1, 11))
    assert refs.numbered(text).splitlines()[0] == " 1| l1"
    assert refs.numbered(text).splitlines()[9] == "10| l10"


def test_parse_reads_the_fenced_refs_list():
    assert refs.parse('Done.\n```json\n{"refs": [{"line": 1}]}\n```') == ([{"line": 1}], [])
    assert refs.parse("no json here")[1] == ["No JSON block found in the answer"]
    assert refs.parse('```json\n{"refs": 3}\n```')[1] == ['the answer must be a JSON object with a "refs" list']


def test_a_good_ref_is_kept_and_markup_is_ignored(root):
    assert check([ref()], root) == [ref()]
    # The phrase sits inside link syntax in the source.
    assert check([ref(line=4, text="Limits", targetStart=7, targetEnd=8)], root)[0]["text"] == "Limits"


def test_a_phrase_can_wrap_onto_the_next_line(root):
    assert check([ref(text="and see the Limits", targetStart=7, targetEnd=8)], root)


def test_bad_refs_are_dropped(root):
    bad = [
        ref(text="section 9"),                     # not on that line
        ref(line=0),                               # outside the file
        ref(targetEnd=99),                         # outside the file
        ref(targetStart=6, targetEnd=5),           # backwards
        ref(targetStart=2, targetEnd=4),           # contains its own line
        ref(line="3"),                             # not a number
        ref(line=True),
        ref(text=""),
        ref(text="x" * 200),
        "not an object",
    ]
    assert check(bad, root) == []


def test_duplicates_are_dropped_and_the_rest_sorted_by_line(root):
    later = ref(line=4, text="Limits", targetStart=7, targetEnd=8)
    kept = check([later, ref(), ref(text="Section 2")], root)
    assert [r["line"] for r in kept] == [3, 4]


def test_note_is_optional_and_trimmed(root):
    assert check([ref(note=None)], root)[0]["note"] == ""
    assert len(check([ref(note="n" * 200)], root)[0]["note"]) == refs.MAX_NOTE


def test_a_ref_to_another_file_is_kept_when_its_lines_exist(root):
    found = check([ref(text="Limits", line=4, targetPath="./app/codes.py", targetStart=2, targetEnd=2)], root)
    assert found[0]["targetPath"] == "app/codes.py"
    # Its own line number doesn't matter in another file.
    assert check([ref(targetPath="app/codes.py", targetStart=1, targetEnd=2)], root)


def test_a_ref_naming_this_document_is_a_same_file_ref(root):
    assert check([ref(targetPath="docs/spec.md")], root)[0]["targetPath"] is None
    assert check([ref(targetPath="docs/spec.md", targetStart=3, targetEnd=4)], root) == []


def test_bad_refs_to_other_files_are_dropped(root):
    bad = [
        ref(targetPath="app/missing.py", targetStart=1, targetEnd=1),
        ref(targetPath="app/codes.py", targetStart=1, targetEnd=3),  # only 2 lines
        ref(targetPath="../outside.py", targetStart=1, targetEnd=1),
        ref(targetPath="/etc/passwd", targetStart=1, targetEnd=1),
        ref(targetPath="app", targetStart=1, targetEnd=1),           # a directory
        ref(targetPath=7, targetStart=1, targetEnd=1),
    ]
    assert check(bad, root) == []


def test_line_map_follows_unchanged_lines():
    assert refs.line_map(["a", "b", "c"], ["new", "a", "B", "c"]) == {1: 2, 3: 4}


def test_partial_request_lists_lines_as_ranges():
    assert "1–3, 7, 9–10." in refs.partial_request([1, 2, 3, 7, 9, 10])


def test_markup_is_left_out_of_the_stored_phrase(tmp_path):
    lines = ["Retry up to `MAX_RETRIES` times, per the [retry policy](retry.md).", "", "MAX_RETRIES = 3"]

    def kept(text):
        found = refs.validate([ref(line=1, text=text, targetStart=3, targetEnd=3)], lines, path="d.md", root=tmp_path)
        return [r["text"] for r in found]

    assert kept("`MAX_RETRIES`") == ["MAX_RETRIES"]
    assert kept("[retry policy](retry.md)") == ["retry policy"]
    # An underscore inside a word is shown, so a phrase without it isn't on the line.
    assert kept("MAXRETRIES") == []


def test_a_path_that_names_this_document_another_way_is_a_same_file_ref(root):
    assert check([ref(targetPath="./docs/spec.md")], root)[0]["targetPath"] is None
    assert check([ref(targetPath="docs/../docs/spec.md")], root)[0]["targetPath"] is None


def test_blank_lines_added_by_a_commit_need_no_check():
    old = ["# Spec", "Text."]
    new = ["# Spec", "", "Text.", "", "New text."]
    _, pending, _ = refs.carry([], path="d.md", old={"d.md": old}, new={"d.md": new})
    assert pending == [5]
