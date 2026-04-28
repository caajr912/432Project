let chart; // global chart variable
const API_BASE = ""; // keep empty if frontend is served from same backend origin

/** "week" = last 7 sessions; "month" = daily bars in the last 30 calendar days */
let chartRangeMode = "week";
let cacheTicker = "";
let cacheQuote = null;
let cacheCandles = null;
/** Articles from Neo4j: (Article)-[:MENTIONS]->(Entity)-[:MAPS_TO]->(Ticker) */
let cacheKgArticles = [];
/** Last proxy/API error for knowledge-graph articles (shown under chart) */
let cacheKgLoadError = "";
/** One entry per scatter point — aligned with scatter dataset `data` */
let cacheScatterMeta = [];
/** Click-to-open state for KG dot tooltip (prevents hover from showing it). */
let kgTooltipArmed = false;
/** Which KG dot is armed (datasetIndex + dataIndex), so hover can't switch it. */
let kgTooltipArmedKey = null;
/** Remembers last pointer event type (best-effort, for touch devices). */
let lastChartPointerEventType = "";

const KG_SCATTER_LABEL = "Graph-linked news (Neo4j)";

/** US equity session calendar day for a bar timestamp (matches YYYY-MM-DD headlines). */
function candleDayNY(tsSec) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(tsSec * 1000));
}

function parseYmdUtc(ymd) {
  const s = (ymd || "").slice(0, 10);
  const p = s.split("-");
  if (p.length !== 3) return NaN;
  const y = Number(p[0]);
  const m = Number(p[1]);
  const d = Number(p[2]);
  if (!y || !m || !d) return NaN;
  return Date.UTC(y, m - 1, d);
}

/**
 * Map article published_date to a bar index in the current slice (0 = first visible bar).
 * Exact NY session date match, else nearest trading day within maxDaySlack calendar days.
 */
function matchArticleToBarIndex(slice, pubYmd, maxDaySlack) {
  if (!slice || !pubYmd) return null;
  const pub = pubYmd.slice(0, 10);
  const dateToRel = new Map();
  let rel = 0;
  for (let i = slice.start; i < slice.n; i++) {
    dateToRel.set(candleDayNY(slice.t[i]), rel);
    rel++;
  }
  if (dateToRel.has(pub)) return dateToRel.get(pub);

  const pubTs = parseYmdUtc(pub);
  if (Number.isNaN(pubTs)) return null;
  let bestRel = null;
  let bestDist = Infinity;
  rel = 0;
  for (let i = slice.start; i < slice.n; i++) {
    const dayTs = parseYmdUtc(candleDayNY(slice.t[i]));
    if (Number.isNaN(dayTs)) {
      rel++;
      continue;
    }
    const dist = Math.abs(dayTs - pubTs);
    if (dist < bestDist) {
      bestDist = dist;
      bestRel = rel;
    }
    rel++;
  }
  const maxMs = maxDaySlack * 86400000;
  if (bestRel == null || bestDist > maxMs) return null;
  return bestRel;
}

function buildKgScatterPoints(slice, labels, highs, lows, articles) {
  cacheScatterMeta = [];
  const scatterData = [];
  if (!slice || !articles.length || !labels.length) return scatterData;

  const byRel = new Map();
  for (const a of articles) {
    const pub = (a.published_date || "").slice(0, 10);
    const rel = matchArticleToBarIndex(slice, pub, 4);
    if (rel == null || rel < 0 || rel >= labels.length) continue;
    if (!byRel.has(rel)) byRel.set(rel, []);
    byRel.get(rel).push(a);
  }

  byRel.forEach((arts, rel) => {
    const label = labels[rel];
    const hi = Number(highs[rel]);
    const lo = Number(lows[rel]);
    const mid = (hi + lo) / 2;
    const span = Math.max(hi - lo, Math.abs(hi) * 0.004, 0.5);
    arts.forEach((article, j) => {
      const y = mid + span * (0.2 + j * 0.11);
      scatterData.push({ x: label, y });
      cacheScatterMeta.push(article);
    });
  });

  return scatterData;
}

