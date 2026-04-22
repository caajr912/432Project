"""
ingest/graph.py
Writes processed headlines and stock prices from SQLite into Neo4j.

Graph schema:
    (:Article {id, headline, url, published_date, sentiment, section})
    (:Entity  {text, label})
    (:Ticker  {symbol})
    (:Price   {symbol, date, open, high, low, close, volume, pct_change})

Relationships:
    (:Article)-[:MENTIONS]->(:Entity)
    (:Entity)-[:MAPS_TO]->(:Ticker)
    (:Ticker)-[:HAD_PRICE]->(:Price)
    (:Article)-[:PUBLISHED_ON {sentiment}]->(:Price)  <- same-day link

Run manually:
    python graph.py

Or via run.py:
    python run.py --only graph
"""

import json
import os
import sqlite3

from neo4j import GraphDatabase
from dotenv import load_dotenv

load_dotenv()

NEO4J_URI      = os.getenv("NEO4J_URI", "bolt://localhost:7687")
NEO4J_USER     = os.getenv("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.getenv("NEO4J_PASSWORD", "")
NEO4J_DATABASE = "neo4j"

# ---------------------------------------------------------------------------
# Entity → Ticker mapping
# Expand this as you add more tickers to your watchlist.
# Keys are lowercased entity text for case-insensitive matching.
# ---------------------------------------------------------------------------
ENTITY_TICKER_MAP = {
    # Big Tech
    "apple":               "AAPL",
    "apple inc":           "AAPL",
    "microsoft":           "MSFT",
    "google":              "GOOGL",
    "alphabet":            "GOOGL",
    "amazon":              "AMZN",
    "meta":                "META",
    "facebook":            "META",
    "nvidia":              "NVDA",
    "tesla":               "TSLA",
    "elon musk":           "TSLA",
    "netflix":             "NFLX",
    # Finance
    "jpmorgan":            "JPM",
    "jp morgan":           "JPM",
    "jamie dimon":         "JPM",
    # Energy
    "exxon":               "XOM",
    "exxon mobil":         "XOM",
    # Healthcare
    "johnson & johnson":   "JNJ",
    "johnson and johnson": "JNJ",
    # Broad market triggers
    "federal reserve":     "^GSPC",
    "fed":                 "^GSPC",
    "jerome powell":       "^GSPC",
    "interest rates":      "^GSPC",
    "inflation":           "^GSPC",
    "tariff":              "^GSPC",
    "tariffs":             "^GSPC",
    "recession":           "^GSPC",
    "s&p":                 "^GSPC",
    "wall street":         "^GSPC",
    "stock market":        "^GSPC",
    "nasdaq":              "^IXIC",
    "dow":                 "^DJI",
    "dow jones":           "^DJI",
}


def map_entities_to_tickers(entities: list[dict]) -> list[str]:
    """Return list of tickers that any entity in the list maps to."""
    tickers = set()
    for ent in entities:
        key = ent["text"].lower()
        if key in ENTITY_TICKER_MAP:
            tickers.add(ENTITY_TICKER_MAP[key])
    return list(tickers)


# ---------------------------------------------------------------------------
# Neo4j driver
# ---------------------------------------------------------------------------

def get_driver():
    return GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))


def ensure_constraints(session):
    """Create uniqueness constraints so re-runs don't duplicate nodes."""
    constraints = [
        "CREATE CONSTRAINT article_id IF NOT EXISTS FOR (a:Article) REQUIRE a.id IS UNIQUE",
        "CREATE CONSTRAINT entity_key IF NOT EXISTS FOR (e:Entity) REQUIRE (e.text, e.label) IS NODE KEY",
        "CREATE CONSTRAINT ticker_symbol IF NOT EXISTS FOR (t:Ticker) REQUIRE t.symbol IS UNIQUE",
        "CREATE CONSTRAINT price_key IF NOT EXISTS FOR (p:Price) REQUIRE (p.symbol, p.date) IS NODE KEY",
    ]
    for c in constraints:
        try:
            session.run(c)
        except Exception:
            pass  # constraint may already exist


# ---------------------------------------------------------------------------
# Writers
# ---------------------------------------------------------------------------

