"""
api/main.py
FastAPI backend for StockMap.

Endpoints:
    GET /api/articles               — recent headlines with sentiment + entities
    GET /api/prices/{ticker}        — price history for a ticker
    GET /api/chart-articles/{ticker} — distinct articles linked to a ticker (for chart markers)
    GET /api/graph/{ticker}         — articles + entities linked to a ticker
    GET /api/correlate/{ticker}     — core MVP: sentiment vs price movement
    GET /api/tickers                — list of available tickers in DB
    GET /health                     — health check

Run:
    uvicorn api.main:app --reload
    or from project root:
    uvicorn main:app --reload --app-dir api
"""

import json
import os
import sys
from datetime import date, timedelta
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from neo4j import GraphDatabase
from dotenv import load_dotenv

load_dotenv()

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

NEO4J_URI      = os.getenv("NEO4J_URI", "neo4j://127.0.0.1:7687")
NEO4J_USER     = os.getenv("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.getenv("NEO4J_PASSWORD", "")
NEO4J_DATABASE = "neo4j"

# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------

app = FastAPI(
    title="StockMap API",
    description="Knowledge graph correlating news sentiment with stock movements",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tighten this in prod
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# DB connection
# ---------------------------------------------------------------------------

def get_driver():
    return GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))


def run_query(query: str, params: dict = None) -> list[dict]:
    driver = get_driver()
    try:
        with driver.session(database=NEO4J_DATABASE) as session:
            result = session.run(query, params or {})
            return [dict(r) for r in result]
    finally:
        driver.close()


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/api/tickers")
def get_tickers():
    """List all tickers that have price data in the graph."""
    rows = run_query("MATCH (t:Ticker) RETURN t.symbol AS symbol ORDER BY symbol")
    return [r["symbol"] for r in rows]


@app.get("/api/articles")
def get_articles(
    section: Optional[str] = None,
    limit: int = Query(default=20, le=100),
    sentiment: Optional[str] = Query(default=None, description="positive | negative | neutral"),
):
    """
    Recent headlines with sentiment and entities.
    Optional filters: section, sentiment polarity.
    """
    filters = []
    params = {"limit": limit}

    if section:
        filters.append("a.section = $section")
        params["section"] = section

    if sentiment == "positive":
        filters.append("a.sentiment > 0.05")
    elif sentiment == "negative":
        filters.append("a.sentiment < -0.05")
    elif sentiment == "neutral":
        filters.append("a.sentiment >= -0.05 AND a.sentiment <= 0.05")

    where = ("WHERE " + " AND ".join(filters)) if filters else ""

    rows = run_query(
        f"""
        MATCH (a:Article)
        {where}
        OPTIONAL MATCH (a)-[:MENTIONS]->(e:Entity)
        RETURN a.id           AS id,
               a.headline     AS headline,
               a.abstract     AS abstract,
               a.url          AS url,
               a.published_date AS published_date,
               a.sentiment    AS sentiment,
               a.section      AS section,
               collect({{text: e.text, label: e.label}}) AS entities
        ORDER BY a.published_date DESC
        LIMIT $limit
        """,
        params,
    )
    return rows


@app.get("/api/prices/{ticker}")
def get_prices(
    ticker: str,
    days: int = Query(default=30, le=365),
):
    """Price history for a ticker over the last N days."""
    ticker = ticker.upper()
    cutoff = (date.today() - timedelta(days=days)).isoformat()

    rows = run_query(
        """
        MATCH (t:Ticker {symbol: $symbol})-[:HAD_PRICE]->(p:Price)
        WHERE p.date >= $cutoff
        RETURN p.date       AS date,
               p.open       AS open,
               p.high       AS high,
               p.low        AS low,
               p.close      AS close,
               p.volume     AS volume,
               p.pct_change AS pct_change
        ORDER BY p.date ASC
        """,
        {"symbol": ticker, "cutoff": cutoff},
    )
    if not rows:
        raise HTTPException(status_code=404, detail=f"No price data for {ticker}")
    return {"ticker": ticker, "prices": rows}


