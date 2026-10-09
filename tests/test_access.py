import stat

import pytest
from fastapi.testclient import TestClient

from spec_tackle import _is_loopback
from spec_tackle.access import COOKIE, Access
from spec_tackle.app import app


@pytest.fixture
def stranger():
    """A client that never opened the launch link."""
    with TestClient(app) as client:
        yield client


def test_pages_are_locked_without_the_cookie(stranger):
    response = stranger.get("/pr/o/r/7")

    assert response.status_code == 403
    assert "printed in the terminal" in response.text
    assert '<div id="root">' not in response.text


@pytest.mark.parametrize("path", ["/api/session", "/auth/login"])
def test_the_api_is_locked_without_the_cookie(stranger, path):
    response = stranger.get(path)

    assert response.status_code == 403
    assert response.json()["locked"] is True


def test_repo_files_are_locked_without_the_cookie(stranger):
    assert stranger.get("/raw/o/r/sha/docs/a.png").status_code == 403


def test_posts_are_locked_without_the_cookie(stranger):
    assert stranger.post("/api/pr/o/r/7/logic").status_code == 403
    assert stranger.post("/auth/login").status_code == 403


def test_a_wrong_cookie_is_locked_out(stranger):
    stranger.cookies.set(COOKIE, "guess")

    assert stranger.get("/api/session").status_code == 403


def test_the_bundle_is_public(stranger):
    assert stranger.get("/static/favicon.svg").status_code == 200


def test_the_launch_link_sets_the_cookie_once(stranger, known_access):
    code = known_access.launch_code()

    response = stranger.get(f"/pr/o/r/7?key={code}&x=1", follow_redirects=False)

    assert response.status_code == 303
    assert response.headers["location"] == "/pr/o/r/7?x=1"
    cookie = response.headers["set-cookie"]
    assert cookie.startswith(f"{COOKIE}={known_access.secret};")
    assert "HttpOnly" in cookie and "SameSite=Lax" in cookie
    assert stranger.get("/api/session").status_code == 200

    stranger.cookies.clear()
    assert stranger.get(f"/pr/o/r/7?key={code}", follow_redirects=False).status_code == 403


def test_an_old_link_still_works_in_a_browser_with_the_cookie(web_app):
    response = web_app.get("/pr/o/r/7?key=used-up", follow_redirects=False)

    assert response.status_code == 303
    assert response.headers["location"] == "/pr/o/r/7"


def test_the_launch_link_never_redirects_off_site(stranger, known_access):
    response = stranger.get(f"http://testserver//evil.example/?key={known_access.launch_code()}", follow_redirects=False)

    assert response.headers["location"] == "/evil.example/"


def test_the_secret_is_kept_private_and_reused(isolated_data_home):
    first = Access.load()

    path = isolated_data_home / "spec-tackle" / "key"
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert Access.load().secret == first.secret


@pytest.mark.parametrize(
    "host, loopback",
    [("127.0.0.1", True), ("localhost", True), ("::1", True), ("0.0.0.0", False), ("192.168.1.5", False)],
)
def test_loopback_hosts(host, loopback):
    assert _is_loopback(host) is loopback
