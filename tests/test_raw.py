import pytest

SANDBOX = "default-src 'none'; style-src 'unsafe-inline'; sandbox"


@pytest.mark.parametrize("name", ["a.png", "a.svg"])
def test_images_are_shown_sandboxed(web_app, name):
    response = web_app.get(f"/raw/o/r/sha/docs/{name}")

    assert response.headers["content-type"].startswith("image/")
    assert response.headers["content-security-policy"] == SANDBOX
    assert response.headers["x-content-type-options"] == "nosniff"
    assert "content-disposition" not in response.headers


@pytest.mark.parametrize("name", ["a.html", "a.xhtml", "a.xml", "a.txt", "a.js", "noext"])
def test_anything_else_is_a_download(web_app, name):
    # XHTML or XML opened from a link would otherwise run its script on our origin.
    response = web_app.get(f"/raw/o/r/sha/docs/{name}")

    assert response.headers["content-type"] == "application/octet-stream"
    assert response.headers["content-disposition"] == "attachment"
    assert response.headers["content-security-policy"] == SANDBOX
    assert response.headers["x-content-type-options"] == "nosniff"