def _norm_pub_date(v) -> str:
    if v is None:
        return ""
    if hasattr(v, "isoformat"):
        return v.isoformat()[:10]
    s = str(v)
    return s[:10] if len(s) >= 10 else s


@app.get("/api/chart-articles/{ticker}")
def get_chart_articles(
    ticker: str,
    limit: int = Query(default=120, le=400),
):
    """
    Articles for a ticker via (Article)-[:MENTIONS]->(Entity)-[:MAPS_TO]->(Ticker).
    `published_date` is normalized to YYYY-MM-DD for aligning with daily candles.
    """
    ticker = ticker.upper()
    rows = run_query(
        """
        MATCH (a:Article)-[:MENTIONS]->(e:Entity)-[:MAPS_TO]->(t:Ticker {symbol: $symbol})
        RETURN DISTINCT a.id AS id,
               a.headline AS headline,
               a.published_date AS published_date,
               a.sentiment AS sentiment,
               a.url AS url
        ORDER BY a.published_date DESC
        LIMIT $limit
        """,
        {"symbol": ticker, "limit": limit},
    )
    articles = []
    for r in rows:
        pd = _norm_pub_date(r.get("published_date"))
        if not pd:
            continue
        articles.append({
            "id": r.get("id"),
            "headline": r.get("headline") or "",
            "published_date": pd,
            "sentiment": r.get("sentiment"),
            "url": r.get("url") or "",
        })
    return {"ticker": ticker, "articles": articles}


@app.get("/api/graph/{ticker}")
def get_graph(ticker: str):
    """
    All articles and entities linked to a ticker.
    Returns node/edge structure suitable for frontend graph rendering.
    """
    ticker = ticker.upper()

    rows = run_query(
        """
        MATCH (a:Article)-[:MENTIONS]->(e:Entity)-[:MAPS_TO]->(t:Ticker {symbol: $symbol})
        RETURN a.id           AS article_id,
               a.headline     AS headline,
               a.published_date AS published_date,
               a.sentiment    AS sentiment,
               a.url          AS url,
               e.text         AS entity_text,
               e.label        AS entity_label,
               t.symbol       AS ticker
        ORDER BY a.published_date DESC
        """,
        {"symbol": ticker},
    )

    if not rows:
        raise HTTPException(status_code=404, detail=f"No graph data for {ticker}")

    # Build nodes + edges for frontend
    nodes = {}
    edges = []

    ticker_node_id = f"ticker_{ticker}"
    nodes[ticker_node_id] = {"id": ticker_node_id, "type": "Ticker", "label": ticker}

    for row in rows:
        a_id = f"article_{row['article_id']}"
        e_id = f"entity_{row['entity_text']}_{row['entity_label']}"

        if a_id not in nodes:
            nodes[a_id] = {
                "id": a_id,
                "type": "Article",
                "label": row["headline"][:60],
                "headline": row["headline"],
                "published_date": row["published_date"],
                "sentiment": row["sentiment"],
                "url": row["url"],
            }

        if e_id not in nodes:
            nodes[e_id] = {
                "id": e_id,
                "type": "Entity",
                "label": row["entity_text"],
                "entity_label": row["entity_label"],
            }

        edges.append({"source": a_id, "target": e_id, "type": "MENTIONS"})
        edges.append({"source": e_id, "target": ticker_node_id, "type": "MAPS_TO"})

    return {
        "ticker": ticker,
        "nodes": list(nodes.values()),
        "edges": edges,
    }


