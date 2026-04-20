"""
ingest/stocks.py
Fetches daily OHLCV candles from Finnhub for a watchlist of tickers
and upserts them into the SQLite staging DB.
"""

import os
import sqlite3
import time
import requests
from datetime import date, timedelta
from dotenv import load_dotenv

load_dotenv()

FINNHUB_API_KEY = os.getenv("FINNHUB_API_KEY")
FINNHUB_BASE = "https://finnhub.io/api/v1"

# Default watchlist — expand as needed
DEFAULT_TICKERS = [
    "AAPL", "MSFT", "GOOGL", "AMZN", "META",
    "NVDA", "TSLA", "JPM", "XOM", "JNJ",
]

# Finnhub free tier: 60 requests/min
REQUEST_DELAY = 1.1  # seconds between calls


def fetch_candles(ticker: str, from_ts: int, to_ts: int) -> dict | None:
    """Fetch daily OHLCV candles from Finnhub."""
    resp = requests.get(
        f"{FINNHUB_BASE}/stock/candle",
        params={
            "symbol": ticker,
            "resolution": "D",
            "from": from_ts,
            "to": to_ts,
            "token": FINNHUB_API_KEY,
        },
        timeout=10,
    )
    resp.raise_for_status()
    data = resp.json()
    if data.get("s") != "ok":
        return None
    return data


def candles_to_rows(ticker: str, data: dict) -> list[dict]:
    """Zip parallel arrays from Finnhub response into row dicts."""
    rows = []
    for i, ts in enumerate(data["t"]):
        trade_date = date.fromtimestamp(ts).isoformat()
        rows.append({
            "ticker": ticker,
            "trade_date": trade_date,
            "open": data["o"][i],
            "high": data["h"][i],
            "low": data["l"][i],
            "close": data["c"][i],
            "volume": data["v"][i],
        })
    return rows


def upsert_candles(conn: sqlite3.Connection, rows: list[dict]):
    """Insert candles, replace on conflict (ticker, trade_date)."""
    conn.executemany(
        """
        INSERT OR REPLACE INTO stock_prices
            (ticker, trade_date, open, high, low, close, volume)
        VALUES
            (:ticker, :trade_date, :open, :high, :low, :close, :volume)
        """,
        rows,
    )
    conn.commit()


def run(conn: sqlite3.Connection, tickers: list[str] = None, lookback_days: int = 365):
    """Main entry point called by run.py."""
    tickers = tickers or DEFAULT_TICKERS

    to_ts = int(time.time())
    from_ts = int((date.today() - timedelta(days=lookback_days)).strftime("%s") 
                  if hasattr(date.today(), 'strftime') 
                  else time.time() - lookback_days * 86400)
    # Cleaner cross-platform timestamp:
    from_ts = to_ts - (lookback_days * 86400)

    total_rows = 0
    for ticker in tickers:
        try:
            data = fetch_candles(ticker, from_ts, to_ts)
            if not data:
                print(f"  [STOCKS] {ticker}: no data returned")
                continue
            rows = candles_to_rows(ticker, data)
            upsert_candles(conn, rows)
            print(f"  [STOCKS] {ticker}: {len(rows)} candles")
            total_rows += len(rows)
            time.sleep(REQUEST_DELAY)  # respect rate limit
        except requests.HTTPError as e:
            print(f"  [STOCKS] ERROR fetching {ticker}: {e}")
            time.sleep(REQUEST_DELAY)

    print(f"  [STOCKS] Done — {total_rows} total candles upserted")


if __name__ == "__main__":
    from db import get_conn
    with get_conn() as conn:
        run(conn)
