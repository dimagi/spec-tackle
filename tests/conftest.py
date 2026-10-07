import pytest


@pytest.fixture(autouse=True)
def isolated_data_home(tmp_path, monkeypatch):
    """Keep every test's state.db and repo checkouts out of the real home directory."""
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "data"))
    return tmp_path / "data"