function formatUsd(n) {
  if (n == null || Number.isNaN(n)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(n);
}

function formatVol(n) {
  if (n == null || Number.isNaN(n)) return "—";
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

/** Finnhub profile2: marketCapitalization is in millions USD */
function formatMarketCap(millions) {
  if (millions == null || millions === 0 || Number.isNaN(millions)) return "—";
  if (millions >= 1e6) return `$${(millions / 1e6).toFixed(2)}T`;
  if (millions >= 1e3) return `$${(millions / 1e3).toFixed(1)}B`;
  return `$${millions.toFixed(1)}M`;
}

function pickPe(metric) {
  if (!metric || typeof metric !== "object") return null;
  const m = metric.metric || metric;
  return (
    m.peBasicExclExtraTTM ??
    m.peNormalizedAnnual ??
    m.peAnnual ??
    m.peTTM ??
    null
  );
}

function newsDate(ts) {
  if (!ts) return "";
  const d = new Date(typeof ts === "number" ? ts * 1000 : ts);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function chartTimestamp(ts) {
  if (ts == null) return "Unknown time";
  const d = new Date(Number(ts) * 1000);
  if (Number.isNaN(d.getTime())) return "Unknown time";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return url.toString();
}

async function getStock() {
  const ticker = document.getElementById("ticker").value.trim().toUpperCase();
  if (!ticker) return;

  setLoading(true);
  clearError();

  try {
    const [quoteRes, candlesRes, newsRes] = await Promise.all([
      fetch(buildApiUrl("/api/quote", { symbol: ticker })),
      fetch(buildApiUrl("/api/candles", { symbol: ticker })),
      fetch(buildApiUrl("/api/news", { symbol: ticker })),
    ]);

    const [quoteData, candlesData, newsData] = await Promise.all([
      quoteRes.json(),
      candlesRes.json(),
      newsRes.json(),
    ]);

    if (!quoteRes.ok) throw new Error(quoteData.error || "Unable to load quote data");
    if (!candlesRes.ok) throw new Error(candlesData.error || "Unable to load candle data");
    if (!newsRes.ok) throw new Error(newsData.error || "Unable to load news");

    updatePrice(quoteData.c, quoteData.pc);
    updateChart(ticker, candlesData);
    updateNews(newsData);
  } catch (error) {
    showError(error.message || "Failed to load stock data");
  } finally {
    setLoading(false);
  }
}

function updatePrice(currentPrice, previousClose) {
  const priceEl = document.getElementById("price");
  const priceText = currentPrice != null ? `$${currentPrice.toFixed(2)}` : "—";
  priceEl.innerText = `Current Price: ${priceText}`;
}

function updateNews(newsItems) {
  const newsList = document.getElementById("newsList");
  newsList.innerHTML = "";

  if (!Array.isArray(newsItems) || newsItems.length === 0) {
    newsList.innerHTML = `<div class="newsCard">No news available for this ticker.</div>`;
    return;
  }

  newsItems.slice(0, 5).forEach((item) => {
    const div = document.createElement("div");
    div.className = "newsCard";
    const headline = item.headline || item.summary || "No headline";
    const source = item.source ? ` • ${item.source}` : "";
    const date = item.datetime ? ` (${new Date(item.datetime * 1000).toLocaleDateString()})` : "";
    div.innerText = `${headline}${source}${date}`;
    newsList.appendChild(div);
  });
}

function updateChart(ticker, candles) {
  const ctx = document.getElementById("stockChart").getContext("2d");
  const labels = Array.isArray(candles.t) ? candles.t.map((ts) => new Date(ts * 1000).toLocaleDateString()) : [];
  const prices = Array.isArray(candles.c) ? candles.c : [];

  if (kgScatter.length > 0) {
    datasets.push({
      type: "scatter",
      label: KG_SCATTER_LABEL,
      data: kgScatter,
      backgroundColor: "rgba(124, 58, 237, 0.92)",
      borderColor: "#fff",
      borderWidth: 2,
      pointRadius: denseMonth ? 5 : 7,
      // Keep hover tight; click still works because hit radius is reasonable.
      pointHoverRadius: denseMonth ? 6 : 7,
      pointHitRadius: denseMonth ? 10 : 12,
      order: 10,
    });
  }

  chart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets,
    },
    options: {
      responsive: true,
      // Keep hover behavior tight so tooltips don't "grab" a wide x-range.
      interaction: { mode: "nearest", intersect: true },
      hover: { mode: "nearest", intersect: true },
      elements: {
        point: {
          hoverRadius: 0,
          hoverBorderWidth: 0,
        },
        line: {
          hoverBorderWidth: 0,
        },
      },
      onHover(e) {
        lastChartPointerEventType = e?.type || "";
      },
      onClick(event, elements, c) {
        lastChartPointerEventType = event?.type || "click";
        const hit = Array.isArray(elements) && elements.length > 0 ? elements[0] : null;
        const dsLabel =
          hit && c && c.data && c.data.datasets && c.data.datasets[hit.datasetIndex]
            ? c.data.datasets[hit.datasetIndex].label
            : "";

        // Only "arm" KG tooltip when a KG dot was actually clicked/tapped.
        kgTooltipArmed = dsLabel === KG_SCATTER_LABEL;
        kgTooltipArmedKey = kgTooltipArmed && hit ? { datasetIndex: hit.datasetIndex, dataIndex: hit.index } : null;

        // Clicking empty space should dismiss tooltip/active elements and disarm KG tooltip.
        if (!hit) {
          try {
            c.setActiveElements([]);
            if (c.tooltip) c.tooltip.setActiveElements([], { x: 0, y: 0 });
            c.update();
          } catch {}
          return;
        }

        // For KG dots, force the tooltip to show on click (since hover is disabled for KG by filter()).
        if (kgTooltipArmed) {
          try {
            c.setActiveElements(elements);
            if (c.tooltip) c.tooltip.setActiveElements(elements, { x: event.x, y: event.y });
            c.update();
          } catch {}
        }
      },
      plugins: {
        legend: {
          display: true,
          position: "bottom",
          labels: {
            boxWidth: 12,
            padding: 16,
            font: { size: 12, family: "Inter, sans-serif" },
            color: "#475569",
          },
        },
        tooltip: {
          // Default: hover tooltips should be precise.
          mode: "nearest",
          intersect: true,
          callbacks: {
            title(items) {
              if (!items || items.length === 0) return "";
              const first = items[0];
              // Scatter dots have their own indexing, so `dataIndex` does NOT line up with candle timestamps.
              // For KG dots, show the article's published date (or the x-label) instead of a candle timestamp.
              if (first.dataset && first.dataset.label === KG_SCATTER_LABEL) {
                const meta = cacheScatterMeta[first.dataIndex];
                const pd = meta && meta.published_date ? String(meta.published_date).slice(0, 10) : "";
                if (pd) return `Published: ${pd}`;
                const rawX = first.raw && first.raw.x != null ? String(first.raw.x) : "";
                return rawX || "Published";
              }
              return chartTimestamp(timestamps[first.dataIndex]);
            },
            label(ctx) {
              if (ctx.dataset.label === KG_SCATTER_LABEL) {
                const meta = cacheScatterMeta[ctx.dataIndex];
                if (!meta) return "";
                const h = (meta.headline || "—").slice(0, 140);
                const s =
                  meta.sentiment != null && !Number.isNaN(Number(meta.sentiment))
                    ? ` · sentiment ${Number(meta.sentiment).toFixed(2)}`
                    : "";
                return `${h}${s}`;
              }
              const v = ctx.parsed.y;
              return `${ctx.dataset.label}: ${formatUsd(v)}`;
            },
            afterLabel(ctx) {
              if (ctx.dataset.label === KG_SCATTER_LABEL) {
                const meta = cacheScatterMeta[ctx.dataIndex];
                return meta && meta.url ? String(meta.url) : "";
              }
              return "";
            },
          },
          // Only show KG dot details on click/tap; allow normal hover tooltips for other datasets.
          filter(item) {
            if (item?.dataset?.label !== KG_SCATTER_LABEL) return true;
            // Click-to-open: allow ONLY the specific dot that was clicked to show details.
            // This remains true even after mousemove events, until the user clicks elsewhere.
            if (!kgTooltipArmed || !kgTooltipArmedKey) return false;
            return item.datasetIndex === kgTooltipArmedKey.datasetIndex && item.dataIndex === kgTooltipArmedKey.dataIndex;
          },
        },
      },
      scales: {
        x: {
          title: {
            display: true,
            text: xTitle,
            color: "#64748b",
            font: { size: 12, weight: "500" },
          },
          grid: { display: false },
          ticks: {
            autoSkip: denseMonth,
            maxTicksLimit: denseMonth ? 16 : 24,
            autoSkipPadding: 4,
            maxRotation: denseMonth ? 50 : 40,
            minRotation: denseMonth ? 40 : 25,
          },
        },
        y: {
          title: {
            display: true,
            text: "Amount (USD)",
            color: "#64748b",
            font: { size: 12, weight: "500" },
          },
          grid: { color: "#e5e7eb" },
          ticks: {
            color: "#64748b",
            callback(value) {
              return formatUsd(value);
            },
          },
        },
      },
    },
  });
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("rangeWeek").addEventListener("click", () => setChartRange("week"));
  document.getElementById("rangeMonth").addEventListener("click", () => setChartRange("month"));
});

