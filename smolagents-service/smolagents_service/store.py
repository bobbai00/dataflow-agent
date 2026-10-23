# Licensed to the Apache Software Foundation (ASF) under one or more
# contributor license agreements. See the NOTICE file distributed with
# this work for additional information regarding copyright ownership.
# The ASF licenses this file to You under the Apache License, Version 2.0
# (the "License"); you may not use this file except in compliance with
# the License. You may obtain a copy of the License at
# http://www.apache.org/licenses/LICENSE-2.0
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""SQLite storage: accounts, logins, and every trace record, each row owned by one user.

One connection, guarded by a lock, serves every thread; WAL mode lets outside
readers (the sqlite3 shell, a notebook) read while the server writes. Timestamps
are Unix epoch seconds as floats. Every read takes the caller's user id and
filters on it: that filter is the isolation the API and the UI rely on.

Tables, from the outside in: a `chat_sessions` row is one browser session with
its own agent and Python worker; a `runs` row is either one user message and the
agent's whole answer to it (kind 'agent') or one piece of the user's own code run
in the session's interpreter (kind 'script'); a `steps` row is one agent step;
`llm_calls` and `python_execs` are the model call and the code execution inside
a step, each with its own start and end, and each execution names the worker
process that ran it. `events` records account actions (register, login, logout,
uploads).
"""

import hashlib
import hmac
import json
import re
import secrets
import sqlite3
import threading
import time
import uuid
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS logins (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at REAL NOT NULL,
    expires_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    model_id TEXT,
    started_at REAL NOT NULL,
    ended_at REAL,
    end_reason TEXT
);
CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    chat_session_id TEXT NOT NULL REFERENCES chat_sessions(id),
    turn INTEGER NOT NULL,
    task TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'agent',
    started_at REAL NOT NULL,
    ended_at REAL,
    status TEXT NOT NULL DEFAULT 'running',
    final_answer TEXT,
    error TEXT
);
CREATE TABLE IF NOT EXISTS steps (
    run_id TEXT NOT NULL REFERENCES runs(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    step_number INTEGER NOT NULL,
    started_at REAL,
    ended_at REAL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    model_output TEXT,
    code TEXT,
    observations TEXT,
    error TEXT,
    is_final_answer INTEGER NOT NULL DEFAULT 0,
    figures INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (run_id, step_number)
);
CREATE TABLE IF NOT EXISTS llm_calls (
    id INTEGER PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    step_number INTEGER,
    model_id TEXT,
    started_at REAL NOT NULL,
    first_token_at REAL,
    ended_at REAL NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    input_messages TEXT,
    output_text TEXT,
    error TEXT
);
CREATE TABLE IF NOT EXISTS python_execs (
    id INTEGER PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    step_number INTEGER,
    started_at REAL NOT NULL,
    ended_at REAL NOT NULL,
    worker_seconds REAL,
    worker_pid INTEGER,
    code TEXT,
    logs TEXT,
    output TEXT,
    is_final_answer INTEGER NOT NULL DEFAULT 0,
    figures INTEGER NOT NULL DEFAULT 0,
    error TEXT
);
CREATE TABLE IF NOT EXISTS artifacts (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    run_id TEXT,
    step_number INTEGER,
    kind TEXT NOT NULL,
    path TEXT NOT NULL,
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    user_id INTEGER,
    chat_session_id TEXT,
    kind TEXT NOT NULL,
    at REAL NOT NULL,
    detail TEXT
);
-- The seed (seeding.py) a user was given: the notebook run it made, once per user and seed.
CREATE TABLE IF NOT EXISTS seeds (
    user_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    status TEXT NOT NULL,
    run_id TEXT,
    started_at REAL NOT NULL,
    finished_at REAL,
    error TEXT,
    PRIMARY KEY (user_id, name)
);
CREATE INDEX IF NOT EXISTS runs_by_user ON runs (user_id, started_at);
CREATE INDEX IF NOT EXISTS llm_calls_by_step ON llm_calls (run_id, step_number);
CREATE INDEX IF NOT EXISTS python_execs_by_step ON python_execs (run_id, step_number);
CREATE INDEX IF NOT EXISTS artifacts_by_run ON artifacts (run_id);
CREATE INDEX IF NOT EXISTS events_by_user ON events (user_id, at);
CREATE INDEX IF NOT EXISTS logins_by_user ON logins (user_id);
"""

