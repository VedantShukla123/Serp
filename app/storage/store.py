"""SQLite persistence for runs, chat turns, simulated bookings/orders and user accounts.

Ownership: runs, bookings and orders carry an `owner_id` (the account's user_id). Readers pass
`scope`: a user_id returns only that user's rows; None is unscoped (local development without
sign-in, and the local MCP server). Rows stored before accounts existed have owner_id NULL: they
are kept, visible unscoped, and never visible to a signed-in account.
"""
from __future__ import annotations

import json
import sqlite3
import threading
from pathlib import Path

_lock = threading.Lock()


def _connect(db_path: str) -> sqlite3.Connection:
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


def _add_owner_column(conn: sqlite3.Connection, table: str) -> None:
    """Additive migration: older databases gain a nullable owner_id; no row is changed or removed."""
    cols = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
    if "owner_id" not in cols:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN owner_id TEXT")
    conn.execute(f"CREATE INDEX IF NOT EXISTS idx_{table}_owner ON {table}(owner_id)")


def _scoped(sql: str, params: tuple, scope: str | None) -> tuple[str, tuple]:
    return (sql, params) if scope is None else (sql + " AND owner_id = ?", params + (scope,))


def init_db(db_path: str) -> None:
    with _lock, _connect(db_path) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS runs (
                run_id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                request TEXT NOT NULL,
                data TEXT NOT NULL
            )
            """
        )
        _add_owner_column(conn, "runs")
        conn.commit()


def save_run(db_path: str, run_id: str, created_at: str, request: str, data: dict,
             owner_id: str | None = None) -> None:
    init_db(db_path)
    with _lock, _connect(db_path) as conn:
        conn.execute(
            # Re-saving a run never changes (or clears) who owns it.
            "INSERT INTO runs (run_id, created_at, request, data, owner_id) VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(run_id) DO UPDATE SET created_at = excluded.created_at, request = excluded.request, "
            "data = excluded.data, owner_id = COALESCE(runs.owner_id, excluded.owner_id)",
            (run_id, created_at, request, json.dumps(data, default=str), owner_id),
        )
        conn.commit()


def claim_run(db_path: str, run_id: str, owner_id: str) -> None:
    """Attach a run that THIS request just created (server-side run_id) to its user. Only fills an
    empty owner, so it can never move someone else's run."""
    init_db(db_path)
    with _lock, _connect(db_path) as conn:
        conn.execute("UPDATE runs SET owner_id = ? WHERE run_id = ? AND owner_id IS NULL", (owner_id, run_id))
        conn.commit()


def get_run(db_path: str, run_id: str, scope: str | None = None) -> dict | None:
    init_db(db_path)
    with _lock, _connect(db_path) as conn:
        row = conn.execute(*_scoped("SELECT data FROM runs WHERE run_id = ?", (run_id,), scope)).fetchone()
        if row is None:
            return None
        return json.loads(row["data"])


def list_runs(db_path: str, limit: int = 50, scope: str | None = None) -> list[dict]:
    init_db(db_path)
    sql, params = _scoped("SELECT run_id, created_at, request FROM runs WHERE 1 = 1", (), scope)
    with _lock, _connect(db_path) as conn:
        rows = conn.execute(sql + " ORDER BY created_at DESC LIMIT ?", params + (limit,)).fetchall()
        return [dict(r) for r in rows]


# ---- Chat agent turns (append-only; existing runs functions untouched) ----

def init_turns(db_path: str) -> None:
    with _lock, _connect(db_path) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS turns (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, id)"
        )
        conn.commit()


def save_turn(db_path: str, session_id: str, role: str, content: str) -> None:
    """Persist one chat turn. Creates the turns table on first use."""
    from datetime import datetime, timezone

    init_turns(db_path)
    created_at = datetime.now(timezone.utc).isoformat()
    with _lock, _connect(db_path) as conn:
        conn.execute(
            "INSERT INTO turns (session_id, role, content, created_at) VALUES (?, ?, ?, ?)",
            (session_id, role, content, created_at),
        )
        conn.commit()


def get_history(db_path: str, session_id: str, limit: int = 8) -> list[dict]:
    """Return the last `limit` turns for a session, oldest-first.

    Each item is {"role": ..., "content": ...}.
    """
    init_turns(db_path)
    with _lock, _connect(db_path) as conn:
        rows = conn.execute(
            "SELECT role, content FROM turns WHERE session_id = ? ORDER BY id DESC LIMIT ?",
            (session_id, limit),
        ).fetchall()
    return [{"role": r["role"], "content": r["content"]} for r in reversed(rows)]


# ---- Simulated bookings (append-only; demo records, never real reservations) ----

