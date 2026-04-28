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
  const timestamps = [];
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
      timestamps.push(t[i]);
    }
  }
  if (labels.length === 0) {
    labels = ["Day 1"];
    const hVal = quote.h != null ? quote.h : price;
    const lVal = quote.l != null ? quote.l : price;
    highs.push(hVal != null ? hVal : 0);
    lows.push(lVal != null ? lVal : 0);
    timestamps.push(quote.t || Math.floor(Date.now() / 1000));
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
          pointHoverRadius: denseMonth ? 3 : 5,
          pointHitRadius: denseMonth ? 8 : 10,
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
          pointHoverRadius: denseMonth ? 3 : 5,
          pointHitRadius: denseMonth ? 8 : 10,
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
            // Force an immediate render on click (some Chart.js builds otherwise wait for a move event).
            if (c.tooltip && typeof c.tooltip.update === "function") c.tooltip.update(true);
            c.update();
            if (typeof c.draw === "function") c.draw();
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
          // Ensure click immediately triggers tooltip evaluation/render.
          events: ["mousemove", "mouseout", "click", "touchstart", "touchmove"],
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
        { label: "High", data: highs, borderColor: "#00ffcc", backgroundColor: "rgba(0,255,204,0.08)", tension: 0.35, pointRadius: 0, borderWidth: 2 },
        { label: "Low", data: lows, borderColor: "#ff0044", backgroundColor: "rgba(255,0,68,0.05)", tension: 0.35, pointRadius: 0, borderWidth: 2 },
        { label: "Trend", data: trends, borderColor: "#7cc7ff", backgroundColor: "rgba(124,199,255,0.05)", tension: 0.35, pointRadius: 0, borderWidth: 2 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: true, labels: { color: "#c9fff0" } },
        tooltip: {
          intersect: false,
          callbacks: {
            title(items) {
              if (!items || items.length === 0) return "";
              return chartTimestamp(timestamps[items[0].dataIndex]);
            },
            label(ctx) {
              return `${ctx.dataset.label}: ${formatUsd(ctx.parsed.y)}`;
            },
          },
        },
      },
      scales: {
        x: { ticks: { color: "#64748b" }, grid: { color: "rgba(0,255,204,0.06)" } },
        y: {
          ticks: { color: "#64748b", callback(value) { return formatUsd(value); } },
          grid: { color: "rgba(0,255,204,0.06)" },
        },
      },
    },
  });

  const priceEl = document.getElementById("researchPrice");
  const changeEl = document.getElementById("researchChange");
  const capEl = document.getElementById("researchMarketCap");
  const peEl = document.getElementById("researchPe");
  const volEl = document.getElementById("researchVolume");
  const rangeEl = document.getElementById("researchRange");
  const highEl = document.getElementById("researchHigh");
  const lowEl = document.getElementById("researchLow");
  const trendEl = document.getElementById("researchTrend");
  const signalEl = document.getElementById("researchSignal");
  const candles = bundle.candles;
  const quote = bundle.quote || {};
  const profile = bundle.profile || {};
  const metric = bundle.metric || {};
  const pe = pickPe(metric);
  const insight = researchInsight(candles, pe, quote.c, quote);
  const dayChange = quote.dp != null ? quote.dp : null;

  if (priceEl) priceEl.textContent = quote.c != null ? formatUsd(quote.c) : "—";
  if (changeEl) changeEl.textContent = dayChange != null ? `${dayChange.toFixed(2)}%` : "—";
  if (changeEl) changeEl.className = `research-stat-value ${dayChange >= 0 ? "positive" : "negative"}`;
  if (capEl) capEl.textContent = formatMarketCap(profile.marketCapitalization);
  if (peEl) peEl.textContent = pe != null && !Number.isNaN(Number(pe)) ? Number(pe).toFixed(2) : "—";
  if (volEl) volEl.textContent = formatVol(quote.v);
  if (rangeEl) {
    const hi = quote.h != null ? formatUsd(quote.h) : "—";
    const lo = quote.l != null ? formatUsd(quote.l) : "—";
    rangeEl.textContent = `${lo} / ${hi}`;
  }
  if (highEl) highEl.textContent = quote.h != null ? formatUsd(quote.h) : "—";
  if (lowEl) lowEl.textContent = quote.l != null ? formatUsd(quote.l) : "—";
  if (trendEl) trendEl.textContent = insight.trend;
  if (signalEl) signalEl.textContent = insight.momentum;
}

