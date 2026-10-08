from spec_tackle.app import app


def test_page_returns_everything_the_review_ui_needs(web_app):
    data = web_app.get("/api/pr/o/r/7/page").json()

    assert data["pr"] == {"owner": "o", "repo": "r", "number": 7, "url": "https://github.com/o/r/pull/7"}
    assert data["overview"]["title"] == "Add spec"
    assert "reviewThreads" not in data["overview"]
    assert data["activity"]["headSha"] == "abc1234"
    assert data["viewer"]["login"] == "me"
    assert data["claude"] is False

    [file] = data["files"]
    assert file["path"] == "docs/a.md"
    assert file["markdown"] is True and file["wholeFile"] is True
    assert 'data-ls="1"' in file["rendered"]
    assert file["outline"][0]["text"] == "Title"
    assert file["hunks"] == [[1, 4]]


def test_page_when_signed_out_says_so(web_app):
    app.state.session.signed_in = False

    response = web_app.get("/api/pr/o/r/7/page")

    assert response.status_code == 401
    assert response.json()["signedOut"] is True
