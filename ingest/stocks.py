"""
ingest/stocks.py
Fetches daily OHLCV candles for a watchlist of tickers and upserts
them into the SQLite staging DB.

Strategy: try Finnhub first (requires paid plan for /stock/candle),
fall back to Yahoo Finance (no key needed) if Finnhub 403s.
"""

import os
import sqlite3
import time
import requests
from datetime import date
from dotenv import load_dotenv

load_dotenv()

FINNHUB_API_KEY = os.getenv("FINNHUB_API_KEY")
FINNHUB_BASE = "https://finnhub.io/api/v1"

YAHOO_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/122.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json",
}

DEFAULT_TICKERS = [
    "AAPL", "MSFT", "GOOGL", "AMZN", "META",
    "NVDA", "TSLA", "JPM", "XOM", "JNJ",
]

REQUEST_DELAY = 0.5


def _fetch_finnhub(ticker, from_ts, to_ts):
    if not FINNHUB_API_KEY:
        return None
    try:
        resp = requests.get(
            f"{FINNHUB_BASE}/stock/candle",
            params={"symbol": ticker, "resolution": "D",
                    "from": from_ts, "to": to_ts, "token": FINNHUB_API_KEY},
            timeout=10,
        )
        if resp.status_code == 403:
            return None
        resp.raise_for_status()
        data = resp.json()
        return data if data.get("s") == "ok" and data.get("t") else None
    except Exception:
        return None


def _fetch_yahoo(ticker):
    sym = ticker.upper().replace(".", "-")
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}?range=1y&interval=1d"
    try:
        resp = requests.get(url, headers=YAHOO_HEADERS, timeout=10)
        if not resp.ok:
            return None
        j = resp.json()
        result = (j.get("chart") or {}).get("result") or []
        if not result:
            return None
        result = result[0]
        q = ((result.get("indicators") or {}).get("quote") or [{}])[0]
        ts      = result.get("timestamp") or []
        closes  = q.get("close")  or []
        opens   = q.get("open")   or []
        highs   = q.get("high")   or []
        lows    = q.get("low")    or []
        volumes = q.get("volume") or []
        if not ts or not closes:
            return None

        t, o, h, l, c, v = [], [], [], [], [], []
        for i, timestamp in enumerate(ts):
            cv = closes[i] if i < len(closes) else None
            if cv is None:
                continue
            t.append(timestamp)
            o.append(opens[i]   if i < len(opens)   and opens[i]   is not None else cv)
            h.append(highs[i]   if i < len(highs)   and highs[i]   is not None else cv)
            l.append(lows[i]    if i < len(lows)    and lows[i]    is not None else cv)
            c.append(cv)
            v.append(volumes[i] if i < len(volumes) and volumes[i] is not None else 0)

        return {"s": "ok", "t": t, "o": o, "h": h, "l": l, "c": c, "v": v} if t else None
    except Exception:
        return None


def fetch_candles(ticker, from_ts, to_ts):
    data = _fetch_finnhub(ticker, from_ts, to_ts)
    source = "finnhub"
    if not data:
        data = _fetch_yahoo(ticker)
        source = "yahoo"
    if not data:
        return None

    trimmed = {"s": "ok", "t": [], "o": [], "h": [], "l": [], "c": [], "v": []}
    for i, ts in enumerate(data["t"]):
        if from_ts <= ts <= to_ts:
            for k in ("t", "o", "h", "l", "c", "v"):
                trimmed[k].append(data[k][i])

    result = trimmed if trimmed["t"] else data
    result["_source"] = source
    return result


def candles_to_rows(ticker, data):
    rows = []
    for i, ts in enumerate(data["t"]):
        rows.append({
            "ticker":     ticker,
            "trade_date": date.fromtimestamp(ts).isoformat(),
            "open":       data["o"][i],
            "high":       data["h"][i],
            "low":        data["l"][i],
            "close":      data["c"][i],
            "volume":     data["v"][i],
        })
    return rows


def upsert_candles(conn, rows):
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


def run(conn, tickers=None, lookback_days=365):
    tickers = tickers or DEFAULT_TICKERS
    to_ts   = int(time.time())
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
            print(f"  [STOCKS] {ticker}: {len(rows)} candles (via {data.get('_source','?')})")
            total_rows += len(rows)
        except Exception as e:
            print(f"  [STOCKS] ERROR fetching {ticker}: {e}")
        finally:
            time.sleep(REQUEST_DELAY)

    print(f"  [STOCKS] Done — {total_rows} total candles upserted")


if __name__ == "__main__":
    from db import get_conn
    with get_conn() as conn:
        run(conn)