function renderResearchThesis(bundle) {
  const el = document.getElementById("researchThesis");
  if (!el) return;
  const pe = pickPe(bundle.metric);
  const insight = researchInsight(bundle.candles, pe, bundle.quote?.c, bundle.quote);
  const newsCount = Array.isArray(bundle.news) ? bundle.news.length : 0;
  const newsNote = newsCount > 0
    ? `${newsCount} recent headlines were found for this ticker.`
    : "Stock-specific headlines were thin, so the page will fall back to market headlines.";
  el.innerHTML = `
    <div class="research-thesis-item">
      <span class="research-thesis-pill bullish">Bull case</span>
      <p>${insight.trendNote}</p>
    </div>
    <div class="research-thesis-item">
      <span class="research-thesis-pill bearish">Bear case</span>
      <p>${insight.valuation}</p>
    </div>
    <div class="research-thesis-item">
      <span class="research-thesis-pill neutral">Watch list</span>
      <p>${insight.momentum} ${newsNote}</p>
    </div>
  `;
}

function renderResearchNews(items, fallbackItems) {
  const el = document.getElementById("researchNewsList");
  if (!el) return;
  const list = Array.isArray(items) && items.length > 0 ? items.slice(0, 6) : (Array.isArray(fallbackItems) ? fallbackItems.slice(0, 6) : []);
  el.innerHTML = "";
  if (list.length === 0) {
    const empty = document.createElement("div");
    empty.className = "newsCard";
    empty.innerHTML = "<p class=\"news-title\">No recent headlines available</p>";
    el.appendChild(empty);
    return;
  }

  list.forEach((article) => {
    const div = document.createElement("div");
    div.className = "newsCard research-news-card";
    const title = document.createElement("p");
    title.className = "news-title";
    title.textContent = article.headline || article.summary || article.title || "—";
    const meta = document.createElement("p");
    meta.className = "news-date";
    const source = article.source ? ` • ${article.source}` : "";
    const sentiment = article.sentiment != null ? ` • ${Number(article.sentiment).toFixed(2)}` : "";
    meta.textContent = `${newsDate(article.datetime || article.published_date)}${source}${sentiment}`.trim();
    div.appendChild(title);
    div.appendChild(meta);
    el.appendChild(div);
  });
}

async function renderResearchCompare(currentTicker) {
  const el = document.getElementById("researchCompareList");
  if (!el) return;
  const peers = [currentTicker, "MSFT", "NVDA", "GOOGL"].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).slice(0, 4);
  el.innerHTML = "<div class='research-compare-head'><span>Ticker</span><span>Price</span><span>Trend</span></div>";

  for (const symbol of peers) {
    const row = document.createElement("div");
    row.className = "research-compare-row";
    row.innerHTML = `
      <div class="research-compare-symbol">${symbol}</div>
      <div class="research-compare-price">Loading…</div>
      <div class="research-compare-trend">—</div>
      <div class="research-spark-wrap"><canvas id="researchSpark_${safeId(symbol)}" class="research-sparkline-canvas"></canvas></div>
    `;
    el.appendChild(row);

    try {
      const [quoteRes, candlesRes] = await Promise.all([
        fetch(`/api/quote?symbol=${encodeURIComponent(symbol)}`),
        fetch(`/api/candles?symbol=${encodeURIComponent(symbol)}`),
      ]);
      const quote = quoteRes.ok ? await quoteRes.json() : null;
      const candles = candlesRes.ok ? await candlesRes.json() : null;
      const priceCell = row.querySelector(".research-compare-price");
      const trendCell = row.querySelector(".research-compare-trend");
      if (priceCell) priceCell.textContent = quote && quote.c != null ? formatUsd(quote.c) : "—";
      if (trendCell) trendCell.textContent = trendLabel(candles);
      await createSparkline(`researchSpark_${safeId(symbol)}`, candles);
    } catch (err) {
      row.querySelector(".research-compare-price").textContent = "—";
      row.querySelector(".research-compare-trend").textContent = "Unavailable";
      console.warn("Research peer fetch failed", symbol, err);
    }
  }
}