# Columns added after the first release, for databases created before them.
MIGRATIONS = [("runs", "kind", "TEXT NOT NULL DEFAULT 'agent'"), ("python_execs", "worker_pid", "INTEGER")]

# Recreated at every start, so they always have every column of their tables.
VIEWS = """
DROP VIEW IF EXISTS step_timing;
DROP VIEW IF EXISTS run_summary;

-- Where a step's time went: the model call, the code execution, and the rest
-- (parsing, memory, callbacks) is seconds - llm_seconds - python_seconds.
CREATE VIEW IF NOT EXISTS step_timing AS
SELECT s.*,
       s.ended_at - s.started_at AS seconds,
       (SELECT COALESCE(SUM(l.ended_at - l.started_at), 0) FROM llm_calls l
         WHERE l.run_id = s.run_id AND l.step_number = s.step_number) AS llm_seconds,
       (SELECT COALESCE(SUM(p.ended_at - p.started_at), 0) FROM python_execs p
         WHERE p.run_id = s.run_id AND p.step_number = s.step_number) AS python_seconds
FROM steps s;

CREATE VIEW IF NOT EXISTS run_summary AS
SELECT r.*,
       r.ended_at - r.started_at AS seconds,
       (SELECT COUNT(*) FROM steps s WHERE s.run_id = r.id) AS steps,
       (SELECT COUNT(*) FROM llm_calls l WHERE l.run_id = r.id) AS llm_calls,
       (SELECT COALESCE(SUM(l.ended_at - l.started_at), 0) FROM llm_calls l WHERE l.run_id = r.id) AS llm_seconds,
       (SELECT COALESCE(SUM(p.ended_at - p.started_at), 0) FROM python_execs p WHERE p.run_id = r.id)
           AS python_seconds,
       (SELECT COALESCE(SUM(l.input_tokens), 0) FROM llm_calls l WHERE l.run_id = r.id) AS input_tokens,
       (SELECT COALESCE(SUM(l.output_tokens), 0) FROM llm_calls l WHERE l.run_id = r.id) AS output_tokens
FROM runs r;
"""

USERNAME = re.compile(r"[A-Za-z0-9_.-]{3,32}")
MIN_PASSWORD = 8
SCRYPT = {"n": 2**14, "r": 8, "p": 1}


class AuthError(ValueError):
    """A registration the store refuses, with a message fit to show the user."""


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, dklen=32, **SCRYPT)
    return f"scrypt${SCRYPT['n']}${SCRYPT['r']}${SCRYPT['p']}${salt.hex()}${digest.hex()}"


def check_password(password: str, stored: str) -> bool:
    _, n, r, p, salt, digest = stored.split("$")
    candidate = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=int(n), r=int(r), p=int(p), dklen=32)
    return hmac.compare_digest(candidate.hex(), digest)


