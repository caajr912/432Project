# StockMap: News-to-Market Knowledge Graph

> **At a glance:** A data pipeline that ingests daily news headlines and stock market data, enriches each headline with named-entity recognition, sentiment scoring, and LLM classification, and models the relationships as a knowledge graph (Neo4j locally, Amazon Neptune in production) served through a FastAPI backend. CI runs Python and Node tests on every push via GitHub Actions, and the frontend deploys to Amazon S3.
>
> **My role:** Team project for CMPS 432 (Parallel and Distributed Programming) at the University of Louisiana at Lafayette. I led the team and built the majority of the system, including the ingestion pipeline, enrichment passes, knowledge graph, API, and CI.

The core thesis: general news moves markets. The system captures headlines, extracts entities and sentiment, maps them to stocks and indexes, and measures whether news sentiment correlates with price movement in the days that follow.

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | HTML, CSS, JavaScript (deployed to S3) |
| Backend | Python (FastAPI) |
| Knowledge Graph | Neo4j (local dev) → Amazon Neptune (prod) |
| Staging DB | SQLite |
| NER | spaCy (`en_core_web_sm`) |
| Sentiment | VADER |
| LLM Enrichment | Google Gemini |
| News API | NYT Top Stories |
| Stock API | Finnhub / Yahoo Finance (fallback) |
| CI/CD | GitHub Actions |

---

## Architecture

```
NYT API ──────────────┐
                      ▼
              ingest/run.py
                      ▲
Finnhub / Yahoo ──────┘
                      │
                      ▼
            SQLite (staging)
         headlines · stock_prices
                      │
                      ▼
          NER + Sentiment pass
            (spaCy + VADER)
                      │
                      ▼
       Gemini LLM enrichment pass
  (entity refinement, macro classification,
   sector tagging, relationship extraction)
                      │
                      ▼
       Neo4j / Neptune (knowledge graph)
                      │
                      ▼
              FastAPI backend
                      │
                      ▼
   HTML/JS frontend (graph viz + stock charts)
```

---

## How the pipeline works

1. **News ingestion.** Pulls top stories from the business, technology, world, and US sections, and stores the headline, abstract, URL, and publish date in SQLite.
2. **Market ingestion.** Pulls a year of daily OHLCV candles for 10 stocks and 3 market indexes (S&P 500, Dow, Nasdaq).
3. **NER + sentiment.** spaCy extracts named entities (companies, people, places) from each headline, and VADER scores sentiment from -1.0 to +1.0.
4. **LLM enrichment.** Gemini refines entity extraction, classifies macro market impact (Fed policy, inflation, geopolitical risk), tags affected sectors, and extracts the core market-relevant relationship from each headline. This links broad news to indexes even when no index is named.
5. **Graph writer.** Loads everything into the knowledge graph: `Article → MENTIONS → Entity → MAPS_TO → Ticker → HAD_PRICE → Price`.
6. **Correlation.** For a given ticker, the API finds every linked article, measures the price change over the following N days, and computes the Pearson correlation between sentiment and price movement.

---

## API

| Endpoint | Description |
|---|---|
| `GET /health` | Health check |
| `GET /api/tickers` | List available tickers |
| `GET /api/articles` | Headlines (filter by `?section=` or `?sentiment=positive/negative/neutral`) |
| `GET /api/prices/{ticker}` | Price history (`?days=30`) |
| `GET /api/graph/{ticker}` | Knowledge graph nodes and edges for a ticker |
| `GET /api/correlate/{ticker}` | Sentiment vs. price correlation (`?window_days=3`) |

Interactive docs are served at `/docs` when the API is running.

---

## Running locally

### 1. Clone and install

```bash
git clone https://github.com/caajr912/432Project.git
cd 432Project
pip install -r requirements.txt
pip install google-generativeai
python -m spacy download en_core_web_sm
npm install
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Fill in `.env` with your keys:

```
FINNHUB_API_KEY=your_finnhub_key
NYT_API_KEY=your_nyt_key
NEO4J_URI=neo4j://127.0.0.1:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=your_neo4j_password
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-3.1-flash-lite-preview
PORT=3000
```

API keys: [NYT Developer](https://developer.nytimes.com) (enable Top Stories), [Finnhub](https://finnhub.io) (free tier works; candles fall back to Yahoo Finance), [Google AI Studio](https://aistudio.google.com) (free tier is sufficient).

### 3. Start Neo4j

Start a local Neo4j Desktop instance on `neo4j://127.0.0.1:7687` using the default `neo4j` database.

### 4. Run the pipeline

```bash
# Full pipeline: news → stocks → NER → Gemini enrichment → graph
python ingest/run.py

# Individual steps
python ingest/run.py --only nyt
python ingest/run.py --only stocks --tickers AAPL TSLA NVDA --lookback 90
python ingest/run.py --only ner
python ingest/run.py --only gemini
python ingest/run.py --only graph
```

Ingested data is staged in `data/staging.db`, which is generated locally and not committed.

### 5. Run the API

```bash
python -m uvicorn api.main:app --reload
```

The API runs at `http://localhost:8000`.

---

## Testing and CI

The tests don't require Neo4j; the FastAPI tests mock the database layer.

```bash
# Python (pytest + httpx TestClient)
pip install -r requirements-test.txt
python -m pytest -v

# Node (built-in node:test)
npm test
```

GitHub Actions runs both suites on every push and pull request (Python 3.12, Node 20). A second workflow deploys the frontend to Amazon S3. See `.github/workflows/`.

---

## Notes

- Neo4j is used for local development and Amazon Neptune is the production target. Both speak openCypher, so queries port with minimal changes.
- `server.js` is a legacy frontend scaffold; the FastAPI backend replaces it.
- Correlation signal improves with more data, so the pipeline is designed to run daily.
