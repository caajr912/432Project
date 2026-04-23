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
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=your_neo4j_password
PORT=3000
```

> **Never commit `.env` to git.** It is already in `.gitignore`.

### 5. Start Neo4j

Open Neo4j Desktop and start your local database instance. It should be running on `bolt://localhost:7687` by default.

### 6. Get API keys

- **NYT**: https://developer.nytimes.com — create an app, enable **Top Stories API** under the APIs tab
- **Finnhub**: https://finnhub.io — free tier works (stock candles fall back to Yahoo Finance automatically)

---

## Running the ingestion pipeline

```bash
# Run everything (news + stocks)
python ingest/run.py

# News only
python ingest/run.py --only nyt

# Stocks only
python ingest/run.py --only stocks

# Specific tickers
python ingest/run.py --only stocks --tickers AAPL TSLA NVDA

# Custom lookback window (default 365 days)
python ingest/run.py --only stocks --lookback 90
```

Ingested data is stored in `data/staging.db` (SQLite). This directory is gitignored.

---

## Project structure

```
432Project/
├── ingest/
│   ├── db.py          # SQLite schema + connection helper
│   ├── nyt.py         # NYT Top Stories fetcher
│   ├── stocks.py      # Finnhub/Yahoo Finance candle fetcher
│   └── run.py         # CLI entry point for ingestion
├── 432Project-main/
│   └── Frontend/      # HTML/CSS/JS frontend (current demo)
├── data/              # SQLite staging DB (gitignored)
├── server.js          # Node/Express dev server (proxies Finnhub)
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

## Running the API

```bash
python -m uvicorn api.main:app --reload
```

API runs at http://localhost:8000
Interactive docs at http://localhost:8000/docs

### Endpoints
- `GET /api/tickers` — available tickers
- `GET /api/articles` — headlines (filter by ?section= or ?sentiment=)
- `GET /api/prices/{ticker}` — price history (?days=30)
- `GET /api/graph/{ticker}` — knowledge graph nodes + edges for a ticker
- `GET /api/correlate/{ticker}` — sentiment vs price correlation (?window_days=3)
- `GET /health` — health check

---

## Scrum

- Weekly meetings: **Tuesdays @ 3pm**
- Kanban board: https://trello.com/invite/b/69ab6cf300c35b488715a0be/ATTIce3037c2be581944167fc4f7a684ca40FB172DC1/cmps432

---

## Notes

- `data/` is gitignored — each developer runs ingestion locally
- The Node `server.js` is a frontend demo scaffold and will be replaced by FastAPI
- Neo4j Desktop is used for local dev; Amazon Neptune is the production target. Both speak openCypher so queries port with minimal changes.
