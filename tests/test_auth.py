import asyncio
import os
import stat

import pytest
from fastapi.testclient import TestClient

from spec_tackle import auth
from spec_tackle.app import app


def _fake_gh(tmp_path, monkeypatch, script: str) -> None:
    """Put a stand-in `gh` first on PATH that runs `script` (a POSIX shell body)."""
    gh = tmp_path / "gh"
    gh.write_text(f"#!/bin/sh\n{script}\n")
    gh.chmod(gh.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("PATH", f"{tmp_path}{os.pathsep}{os.environ['PATH']}")


async def _run_login() -> auth.LoginFlow:
    flow = auth.LoginFlow()
    await flow.start(timeout=5)
    if flow._task:
        await flow._task
    return flow


def test_login_flow_reads_the_one_time_code_and_waits_for_approval(tmp_path, monkeypatch):
    _fake_gh(tmp_path, monkeypatch, """
echo "! First copy your one-time code: AB12-CD34"
echo "Open this URL to continue in your web browser: https://github.com/login/device"
sleep 0.2
echo "✓ Logged in as someone"
""")
    flow = asyncio.run(_run_login())
    assert flow.code == "AB12-CD34"
    assert flow.url == "https://github.com/login/device"
    assert flow.state == "done"


def test_login_flow_reports_the_cli_error(tmp_path, monkeypatch):
    _fake_gh(tmp_path, monkeypatch, 'echo "error connecting to github.com"; exit 1')
    flow = asyncio.run(_run_login())
    assert flow.state == "failed"
    assert flow.message == "error connecting to github.com"


@pytest.fixture
def signed_out(monkeypatch):
    monkeypatch.setattr(auth, "find_token", lambda: None)
    with TestClient(app) as client:
        yield client


def test_home_page_offers_sign_in_when_signed_out(signed_out):
    html = signed_out.get("/").text
    assert "Sign in to GitHub to start" in html
    assert "Not signed in" in html
    assert 'name="url"' not in html  # the PR link box waits until you're signed in


def test_review_page_sends_you_to_sign_in_and_back(signed_out):
    response = signed_out.get("/pr/o/r/1")
    assert response.status_code == 401
    assert "Sign in to GitHub to start" in response.text
    assert '"/pr/o/r/1"' in response.text  # where to return after signing in


def test_api_says_signed_out(signed_out):
    response = signed_out.get("/api/pr/o/r/1/activity")
    assert response.status_code == 401
    assert response.json()["signedOut"] is True


def test_next_only_returns_to_this_app(signed_out):
    assert "evil.example" not in signed_out.get("/?next=//evil.example/x").text


def test_session_token_returns_the_signed_in_token(monkeypatch):
    async def fake_viewer(self):
        return {"login": "me", "name": None, "avatarUrl": ""}

    monkeypatch.setattr(auth, "find_token", lambda: "tok-123")
    monkeypatch.setattr(auth.GitHub, "viewer", fake_viewer)
    session = auth.Session()
    assert asyncio.run(session.token()) == "tok-123"


def test_session_token_raises_when_signed_out(monkeypatch):
    monkeypatch.setattr(auth, "find_token", lambda: None)
    with pytest.raises(auth.NotSignedIn):
        asyncio.run(auth.Session().token())
