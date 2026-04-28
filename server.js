const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const http = require("http");
const express = require("express");

const PORT_START = Number(process.env.PORT) || 3000;
const PORT_MAX_TRIES = 25;
const FRONTEND = path.join(__dirname, "Frontend");
const FINNHUB_BASE = "https://finnhub.io/api/v1";
const token = (process.env.FINNHUB_API_KEY || "").trim();

/** Finnhub free tier returns 403 on `/stock/candle`; Yahoo chart is used as fallback (no key). */
const YAHOO_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const app = express();

function finnhubUrl(route, params) {
  const u = new URL(FINNHUB_BASE + route);
  u.searchParams.set("token", token);
  Object.entries(params).forEach(([k, v]) => {
    if (v != null && v !== "") u.searchParams.set(k, String(v));
  });
  return u.toString();
}

async function forwardJson(res, url) {
  const r = await fetch(url);
  const text = await r.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return res.status(502).json({ error: "Invalid response from Finnhub" });
  }
  if (!r.ok) {
    return res.status(r.status).json(body.error ? body : { error: text || r.statusText });
  }
  res.json(body);
}

function yahooChartSymbol(symbol) {
  return String(symbol || "")
    .trim()
    .toUpperCase()
    .replace(/\./g, "-");
}

/** Same shape as Finnhub stock/candle: { s, t, o, h, l, c, v } */
async function fetchYahooDailyCandles(symbol) {
  const sym = yahooChartSymbol(symbol);
  if (!sym) return null;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1y&interval=1d`;
  const r = await fetch(url, {
    headers: { "User-Agent": YAHOO_UA, Accept: "application/json" },
  });
  if (!r.ok) return null;
  const j = await r.json();
  const result = j.chart?.result?.[0];
  if (!result) return null;
  const q = result.indicators?.quote?.[0];
  const ts = result.timestamp;
  if (!q || !Array.isArray(ts) || !Array.isArray(q.close)) return null;

  const t = [];
  const o = [];
  const h = [];
  const l = [];
  const c = [];
  const v = [];
  for (let i = 0; i < ts.length; i++) {
    const close = q.close[i];
    if (close == null || Number.isNaN(close)) continue;
    t.push(ts[i]);
    o.push(q.open[i] ?? close);
    h.push(q.high[i] ?? close);
    l.push(q.low[i] ?? close);
    c.push(close);
    v.push(q.volume[i] ?? 0);
  }
  if (t.length === 0) return null;
  return { s: "ok", t, o, h, l, c, v };
}

function filterCandlesByRange(candles, fromSec, toSec) {
  if (!candles || !Array.isArray(candles.t)) return null;
  const out = { s: "ok", t: [], o: [], h: [], l: [], c: [], v: [] };
  for (let i = 0; i < candles.t.length; i++) {
    if (candles.t[i] >= fromSec && candles.t[i] <= toSec) {
      out.t.push(candles.t[i]);
      out.o.push(candles.o[i]);
      out.h.push(candles.h[i]);
      out.l.push(candles.l[i]);
      out.c.push(candles.c[i]);
      out.v.push(candles.v[i]);
    }
  }
  return out.t.length > 0 ? out : null;
}

async function fetchDailyCandles(symbol, fromSec, toSec) {
  if (token) {
    const url = finnhubUrl("/stock/candle", {
      symbol,
      resolution: "D",
      from: fromSec,
      to: toSec,
    });
    const r = await fetch(url);
    const text = await r.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    const finnOk =
      r.ok &&
      body &&
      body.s === "ok" &&
      Array.isArray(body.t) &&
      body.t.length > 0;
    if (finnOk) return body;
  }

  const yahoo = await fetchYahooDailyCandles(symbol);
  if (!yahoo) return { s: "no_data", t: [] };
  const trimmed = filterCandlesByRange(yahoo, fromSec, toSec);
  return trimmed || yahoo;
}

app.get("/api/quote", async (req, res) => {
  const symbol = String(req.query.symbol || "")
    .trim()
    .toUpperCase();
  if (!symbol) return res.status(400).json({ error: "symbol required" });
  try {
    if (!token) {
      const to = Math.floor(Date.now() / 1000);
      const from = to - 30 * 24 * 60 * 60;
      const candles = await fetchDailyCandles(symbol, from, to);
      if (!candles || candles.s !== "ok" || !Array.isArray(candles.c) || candles.c.length === 0) {
        return res.status(404).json({ error: "No quote data available" });
      }
      const last = candles.c[candles.c.length - 1];
      const prev = candles.c.length > 1 ? candles.c[candles.c.length - 2] : last;
      const high = candles.h[candles.h.length - 1] ?? last;
      const low = candles.l[candles.l.length - 1] ?? last;
      const change = last - prev;
      const changePercent = prev ? (change / prev) * 100 : 0;
      return res.json({ c: last, h: high, l: low, o: candles.o[candles.o.length - 1] ?? last, pc: prev, d: change, dp: changePercent, t: candles.t[candles.t.length - 1], v: candles.v[candles.v.length - 1] ?? null });
    }
    await forwardJson(res, finnhubUrl("/quote", { symbol }));
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/candles", async (req, res) => {
  const symbol = String(req.query.symbol || "")
    .trim()
    .toUpperCase();
  if (!symbol) return res.status(400).json({ error: "symbol required" });
  const to = Math.floor(Date.now() / 1000);
  const from = to - 400 * 24 * 60 * 60;
  try {
    const data = await fetchDailyCandles(symbol, from, to);
    if (data && data.s === "ok" && Array.isArray(data.t) && data.t.length > 0) {
      return res.json(data);
    }
    return res.status(404).json({
      error: "No daily OHLC data (Finnhub candle needs paid plan; Yahoo fallback failed).",
      s: "no_data",
      t: [],
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

/** Daily candles — same as /api/candles (alias for older clients). */
app.get("/api/candles-week", async (req, res) => {
  const symbol = String(req.query.symbol || "")
    .trim()
    .toUpperCase();
  if (!symbol) return res.status(400).json({ error: "symbol required" });
  const to = Math.floor(Date.now() / 1000);
  const from = to - 400 * 24 * 60 * 60;
  try {
    const data = await fetchDailyCandles(symbol, from, to);
    if (data && data.s === "ok" && Array.isArray(data.t) && data.t.length > 0) {
      return res.json(data);
    }
    return res.status(404).json({
      error: "No daily OHLC data (Finnhub candle needs paid plan; Yahoo fallback failed).",
      s: "no_data",
      t: [],
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/news", async (req, res) => {
  const symbol = String(req.query.symbol || "")
    .trim()
    .toUpperCase();
  if (!symbol) return res.status(400).json({ error: "symbol required" });
  if (!token) return res.json([]);
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 30);
  const toStr = to.toISOString().slice(0, 10);
  const fromStr = from.toISOString().slice(0, 10);
  try {
    await forwardJson(
      res,
      finnhubUrl("/company-news", { symbol, from: fromStr, to: toStr })
    );
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/profile", async (req, res) => {
  const symbol = String(req.query.symbol || "")
    .trim()
    .toUpperCase();
  if (!symbol) return res.status(400).json({ error: "symbol required" });
  if (!token) return res.json({});
  try {
    await forwardJson(res, finnhubUrl("/stock/profile2", { symbol }));
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/metric", async (req, res) => {
  const symbol = String(req.query.symbol || "")
    .trim()
    .toUpperCase();
  if (!symbol) return res.status(400).json({ error: "symbol required" });
  if (!token) return res.json({ metric: {} });
  try {
    await forwardJson(res, finnhubUrl("/stock/metric", { symbol, metric: "all" }));
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/nyt-headlines", async (req, res) => {
  try {
    const sqlite3 = require('sqlite3').verbose();
    const db = new sqlite3.Database('./data/staging.db');
    db.all("SELECT headline, sentiment, entities_json, published_date FROM headlines WHERE processed = 1 ORDER BY published_date DESC LIMIT 10", [], (err, rows) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      const headlines = rows.map(row => ({
        headline: row.headline,
        sentiment: row.sentiment,
        entities: JSON.parse(row.entities_json || '[]'),
        published_date: row.published_date
      }));
      res.json(headlines);
      db.close();
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

/** Markets endpoints - lightweight Yahoo-based fallbacks for indices and movers */
app.get("/api/indices", async (req, res) => {
  try {
    // Common index tickers (Yahoo uses ^ prefix)
    const symbols = ["^GSPC", "^DJI", "^IXIC"].join(",");
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(
      symbols
    )}`;
    const r = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (compatible; 432Project/1.0)" } });
    if (r.ok) {
      const j = await r.json();
      const quotes = (j.quoteResponse?.result || []).map((q) => ({
        symbol: q.symbol,
        price: q.regularMarketPrice,
        change: q.regularMarketChange,
        changePercent: q.regularMarketChangePercent,
        marketState: q.marketState,
      }));
      return res.json({ indices: quotes });
    }

    // Fallback: Yahoo quote blocked for indices — use common ETFs as proxies (SPY, DIA, QQQ)
    const fallback = ["SPY", "DIA", "QQQ"];
    const fUrl = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(fallback.join(","))}`;
    const fr = await fetch(fUrl, { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (compatible; 432Project/1.0)" } });
    if (fr.ok) {
      const fj = await fr.json();
      const map = { SPY: "^GSPC", DIA: "^DJI", QQQ: "^IXIC" };
      const quotes = (fj.quoteResponse?.result || []).map((q) => ({
        symbol: map[q.symbol] || q.symbol,
        price: q.regularMarketPrice,
        change: q.regularMarketChange,
        changePercent: q.regularMarketChangePercent,
        marketState: q.marketState,
      }));
      return res.json({ indices: quotes });
    }

    // As final fallback compute latest close from daily candles for ETF proxies
    const etfs = ["SPY","DIA","QQQ"];
    const out = [];
    const to = Math.floor(Date.now()/1000);
    const from = to - 7*24*60*60;
    for (const s of etfs){
      try{
        const c = await fetchDailyCandles(s, from, to);
        if (c && Array.isArray(c.c) && c.c.length>0){
          const last = c.c[c.c.length-1];
          const prev = c.c[c.c.length-2] || last;
          out.push({ symbol: s === 'SPY'? '^GSPC': s === 'DIA'? '^DJI': '^IXIC', price: last, change: last - prev, changePercent: prev?((last-prev)/prev)*100:0 });
        }
      }catch(e){ }
    }
    if (out.length>0) return res.json({ indices: out });

    return res.status(502).json({ error: "Yahoo quote fetch failed for indices" });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/movers", async (req, res) => {
  try {
    // Optional symbols query (comma-separated); otherwise use a set of large-cap stocks
    const q = String(req.query.symbols || "").trim();
    const defaults = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "JPM", "XOM", "V"];
    const symbols = q ? q.split(",").map((s) => s.trim()).filter(Boolean) : defaults;
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols.join(","))}`;
    const r = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (compatible; 432Project/1.0)" } });
    if (r.ok) {
      const j = await r.json();
      const results = (j.quoteResponse?.result || []).map((q) => ({
        symbol: q.symbol,
        price: q.regularMarketPrice,
        change: q.regularMarketChange,
        changePercent: q.regularMarketChangePercent,
      }));
      // sort by percent change
      const sorted = results.slice().sort((a, b) => (b.changePercent || 0) - (a.changePercent || 0));
      const gainers = sorted.slice(0, 5);
      const losers = sorted.slice(-5).reverse();
      return res.json({ gainers, losers });
    }

    // Yahoo failed; compute movers from recent candles as fallback
    const compute = async (symList) => {
      const out = [];
      const to = Math.floor(Date.now() / 1000);
      const from = to - 10 * 24 * 60 * 60;
      for (const s of symList) {
        try {
          const c = await fetchDailyCandles(s, from, to);
          if (c && Array.isArray(c.c) && c.c.length >= 2) {
            const last = c.c[c.c.length - 1];
            const prev = c.c[c.c.length - 2] || last;
            const change = last - prev;
            const changePercent = prev ? (change / prev) * 100 : 0;
            out.push({ symbol: s, price: last, change, changePercent });
          }
        } catch (err) {
          // ignore
        }
      }
      return out;
    };

    const fallbackResults = await compute(symbols);
    const sortedFallback = fallbackResults.slice().sort((a, b) => (b.changePercent || 0) - (a.changePercent || 0));
    const gainers = sortedFallback.slice(0, 5);
    const losers = sortedFallback.slice(-5).reverse();
    return res.json({ gainers, losers });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/market-sentiment", async (req, res) => {
  try {
    // Lightweight placeholder: return mixed sentiment. Can be replaced with NER/sentiment aggregation later.
    res.json({ sentiment: "mixed", score: 0.05 });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.use(express.static(FRONTEND));

function startListen(port, attempt) {
  const srv = http.createServer(app);
  srv.on("error", (err) => {
    if (err.code === "EADDRINUSE" && attempt < PORT_MAX_TRIES) {
      console.warn(`Port ${port} is in use, trying ${port + 1}…`);
      startListen(port + 1, attempt + 1);
    } else {
      console.error(err);
      process.exit(1);
    }
  });
  srv.listen(port, () => {
    console.log(`App: http://localhost:${port}`);
    if (port !== PORT_START) {
      console.log(`(Port ${PORT_START} was busy. Set PORT=${port} in .env to skip searching.)`);
    }
    if (!token) console.warn("Warning: FINNHUB_API_KEY is not set in .env");
  });
  return srv;
}

if (require.main === module) {
  startListen(PORT_START, 0);
}

module.exports = {
  app,
  yahooChartSymbol,
  filterCandlesByRange,
  startListen,
};
