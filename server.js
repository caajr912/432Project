const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const http = require("http");
const express = require("express");

const PORT_START = Number(process.env.PORT) || 3000;
const PORT_MAX_TRIES = 25;
const FRONTEND = path.join(__dirname, "432Project-main", "Frontend");
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
  if (!token) return res.status(500).json({ error: "Missing FINNHUB_API_KEY in .env" });
  const symbol = String(req.query.symbol || "")
    .trim()
    .toUpperCase();
  if (!symbol) return res.status(400).json({ error: "symbol required" });
  try {
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
  if (!token) return res.status(500).json({ error: "Missing FINNHUB_API_KEY in .env" });
  const symbol = String(req.query.symbol || "")
    .trim()
    .toUpperCase();
  if (!symbol) return res.status(400).json({ error: "symbol required" });
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
  if (!token) return res.status(500).json({ error: "Missing FINNHUB_API_KEY in .env" });
  const symbol = String(req.query.symbol || "")
    .trim()
    .toUpperCase();
  if (!symbol) return res.status(400).json({ error: "symbol required" });
  try {
    await forwardJson(res, finnhubUrl("/stock/profile2", { symbol }));
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/metric", async (req, res) => {
  if (!token) return res.status(500).json({ error: "Missing FINNHUB_API_KEY in .env" });
  const symbol = String(req.query.symbol || "")
    .trim()
    .toUpperCase();
  if (!symbol) return res.status(400).json({ error: "symbol required" });
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
}

startListen(PORT_START, 0);
