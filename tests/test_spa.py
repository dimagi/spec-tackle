from urllib.parse import parse_qs, urlsplit

from spec_tackle.app import app


def test_review_route_serves_the_react_shell(web_app):
    response = web_app.get("/pr/o/r/7")

    assert response.status_code == 200
    assert '<div id="root">' in response.text
    assert response.headers["cache-control"] == "no-cache"


def test_home_serves_the_react_shell(web_app):
    assert '<div id="root">' in web_app.get("/").text


def test_the_preview_paths_are_gone(web_app):
    assert web_app.get("/next/pr/o/r/7").status_code == 404


def test_a_pr_link_opens_the_review(web_app):
    response = web_app.get("/?url=https://github.com/o/r/pull/7/files", follow_redirects=False)

    assert response.status_code == 303
    assert response.headers["location"] == "/pr/o/r/7"


def test_a_bad_link_goes_back_home_with_the_error(web_app):
    response = web_app.get("/?url=not-a-pr", follow_redirects=False)

    assert response.status_code == 303
    location = urlsplit(response.headers["location"])
    assert location.path == "/"
    query = parse_qs(location.query)
    assert query["url"] == ["not-a-pr"]
    assert query["error"][0]


def test_session_reports_viewer_and_capabilities(web_app):
    data = web_app.get("/api/session").json()

    assert data["viewer"]["login"] == "me"
    assert data["claude"] is False
    assert isinstance(data["ghCli"], bool)


def test_session_when_signed_out_has_no_viewer(web_app):
    app.state.session.signed_in = False

    assert web_app.get("/api/session").json()["viewer"] is None
