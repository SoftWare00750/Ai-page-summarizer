// background.js — Service Worker v5
// All AI calls route through the PageMind Render backend.
// No API keys stored or used in the extension.

const CACHE_TTL_MS    = 30 * 60 * 1000; // 30 minutes
const FETCH_TIMEOUT   = 90_000;          // 90s — backend may be cold-starting on Render free tier
const MAX_RETRIES     = 2;
const DEFAULT_BACKEND = "https://pagemind-backend.onrender.com";

// ── Message router ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "SUMMARIZE") {
    handleSummarize(message.payload)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === "CLEAR_CACHE") {
    clearCache(message.payload?.url)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === "GET_BACKEND_URL") {
    getBackendUrl()
      .then((url) => sendResponse({ url }))
      .catch(() => sendResponse({ url: DEFAULT_BACKEND }));
    return true;
  }

  if (message.type === "PING_BACKEND") {
    pingBackend()
      .then((ok) => sendResponse({ ok }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
});

// ── Main summarize handler ────────────────────────────────────────────────────
async function handleSummarize({ url, title, content, mode }) {
  const cacheKey = `cache_${hashUrl(url)}_${mode || "default"}`;
  const cached   = await getCached(cacheKey);
  if (cached) return { ...cached, fromCache: true };

  const backendUrl = await getBackendUrl();
  const result     = await callBackend(backendUrl, { title, content, mode });

  await setCached(cacheKey, result);
  return { ...result, fromCache: false };
}

// ── Call the Render backend ───────────────────────────────────────────────────
async function callBackend(backendUrl, { title, content, mode }) {
  // Trim content before sending — reduces request size
  const truncated = content.slice(0, 5000);
  let lastError;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(2500);

    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    try {
      const res = await fetch(`${backendUrl}/summarize`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ title, content: truncated, mode }),
        signal:  controller.signal,
      });
      clearTimeout(timer);

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        const code = data?.error || `HTTP_${res.status}`;
        if (res.status === 429)                     throw new Error("RATE_LIMITED");
        if (res.status === 504)                     throw new Error("TIMEOUT");
        if (res.status === 400)                     throw new Error(data?.error || "INVALID_INPUT");
        if (res.status >= 500 && attempt < MAX_RETRIES - 1) {
          lastError = new Error(code);
          continue;
        }
        throw new Error(code);
      }

      if (!data.summary || !Array.isArray(data.summary)) {
        throw new Error("EMPTY_RESPONSE");
      }

      return data;

    } catch (err) {
      clearTimeout(timer);

      if (err.name === "AbortError") {
        lastError = new Error("TIMEOUT");
      } else if (
        err.message === "Failed to fetch" ||
        err.message.includes("fetch") ||
        err.message.includes("NetworkError")
      ) {
        lastError = new Error("BACKEND_UNREACHABLE");
      } else {
        lastError = err;
      }

      // Non-retriable errors
      if (["RATE_LIMITED", "INVALID_INPUT", "TOO_SHORT"].includes(lastError.message)) break;
    }
  }

  throw lastError || new Error("SERVER_ERROR");
}

// ── Ping backend (used by settings page to test connection) ───────────────────
async function pingBackend() {
  const backendUrl = await getBackendUrl();
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(`${backendUrl}/health`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Backend URL (stored in chrome.storage.local, falls back to default) ───────
async function getBackendUrl() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["backendUrl"], (result) => {
      const url = (result.backendUrl || DEFAULT_BACKEND).replace(/\/$/, "");
      resolve(url);
    });
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function hashUrl(url) {
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    hash = (hash << 5) - hash + url.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Cache helpers ─────────────────────────────────────────────────────────────
async function getCached(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (result) => {
      const entry = result[key];
      if (!entry) return resolve(null);
      if (Date.now() - entry.timestamp > CACHE_TTL_MS) return resolve(null);
      resolve(entry.data);
    });
  });
}

async function setCached(key, data) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [key]: { data, timestamp: Date.now() } }, resolve);
  });
}

async function clearCache(url) {
  return new Promise((resolve) => {
    if (url) {
      const prefix = `cache_${hashUrl(url)}`;
      chrome.storage.local.get(null, (all) => {
        const keys = Object.keys(all).filter((k) => k.startsWith(prefix));
        if (!keys.length) return resolve();
        chrome.storage.local.remove(keys, resolve);
      });
    } else {
      chrome.storage.local.get(null, (all) => {
        const keys = Object.keys(all).filter((k) => k.startsWith("cache_"));
        if (!keys.length) return resolve();
        chrome.storage.local.remove(keys, resolve);
      });
    }
  });
}
