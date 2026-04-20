"""
ingest/run.py
Main ingestion entry point.

Usage:
    python run.py                        # full pipeline: nyt -> stocks -> ner
    python run.py --only nyt             # just headlines
    python run.py --only stocks          # just stock data
    python run.py --only ner             # just NER/sentiment pass
    python run.py --tickers AAPL TSLA    # specific tickers (stocks step)
    python run.py --lookback 90          # days of stock history (default 365)
"""

import argparse
from datetime import datetime

from db import get_conn
import nyt
import stocks
import ner


def main():
    parser = argparse.ArgumentParser(description="StockMap ingestion runner")
    parser.add_argument("--only", choices=["nyt", "stocks", "ner"],
                        help="Run only one step")
    parser.add_argument("--tickers", nargs="+",
                        help="Override default ticker list (stocks step)")
    parser.add_argument("--lookback", type=int, default=365,
                        help="Days of stock history to fetch (default 365)")
    args = parser.parse_args()

    print(f"\n=== StockMap Ingestion — {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} ===\n")

    with get_conn() as conn:
        if args.only == "nyt":
            nyt.run(conn)
        elif args.only == "stocks":
            stocks.run(conn, tickers=args.tickers, lookback_days=args.lookback)
        elif args.only == "ner":
            ner.run(conn)
        else:
            nyt.run(conn)
            print()
            stocks.run(conn, tickers=args.tickers, lookback_days=args.lookback)
            print()
            ner.run(conn)

    print("\n=== Done ===\n")


if __name__ == "__main__":
    main()
