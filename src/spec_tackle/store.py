"""Local state on disk: one SQLite file under the user's data directory."""

from __future__ import annotations

import json
import os
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path

from .github import PRRef

# Each entry moves the schema up one version (tracked in PRAGMA user_version).
_MIGRATIONS = [
    # 1: recent PRs (table kept for a possible future feature)
    """
    CREATE TABLE recent_prs (
        login TEXT NOT NULL, owner TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL,
        title TEXT NOT NULL, opened_at TEXT NOT NULL,
        PRIMARY KEY (login, owner, repo, number)
    );
    """,
    # 2: private Claude threads (see docs/specs/ask-claude.md)
    """
    CREATE TABLE claude_threads (
        id TEXT PRIMARY KEY, login TEXT NOT NULL,
        owner TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL,
        path TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL,
        anchor_text TEXT, commit_sha TEXT NOT NULL, snapshot TEXT, session_id TEXT,
        created_at TEXT NOT NULL
    );
    CREATE TABLE claude_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL REFERENCES claude_threads(id) ON DELETE CASCADE,
        role TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX claude_threads_by_pr ON claude_threads (login, owner, repo, number);
    """,
    # 3: Logic view maps (see docs/specs/2026-10-08-logic-view-design.md)
    """
    CREATE TABLE logic_maps (
        id TEXT PRIMARY KEY, login TEXT NOT NULL,
        owner TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL,
        head_sha TEXT NOT NULL, summary TEXT NOT NULL, tree TEXT NOT NULL,
        changed_lines TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE (login, owner, repo, number, head_sha)
    );
    """,
    # 4: cross-references in a document (see docs/specs/2026-10-09-doc-references-design.md)
    """
    CREATE TABLE doc_refs (
        id TEXT PRIMARY KEY, login TEXT NOT NULL,
        owner TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL,
        path TEXT NOT NULL, head_sha TEXT NOT NULL, refs TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE (login, owner, repo, number, path, head_sha)
    );
    """,
    # 5: references carried forward from an older commit, and the lines still to check
    """
    ALTER TABLE doc_refs ADD COLUMN pending TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE doc_refs ADD COLUMN based_on TEXT;
    ALTER TABLE doc_refs ADD COLUMN outdated INTEGER NOT NULL DEFAULT 0;
    """,
    # 6: Logic walkthrough traces (see docs/specs/2026-10-10-logic-walkthrough-design.md)
    """
    CREATE TABLE logic_traces (
        id TEXT PRIMARY KEY, login TEXT NOT NULL, map_id TEXT NOT NULL, entry_id TEXT NOT NULL,
        input_hash TEXT NOT NULL, inputs TEXT NOT NULL, steps TEXT NOT NULL, outcome TEXT NOT NULL,
        proposed INTEGER NOT NULL, used_at TEXT NOT NULL,
        UNIQUE (login, map_id, entry_id, input_hash)
    );
    """,
]


class StoreError(Exception):
    pass


def data_dir() -> Path:
    base = os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share"
    return Path(base) / "spec-tackle"


def make_private(path: Path) -> None:
    """Create `path` if needed and make it readable only by this user.

    It holds private questions, answers and clones of private repos.
    """
    path.mkdir(parents=True, exist_ok=True)
    path.chmod(0o700)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _now_exact() -> str:
    """Like _now, with microseconds: traces used within the same second still order right."""
    return datetime.now(timezone.utc).isoformat()