// --- Simple view switching for nav (home / markets) ---
function showView(view) {
  const home = document.getElementById("homeSection");
  const markets = document.getElementById("marketsSection");
  const research = document.getElementById("researchSection");
  const navLinks = document.querySelectorAll(".nav-link");
  navLinks.forEach((n) => n.classList.remove("active"));
  if (view === "markets") {
    if (home) home.style.display = "none";
    if (research) research.style.display = "none";
    if (markets) markets.style.display = "block";
    const ln = document.getElementById("navMarkets"); if (ln) ln.classList.add("active");
    fetchMarkets();
  } else if (view === "research") {
    if (home) home.style.display = "none";
    if (markets) markets.style.display = "none";
    if (research) research.style.display = "block";
    const ln = document.getElementById("navResearch"); if (ln) ln.classList.add("active");
    loadResearch();
  } else {
    if (research) research.style.display = "none";
    if (markets) markets.style.display = "none";
    if (home) home.style.display = "block";
    const ln = document.getElementById("navHome"); if (ln) ln.classList.add("active");
  }
}

async function fetchMarkets() {
  try {
    const [indicesRes, moversRes, sentimentRes] = await Promise.all([
      fetch("/api/indices"),
      fetch("/api/movers"),
      fetch("/api/market-sentiment"),
    ]);
    const indices = indicesRes.ok ? (await indicesRes.json()).indices || [] : [];
    const movers = moversRes.ok ? await moversRes.json() : { gainers: [], losers: [] };
    const sentiment = sentimentRes.ok ? await sentimentRes.json() : { sentiment: "unknown", score: 0 };
    renderIndices(indices);
    renderMovers(movers);
    renderSentiment(sentiment);
  } catch (e) {
    document.getElementById("indicesList").innerText = "Could not load indices";
    document.getElementById("moversList").innerText = "Could not load movers";
    document.getElementById("marketSentiment").innerText = "Could not load sentiment";
    console.error(e);
  }
}

