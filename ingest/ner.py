"""
ingest/ner.py
NER + sentiment pass over raw headlines in SQLite.

For every headline with processed=0:
  1. Run spaCy NER → extract entities (text, label)
  2. Score sentiment with VADER
  3. Write entities_json + sentiment back to DB
  4. Mark processed=1

Run manually:
    python ner.py

Or via run.py:
    python run.py --only ner
"""

import json
import sqlite3
import spacy
from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer

# Entity types we care about — filter out noise like DATE, CARDINAL, ORDINAL
RELEVANT_LABELS = {
    "ORG",      # Apple, Federal Reserve, NATO
    "PERSON",   # Elon Musk, Jerome Powell
    "GPE",      # USA, China, Ukraine (geo-political entities)
    "LOC",      # broader locations
    "NORP",     # nationalities, political groups (Republicans, Chinese)
    "PRODUCT",  # specific products occasionally relevant
    "EVENT",    # wars, elections
    "LAW",      # legislation
}

_nlp = None
_vader = None


def _get_nlp():
    global _nlp
    if _nlp is None:
        _nlp = spacy.load("en_core_web_sm")
    return _nlp


def _get_vader():
    global _vader
    if _vader is None:
        _vader = SentimentIntensityAnalyzer()
    return _vader


def extract_entities(text: str) -> list[dict]:
    """Run spaCy NER on text, return filtered entity list."""
    nlp = _get_nlp()
    doc = nlp(text)
    seen = set()
    entities = []
    for ent in doc.ents:
        if ent.label_ not in RELEVANT_LABELS:
            continue
        key = (ent.text.strip(), ent.label_)
        if key in seen:
            continue
        seen.add(key)
        entities.append({"text": ent.text.strip(), "label": ent.label_})
    return entities


def score_sentiment(text: str) -> float:
    """
    VADER compound score: -1.0 (most negative) to 1.0 (most positive).
    We run it on headline + abstract combined for better signal.
    """
    vader = _get_vader()
    scores = vader.polarity_scores(text)
    return round(scores["compound"], 4)


def process_batch(conn: sqlite3.Connection, batch_size: int = 100) -> int:
    """
    Process up to batch_size unprocessed headlines.
    Returns number of rows processed.
    """
    rows = conn.execute(
        """
        SELECT id, headline, abstract
        FROM headlines
        WHERE processed = 0
        LIMIT ?
        """,
        (batch_size,),
    ).fetchall()

    if not rows:
        return 0

    updates = []
    for row in rows:
        # Combine headline + abstract for richer NER and sentiment signal
        full_text = f"{row['headline']}. {row['abstract'] or ''}".strip()

        entities = extract_entities(full_text)
        sentiment = score_sentiment(full_text)

        updates.append({
            "id": row["id"],
            "entities_json": json.dumps(entities),
            "sentiment": sentiment,
        })

    conn.executemany(
        """
        UPDATE headlines
        SET entities_json = :entities_json,
            sentiment     = :sentiment,
            processed     = 1
        WHERE id = :id
        """,
        updates,
    )
    conn.commit()
    return len(updates)


def run(conn: sqlite3.Connection, batch_size: int = 100):
    """Main entry point called by run.py."""
    total = 0
    while True:
        count = process_batch(conn, batch_size)
        if count == 0:
            break
        total += count
        print(f"  [NER] Processed {total} headlines...")

    if total == 0:
        print("  [NER] No unprocessed headlines found")
    else:
        print(f"  [NER] Done — {total} headlines processed")

    # Print a sample so we can see it's working
    _print_sample(conn)


def _print_sample(conn: sqlite3.Connection, n: int = 3):
    """Print a few processed rows so we can visually verify output."""
    rows = conn.execute(
        """
        SELECT headline, sentiment, entities_json
        FROM headlines
        WHERE processed = 1
        LIMIT ?
        """,
        (n,),
    ).fetchall()

    if not rows:
        return

    print("\n  --- Sample output ---")
    for row in rows:
        entities = json.loads(row["entities_json"] or "[]")
        entity_str = ", ".join(f"{e['text']} ({e['label']})" for e in entities[:5])
        sentiment_label = (
            "POSITIVE" if row["sentiment"] > 0.05
            else "NEGATIVE" if row["sentiment"] < -0.05
            else "NEUTRAL"
        )
        print(f"\n  Headline : {row['headline'][:80]}...")
        print(f"  Sentiment: {row['sentiment']} ({sentiment_label})")
        print(f"  Entities : {entity_str or 'none detected'}")
    print()


if __name__ == "__main__":
    import sys
    sys.path.insert(0, ".")
    from db import get_conn
    with get_conn() as conn:
        run(conn)