# Checked against when the username is unknown, so a miss costs as long as a wrong password.
_DUMMY_HASH = hash_password(secrets.token_hex(8))


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class Store:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(self.path, check_same_thread=False, isolation_level=None)
        self._db.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        with self._lock:
            self._db.execute("PRAGMA journal_mode=WAL")
            self._db.execute("PRAGMA foreign_keys=ON")
            self._db.executescript(SCHEMA)
            for table, column, declaration in MIGRATIONS:
                if column not in {row[1] for row in self._db.execute(f"PRAGMA table_info({table})")}:
                    self._db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {declaration}")
            self._db.executescript(VIEWS)

    def _execute(self, sql: str, params=()) -> sqlite3.Cursor:
        with self._lock:
            return self._db.execute(sql, params)

    def _rows(self, sql: str, params=()) -> list[dict]:
        with self._lock:
            return [dict(row) for row in self._db.execute(sql, params).fetchall()]

    def close(self) -> None:
        with self._lock:
            self._db.close()

    # Accounts and logins

    def create_user(self, username: str, password: str) -> int:
        if not USERNAME.fullmatch(username):
            raise AuthError("A username is 3 to 32 letters, digits, '.', '_' or '-'.")
        if len(password) < MIN_PASSWORD:
            raise AuthError(f"A password needs at least {MIN_PASSWORD} characters.")
        password_hash = hash_password(password)
        try:
            cursor = self._execute("INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)",
                                   (username, password_hash, time.time()))
        except sqlite3.IntegrityError:
            raise AuthError("That username is taken.") from None
        return cursor.lastrowid

    def authenticate(self, username: str, password: str) -> dict | None:
        rows = self._rows("SELECT id, username, password_hash FROM users WHERE username = ?", (username,))
        if not rows:
            check_password(password, _DUMMY_HASH)
            return None
        user = rows[0]
        if not check_password(password, user["password_hash"]):
            return None
        return {"id": user["id"], "username": user["username"]}

    def user_by_name(self, username: str) -> dict | None:
        rows = self._rows("SELECT id, username FROM users WHERE username = ?", (username,))
        return rows[0] if rows else None

    def create_login(self, user_id: int, days: float) -> str:
        token, now = secrets.token_urlsafe(32), time.time()
        self._execute("INSERT INTO logins (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
                      (_token_hash(token), user_id, now, now + days * 86400))
        return token

    def user_for_token(self, token: str) -> dict | None:
        rows = self._rows("SELECT u.id, u.username FROM logins l JOIN users u ON u.id = l.user_id "
                          "WHERE l.token_hash = ? AND l.expires_at > ?", (_token_hash(token), time.time()))
        return rows[0] if rows else None

    def delete_login(self, token: str) -> None:
        self._execute("DELETE FROM logins WHERE token_hash = ?", (_token_hash(token),))

    # Trace writes

    def record_event(self, user_id: int | None, kind: str, chat_session_id: str | None = None, **detail) -> None:
        self._execute("INSERT INTO events (user_id, chat_session_id, kind, at, detail) VALUES (?, ?, ?, ?, ?)",
                      (user_id, chat_session_id, kind, time.time(), json.dumps(detail) if detail else None))

    def start_chat_session(self, user_id: int, model_id: str) -> str:
        session_id = uuid.uuid4().hex
        self._execute("INSERT INTO chat_sessions (id, user_id, model_id, started_at) VALUES (?, ?, ?, ?)",
                      (session_id, user_id, model_id, time.time()))
        return session_id

    def end_chat_session(self, session_id: str, reason: str) -> None:
        self._execute("UPDATE chat_sessions SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL",
                      (time.time(), reason, session_id))

    def start_run(self, user_id: int, chat_session_id: str, turn: int, task: str, kind: str = "agent") -> str:
        run_id = uuid.uuid4().hex
        self._execute("INSERT INTO runs (id, user_id, chat_session_id, turn, task, kind, started_at) "
                      "VALUES (?, ?, ?, ?, ?, ?, ?)", (run_id, user_id, chat_session_id, turn, task, kind, time.time()))
        return run_id

    def finish_run(self, run_id: str, status: str, final_answer: str | None, error: str | None) -> None:
        self._execute("UPDATE runs SET ended_at = ?, status = ?, final_answer = ?, error = ? WHERE id = ?",
                      (time.time(), status, final_answer, error, run_id))

    def record_step(self, **row) -> None:
        self._insert("steps", row, replace=True)

    def record_llm_call(self, **row) -> None:
        self._insert("llm_calls", row)

    def record_python_exec(self, **row) -> None:
        self._insert("python_execs", row)

    def record_artifact(self, user_id: int, kind: str, path: str, run_id: str | None = None,
                        step_number: int | None = None) -> None:
        self._insert("artifacts", {"user_id": user_id, "kind": kind, "path": path, "run_id": run_id,
                                   "step_number": step_number, "created_at": time.time()})

    def move_artifact(self, old_path: str, new_path: str) -> None:
        self._execute("UPDATE artifacts SET path = ? WHERE path = ?", (new_path, old_path))

    def _insert(self, table: str, row: dict, replace: bool = False) -> None:
        columns = ", ".join(row)
        marks = ", ".join("?" for _ in row)
        verb = "INSERT OR REPLACE" if replace else "INSERT"
        self._execute(f"{verb} INTO {table} ({columns}) VALUES ({marks})", tuple(row.values()))

    # Seeds

    def seed_of(self, user_id: int, name: str) -> dict | None:
        rows = self._rows("SELECT * FROM seeds WHERE user_id = ? AND name = ?", (user_id, name))
        return rows[0] if rows else None

    def seed_started(self, user_id: int, name: str) -> None:
        self._insert("seeds", {"user_id": user_id, "name": name, "status": "running", "run_id": None,
                               "started_at": time.time(), "finished_at": None, "error": None}, replace=True)

    def seed_finished(self, user_id: int, name: str, status: str, run_id: str | None, error: str | None) -> None:
        self._execute("UPDATE seeds SET status = ?, run_id = ?, finished_at = ?, error = ? WHERE user_id = ? AND name = ?",
                      (status, run_id, time.time(), error, user_id, name))

    # Reads, always scoped to one user

    def list_runs(self, user_id: int, limit: int = 100) -> list[dict]:
        return self._rows("SELECT * FROM run_summary WHERE user_id = ? ORDER BY started_at DESC LIMIT ?",
                          (user_id, limit))

    def runs_asc(self, user_id: int) -> list[dict]:
        """The user's finished runs, oldest first: what a new session continues from."""
        return self._rows("SELECT * FROM runs WHERE user_id = ? AND status != 'running' ORDER BY started_at, turn",
                          (user_id,))

    def steps_of(self, run_id: str) -> list[dict]:
        return self._rows("SELECT * FROM steps WHERE run_id = ? ORDER BY step_number", (run_id,))

    def python_execs_of(self, run_id: str) -> list[dict]:
        return self._rows("SELECT * FROM python_execs WHERE run_id = ? ORDER BY started_at, id", (run_id,))

    def get_run(self, user_id: int, run_id: str, context: bool = False) -> dict | None:
        runs = self._rows("SELECT * FROM run_summary WHERE id = ? AND user_id = ?", (run_id, user_id))
        if not runs:
            return None
        llm_columns = "*" if context else ", ".join(
            c for c in ("id", "run_id", "user_id", "step_number", "model_id", "started_at", "first_token_at",
                        "ended_at", "input_tokens", "output_tokens", "output_text", "error"))
        scope = (run_id, user_id)
        return {
            **runs[0],
            "steps": self._rows("SELECT * FROM step_timing WHERE run_id = ? AND user_id = ? ORDER BY step_number",
                                scope),
            "llm_calls": self._rows(f"SELECT {llm_columns} FROM llm_calls WHERE run_id = ? AND user_id = ? "
                                    "ORDER BY started_at", scope),
            "python_execs": self._rows("SELECT * FROM python_execs WHERE run_id = ? AND user_id = ? "
                                       "ORDER BY started_at", scope),
            "artifacts": self._rows("SELECT * FROM artifacts WHERE run_id = ? AND user_id = ? ORDER BY id", scope),
        }

    def step_context(self, user_id: int, run_id: str, step_number: int) -> list | None:
        """The messages the model was sent in that step, or None."""
        rows = self._rows("SELECT input_messages FROM llm_calls WHERE run_id = ? AND user_id = ? AND step_number = ? "
                          "ORDER BY started_at DESC LIMIT 1", (run_id, user_id, step_number))
        return json.loads(rows[0]["input_messages"]) if rows and rows[0]["input_messages"] else None

    def delete_run(self, user_id: int, run_id: str) -> list[str] | None:
        """Delete one of the user's runs and its records; the artifact paths to remove, or None if not theirs."""
        with self._lock:
            owned = self._db.execute("SELECT 1 FROM runs WHERE id = ? AND user_id = ?", (run_id, user_id)).fetchone()
            if not owned:
                return None
            paths = [row["path"] for row in self._db.execute("SELECT path FROM artifacts WHERE run_id = ?", (run_id,))]
            self._db.execute("BEGIN")
            for table in ("steps", "llm_calls", "python_execs", "artifacts"):
                self._db.execute(f"DELETE FROM {table} WHERE run_id = ?", (run_id,))
            self._db.execute("DELETE FROM runs WHERE id = ?", (run_id,))
            self._db.execute("COMMIT")
        return paths

    def list_events(self, user_id: int, limit: int = 200) -> list[dict]:
        rows = self._rows("SELECT * FROM events WHERE user_id = ? ORDER BY at DESC LIMIT ?", (user_id, limit))
        for row in rows:
            row["detail"] = json.loads(row["detail"]) if row["detail"] else None
        return rows