function renderIndices(list) {
  const el = document.getElementById("indicesList");
  if (!el) return;
  el.innerHTML = "";
  if (!Array.isArray(list) || list.length === 0) {
    el.innerText = "No indices available";
    return;
  }
  list.forEach((it) => {
    const row = document.createElement("div");
    row.className = "info-row";
    const label = document.createElement("span"); label.className = "info-label"; label.textContent = it.symbol;
    const value = document.createElement("span"); value.className = "info-value"; value.textContent = it.price != null ? formatUsd(it.price) : "—";
    row.appendChild(label); row.appendChild(value);
    el.appendChild(row);
  });
}

function renderMovers(payload) {
  const el = document.getElementById("moversList");
  if (!el) return;
  el.innerHTML = "";
  const gainers = payload.gainers || [];
  const losers = payload.losers || [];
  const makeList = (title, arr) => {
    const h = document.createElement("h4"); h.textContent = title; h.style.margin = "8px 0"; h.style.color = "#00ffcc";
    el.appendChild(h);
    arr.forEach((it) => {
      const row = document.createElement("div"); row.className = "info-row";
      const label = document.createElement("span"); label.className = "info-label"; label.textContent = it.symbol;
      const value = document.createElement("span"); value.className = "info-value"; value.textContent = it.changePercent != null ? `${it.changePercent.toFixed(2)}%` : "—";
      if (it.changePercent > 0) value.classList.add("positive"); else if (it.changePercent < 0) value.classList.add("negative");
      row.appendChild(label); row.appendChild(value);
      el.appendChild(row);
    });
  };
  makeList("Gainers", gainers);
  makeList("Losers", losers);
}

