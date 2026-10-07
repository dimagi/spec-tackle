"""Local state on disk: one SQLite file under the user's data directory."""

from __future__ import annotations

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
]


class StoreError(Exception):
    pass


def data_dir() -> Path:
    base = os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share"
    return Path(base) / "spec-tackle"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Store:
    def __init__(self, conn: sqlite3.Connection):
        self._db = conn

    @classmethod
    def open(cls, path: Path | None = None) -> Store:
        path = path or data_dir() / "state.db"
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            # One connection, used only from the event loop thread at a time.
            conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA foreign_keys = ON")
            version = conn.execute("PRAGMA user_version").fetchone()[0]
            for number, sql in enumerate(_MIGRATIONS[version:], start=version + 1):
                conn.executescript(f"BEGIN; {sql} PRAGMA user_version = {number}; COMMIT;")
        except (OSError, sqlite3.Error) as exc:
            raise StoreError(f"Can't open {path}: {exc}") from exc
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
