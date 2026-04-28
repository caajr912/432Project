# StockMap — CMPS 432 Group Project

A data pipeline and knowledge graph system that correlates general world news (NYT headlines) with stock market movements. The core thesis: general news moves markets. We capture headlines, extract entities and sentiment, map them to stocks/indexes, and model the relationships in a graph database.

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | HTML, CSS, JavaScript |
| Backend | Python (FastAPI) |
| Knowledge Graph | Neo4j (local dev) → Amazon Neptune (prod) |
| Staging DB | SQLite |
| NER | spaCy (`en_core_web_sm`) |
| Sentiment | VADER |
| LLM Enrichment | Google Gemini |
| News API | NYT Top Stories |
| Stock API | Finnhub (paid) / Yahoo Finance (free fallback) |

---

## Team

| Name | Role |
|---|---|
| Khiem Nguyen | ER diagram, database integration, backend |
| Chris R | Pipeline, testing (unit, e2e, docker, v-test) |
| Ethan G | UI design, mockups, wireframes, user flow |
| Ethan M | Database setup, API integration |
| Diego | UI design, mockups, wireframes |
| Chris | Scrum master, backlog, meeting scheduling |

---

## Setup

### 1. Clone the repo

```bash
git clone https://github.com/<your-org>/432Project.git
cd 432Project
```

### 2. Install Python dependencies

```bash
pip install -r requirements.txt
pip install google-generativeai
python -m spacy download en_core_web_sm
```

### 3. Install Node dependencies (for the frontend dev server)

```bash
npm install
```

### 4. Configure environment variables

Copy `.env.example` to `.env` and fill in your keys:

```bash
cp .env.example .env
```

`.env` values needed:

```
FINNHUB_API_KEY=your_finnhub_key
NYT_API_KEY=your_nyt_key
NEO4J_URI=neo4j://127.0.0.1:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=your_neo4j_password
GEMINI_API_KEY=your_gemini_api_key     # get from aistudio.google.com (free)
GEMINI_MODEL=gemini-3.1-flash-lite-preview
PORT=3000
```

> **Never commit `.env` to git.** It is already in `.gitignore`.

### 5. Start Neo4j

Open Neo4j Desktop and start your local database instance. The default database name is `neo4j` — do not rename it. Connection should be on `neo4j://127.0.0.1:7687` by default.

### 6. Get API keys

- **NYT**: https://developer.nytimes.com — create an app, enable **Top Stories API** under the APIs tab
- **Finnhub**: https://finnhub.io — free tier works (stock candles fall back to Yahoo Finance automatically)
- **Gemini**: https://aistudio.google.com — create a project and generate an API key (free tier is sufficient)

---

## Running the ingestion pipeline

```bash
# Full pipeline: NYT -> stocks -> NER -> Gemini enrichment -> Neo4j graph
python ingest/run.py

# Individual steps
python ingest/run.py --only nyt        # headlines only
python ingest/run.py --only stocks     # stock candles only
python ingest/run.py --only ner        # NER + sentiment pass
python ingest/run.py --only gemini     # Gemini LLM enrichment pass
python ingest/run.py --only graph      # write to Neo4j

# Specific tickers
python ingest/run.py --only stocks --tickers AAPL TSLA NVDA

# Custom lookback window (default 365 days)
python ingest/run.py --only stocks --lookback 90
```

Ingested data is stored in `data/staging.db` (SQLite). This directory is gitignored — run ingestion locally after setup.

> **Run the full pipeline daily** to accumulate data and improve correlation signal.

---

## Running the API

```bash
python -m uvicorn api.main:app --reload
```

API runs at http://localhost:8000
Interactive docs at http://localhost:8000/docs

### Endpoints

| Endpoint | Description |
|---|---|
| `GET /health` | Health check |
| `GET /api/tickers` | List available tickers |
| `GET /api/articles` | Headlines (filter by ?section= or ?sentiment=positive/negative/neutral) |
| `GET /api/prices/{ticker}` | Price history (?days=30) |
| `GET /api/graph/{ticker}` | Knowledge graph nodes + edges for a ticker |
| `GET /api/correlate/{ticker}` | Sentiment vs price correlation (?window_days=3) |

