"""The committed bundle must be built from the committed frontend source."""

import hashlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"
DIST = ROOT / "src" / "spec_tackle" / "static" / "dist"
# Keep in sync with frontend/scripts/source-hash.mjs.
INPUTS = ["index.html", "package-lock.json", "vite.config.ts", "tsconfig.json"]


def source_hash() -> str:
    files = sorted(p for p in (FRONTEND / "src").rglob("*") if p.is_file())
    files += [FRONTEND / name for name in INPUTS]
    digest = hashlib.sha256()
    for path in files:
        digest.update(path.relative_to(FRONTEND).as_posix().encode() + b"\0")
        digest.update(path.read_bytes() + b"\0")
    return digest.hexdigest()


def test_bundle_is_built_from_current_source():
    recorded = (DIST / ".source-hash").read_text().strip()
    assert recorded == source_hash(), "frontend changed: run `npm run build` in frontend/"


def test_bundle_has_an_entry_page():
    assert '<div id="root">' in (DIST / "index.html").read_text()
