"""SQLite persistence for runs. stdlib sqlite3 — enough for v1."""
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
        conn.commit()


def save_run(db_path: str, run_id: str, created_at: str, request: str, data: dict) -> None:
    init_db(db_path)
    with _lock, _connect(db_path) as conn:
        conn.execute(
            "INSERT OR REPLACE INTO runs (run_id, created_at, request, data) VALUES (?, ?, ?, ?)",
            (run_id, created_at, request, json.dumps(data, default=str)),
        )
        conn.commit()


def get_run(db_path: str, run_id: str) -> dict | None:
    init_db(db_path)
    with _lock, _connect(db_path) as conn:
        row = conn.execute("SELECT data FROM runs WHERE run_id = ?", (run_id,)).fetchone()
        if row is None:
            return None
        return json.loads(row["data"])


def list_runs(db_path: str, limit: int = 50) -> list[dict]:
    init_db(db_path)
    with _lock, _connect(db_path) as conn:
        rows = conn.execute(
            "SELECT run_id, created_at, request FROM runs ORDER BY created_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
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
        conn.commit()


def save_booking(db_path: str, booking: dict) -> None:
    init_bookings(db_path)
    with _lock, _connect(db_path) as conn:
        conn.execute(
            "INSERT INTO bookings (booking_id, created_at, run_id, candidate_id, data) VALUES (?, ?, ?, ?, ?)",
            (booking["booking_id"], booking["created_at"], booking["run_id"],
             booking["candidate_id"], json.dumps(booking, default=str)),
        )
        conn.commit()


def get_booking(db_path: str, booking_id: str) -> dict | None:
    init_bookings(db_path)
    with _lock, _connect(db_path) as conn:
        row = conn.execute("SELECT data FROM bookings WHERE booking_id = ?", (booking_id,)).fetchone()
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
        conn.commit()


def save_order(db_path: str, order: dict) -> None:
    init_orders(db_path)
    with _lock, _connect(db_path) as conn:
        conn.execute(
            "INSERT INTO orders (order_id, created_at, run_id, candidate_id, data) VALUES (?, ?, ?, ?, ?)",
            (order["order_id"], order["created_at"], order["run_id"],
             order["candidate_id"], json.dumps(order, default=str)),
        )
        conn.commit()


def get_order(db_path: str, order_id: str) -> dict | None:
    init_orders(db_path)
    with _lock, _connect(db_path) as conn:
        row = conn.execute("SELECT data FROM orders WHERE order_id = ?", (order_id,)).fetchone()
        return None if row is None else json.loads(row["data"])