async function loadResearch() {
  const input = document.getElementById("researchTicker");
  const raw = (input && input.value ? input.value : researchTicker || cacheTicker || "AAPL").trim().toUpperCase();
  const ticker = raw.replace(/[^A-Z0-9.-]/g, "");
  if (!ticker) return;

  researchTicker = ticker;
  if (input) input.value = ticker;

  const subtitle = document.getElementById("researchChartSubtitle");
  if (subtitle) subtitle.textContent = `Loading research for ${ticker}…`;

  try {
    const [quoteRes, candleRes, newsRes, profileRes, metricRes, nytRes] = await Promise.all([
      fetch(`/api/quote?symbol=${encodeURIComponent(ticker)}`),
      fetch(`/api/candles?symbol=${encodeURIComponent(ticker)}`),
      fetch(`/api/news?symbol=${encodeURIComponent(ticker)}`),
      fetch(`/api/profile?symbol=${encodeURIComponent(ticker)}`),
      fetch(`/api/metric?symbol=${encodeURIComponent(ticker)}`),
      fetch(`/api/nyt-headlines`),
    ]);

    let quote = null;
    try { quote = quoteRes.ok ? await quoteRes.json() : null; } catch (err) { quote = null; }
    const candles = candleRes.ok ? await candleRes.json() : null;
    const news = newsRes.ok ? await newsRes.json() : [];
    const profile = profileRes.ok ? await profileRes.json() : null;
    const metric = metricRes.ok ? await metricRes.json() : null;
    const nyt = nytRes.ok ? await nytRes.json() : [];

    researchCache = { ticker, quote, candles, news, profile, metric, nyt };
    renderResearchChart(researchCache);
    renderResearchThesis(researchCache);
    renderResearchNews(news, nyt);
    await renderResearchCompare(ticker);
  } catch (error) {
    console.error("Research load failed", error);
    if (subtitle) subtitle.textContent = "Unable to load research data right now.";
    const newsEl = document.getElementById("researchNewsList");
    const compareEl = document.getElementById("researchCompareList");
    if (newsEl) newsEl.innerHTML = "<div class='newsCard'><p class='news-title'>Research data failed to load.</p></div>";
    if (compareEl) compareEl.innerHTML = "<p style='margin:0;color:#4a7c59;'>Comparison data is unavailable.</p>";
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const researchInput = document.getElementById("researchTicker");
  if (researchInput) researchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadResearch();
  });
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

    // tolerate backend parts failing (e.g., missing FINNHUB key) — prefer rendering candles
    let quote = null;
    try {
      quote = await quoteRes.json();
    } catch (err) {
      quote = null;
    }
    if (!quoteRes.ok) {
      console.warn("Quote fetch failed", quote && (quote.error || quote.message));
      // provide a lightweight placeholder so charts/table can still render from candles
      quote = quote || { c: null, h: null, l: null };
    }

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


// --- Markets: mini-index charts and mover sparklines ---
const miniCharts = {};
const sparkCharts = {};

function safeId(sym){
  return String(sym || '').replace(/\^/g, '_').replace(/[^A-Za-z0-9_-]/g, '');
}

async function createMiniChart(canvasId, candles){
  const el = document.getElementById(canvasId);
  if (!el) return;
  const ctx = el.getContext('2d');
  try { if (miniCharts[canvasId]) miniCharts[canvasId].destroy(); } catch(e){}
  if (!candles || !Array.isArray(candles.t) || candles.t.length===0) {
    // show placeholder line using no data
    miniCharts[canvasId] = new Chart(ctx, { type:'line', data:{ labels:[''], datasets:[{ data:[0], borderColor:'#00ffcc', borderWidth:1, pointRadius:0 }]}, options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}}, scales:{x:{display:false}, y:{display:false}} }});
    return;
  }
  const closes = candles.c.slice(-30);
  const timestamps = candles.t.slice(-30);
  const labels = closes.map((_,i)=>i+1);
  miniCharts[canvasId] = new Chart(ctx, {
    type:'line',
    data:{ labels, datasets:[{ label:'close', data:closes, borderColor:'#00ffcc', backgroundColor:'rgba(0,255,204,0.06)', tension:0.3, fill:true, pointRadius:0, borderWidth:1.5 }]},
    options:{ responsive:true, maintainAspectRatio:false, interaction:{mode:'nearest', intersect:false}, plugins:{legend:{display:false}, tooltip:{intersect:false, callbacks:{title(items){ if(!items||items.length===0) return ''; return chartTimestamp(timestamps[items[0].dataIndex]); }, label(ctx){ return `Close: ${formatUsd(ctx.parsed.y)}`; }}}}, elements:{line:{tension:0.3}}, scales:{x:{display:false}, y:{display:false}} }
  });
}