function renderSentiment(s) {
  const el = document.getElementById("marketSentiment");
  if (!el) return;
  el.innerHTML = "";
  const p = document.createElement("p"); p.style.margin = "0"; p.textContent = `Sentiment: ${s.sentiment || 'unknown'} (${(s.score || 0).toFixed(2)})`;
  el.appendChild(p);
}

// ensure default view is home
document.addEventListener("DOMContentLoaded", () => {
  showView('home');
});

let researchChart = null;
let researchRangeMode = "week";
let researchTicker = "";
let researchCache = null;

function setResearchTicker(ticker) {
  const input = document.getElementById("researchTicker");
  if (!input) return;
  input.value = String(ticker || "").trim().toUpperCase();
}

function setResearchRange(mode) {
  if (mode !== "week" && mode !== "month") return;
  researchRangeMode = mode;
  const weekBtn = document.getElementById("researchRangeWeek");
  const monthBtn = document.getElementById("researchRangeMonth");
  if (weekBtn) weekBtn.classList.toggle("active", mode === "week");
  if (monthBtn) monthBtn.classList.toggle("active", mode === "month");
  if (researchCache) {
    renderResearchChart(researchCache);
  }
}

function trendLabel(candles) {
  if (!candles || !Array.isArray(candles.c) || candles.c.length < 2) return "Neutral";
  const first = candles.c[0];
  const last = candles.c[candles.c.length - 1];
  if (last > first) return "Bullish";
  if (last < first) return "Bearish";
  return "Neutral";
}

function researchInsight(candles, pe, price, quote) {
  const trend = trendLabel(candles);
  const change = quote && quote.dp != null ? quote.dp : 0;
  const valuation = pe != null && !Number.isNaN(Number(pe))
    ? Number(pe) > 30
      ? "Valuation looks stretched relative to earnings."
      : Number(pe) > 15
        ? "Valuation is in a middle zone, worth a closer look."
        : "Valuation looks relatively modest."
    : "Valuation data is unavailable right now.";
  const momentum = change > 0
    ? "Momentum is positive on the latest quote."
    : change < 0
      ? "Momentum is negative on the latest quote."
      : "Latest quote is flat.";
  const trendNote = trend === "Bullish"
    ? "The recent candle trend is leaning bullish."
    : trend === "Bearish"
      ? "The recent candle trend is leaning bearish."
      : "Recent candles are balanced.";
  return { trend, valuation, momentum, trendNote };
}

function sliceResearchCandles(candles) {
  return sliceByChartRange(candles, researchRangeMode);
}

function renderResearchChart(bundle) {
  const subtitle = document.getElementById("researchChartSubtitle");
  const chartEl = document.getElementById("researchChart");
  if (!bundle || !chartEl) return;
  const slice = sliceResearchCandles(bundle.candles);
  if (subtitle) {
    subtitle.textContent = chartRangeSubtitle(slice, researchRangeMode);
  }

  const ctx = chartEl.getContext("2d");
  const highs = [];
  const lows = [];
  const labels = [];
  const timestamps = [];
  if (slice && slice.t && slice.start != null) {
    for (let i = slice.start; i < slice.n; i++) {
      labels.push(new Date(slice.t[i] * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" }));
      highs.push(slice.h[i]);
      lows.push(slice.l[i]);
      timestamps.push(slice.t[i]);
    }
  }

  if (labels.length === 0 && bundle.quote) {
    labels.push("Latest");
    highs.push(bundle.quote.h || bundle.quote.c || 0);
    lows.push(bundle.quote.l || bundle.quote.c || 0);
    timestamps.push(bundle.quote.t || Math.floor(Date.now() / 1000));
  }

  const trends = highs.map((hi, i) => (Number(hi) + Number(lows[i])) / 2);
  try {
    if (researchChart) researchChart.destroy();
  } catch (err) {
    console.warn(err);
  }

  researchChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: `${ticker} Price`,
          data: prices,
          borderColor: "#4f46e5",
          backgroundColor: "rgba(79,70,229,0.15)",
          tension: 0.4,
          fill: true,
          pointRadius: 4,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
      },
      scales: {
        x: { grid: { display: false } },
        y: { grid: { color: "#e5e7eb" } },
      },
    },
  });
}

