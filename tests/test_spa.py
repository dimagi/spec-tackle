from spec_tackle.app import app


def test_review_route_serves_the_react_shell(web_app):
    response = web_app.get("/next/pr/o/r/7")

    assert response.status_code == 200
    assert '<div id="root">' in response.text
    assert response.headers["cache-control"] == "no-cache"


def test_index_route_serves_the_react_shell(web_app):
    assert '<div id="root">' in web_app.get("/next/").text


def test_session_reports_viewer_and_capabilities(web_app):
    data = web_app.get("/api/session").json()

    assert data["viewer"]["login"] == "me"
    assert data["claude"] is False
    assert isinstance(data["ghCli"], bool)


def test_session_when_signed_out_has_no_viewer(web_app):
    app.state.session.signed_in = False

    assert web_app.get("/api/session").json()["viewer"] is None
