"""Map jobs: analyse a PR's head checkout in a subprocess, once, and cache the result."""

from __future__ import annotations

import asyncio
import json
import os
import re
import sys
from pathlib import Path

WORKER = [sys.executable, "-m", "spec_tackle.analysis.worker"]
_NAME = re.compile(r"[A-Za-z0-9_.-]+")
_SHA = re.compile(r"[0-9a-f]{7,40}")


async def _run(command: list[str], payload: bytes, timeout: float, env: dict[str, str]) -> dict | None:
    proc = await asyncio.create_subprocess_exec(
        *command, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE, env=env,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(payload), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return None
    if proc.returncode != 0:
        return {"status": "error", "message": err.decode("utf-8", "replace").strip()[-500:] or "Analysis failed"}
    return json.loads(out)


async def run_worker(worktree: Path, files: list[dict], timeout: float, command: list[str] = WORKER) -> dict:
    """The map for `worktree`; if the import graph takes too long, a partial map without it."""
    payload = json.dumps({"worktree": str(worktree), "files": files}).encode()
    result = await _run(command, payload, timeout, dict(os.environ))
    if result is None:
        result = await _run(command, payload, timeout, {**os.environ, "SPEC_TACKLE_NO_GRAPH": "1"})
    return result or {"status": "error", "message": "Analysing this PR took too long."}


class MapJobs:
    def __init__(self, root: Path, checkouts, timeout: float = 60, run=run_worker):
        self.root = root
        self.checkouts = checkouts
        self.timeout = timeout
        self._run = run
        self._jobs: dict[tuple, asyncio.Task] = {}
        self._errors: dict[tuple, str] = {}

    def _path(self, key: tuple) -> Path:
        return self.root / ("__".join(key) + ".json")

    async def get(self, *, owner: str, repo: str, base: str, head: str, files: list[dict], token: str) -> dict:
        """The cached map, the last error (once), or {"status": "pending"} while a job runs."""
        if not (_NAME.fullmatch(owner) and _NAME.fullmatch(repo)) or owner in (".", "..") or repo in (".", ".."):
            raise ValueError("Not a valid owner or repo name")
        if not (_SHA.fullmatch(base) and _SHA.fullmatch(head)):
            raise ValueError("Not a commit id")
        key = (owner, repo, base, head)
        path = self._path(key)
        if path.exists():
            return json.loads(path.read_text())
        if key in self._errors and key not in self._jobs:
            return {"status": "error", "message": self._errors.pop(key)}
        if key not in self._jobs:
            self._jobs[key] = asyncio.create_task(self._build(key, files, token))
        return {"status": "pending"}

    def running(self, *, owner: str, repo: str, base: str, head: str) -> bool:
        return (owner, repo, base, head) in self._jobs

    def cached(self, *, owner: str, repo: str, base: str, head: str) -> dict | None:
        path = self._path((owner, repo, base, head))
        return json.loads(path.read_text()) if path.exists() else None

    def narration(self, *, owner: str, repo: str, base: str, head: str) -> dict | None:
        path = self._path((owner, repo, base, head)).with_suffix(".narration.json")
        return json.loads(path.read_text()) if path.exists() else None

    def save_narration(self, *, owner: str, repo: str, base: str, head: str, notes: dict) -> None:
        self._path((owner, repo, base, head)).with_suffix(".narration.json").write_text(json.dumps(notes))

    async def _build(self, key: tuple, files: list[dict], token: str) -> None:
        owner, repo, _, head = key
        try:
            worktree = await self.checkouts.worktree(owner=owner, repo=repo, sha=head, token=token)
            result = await self._run(worktree, files, self.timeout)
            if result.get("status") == "error":
                self._errors[key] = result["message"]
            else:
                self.root.mkdir(parents=True, exist_ok=True)
                tmp = self._path(key).with_suffix(".tmp")
                tmp.write_text(json.dumps(result))
                tmp.replace(self._path(key))
        except Exception as exc:
            self._errors[key] = str(exc)
        finally:
            self._jobs.pop(key, None)


NARRATE_PROMPT = """For each file below, write one short sentence saying why this PR changes it,
from the point of view of a reviewer reading the PR in order. Answer with only a JSON object
mapping each path to its sentence.

Files:
"""


def parse_notes(answer: str, paths: list[str]) -> dict[str, str]:
    """The first JSON object in Claude's answer, keeping one line per known path."""
    start = answer.find("{")
    while start != -1:
        try:
            data, _ = json.JSONDecoder().raw_decode(answer[start:])
        except json.JSONDecodeError:
            start = answer.find("{", start + 1)
            continue
        if isinstance(data, dict):
            known = set(paths)
            return {
                p: str(v).strip().splitlines()[0][:200]
                for p, v in data.items() if p in known and isinstance(v, str) and v.strip()
            }
        break
    return {}