function setLoading(isLoading) {
  const button = document.querySelector("button[onclick=\"getStock()\"]");
  if (!button) return;
  button.disabled = isLoading;
  button.innerText = isLoading ? "Loading..." : "Search";
}

function showError(message) {
  const newsList = document.getElementById("newsList");
  newsList.innerHTML = `<div class="newsCard">Error: ${message}</div>`;
}

function clearError() {
  const newsList = document.getElementById("newsList");
  if (newsList) newsList.innerHTML = "";
}

// NYT Headlines functions
async function getNytHeadlines() {
  const nytList = document.getElementById("nytList");
  nytList.innerHTML = '<div class="newsCard">Loading NYT headlines...</div>';

  try {
    const res = await fetch(buildApiUrl("/api/nyt-headlines"));
    if (!res.ok) throw new Error("Failed to load NYT headlines");
    const headlines = await res.json();
    updateNytHeadlines(headlines);
  } catch (error) {
    nytList.innerHTML = `<div class="newsCard">Error: ${error.message}</div>`;
  }
}

function updateNytHeadlines(headlines) {
  const nytList = document.getElementById("nytList");
  nytList.innerHTML = "";

  if (!Array.isArray(headlines) || headlines.length === 0) {
    nytList.innerHTML = '<div class="newsCard">No NYT headlines available.</div>';
    return;
  }

  headlines.slice(0, 5).forEach((item) => {
    const div = document.createElement("div");
    div.className = "nyt-card";
    
    // Determine sentiment class
    const sentiment = item.sentiment || 0;
    if (sentiment > 0.05) div.classList.add("positive");
    else if (sentiment < -0.05) div.classList.add("negative");

    // Sentiment label
    const sentimentLabel = sentiment > 0.05 ? "POSITIVE" : sentiment < -0.05 ? "NEGATIVE" : "NEUTRAL";
    div.innerHTML = `
      <div class="nyt-sentiment">${sentimentLabel} (${sentiment.toFixed(2)})</div>
      <div class="news-title">${item.headline}</div>
      <div class="nyt-entities">
        ${item.entities ? item.entities.map(e => `<span>${e.text} (${e.label})</span>`).join("") : "No entities"}
      </div>
      <p class="news-date">${item.published_date}</p>
    `;
    nytList.appendChild(div);
  });
}

// enhance fetchMarkets to use expanded renderers
async function fetchMarkets(){
  try{
    const [indicesRes, moversRes, sentimentRes] = await Promise.all([
      fetch('/api/indices'), fetch('/api/movers'), fetch('/api/market-sentiment')
    ]);
    const indices = indicesRes.ok? (await indicesRes.json()).indices || [] : [];
    const movers = moversRes.ok? await moversRes.json() : {gainers:[], losers:[]};
    const sentiment = sentimentRes.ok? await sentimentRes.json() : {sentiment:'unknown', score:0};
    
    // Render all visual elements
    updateMarketStatus();
    updateVIX();
    updateMarketBreadth();
    renderSectorHeatmap();
    
    await renderIndicesExpanded(indices);
    await renderMoversExpanded(movers);
    renderSentiment(sentiment);
  }catch(e){ console.error('fetchMarkets expanded failed', e); document.getElementById('indicesGrid').innerText='Could not load indices'; document.getElementById('moversTable').innerText='Could not load movers'; }
}

// Expose handlers used by inline HTML attributes (onclick/onchange).
// This avoids "ReferenceError: <fn> is not defined" if the script scope changes.
(function exposeInlineHandlers() {
  const fns = [
    "getStock",
    "showView",
    "onTickerSelect",
    "loadResearch",
    "setResearchTicker",
    "setResearchRange",
  ];
  for (const name of fns) {
    try {
      const fn = typeof globalThis[name] === "function" ? globalThis[name] : (typeof eval(name) === "function" ? eval(name) : null);
      if (typeof fn === "function") globalThis[name] = fn;
    } catch {
      // ignore missing names
    }
  }
})();