---

## Running tests

From the repo root (`432Project/`). You do **not** need Neo4j running for these — the FastAPI tests mock the database layer.

### Node (Express `server.js` helpers)

Uses built-in [`node:test`](https://nodejs.org/api/test.html) on chart helper functions.

```bash
npm install
npm test
```

### Python (FastAPI `api/`)

Uses [`pytest`](https://pytest.org/) and `httpx` via `TestClient`.

```bash
pip install -r requirements-test.txt
python -m pytest -v
```

### CI

On every push and pull request, GitHub Actions runs the same checks: `pytest` (Python 3.12) and `npm ci` + `npm test` (Node 20). See `.github/workflows/ci.yml`.

---

## Project structure

```
432Project/
├── api/
│   ├── __init__.py
│   └── main.py        # FastAPI backend
├── ingest/
│   ├── db.py          # SQLite schema + connection helper
│   ├── nyt.py         # NYT Top Stories fetcher
│   ├── stocks.py      # Finnhub/Yahoo Finance candle fetcher
│   ├── ner.py         # spaCy NER + VADER sentiment pass
│   ├── gemini.py      # Gemini LLM enrichment pass
│   └── run.py         # CLI entry point for full pipeline
├── 432Project-main/
│   └── Frontend/      # HTML/CSS/JS frontend
├── data/              # SQLite staging DB (gitignored)
├── server.js          # Node/Express dev server (legacy scaffold)
├── requirements.txt   # Python dependencies
├── package.json       # Node dependencies
├── .env.example       # Environment variable template
└── .env               # Your local secrets (gitignored)
```

---

## Architecture

```
NYT API ──────────────────────────────────┐
                                          ▼
                                   ingest/run.py
                                          │
Finnhub / Yahoo Finance ─────────────────┘
                                          │
                                          ▼
                                   SQLite (staging)
                                    headlines
                                    stock_prices
                                          │
                                          ▼
                               NER + Sentiment pass
                               (spaCy + VADER)
                                          │
                                          ▼
                             Gemini LLM Enrichment pass
                          (entity extraction, macro classification,
                           sector tagging, relationship extraction)
                                          │
                                          ▼
                                   Neo4j / Neptune
                               (knowledge graph)
                                          │
                                          ▼
                                 FastAPI backend
                                          │
                                          ▼
                                  HTML/JS Frontend
                             (graph viz + stock charts)
```

---

## How the pipeline works

1. **NYT ingestion** — pulls top stories from business, technology, world, and US sections. Stores headline, abstract, URL, and publish date in SQLite.

2. **Stock ingestion** — pulls 1 year of daily OHLCV candles for 10 stocks and 3 market indexes (S&P 500, Dow, Nasdaq) via Yahoo Finance.

3. **NER + sentiment** — spaCy extracts named entities (companies, people, places) from each headline. VADER scores sentiment from -1.0 to +1.0.

4. **Gemini enrichment** — Gemini LLM refines entity extraction, classifies macro market impact (Fed policy, inflation, geopolitical risk), tags affected sectors, and extracts the core market-relevant relationship from each headline. This step links broad news to indexes even when no index is explicitly named.

5. **Graph writer** — pushes all data into Neo4j as a knowledge graph: Article -> MENTIONS -> Entity -> MAPS_TO -> Ticker -> HAD_PRICE -> Price.

6. **Correlation** — the /api/correlate/{ticker} endpoint queries the graph to find all articles linked to a ticker, measures the stock price change in the N days following each article, and computes Pearson correlation between sentiment and price movement.

---

## Scrum

- Weekly meetings: **Tuesdays @ 3pm**
- Kanban board: https://trello.com/invite/b/69ab6cf300c35b488715a0be/ATTIce3037c2be581944167fc4f7a684ca40FB172DC1/cmps432

---

## Notes

- `data/` is gitignored — each developer runs ingestion locally after cloning
- The Node `server.js` is a legacy frontend scaffold — the FastAPI backend replaces it
- Neo4j Desktop is used for local dev; Amazon Neptune is the production target. Both speak openCypher so queries port with minimal changes
- Correlation signal improves with more data — run the pipeline daily in the days leading up to the demo