def init_bookings(db_path: str) -> None:
    with _lock, _connect(db_path) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS bookings (
                booking_id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                run_id TEXT NOT NULL,
                candidate_id TEXT NOT NULL,
                data TEXT NOT NULL
            )
            """
        )
        _add_owner_column(conn, "bookings")
        conn.commit()


def save_booking(db_path: str, booking: dict, owner_id: str | None = None) -> None:
    init_bookings(db_path)
    with _lock, _connect(db_path) as conn:
        conn.execute(
            "INSERT INTO bookings (booking_id, created_at, run_id, candidate_id, data, owner_id) VALUES (?, ?, ?, ?, ?, ?)",
            (booking["booking_id"], booking["created_at"], booking["run_id"],
             booking["candidate_id"], json.dumps(booking, default=str), owner_id),
        )
        conn.commit()


def get_booking(db_path: str, booking_id: str, scope: str | None = None) -> dict | None:
    init_bookings(db_path)
    with _lock, _connect(db_path) as conn:
        row = conn.execute(*_scoped("SELECT data FROM bookings WHERE booking_id = ?", (booking_id,), scope)).fetchone()
        return None if row is None else json.loads(row["data"])


# ---- Simulated product orders (append-only; demo records, never real purchases) ----

def init_orders(db_path: str) -> None:
    with _lock, _connect(db_path) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS orders (
                order_id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                run_id TEXT NOT NULL,
                candidate_id TEXT NOT NULL,
                data TEXT NOT NULL
            )
            """
        )
        _add_owner_column(conn, "orders")
        conn.commit()


def save_order(db_path: str, order: dict, owner_id: str | None = None) -> None:
    init_orders(db_path)
    with _lock, _connect(db_path) as conn:
        conn.execute(
            "INSERT INTO orders (order_id, created_at, run_id, candidate_id, data, owner_id) VALUES (?, ?, ?, ?, ?, ?)",
            (order["order_id"], order["created_at"], order["run_id"],
             order["candidate_id"], json.dumps(order, default=str), owner_id),
        )
        conn.commit()


def get_order(db_path: str, order_id: str, scope: str | None = None) -> dict | None:
    init_orders(db_path)
    with _lock, _connect(db_path) as conn:
        row = conn.execute(*_scoped("SELECT data FROM orders WHERE order_id = ?", (order_id,), scope)).fetchone()
        return None if row is None else json.loads(row["data"])


# ---- User accounts (Argon2id hashes only — never plaintext) ----

def init_users(db_path: str) -> None:
    with _lock, _connect(db_path) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                user_id TEXT PRIMARY KEY,
                email TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
            """
        )
        conn.execute("CREATE TABLE IF NOT EXISTS revoked_sessions (sid TEXT PRIMARY KEY, exp INTEGER NOT NULL)")
        conn.commit()


class EmailTaken(Exception):
    pass


def create_user(db_path: str, user_id: str, email: str, name: str, password_hash: str, created_at: str) -> None:
    """`email` must already be normalized; the UNIQUE constraint is the source of truth for duplicates."""
    init_users(db_path)
    try:
        with _lock, _connect(db_path) as conn:
            conn.execute("INSERT INTO users (user_id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
                         (user_id, email, name, password_hash, created_at))
            conn.commit()
    except sqlite3.IntegrityError as e:
        raise EmailTaken(email) from e


def _user(db_path: str, column: str, value: str) -> dict | None:
    init_users(db_path)
    with _lock, _connect(db_path) as conn:
        row = conn.execute(f"SELECT user_id, email, name, password_hash, created_at FROM users WHERE {column} = ?",
                           (value,)).fetchone()
        return None if row is None else dict(row)


def get_user_by_email(db_path: str, email: str) -> dict | None:
    return _user(db_path, "email", email)


def get_user(db_path: str, user_id: str) -> dict | None:
    return _user(db_path, "user_id", user_id)


def update_password_hash(db_path: str, user_id: str, password_hash: str) -> None:
    init_users(db_path)
    with _lock, _connect(db_path) as conn:
        conn.execute("UPDATE users SET password_hash = ? WHERE user_id = ?", (password_hash, user_id))
        conn.commit()


def revoke_session(db_path: str, sid: str, exp: int) -> None:
    """Persisted logout: survives restarts for as long as the database does."""
    init_users(db_path)
    with _lock, _connect(db_path) as conn:
        conn.execute("DELETE FROM revoked_sessions WHERE exp < CAST(strftime('%s','now') AS INTEGER)")
        conn.execute("INSERT OR REPLACE INTO revoked_sessions (sid, exp) VALUES (?, ?)", (sid, int(exp)))
        conn.commit()


def is_session_revoked(db_path: str, sid: str) -> bool:
    init_users(db_path)
    with _lock, _connect(db_path) as conn:
        return conn.execute("SELECT 1 FROM revoked_sessions WHERE sid = ?", (sid,)).fetchone() is not None
