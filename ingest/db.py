"""
ingest/db.py
SQLite staging database — temporary store before data is pushed to Neo4j.
Run this file directly to initialize the schema: python db.py
"""

import os
import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).parent.parent / "data" / "staging.db"


def get_conn() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    _ensure_schema(conn)
    return conn


def _ensure_schema(conn: sqlite3.Connection):
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS headlines (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            nyt_id         TEXT    UNIQUE NOT NULL,
            section        TEXT    NOT NULL,
            headline       TEXT    NOT NULL,
            abstract       TEXT,
            url            TEXT,
            published_date TEXT    NOT NULL,   -- YYYY-MM-DD
            fetched_date   TEXT    NOT NULL,   -- YYYY-MM-DD
            -- populated after NER/sentiment pass
            entities_json  TEXT,               -- JSON array of {text, label} dicts
            sentiment      REAL,               -- -1.0 to 1.0
            processed      INTEGER DEFAULT 0   -- 0=raw, 1=NER done, 2=graph written
        );

        CREATE TABLE IF NOT EXISTS stock_prices (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            ticker     TEXT NOT NULL,
            trade_date TEXT NOT NULL,           -- YYYY-MM-DD
            open       REAL,
            high       REAL,
            low        REAL,
            close      REAL,
            volume     INTEGER,
            UNIQUE(ticker, trade_date)
        );

        CREATE INDEX IF NOT EXISTS idx_headlines_date
            ON headlines(published_date);

        CREATE INDEX IF NOT EXISTS idx_headlines_processed
            ON headlines(processed);

        CREATE INDEX IF NOT EXISTS idx_stock_ticker_date
            ON stock_prices(ticker, trade_date);
    """)
    conn.commit()


if __name__ == "__main__":
    conn = get_conn()
    print(f"Schema initialized at {DB_PATH}")
    conn.close()