async function createSparkline(canvasId, candles){
  const el = document.getElementById(canvasId);
  if (!el) return;
  const ctx = el.getContext('2d');
  try { if (sparkCharts[canvasId]) sparkCharts[canvasId].destroy(); } catch(e){}
  if (!candles || !Array.isArray(candles.t) || candles.t.length===0) {
    sparkCharts[canvasId] = new Chart(ctx, { type:'line', data:{ labels:[''], datasets:[{ data:[0], borderColor:'#00ffcc', borderWidth:1, pointRadius:0 }]}, options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}}, scales:{x:{display:false}, y:{display:false}} }});
    return;
  }
  const closes = candles.c.slice(-20);
  const timestamps = candles.t.slice(-20);
  const labels = closes.map((_,i)=>i+1);
  const col = closes[closes.length-1] >= closes[0] ? '#7ef3a0' : '#ff9a9a';
  sparkCharts[canvasId] = new Chart(ctx, { type:'line', data:{ labels, datasets:[{ data:closes, borderColor:col, borderWidth:1.5, pointRadius:0, fill:false }]}, options:{ responsive:true, maintainAspectRatio:false, interaction:{mode:'nearest', intersect:false}, plugins:{legend:{display:false}, tooltip:{intersect:false, callbacks:{title(items){ if(!items||items.length===0) return ''; return chartTimestamp(timestamps[items[0].dataIndex]); }, label(ctx){ return `Close: ${formatUsd(ctx.parsed.y)}`; }}}}, scales:{x:{display:false}, y:{display:false}} }});
}

async function renderIndicesExpanded(indices){
  const grid = document.getElementById('indicesGrid');
  if (!grid) return;
  grid.innerHTML = '';
  for (const idx of indices){
    const sym = idx.symbol;
    const idSafe = safeId(sym);
    const card = document.createElement('div'); card.className='index-card';
    card.innerHTML = `<div class="index-meta"><div><div class="index-symbol">${sym}</div><div class="index-price">${idx.price!=null?formatUsd(idx.price):'—'}</div></div><div class="index-change ${idx.change>=0? 'positive':'negative'}">${idx.change!=null?idx.change.toFixed(2):'—'} (${idx.changePercent!=null?idx.changePercent.toFixed(2)+'%':''})</div></div><canvas id="mini_${idSafe}" class="mini-canvas"></canvas>`;
    grid.appendChild(card);
    // fetch candles for mini chart
    (async ()=>{
      try{
        const r = await fetch(`/api/candles?symbol=${encodeURIComponent(sym)}`);
        const cj = r.ok? await r.json(): null;
        await createMiniChart(`mini_${idSafe}`, cj);
      }catch(e){ console.warn('mini chart fetch failed', sym, e); }
    })();
  }
}