class Store:
    def __init__(self, conn: sqlite3.Connection):
        self._db = conn

    @classmethod
    def open(cls, path: Path | None = None) -> Store:
        try:
            if path is None:
                make_private(data_dir())
                path = data_dir() / "state.db"
            path.parent.mkdir(parents=True, exist_ok=True)
            # One connection, used only from the event loop thread at a time.
            conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA foreign_keys = ON")
            version = conn.execute("PRAGMA user_version").fetchone()[0]
            for number, sql in enumerate(_MIGRATIONS[version:], start=version + 1):
                conn.executescript(f"BEGIN; {sql} PRAGMA user_version = {number}; COMMIT;")
        except (OSError, sqlite3.Error) as exc:
            raise StoreError(f"Can't open {path or data_dir()}: {exc}") from exc
        return cls(conn)

    def close(self) -> None:
        self._db.close()

    # -- Claude threads ----------------------------------------------------

    def create_thread(
        self, *, login: str, pr: PRRef, path: str, start: int, end: int, commit: str
    ) -> str:
        thread_id = str(uuid.uuid4())
        self._db.execute(
            "INSERT INTO claude_threads (id, login, owner, repo, number, path, start_line,"
            " end_line, commit_sha, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (thread_id, login, pr.owner, pr.repo, pr.number, path, start, end, commit, _now()),
        )
        return thread_id

    def add_message(self, *, thread_id: str, role: str, body: str) -> None:
        self._db.execute(
            "INSERT INTO claude_messages (thread_id, role, body, created_at) VALUES (?, ?, ?, ?)",
            (thread_id, role, body, _now()),
        )

    def set_thread_context(self, *, thread_id: str, anchor_text: str, snapshot: str) -> None:
        self._db.execute(
            "UPDATE claude_threads SET anchor_text = ?, snapshot = ? WHERE id = ?",
            (anchor_text, snapshot, thread_id),
        )

    def set_session(self, *, thread_id: str, session_id: str) -> None:
        self._db.execute(
            "UPDATE claude_threads SET session_id = ? WHERE id = ?", (session_id, thread_id)
        )

    def thread(self, *, login: str, thread_id: str) -> dict | None:
        row = self._db.execute(
            "SELECT * FROM claude_threads WHERE id = ? AND login = ?", (thread_id, login)
        ).fetchone()
        return self._with_messages(row) if row else None

    def threads_for_pr(self, *, login: str, pr: PRRef) -> list[dict]:
        rows = self._db.execute(
            "SELECT * FROM claude_threads WHERE login = ? AND owner = ? AND repo = ? AND number = ?"
            " ORDER BY created_at, rowid",
            (login, pr.owner, pr.repo, pr.number),
        ).fetchall()
        return [self._with_messages(row) for row in rows]

    def delete_thread(self, *, login: str, thread_id: str) -> bool:
        cursor = self._db.execute(
            "DELETE FROM claude_threads WHERE id = ? AND login = ?", (thread_id, login)
        )
        return cursor.rowcount > 0

    def _with_messages(self, row: sqlite3.Row) -> dict:
        messages = self._db.execute(
            "SELECT role, body, created_at FROM claude_messages WHERE thread_id = ? ORDER BY id",
            (row["id"],),
        ).fetchall()
        return {
            "id": row["id"],
            "owner": row["owner"],
            "repo": row["repo"],
            "number": row["number"],
            "path": row["path"],
            "startLine": row["start_line"],
            "endLine": row["end_line"],
            "anchorText": row["anchor_text"],
            "commit": row["commit_sha"],
            "snapshot": row["snapshot"],
            "sessionId": row["session_id"],
            "createdAt": row["created_at"],
            "messages": [
                {"role": m["role"], "body": m["body"], "createdAt": m["created_at"]}
                for m in messages
            ],
        }

    # -- Logic maps ---------------------------------------------------------

    def save_logic_map(
        self, *, login: str, pr: PRRef, head_sha: str, summary: str, blocks: list,
        changed_lines: dict[str, list[int]],
    ) -> str:
        """Store a map; one for the same login, PR and commit is replaced, and its traces dropped."""
        map_id = str(uuid.uuid4())
        self._db.execute("BEGIN")
        try:
            self._db.execute(
                "DELETE FROM logic_traces WHERE map_id IN (SELECT id FROM logic_maps"
                " WHERE login = ? AND owner = ? AND repo = ? AND number = ? AND head_sha = ?)",
                (login, pr.owner, pr.repo, pr.number, head_sha),
            )
            self._db.execute(
                "INSERT OR REPLACE INTO logic_maps (id, login, owner, repo, number, head_sha, summary,"
                " tree, changed_lines, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (map_id, login, pr.owner, pr.repo, pr.number, head_sha, summary,
                 json.dumps(blocks), json.dumps(changed_lines), _now()),
            )
            self._db.execute("COMMIT")
        except BaseException:
            self._db.execute("ROLLBACK")
            raise
        return map_id

    def latest_logic_map(self, *, login: str, pr: PRRef) -> dict | None:
        row = self._db.execute(
            "SELECT * FROM logic_maps WHERE login = ? AND owner = ? AND repo = ? AND number = ?"
            " ORDER BY created_at DESC, rowid DESC LIMIT 1",
            (login, pr.owner, pr.repo, pr.number),
        ).fetchone()
        return self._logic_map(row) if row else None

    def logic_map(self, *, login: str, map_id: str) -> dict | None:
        row = self._db.execute(
            "SELECT * FROM logic_maps WHERE id = ? AND login = ?", (map_id, login)
        ).fetchone()
        return self._logic_map(row) if row else None

    @staticmethod
    def _logic_map(row: sqlite3.Row) -> dict:
        return {
            "id": row["id"],
            "owner": row["owner"],
            "repo": row["repo"],
            "number": row["number"],
            "headSha": row["head_sha"],
            "summary": row["summary"],
            "blocks": json.loads(row["tree"]),
            "changedLines": json.loads(row["changed_lines"]),
            "createdAt": row["created_at"],
        }

    # -- Logic walkthrough traces ---------------------------------------------------

    def save_trace(
        self, *, login: str, map_id: str, entry_id: str, input_hash: str, inputs: list,
        steps: list, outcome: dict, proposed: bool,
    ) -> str:
        """Store a trace; one for the same login, map, entry and inputs is replaced."""
        trace_id = str(uuid.uuid4())
        self._db.execute(
            "INSERT OR REPLACE INTO logic_traces (id, login, map_id, entry_id, input_hash, inputs,"
            " steps, outcome, proposed, used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (trace_id, login, map_id, entry_id, input_hash, json.dumps(inputs), json.dumps(steps),
             json.dumps(outcome), int(proposed), _now_exact()),
        )
        return trace_id

    def trace(self, *, login: str, trace_id: str) -> dict | None:
        row = self._db.execute(
            "SELECT * FROM logic_traces WHERE id = ? AND login = ?", (trace_id, login)
        ).fetchone()
        return self._trace(row) if row else None

    def trace_by_hash(self, *, login: str, map_id: str, entry_id: str, input_hash: str) -> dict | None:
        row = self._db.execute(
            "SELECT * FROM logic_traces WHERE login = ? AND map_id = ? AND entry_id = ? AND input_hash = ?",
            (login, map_id, entry_id, input_hash),
        ).fetchone()
        return self._trace(row) if row else None

    def latest_trace(self, *, login: str, map_id: str, entry_id: str) -> dict | None:
        row = self._db.execute(
            "SELECT * FROM logic_traces WHERE login = ? AND map_id = ? AND entry_id = ?"
            " ORDER BY used_at DESC, rowid DESC LIMIT 1",
            (login, map_id, entry_id),
        ).fetchone()
        return self._trace(row) if row else None

    def proposed_trace(self, *, login: str, map_id: str, entry_id: str) -> dict | None:
        row = self._db.execute(
            "SELECT * FROM logic_traces WHERE login = ? AND map_id = ? AND entry_id = ? AND proposed = 1"
            " ORDER BY used_at DESC LIMIT 1",
            (login, map_id, entry_id),
        ).fetchone()
        return self._trace(row) if row else None

    def touch_trace(self, *, trace_id: str) -> None:
        self._db.execute("UPDATE logic_traces SET used_at = ? WHERE id = ?", (_now_exact(), trace_id))

    @staticmethod
    def _trace(row: sqlite3.Row) -> dict:
        return {
            "id": row["id"],
            "mapId": row["map_id"],
            "entryId": row["entry_id"],
            "inputs": json.loads(row["inputs"]),
            "steps": json.loads(row["steps"]),
            "outcome": json.loads(row["outcome"]),
            "proposed": bool(row["proposed"]),
            "usedAt": row["used_at"],
        }

    # -- Document cross-references ---------------------------------------------

    def save_doc_refs(
        self, *, login: str, pr: PRRef, path: str, head_sha: str, refs: list,
        pending: list[int] | None = None, based_on: str | None = None, outdated: int = 0,
    ) -> str:
        """Store a file's references; a set for the same login, PR, path and commit is replaced.

        A set carried forward from an older commit (`based_on`) lists the document lines
        still to check (`pending`) and how many references were dropped as `outdated`.
        """
        refs_id = str(uuid.uuid4())
        self._db.execute(
            "INSERT OR REPLACE INTO doc_refs (id, login, owner, repo, number, path, head_sha, refs,"
            " created_at, pending, based_on, outdated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (refs_id, login, pr.owner, pr.repo, pr.number, path, head_sha, json.dumps(refs), _now(),
             json.dumps(pending or []), based_on, outdated),
        )
        return refs_id

    def latest_doc_refs(self, *, login: str, pr: PRRef, path: str) -> dict | None:
        row = self._db.execute(
            "SELECT * FROM doc_refs WHERE login = ? AND owner = ? AND repo = ? AND number = ? AND path = ?"
            " ORDER BY created_at DESC, rowid DESC LIMIT 1",
            (login, pr.owner, pr.repo, pr.number, path),
        ).fetchone()
        return self._doc_refs(row) if row else None

    def doc_refs_at(self, *, login: str, pr: PRRef, path: str, head_sha: str) -> dict | None:
        row = self._db.execute(
            "SELECT * FROM doc_refs WHERE login = ? AND owner = ? AND repo = ? AND number = ? AND path = ?"
            " AND head_sha = ?",
            (login, pr.owner, pr.repo, pr.number, path, head_sha),
        ).fetchone()
        return self._doc_refs(row) if row else None

    def doc_refs(self, *, login: str, refs_id: str) -> dict | None:
        row = self._db.execute(
            "SELECT * FROM doc_refs WHERE id = ? AND login = ?", (refs_id, login)
        ).fetchone()
        return self._doc_refs(row) if row else None

    @staticmethod
    def _doc_refs(row: sqlite3.Row) -> dict:
        return {
            "id": row["id"],
            "owner": row["owner"],
            "repo": row["repo"],
            "number": row["number"],
            "path": row["path"],
            "headSha": row["head_sha"],
            "refs": json.loads(row["refs"]),
            "pending": json.loads(row["pending"]),
            "basedOn": row["based_on"],
            "outdated": row["outdated"],
            "createdAt": row["created_at"],
        }
