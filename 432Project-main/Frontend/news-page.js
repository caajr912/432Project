const API_BASE = "http://3.133.101.108:8000";

function newsDate(ts) {
  if (!ts) return "";
  const d = new Date(typeof ts === "number" ? ts * 1000 : ts);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function articleHref(url) {
  if (url == null || typeof url !== "string") return null;
  const u = url.trim();
  if (!u) return null;
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return u;
  } catch {
    return null;
  }
}

function appendNewsCard(container, article) {
  const div = document.createElement("div");
  div.className = "newsCard news-page-card-item";
  const titleText = article.headline || article.summary || "—";
  const href = articleHref(article.url);
  if (href) {
    const link = document.createElement("a");
    link.className = "news-title news-title-link";
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = titleText;
    div.appendChild(link);
  } else {
    const title = document.createElement("p");
    title.className = "news-title";
    title.textContent = titleText;
    div.appendChild(title);
  }
  const meta = document.createElement("p");
  meta.className = "news-date";
  const parts = [newsDate(article.datetime || article.published_date)];
  if (article.section) parts.push(article.section);
  if (article.sentiment != null && !Number.isNaN(Number(article.sentiment))) {
    parts.push(`sentiment ${Number(article.sentiment).toFixed(2)}`);
  }
  meta.textContent = parts.filter(Boolean).join(" · ");
  div.appendChild(meta);
  if (article.abstract && String(article.abstract).trim()) {
    const abs = document.createElement("p");
    abs.className = "news-page-abstract";
    abs.textContent = String(article.abstract).trim();
    div.appendChild(abs);
  }
  container.appendChild(div);
}

async function loadNewsPage() {
  const listEl = document.getElementById("newsPageList");
  const statusEl = document.getElementById("newsPageStatus");
  if (!listEl || !statusEl) return;

  listEl.innerHTML = "";
  statusEl.textContent = "Loading…";
  statusEl.classList.remove("news-page-status--error");

  try {
    let r = await fetch(`${API_BASE}/api/articles?limit=500`);
    let cappedNote = "";
    if (r.status === 422) {
      r = await fetch(`${API_BASE}/api/articles?limit=100`);
      cappedNote = " — this host allows at most 100 per request";
    }
    if (!r.ok) {
      const errText = await r.text().catch(() => r.statusText);
      throw new Error(errText || `HTTP ${r.status}`);
    }
    const news = await r.json();
    const items = Array.isArray(news) ? news : [];
    statusEl.textContent = items.length
      ? `${items.length} article${items.length === 1 ? "" : "s"}${cappedNote}`
      : "No articles in the graph yet.";
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "newsCard";
      empty.innerHTML = "<p class=\"news-title\">No articles returned from the API.</p>";
      listEl.appendChild(empty);
      return;
    }
    items.forEach((article) => appendNewsCard(listEl, article));
  } catch (e) {
    statusEl.textContent = e.message || "Could not load news.";
    statusEl.classList.add("news-page-status--error");
    const empty = document.createElement("div");
    empty.className = "newsCard";
    empty.innerHTML =
      "<p class=\"news-title\">Failed to load articles. Is the API running?</p>";
    listEl.appendChild(empty);
    console.error(e);
  }
}

document.addEventListener("DOMContentLoaded", loadNewsPage);