def write_article(tx, row: sqlite3.Row, entities: list[dict]):
    """Merge Article node and its Entity relationships."""
    tx.run(
        """
        MERGE (a:Article {id: $id})
        SET a.headline      = $headline,
            a.abstract      = $abstract,
            a.url           = $url,
            a.published_date= $published_date,
            a.sentiment     = $sentiment,
            a.section       = $section
        """,
        id=row["id"],
        headline=row["headline"],
        abstract=row["abstract"] or "",
        url=row["url"] or "",
        published_date=row["published_date"],
        sentiment=row["sentiment"],
        section=row["section"],
    )

    for ent in entities:
        tx.run(
            """
            MERGE (e:Entity {text: $text, label: $label})
            WITH e
            MATCH (a:Article {id: $article_id})
            MERGE (a)-[:MENTIONS]->(e)
            """,
            text=ent["text"],
            label=ent["label"],
            article_id=row["id"],
        )

        # If entity maps to a ticker, create that relationship too
        ticker = ENTITY_TICKER_MAP.get(ent["text"].lower())
        if ticker:
            tx.run(
                """
                MERGE (t:Ticker {symbol: $symbol})
                WITH t
                MATCH (e:Entity {text: $text, label: $label})
                MERGE (e)-[:MAPS_TO]->(t)
                """,
                symbol=ticker,
                text=ent["text"],
                label=ent["label"],
            )


def write_prices(tx, rows: list[sqlite3.Row]):
    """Merge Ticker and Price nodes with HAD_PRICE relationships."""
    for row in rows:
        tx.run(
            """
            MERGE (t:Ticker {symbol: $symbol})
            MERGE (p:Price {symbol: $symbol, date: $date})
            SET p.open       = $open,
                p.high       = $high,
                p.low        = $low,
                p.close      = $close,
                p.volume     = $volume,
                p.pct_change = $pct_change
            MERGE (t)-[:HAD_PRICE]->(p)
            """,
            symbol=row["ticker"],
            date=row["trade_date"],
            open=row["open"],
            high=row["high"],
            low=row["low"],
            close=row["close"],
            volume=row["volume"],
            pct_change=row["pct_change"],
        )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def compute_pct_changes(rows: list) -> list[dict]:
    """
    Add pct_change field to each row — % change in close vs previous day.
    First row of each ticker gets 0.0.
    """
    by_ticker = {}
    for row in rows:
        by_ticker.setdefault(row["ticker"], []).append(dict(row))

    result = []
    for ticker, ticker_rows in by_ticker.items():
        ticker_rows.sort(key=lambda r: r["trade_date"])
        for i, row in enumerate(ticker_rows):
            if i == 0 or ticker_rows[i - 1]["close"] is None or ticker_rows[i - 1]["close"] == 0:
                row["pct_change"] = 0.0
            else:
                prev_close = ticker_rows[i - 1]["close"]
                row["pct_change"] = round(
                    (row["close"] - prev_close) / prev_close * 100, 4
                )
            result.append(row)
    return result


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def run(sqlite_conn: sqlite3.Connection):
    driver = get_driver()

    try:
        with driver.session(database=NEO4J_DATABASE) as session:
            ensure_constraints(session)

            # --- Write stock prices ---
            print("  [GRAPH] Writing stock prices...")
            price_rows = sqlite_conn.execute(
                "SELECT ticker, trade_date, open, high, low, close, volume FROM stock_prices"
            ).fetchall()

            price_rows_with_pct = compute_pct_changes(price_rows)

            PRICE_BATCH = 500
            for i in range(0, len(price_rows_with_pct), PRICE_BATCH):
                batch = price_rows_with_pct[i:i + PRICE_BATCH]
                with session.begin_transaction() as tx:
                    write_prices(tx, batch)
                    tx.commit()
            print(f"  [GRAPH] {len(price_rows_with_pct)} price nodes written")

            # --- Write articles + entities ---
            print("  [GRAPH] Writing articles and entities...")
            article_rows = sqlite_conn.execute(
                """
                SELECT id, headline, abstract, url, published_date,
                       sentiment, section, entities_json
                FROM headlines
                WHERE processed = 1
                """
            ).fetchall()

            written = 0
            for row in article_rows:
                entities = json.loads(row["entities_json"] or "[]")
                with session.begin_transaction() as tx:
                    write_article(tx, row, entities)
                    tx.commit()
                written += 1

            print(f"  [GRAPH] {written} articles written")

            # Mark articles as graph-written (processed=2)
            sqlite_conn.execute(
                "UPDATE headlines SET processed = 2 WHERE processed = 1"
            )
            sqlite_conn.commit()

            print("  [GRAPH] Done")

    finally:
        driver.close()


if __name__ == "__main__":
    import sys
    sys.path.insert(0, ".")
    from db import get_conn
    with get_conn() as conn:
        run(conn)
