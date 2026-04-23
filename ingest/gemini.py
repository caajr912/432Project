"""
ingest/gemini.py
Enriches processed headlines using Gemini LLM.

For every headline with processed=1 (spaCy done, not yet Gemini-enriched):
  1. Extract better entities than spaCy (catches things like "Tesla" in financial headlines)
  2. Classify macro/sector impact (links broad news to indexes)
  3. Extract relationships (not just mentions, but what happened)
  4. Suggest ticker mappings for entities not in our hardcoded map
  5. Write enriched data back to DB and mark processed=3

Run manually:
    python gemini.py

Or via run.py:
    python run.py --only gemini
"""

import json
import os
import sqlite3
import time

import google.generativeai as genai
from dotenv import load_dotenv

load_dotenv()

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
GEMINI_MODEL   = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")

# 2.5-flash free tier: 5 requests/min
REQUEST_DELAY = 13  # seconds between calls (60s / 5 req + buffer)

# Indexes we can link macro news to
MACRO_TICKERS = ["^GSPC", "^DJI", "^IXIC"]
SECTOR_MAP = {
    "energy":       ["XOM"],
    "tech":         ["AAPL", "MSFT", "GOOGL", "NVDA", "META"],
    "finance":      ["JPM"],
    "healthcare":   ["JNJ"],
    "consumer":     ["AMZN"],
    "auto":         ["TSLA"],
    "broad_market": MACRO_TICKERS,
}

PROMPT_TEMPLATE = """
You are a financial news analyst. Analyze this news headline and abstract, then return a JSON object.

Headline: {headline}
Abstract: {abstract}

Return ONLY a valid JSON object with these fields (no markdown, no explanation):

{{
  "entities": [
    {{"text": "entity name", "label": "ORG|PERSON|GPE|LOC|EVENT|LAW|PRODUCT", "ticker": "TICKER_OR_NULL"}}
  ],
  "macro_impact": true or false,
  "macro_reason": "brief reason if macro_impact is true, else null",
  "sectors": ["energy", "tech", "finance", "healthcare", "consumer", "auto", "broad_market"],
  "relationship": "one sentence describing the key market-relevant event, or null if not market relevant",
  "market_sentiment": "positive", "negative", or "neutral"
}}

Rules:
- entities: extract ALL named companies, people, places, organizations relevant to markets
- For each entity, suggest a stock ticker if you know it (e.g. Apple -> AAPL), else null
- macro_impact: true if this news could affect broad market indexes (Fed policy, inflation, trade war, geopolitical risk, recession, major legislation)
- sectors: list which sectors are affected (can be empty list)
- relationship: the core market-relevant fact in one sentence
- market_sentiment: overall sentiment for the market/affected stocks
"""


def _configure_gemini():
    genai.configure(api_key=GEMINI_API_KEY)
    return genai.GenerativeModel(GEMINI_MODEL)


def enrich_headline(model, headline: str, abstract: str) -> dict | None:
    """Call Gemini and parse the JSON response."""
    prompt = PROMPT_TEMPLATE.format(
        headline=headline,
        abstract=abstract or "",
    )
    try:
        response = model.generate_content(prompt)
        text = response.text.strip()
        # Strip markdown code fences if present
        if text.startswith("```"):
            text = text.split("```")[1]
            if text.startswith("json"):
                text = text[4:]
        return json.loads(text.strip())
    except json.JSONDecodeError:
        return None
    except Exception as e:
        error_str = str(e)
        if "429" in error_str:
            print(f"    [GEMINI] Rate limited — waiting 60 seconds...")
            time.sleep(60)
            return None
        print(f"    [GEMINI] API error: {e}")
        return None


