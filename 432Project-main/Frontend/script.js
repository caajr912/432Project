let chart;

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

function candleRowDate(ts) {
  return new Date(ts * 1000).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function syncSelectToTicker(ticker) {
  const sel = document.getElementById("tickerSelect");
  const match = [...sel.options].some((o) => o.value === ticker);
  sel.value = match ? ticker : "";
}

function onTickerSelect() {
  const sel = document.getElementById("tickerSelect");
  const v = sel.value.trim().toUpperCase();
  if (!v) return;
  document.getElementById("ticker").value = v;
  getStock();
}

/**
 * Daily bars, `t` ascending. Week = last 7 sessions. Month = all sessions in the last 30 calendar days.
 */
function sliceByChartRange(candles, mode) {
  if (!candles || !Array.isArray(candles.t) || candles.t.length === 0) return null;
  if (candles.s === "no_data") return null;
  if (candles.s != null && candles.s !== "ok") return null;
  const { t, o, h, l, c, v } = candles;
  const n = t.length;

  if (mode === "week") {
    const len = Math.min(7, n);
    const start = n - len;
    return { t, o, h, l, c, v, start, n };
  }

  const cutoff = Math.floor(Date.now() / 1000) - 30 * 86400;
  let start = 0;
  for (let i = 0; i < n; i++) {
    if (t[i] >= cutoff) {
      start = i;
      break;
    }
  }
  if (start === 0 && t[n - 1] < cutoff) {
    start = Math.max(0, n - 23);
  }
  return { t, o, h, l, c, v, start, n };
}

function renderDataTable(slice) {
  const tbody = document.getElementById("weekTableBody");
  tbody.innerHTML = "";
  if (!slice) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 6;
    td.textContent = "No daily candle data for this symbol.";
    td.style.textAlign = "left";
    td.style.color = "#64748b";
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  const { t, o, h, l, c, v, start, n } = slice;
  for (let i = start; i < n; i++) {
    const tr = document.createElement("tr");
    const cells = [
      candleRowDate(t[i]),
      formatUsd(o[i]),
      formatUsd(h[i]),
      formatUsd(l[i]),
      formatUsd(c[i]),
      formatVol(v[i]),
    ];
    cells.forEach((text, idx) => {
      const td = document.createElement("td");
      td.textContent = text;
      if (idx === 0) td.style.fontWeight = "500";
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
}

function chartRangeSubtitle(slice, mode) {
  if (!slice || slice.start >= slice.n) {
    return mode === "month"
      ? "Past month — high (green), low (red), trend avg (blue)"
      : "Past week — high (green), low (red), trend avg (blue)";
  }
  const t0 = slice.t[slice.start];
  const t1 = slice.t[slice.n - 1];
  const a = new Date(t0 * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const b = new Date(t1 * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const label = mode === "month" ? "Past month" : "Past week";
  return `${label} (${a} – ${b}) — high, low & trend (USD)`;
}

function updateDataTableHeading(slice, mode) {
  const el = document.getElementById("dataTableHeading");
  if (!slice || slice.start >= slice.n) {
    el.textContent = mode === "month" ? "Daily OHLC (1 month)" : "Daily OHLC (1 week)";
    return;
  }
  const rows = slice.n - slice.start;
  el.textContent =
    mode === "month"
      ? `Daily OHLC — ${rows} trading days (last ~30 days)`
      : `Daily OHLC — ${rows} trading days (1 week)`;
}

function setChartRange(mode) {
  if (mode !== "week" && mode !== "month") return;
  chartRangeMode = mode;
  document.getElementById("rangeWeek").classList.toggle("active", mode === "week");
  document.getElementById("rangeMonth").classList.toggle("active", mode === "month");
  if (cacheTicker && cacheQuote) applyChartAndTable();
}

function applyChartAndTable() {
  const ticker = cacheTicker;
  const quote = cacheQuote;
  const candles = cacheCandles;
  if (!ticker || !quote) return;

  const slice = sliceByChartRange(candles, chartRangeMode);
  renderDataTable(slice);
  updateDataTableHeading(slice, chartRangeMode);

  const price = quote.c;
  let labels = [];
  const highs = [];
  const lows = [];
  if (slice) {
    const { t, h, l, start, n } = slice;
    for (let i = start; i < n; i++) {
      if (chartRangeMode === "week") {
        const dayNum = i - start + 1;
        const dateStr = new Date(t[i] * 1000).toLocaleDateString("en-US", {
          weekday: "short",
          month: "numeric",
          day: "numeric",
        });
        labels.push(`Day ${dayNum} (${dateStr})`);
      } else {
        labels.push(
          new Date(t[i] * 1000).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
          })
        );
      }
      highs.push(h[i]);
      lows.push(l[i]);
    }
  }
  if (labels.length === 0) {
    labels = ["Day 1"];
    const hVal = quote.h != null ? quote.h : price;
    const lVal = quote.l != null ? quote.l : price;
    highs.push(hVal != null ? hVal : 0);
    lows.push(lVal != null ? lVal : 0);
  }

  const trends = highs.map((hi, i) => (Number(hi) + Number(lows[i])) / 2);

  const kgScatter = buildKgScatterPoints(slice, labels, highs, lows, cacheKgArticles);

  let sub = chartRangeSubtitle(slice, chartRangeMode);
  if (kgScatter.length > 0) {
    sub += ` — purple dots = Neo4j-linked articles (${kgScatter.length} in range)`;
  } else if (cacheKgLoadError) {
    sub += ` — ${cacheKgLoadError.slice(0, 140)}`;
  }
  document.getElementById("weekChartSubtitle").textContent = sub;

  const ctx = document.getElementById("stockChart").getContext("2d");
  if (chart) chart.destroy();

  const denseMonth = chartRangeMode === "month" && labels.length > 14;
  const xTitle =
    chartRangeMode === "month"
      ? "Trading days (last ~30 calendar days)"
      : "Trading days (1 week, 7 sessions)";

  const datasets = [
        {
          label: "Daily high (USD)",
          data: highs,
          borderColor: "#16a34a",
          backgroundColor: "rgba(22,163,74,0.08)",
          tension: 0.25,
          fill: false,
          pointRadius: denseMonth ? 3 : 5,
          pointBackgroundColor: "#16a34a",
          pointBorderColor: "#fff",
          pointBorderWidth: 2,
          borderWidth: 2,
        },
        {
          label: "Daily low (USD)",
          data: lows,
          borderColor: "#dc2626",
          backgroundColor: "rgba(220,38,38,0.08)",
          tension: 0.25,
          fill: false,
          pointRadius: denseMonth ? 3 : 5,
          pointBackgroundColor: "#dc2626",
          pointBorderColor: "#fff",
          pointBorderWidth: 2,
          borderWidth: 2,
        },
        {
          label: "Trend (avg of high & low)",
          data: trends,
          borderColor: "#2563eb",
          backgroundColor: "rgba(37,99,235,0.06)",
          tension: 0.25,
          fill: false,
          pointRadius: 0,
          pointHoverRadius: 0,
          pointHitRadius: 0,
          pointBackgroundColor: "transparent",
          pointBorderWidth: 0,
          borderWidth: 2,
        },
  ];

  if (kgScatter.length > 0) {
    datasets.push({
      type: "scatter",
      label: KG_SCATTER_LABEL,
      data: kgScatter,
      backgroundColor: "rgba(124, 58, 237, 0.92)",
      borderColor: "#fff",
      borderWidth: 2,
      pointRadius: denseMonth ? 5 : 7,
      pointHoverRadius: 10,
      pointHitRadius: 16,
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
      interaction: { mode: "nearest", intersect: true },
      hover: { mode: "nearest", intersect: true },
      onClick(event, elements, c) {
        if (elements.length === 0) {
          c.setActiveElements([]);
          if (c.tooltip) c.tooltip.setActiveElements([], { x: 0, y: 0 });
          c.update();
        }
      },
      elements: {
        point: {
          hoverRadius: 0,
          hoverBorderWidth: 0,
        },
        line: {
          hoverBorderWidth: 0,
        },
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
          mode: "nearest",
          intersect: true,
          events: ["click", "touchstart"],
          callbacks: {
            title(items) {
              if (!items.length) return "";
              const raw = items[0].raw;
              if (raw && raw.x != null) return String(raw.x);
              const lab = items[0].chart?.data?.labels;
              const di = items[0].dataIndex;
              if (lab && lab[di] != null) return String(lab[di]);
              return "";
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

async function getStock() {
  const raw = document.getElementById("ticker").value.trim().toUpperCase();
  const ticker = raw.replace(/[^A-Z0-9.-]/g, "");
  if (!ticker) {
    document.getElementById("price").innerText = "Enter a symbol";
    return;
  }

  document.getElementById("price").innerText = "Loading…";
  document.getElementById("weekChartSubtitle").textContent = "Loading…";
  document.getElementById("weekTableBody").innerHTML = "";

  const base = "";
  const q = (path) => `${base}${path}?symbol=${encodeURIComponent(ticker)}`;

  try {
    const [quoteRes, candleRes, newsRes, profileRes, metricRes, kgRes] = await Promise.all([
      fetch(q("/api/quote")),
      fetch(q("/api/candles")),
      fetch(q("/api/news")),
      fetch(q("/api/profile")),
      fetch(q("/api/metric")),
      fetch(q("/api/kg/chart-articles")),
    ]);

    const quote = await quoteRes.json();
    if (!quoteRes.ok) throw new Error(quote.error || quote.message || "Quote failed");

    const candles = candleRes.ok ? await candleRes.json() : null;
    const news = newsRes.ok ? await newsRes.json() : [];
    const profile = profileRes.ok ? await profileRes.json() : null;
    const metricPayload = metricRes.ok ? await metricRes.json() : null;

    let kgRaw = null;
    try {
      kgRaw = await kgRes.json();
    } catch {
      kgRaw = {};
    }
    cacheKgArticles = Array.isArray(kgRaw.articles) ? kgRaw.articles : [];
    cacheKgLoadError = "";
    if (!kgRes.ok) {
      cacheKgLoadError =
        kgRaw && kgRaw.error != null
          ? String(kgRaw.error)
          : `Could not reach KG API (HTTP ${kgRes.status}). Start FastAPI: uvicorn api.main:app --host 127.0.0.1 --port 8000`;
    }

    const price = quote.c;
    document.getElementById("price").innerText =
      price != null ? formatUsd(price) : "—";

    document.getElementById("marketCap").innerText = formatMarketCap(
      profile && profile.marketCapitalization
    );

    const pe = pickPe(metricPayload);
    document.getElementById("peRatio").innerText =
      pe != null && !Number.isNaN(Number(pe)) ? Number(pe).toFixed(2) : "—";

    document.getElementById("techLow").innerText = formatUsd(quote.l);
    document.getElementById("techHigh").innerText = formatUsd(quote.h);

    const newsList = document.getElementById("newsList");
    newsList.innerHTML = "";
    const items = Array.isArray(news) ? news.slice(0, 8) : [];
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "newsCard";
      empty.innerHTML = "<p class=\"news-title\">No recent news</p>";
      newsList.appendChild(empty);
    } else {
      items.forEach((article) => {
        const div = document.createElement("div");
        div.className = "newsCard";
        const title = document.createElement("p");
        title.className = "news-title";
        title.textContent = article.headline || article.summary || "—";
        const dateEl = document.createElement("p");
        dateEl.className = "news-date";
        dateEl.textContent = newsDate(article.datetime);
        div.appendChild(title);
        div.appendChild(dateEl);
        newsList.appendChild(div);
      });
    }

    cacheTicker = ticker;
    cacheQuote = quote;
    cacheCandles = candles;
    applyChartAndTable();
    syncSelectToTicker(ticker);
  } catch (e) {
    cacheTicker = "";
    cacheQuote = null;
    cacheCandles = null;
    cacheKgArticles = [];
    cacheKgLoadError = "";
    cacheScatterMeta = [];
    document.getElementById("price").innerText = e.message || "Request failed";
    document.getElementById("weekChartSubtitle").textContent =
      "High (green), low (red), trend (blue) — pick 1 week or 1 month after searching";
    document.getElementById("weekTableBody").innerHTML = "";
    if (chart) {
      chart.destroy();
      chart = null;
    }
    console.error(e);
  }
}
