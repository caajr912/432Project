"""
ingest/run.py
Main ingestion entry point. Run manually or via cron/APScheduler.

Usage:
    python run.py                    # run everything
    python run.py --only nyt         # just news
    python run.py --only stocks      # just stock data
    python run.py --tickers AAPL TSLA NVDA  # specific tickers
"""

import argparse
from datetime import datetime

from db import get_conn
import nyt
import stocks


def main():
    parser = argparse.ArgumentParser(description="StockMap ingestion runner")
    parser.add_argument("--only", choices=["nyt", "stocks"], help="Run only one ingestor")
    parser.add_argument("--tickers", nargs="+", help="Override default ticker list")
    parser.add_argument("--lookback", type=int, default=365, help="Days of stock history to fetch")
    args = parser.parse_args()

    print(f"\n=== StockMap Ingestion — {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} ===\n")

    with get_conn() as conn:
        if args.only == "nyt":
            nyt.run(conn)
        elif args.only == "stocks":
            stocks.run(conn, tickers=args.tickers, lookback_days=args.lookback)
        else:
            nyt.run(conn)
            print()
            stocks.run(conn, tickers=args.tickers, lookback_days=args.lookback)

    print("\n=== Done ===\n")


if __name__ == "__main__":
    main()
