let chart; // global chart variable
const API_BASE = ""; // keep empty if frontend is served from same backend origin

function buildApiUrl(endpoint, params = {}) {
  const url = new URL(`${API_BASE}${endpoint}`, window.location.origin);
  Object.entries(params).forEach(([key, value]) => {
    if (value != null && value !== "") url.searchParams.set(key, value);
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

  if (chart) chart.destroy();

  chart = new Chart(ctx, {
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

// Add event listener for refresh button
document.addEventListener("DOMContentLoaded", () => {
  getNytHeadlines(); // Load on page load
  const refreshBtn = document.getElementById("refreshNyt");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", getNytHeadlines);
  }
});