async function renderMoversExpanded(payload){
  const el = document.getElementById('moversTable');
  if (!el) return;
  el.innerHTML = '';
  const gainers = (payload.gainers||[]).slice(0,5);
  const losers = (payload.losers||[]).slice(0,5);
  const makeSection = async (title, arr) => {
    const h = document.createElement('h4'); h.textContent = title; h.style.margin='6px 0'; h.style.color='#00ffcc'; el.appendChild(h);
    for (const it of arr){
      const idSafe = safeId(it.symbol);
      const row = document.createElement('div'); row.className='mover-row';
      row.innerHTML = `<div style="display:flex;gap:12px;align-items:center;"><div class="mover-symbol">${it.symbol}</div><div style='min-width:96px'><canvas id="spark_${idSafe}" class="sparkline-canvas"></canvas></div></div><div style="min-width:80px;text-align:right;">${it.changePercent!=null?it.changePercent.toFixed(2)+'%':'—'}</div>`;
      el.appendChild(row);
      (async ()=>{
        try{
          const r = await fetch(`/api/candles?symbol=${encodeURIComponent(it.symbol)}`);
          const cj = r.ok? await r.json(): null;
          await createSparkline(`spark_${idSafe}`, cj);
        }catch(e){ console.warn('spark fetch failed', it.symbol, e); }
      })();
    }
  };
  await makeSection('Gainers', gainers);
  await makeSection('Losers', losers);
}

// Update market status
function updateMarketStatus() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const getPart = (type) => {
    const part = parts.find((p) => p.type === type);
    return part ? part.value : '';
  };

  const weekdayMap = {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 0,
  };

  const day = weekdayMap[getPart('weekday')] ?? now.getDay();
  const hour = Number(getPart('hour') || now.getHours());
  const min = Number(getPart('minute') || now.getMinutes());
  const totalMin = hour * 60 + min;
  const openMin = 9 * 60 + 30; // 9:30 AM
  const closeMin = 16 * 60; // 4:00 PM
  const isWeekday = day >= 1 && day <= 5;
  const isOpen = isWeekday && totalMin >= openMin && totalMin < closeMin;
  
  const card = document.getElementById('marketHours');
  if (card) {
    const val = card.querySelector('.status-value');
    val.textContent = isOpen ? '🟢 Open' : '⭕ Closed';
    val.style.color = isOpen ? '#7ef3a0' : '#ff9a9a';
  }
}

// Update VIX (mock data with slight variation)
function updateVIX() {
  const baseVIX = 15.5;
  const vix = baseVIX + (Math.random() - 0.5) * 4;
  const card = document.getElementById('vixCard');
  if (card) {
    const val = card.querySelector('.status-value');
    val.textContent = vix.toFixed(1);
    if (vix < 15) val.style.color = '#7ef3a0';
    else if (vix < 20) val.style.color = '#00ffcc';
    else val.style.color = '#ff9a9a';
  }
}

// Update market breadth
function updateMarketBreadth() {
  const advancers = 2147;
  const decliners = 1283;
  const total = advancers + decliners;
  const advPercent = (advancers / total) * 100;
  const declPercent = (decliners / total) * 100;
  
  const container = document.getElementById('marketBreadth');
  if (container) {
    const advFill = container.querySelector('.breadth-fill.advancing');
    const declFill = container.querySelector('.breadth-fill.declining');
    const advCount = container.querySelector('.breadth-item:first-child .breadth-count');
    const declCount = container.querySelector('.breadth-item:last-child .breadth-count');
    
    if (advFill) advFill.style.width = advPercent + '%';
    if (declFill) declFill.style.width = declPercent + '%';
    if (advCount) advCount.textContent = advancers.toLocaleString();
    if (declCount) declCount.textContent = decliners.toLocaleString();
  }
}

// Render sector heatmap
function renderSectorHeatmap() {
  const sectors = [
    { name: 'Tech', value: 2.34, up: true },
    { name: 'Healthcare', value: 1.12, up: true },
    { name: 'Finance', value: 0.85, up: true },
    { name: 'Energy', value: -0.45, up: false },
    { name: 'Consumer', value: 0.23, up: true },
    { name: 'Industrials', value: 1.67, up: true },
    { name: 'Materials', value: -0.12, up: false },
    { name: 'Real Estate', value: 0.34, up: true },
    { name: 'Utilities', value: 0.56, up: true },
    { name: 'Telecom', value: -0.78, up: false },
  ];
  
  const container = document.getElementById('sectorHeatmap');
  if (container) {
    container.innerHTML = sectors.map(s => `
      <div class="sector-cell ${s.up ? 'up' : 'down'}">
        <div class="sector-name">${s.name}</div>
        <div class="sector-value">${s.value > 0 ? '+' : ''}${s.value.toFixed(2)}%</div>
      </div>
    `).join('');
  }
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