@app.get("/api/correlate/{ticker}")
def correlate(
    ticker: str,
    window_days: int = Query(default=3, le=10, description="Days after article to measure price change"),
):
    """
    Core MVP endpoint.

    For each article mentioning this ticker, find the stock's price
    change over the next N days and return the correlation between
    article sentiment and subsequent price movement.

    Also returns individual data points so the frontend can plot them.
    """
    ticker = ticker.upper()

    # Get all articles linked to this ticker with their sentiment
    articles = run_query(
        """
        MATCH (a:Article)-[:MENTIONS]->(e:Entity)-[:MAPS_TO]->(t:Ticker {symbol: $symbol})
        RETURN DISTINCT
               a.id            AS id,
               a.headline      AS headline,
               a.published_date AS published_date,
               a.sentiment     AS sentiment,
               a.section       AS section
        ORDER BY a.published_date ASC
        """,
        {"symbol": ticker},
    )

    if not articles:
        raise HTTPException(status_code=404, detail=f"No articles linked to {ticker}")

    # Get all prices for this ticker
    prices = run_query(
        """
        MATCH (t:Ticker {symbol: $symbol})-[:HAD_PRICE]->(p:Price)
        RETURN p.date AS date, p.close AS close, p.pct_change AS pct_change
        ORDER BY p.date ASC
        """,
        {"symbol": ticker},
    )

    # Build date → price lookup
    price_by_date = {r["date"]: r for r in prices}
    price_dates = sorted(price_by_date.keys())

    def get_price_after(pub_date: str, days: int) -> Optional[float]:
        """Find cumulative % change from pub_date to pub_date + days."""
        target = (
            date.fromisoformat(pub_date) + timedelta(days=days)
        ).isoformat()
        # Find nearest available trading day at or after target
        for d in price_dates:
            if d >= pub_date and d <= target:
                continue
            if d > target:
                break
        # Get close on pub_date and close window_days later
        start_price = None
        end_price = None
        for d in price_dates:
            if d >= pub_date and start_price is None:
                start_price = price_by_date[d]["close"]
            if d >= target:
                end_price = price_by_date[d]["close"]
                break
        if start_price and end_price and start_price != 0:
            return round((end_price - start_price) / start_price * 100, 4)
        return None

    # Build data points
    data_points = []
    for article in articles:
        price_change = get_price_after(article["published_date"], window_days)
        if price_change is None:
            continue
        data_points.append({
            "article_id":     article["id"],
            "headline":       article["headline"],
            "published_date": article["published_date"],
            "sentiment":      article["sentiment"],
            "price_change":   price_change,
            "section":        article["section"],
        })

    if not data_points:
        return {
            "ticker": ticker,
            "window_days": window_days,
            "data_points": [],
            "correlation": None,
            "summary": "Not enough overlapping data",
        }

    # Pearson correlation between sentiment and price_change
    sentiments    = [d["sentiment"]    for d in data_points]
    price_changes = [d["price_change"] for d in data_points]
    correlation   = _pearson(sentiments, price_changes)

    # Simple summary buckets
    pos_sentiment_pos_price = sum(
        1 for d in data_points if d["sentiment"] > 0.05 and d["price_change"] > 0
    )
    neg_sentiment_neg_price = sum(
        1 for d in data_points if d["sentiment"] < -0.05 and d["price_change"] < 0
    )
    total = len(data_points)

    return {
        "ticker":       ticker,
        "window_days":  window_days,
        "total_articles": total,
        "correlation":  correlation,
        "agreement_rate": round((pos_sentiment_pos_price + neg_sentiment_neg_price) / total * 100, 1),
        "summary": _correlation_summary(correlation),
        "data_points":  data_points,
    }


def _pearson(x: list[float], y: list[float]) -> Optional[float]:
    """Pearson correlation coefficient."""
    n = len(x)
    if n < 2:
        return None
    mean_x = sum(x) / n
    mean_y = sum(y) / n
    num    = sum((xi - mean_x) * (yi - mean_y) for xi, yi in zip(x, y))
    den_x  = sum((xi - mean_x) ** 2 for xi in x) ** 0.5
    den_y  = sum((yi - mean_y) ** 2 for yi in y) ** 0.5
    if den_x == 0 or den_y == 0:
        return None
    return round(num / (den_x * den_y), 4)


def _correlation_summary(r: Optional[float]) -> str:
    if r is None:
        return "Insufficient data"
    if r > 0.5:
        return "Strong positive correlation — positive news tends to precede price gains"
    if r > 0.2:
        return "Moderate positive correlation"
    if r > -0.2:
        return "Weak or no correlation"
    if r > -0.5:
        return "Moderate negative correlation"
    return "Strong negative correlation — negative news tends to precede price drops"