def build_enriched_entities(gemini_result: dict) -> list[dict]:
    """
    Merge Gemini entities with macro/sector mappings.
    Returns unified entity list with ticker suggestions.
    """
    entities = gemini_result.get("entities") or []

    # Add index tickers if macro impact detected
    if gemini_result.get("macro_impact"):
        for ticker in MACRO_TICKERS:
            entities.append({
                "text": "broad market",
                "label": "ORG",
                "ticker": ticker,
                "source": "macro"
            })

    # Add sector tickers
    for sector in (gemini_result.get("sectors") or []):
        if sector in SECTOR_MAP:
            for ticker in SECTOR_MAP[sector]:
                entities.append({
                    "text": sector,
                    "label": "ORG",
                    "ticker": ticker,
                    "source": "sector"
                })

    return entities


def process_batch(conn: sqlite3.Connection, model, batch_size: int = 20) -> int:
    """
    Process up to batch_size headlines that have been spaCy processed (processed=1)
    but not yet Gemini enriched.
    Returns number of rows processed.
    """
    rows = conn.execute(
        """
        SELECT id, headline, abstract
        FROM headlines
        WHERE processed = 1
        LIMIT ?
        """,
        (batch_size,),
    ).fetchall()

    if not rows:
        return 0

    processed = 0
    for row in rows:
        result = enrich_headline(model, row["headline"], row["abstract"] or "")

        if result is None:
            # Mark as processed anyway to avoid retrying bad headlines
            conn.execute(
                "UPDATE headlines SET processed = 3 WHERE id = ?",
                (row["id"],)
            )
            conn.commit()
            time.sleep(REQUEST_DELAY)
            continue

        enriched_entities = build_enriched_entities(result)

        # Merge with existing spaCy entities
        existing_json = conn.execute(
            "SELECT entities_json FROM headlines WHERE id = ?",
            (row["id"],)
        ).fetchone()["entities_json"]

        existing = json.loads(existing_json or "[]")

        # Add Gemini entities, avoid exact duplicates
        seen = {(e["text"].lower(), e.get("label", "")) for e in existing}
        for ent in enriched_entities:
            key = (ent["text"].lower(), ent.get("label", ""))
            if key not in seen:
                existing.append(ent)
                seen.add(key)

        conn.execute(
            """
            UPDATE headlines
            SET entities_json        = ?,
                gemini_relationship  = ?,
                gemini_sentiment     = ?,
                gemini_macro         = ?,
                processed            = 3
            WHERE id = ?
            """,
            (
                json.dumps(existing),
                result.get("relationship"),
                result.get("market_sentiment"),
                1 if result.get("macro_impact") else 0,
                row["id"],
            )
        )
        conn.commit()

        ticker_suggestions = [e.get("ticker") for e in enriched_entities if e.get("ticker")]
        print(f"    [GEMINI] #{row['id']}: {row['headline'][:60]}...")
        print(f"             macro={result.get('macro_impact')} | "
              f"sentiment={result.get('market_sentiment')} | "
              f"tickers={list(set(t for t in ticker_suggestions if t))}")

        processed += 1
        time.sleep(REQUEST_DELAY)

    return processed


def run(conn: sqlite3.Connection):
    """Main entry point called by run.py."""
    if not GEMINI_API_KEY:
        print("  [GEMINI] No GEMINI_API_KEY set — skipping")
        return

    # Add Gemini columns if they don't exist yet
    try:
        conn.executescript("""
            ALTER TABLE headlines ADD COLUMN gemini_relationship TEXT;
            ALTER TABLE headlines ADD COLUMN gemini_sentiment TEXT;
            ALTER TABLE headlines ADD COLUMN gemini_macro INTEGER DEFAULT 0;
        """)
        conn.commit()
    except Exception:
        pass  # columns already exist

    model = _configure_gemini()
    total = 0

    print("  [GEMINI] Starting enrichment pass...")

    while True:
        count = process_batch(conn, model, batch_size=20)
        if count == 0:
            break
        total += count
        print(f"  [GEMINI] {total} headlines enriched so far...")

    if total == 0:
        print("  [GEMINI] No headlines pending Gemini enrichment")
    else:
        print(f"  [GEMINI] Done — {total} headlines enriched")


if __name__ == "__main__":
    import sys
    sys.path.insert(0, ".")
    from db import get_conn
    with get_conn() as conn:
        run(conn)
