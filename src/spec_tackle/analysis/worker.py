"""Build one Map in its own process: `python -m spec_tackle.analysis.worker` with JSON on stdin.

A separate process keeps grimp's sys.path changes and memory out of the server, and lets
the server stop a build that takes too long.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from .build import build_map


def main() -> None:
    job = json.load(sys.stdin)
    try:
        result = build_map(Path(job["worktree"]), job["files"])
    except Exception as exc:  # report, don't crash: the server shows it with a Retry
        result = {"status": "error", "message": f"Couldn't analyse this PR: {exc}"}
    json.dump(result, sys.stdout)


if __name__ == "__main__":
    main()
