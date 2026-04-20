"""
ingest/nyt.py
Fetches today's NYT headlines and upserts them into the SQLite staging DB.
"""

import os
import sqlite3
import requests
from datetime import date
from dotenv import load_dotenv

load_dotenv()

NYT_API_KEY = os.getenv("NYT_API_KEY")
NYT_BASE = "https://api.nytimes.com/svc/topstories/v2"

# Sections most likely to move markets
SECTIONS = ["business", "technology", "world", "us"]


def fetch_headlines(section: str) -> list[dict]:
    """Fetch top stories for a given NYT section."""
    url = f"{NYT_BASE}/{section}.json"
    resp = requests.get(url, params={"api-key": NYT_API_KEY}, timeout=10)
    resp.raise_for_status()
    data = resp.json()
    return data.get("results", [])


def parse_article(article: dict, section: str) -> dict:
    """Extract only the fields we care about."""
    return {
        "nyt_id": article.get("uri", ""),
        "section": section,
        "headline": article.get("title", ""),
        "abstract": article.get("abstract", ""),
        "url": article.get("url", ""),
        "published_date": article.get("published_date", "")[:10],  # YYYY-MM-DD
        "fetched_date": str(date.today()),
    }


def upsert_headlines(conn: sqlite3.Connection, articles: list[dict]):
    """Insert headlines, skip duplicates by nyt_id."""
    conn.executemany(
        """
        INSERT OR IGNORE INTO headlines
            (nyt_id, section, headline, abstract, url, published_date, fetched_date)
        VALUES
            (:nyt_id, :section, :headline, :abstract, :url, :published_date, :fetched_date)
        """,
        articles,
    )
    conn.commit()


def run(conn: sqlite3.Connection):
    """Main entry point called by run.py."""
    total = 0
    for section in SECTIONS:
        try:
            raw = fetch_headlines(section)
            articles = [parse_article(a, section) for a in raw]
            upsert_headlines(conn, articles)
            print(f"  [NYT] {section}: {len(articles)} articles")
            total += len(articles)
        except requests.HTTPError as e:
            print(f"  [NYT] ERROR fetching {section}: {e}")
    print(f"  [NYT] Done — {total} total articles upserted")


if __name__ == "__main__":
    from db import get_conn
    with get_conn() as conn:
        run(conn)
