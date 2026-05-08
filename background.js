// background.js — Service Worker
// All AI calls go through YOUR backend on Render. No API keys required.

const CACHE_TTL_MS  = 30 * 60 * 1000; // 30 minutes
const FETCH_TIMEOUT = 90_000;          // 90s — Gemini automation can be slow
const MAX_RETRIES   = 2;

// ── IMPORTANT: Set this to your Render backend URL after deploying ────────────
// Example: "https://pagemind-backend.onrender.com"
const BACKEND_URL = "https://pagemind-backend.onrender.com";

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
      .then(url => sendResponse({ url }))
      .catch(() => sendResponse({ url: BACKEND_URL }));
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

  const readingTime = estimateReadingTime(content);
  const response    = { ...result, readingTime, fromCache: false };

  await setCached(cacheKey, response);
  return response;
}

// ── Call your Render backend ──────────────────────────────────────────────────
async function callBackend(backendUrl, { title, content, mode }) {
  // Truncate content before sending — keeps request size small
  const truncated = content.slice(0, 5000);

  let lastError;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(2000);

    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    try {
      const res = await fetch(`${backendUrl}/summarize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, content: truncated, mode }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      const data = await res.json();

      if (!res.ok) {
        // Use the error code from backend if available
        const code = data?.error || `HTTP_${res.status}`;
        if (res.status === 429) throw new Error("RATE_LIMITED");
        if (res.status === 504) throw new Error("TIMEOUT");
        if (res.status === 503) throw new Error("NETWORK_ERROR");
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
      } else if (err.message === "Failed to fetch" || err.message.includes("fetch")) {
        lastError = new Error("BACKEND_UNREACHABLE");
      } else {
        lastError = err;
      }

      // Don't retry on these
      if (["RATE_LIMITED", "INVALID_INPUT"].includes(lastError.message)) break;
    }
  }

  throw lastError || new Error("SERVER_ERROR");
}

// ── Backend URL (can be overridden via storage) ───────────────────────────────
async function getBackendUrl() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["backendUrl"], (result) => {
      resolve(result.backendUrl || BACKEND_URL);
    });
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function estimateReadingTime(text) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / 238));
}

function hashUrl(url) {
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    hash = (hash << 5) - hash + url.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
      const key = `cache_${hashUrl(url)}`;
      chrome.storage.local.get(null, (all) => {
        const keysToRemove = Object.keys(all).filter((k) => k.startsWith(key));
        if (keysToRemove.length === 0) return resolve();
        chrome.storage.local.remove(keysToRemove, resolve);
      });
    } else {
      chrome.storage.local.get(null, (all) => {
        const keysToRemove = Object.keys(all).filter((k) => k.startsWith("cache_"));
        if (keysToRemove.length === 0) return resolve();
        chrome.storage.local.remove(keysToRemove, resolve);
      });
    }
  });
}