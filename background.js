// background.js — Service Worker v6
// Reads API key + provider from chrome.storage.local and calls AI directly.
// Falls back to Render backend if no key is configured.

const CACHE_TTL_MS    = 30 * 60 * 1000;
const FETCH_TIMEOUT   = 60_000;
const MAX_RETRIES     = 2;
const DEFAULT_BACKEND = "https://ai-summarizer-backend-qaid.onrender.com";

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

  if (message.type === "GET_SETTINGS") {
    getSettings()
      .then((s) => sendResponse(s))
      .catch(() => sendResponse({}));
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

  const settings = await getSettings();
  let result;

  if (settings.apiKey && settings.provider) {
    // Call AI provider directly with stored key
    result = await callAIDirect(settings, { title, content, mode });
  } else {
    // Fall back to Render backend (no key needed)
    const backendUrl = (settings.backendUrl || DEFAULT_BACKEND).replace(/\/$/, "");
    result = await callBackend(backendUrl, { title, content, mode });
  }

  await setCached(cacheKey, result);
  return { ...result, fromCache: false };
}

// ── Get settings from storage ─────────────────────────────────────────────────
async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      ["apiKey", "provider", "model", "geminiModel", "claudeModel", "backendUrl"],
      resolve
    );
  });
}

// ── Call AI provider directly ─────────────────────────────────────────────────
async function callAIDirect(settings, { title, content, mode }) {
  const { provider, apiKey, model, geminiModel, claudeModel } = settings;
  const truncated = content.slice(0, 5000);
  const prompt    = buildPrompt(title, truncated, mode);

  switch (provider) {
    case "openai":
      return callOpenAI(apiKey, model || "gpt-4o-mini", prompt);
    case "gemini":
      return callGemini(apiKey, geminiModel || "gemini-2.0-flash", prompt);
    case "claude":
      return callClaude(apiKey, claudeModel || "claude-haiku-4-5-20251001", prompt);
    default:
      throw new Error("UNKNOWN_PROVIDER");
  }
}

// ── OpenAI ────────────────────────────────────────────────────────────────────
async function callOpenAI(apiKey, model, prompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        max_tokens: 1024,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (res.status === 401) throw new Error("INVALID_API_KEY");
      if (res.status === 429) throw new Error("RATE_LIMITED");
      throw new Error(err?.error?.message || `HTTP_${res.status}`);
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || "";
    return parseAIResponse(text, content);
  } finally {
    clearTimeout(timer);
  }
}

// ── Google Gemini ─────────────────────────────────────────────────────────────
async function callGemini(apiKey, model, prompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 1024 },
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (res.status === 400 || res.status === 403) throw new Error("INVALID_API_KEY");
      if (res.status === 429) throw new Error("RATE_LIMITED");
      throw new Error(err?.error?.message || `HTTP_${res.status}`);
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    return parseAIResponse(text, content);
  } finally {
    clearTimeout(timer);
  }
}

// ── Anthropic Claude ──────────────────────────────────────────────────────────
async function callClaude(apiKey, model, prompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (res.status === 401) throw new Error("INVALID_API_KEY");
      if (res.status === 429) throw new Error("RATE_LIMITED");
      throw new Error(err?.error?.message || `HTTP_${res.status}`);
    }

    const data = await res.json();
    const text = data?.content?.[0]?.text || "";
    return parseAIResponse(text, content);
  } finally {
    clearTimeout(timer);
  }
}

// ── Prompt builder ────────────────────────────────────────────────────────────
function buildPrompt(title, content, mode) {
  const modeMap = {
    brief:    { bullets: 3, insights: 1, topics: 3 },
    default:  { bullets: 5, insights: 3, topics: 5 },
    detailed: { bullets: 8, insights: 5, topics: 8 },
  };
  const { bullets, insights, topics } = modeMap[mode] || modeMap.default;

  return `You are a precise webpage summarizer. Read the content below and respond with a single JSON object — no markdown fences, no explanation, no extra text before or after.

TITLE: ${title || "Untitled"}

CONTENT:
${content}

OUTPUT (raw JSON only):
{
  "summary":     [/* exactly ${bullets} concise bullet strings, each ≤ 20 words */],
  "keyInsights": [/* exactly ${insights} deeper insight string(s), each ≤ 30 words */],
  "topics":      [/* exactly ${topics} short keyword/phrase strings */],
  "sentiment":   "positive" | "neutral" | "negative",
  "contentType": "article" | "news" | "documentation" | "blog" | "other"
}

STRICT RULES:
1. summary must have EXACTLY ${bullets} items.
2. keyInsights must have EXACTLY ${insights} item(s).
3. topics must have EXACTLY ${topics} items.
4. sentiment must be one of the three exact strings above.
5. contentType must be one of the five exact strings above.
6. Do NOT include backticks, markdown, or any text outside the JSON object.
7. All strings must be in English.`;
}

// ── Parse AI JSON response ────────────────────────────────────────────────────
function parseAIResponse(raw, originalContent) {
  if (!raw) return fallback("Empty response from AI.");

  let cleaned = raw
    .replace(/^```(?:json)?\s*/im, "")
    .replace(/\s*```\s*$/m, "")
    .trim();

  const braceStart = cleaned.indexOf("{");
  const braceEnd   = cleaned.lastIndexOf("}");
  if (braceStart !== -1 && braceEnd > braceStart) {
    cleaned = cleaned.slice(braceStart, braceEnd + 1);
  }

  cleaned = cleaned.replace(/,\s*([}\]])/g, "$1");

  try {
    const p = JSON.parse(cleaned);
    const SENTIMENTS    = ["positive", "neutral", "negative"];
    const CONTENT_TYPES = ["article", "news", "documentation", "blog", "other"];

    return {
      summary:     ensureArray(p.summary,     1),
      keyInsights: ensureArray(p.keyInsights, 0),
      topics:      ensureArray(p.topics,      0),
      sentiment:   SENTIMENTS.includes(p.sentiment)      ? p.sentiment   : "neutral",
      contentType: CONTENT_TYPES.includes(p.contentType) ? p.contentType : "other",
      readingTime: estimateReadingTime(originalContent || ""),
    };
  } catch {
    return fallback("Could not parse AI response. Please try again.");
  }
}

function ensureArray(val, minLen) {
  const arr = Array.isArray(val)
    ? val.filter((s) => typeof s === "string" && s.trim())
    : [];
  if (arr.length === 0 && minLen > 0) return ["No data available."];
  return arr;
}

function fallback(msg) {
  return {
    summary: [msg], keyInsights: [], topics: [],
    sentiment: "neutral", contentType: "other", readingTime: 0,
  };
}

function estimateReadingTime(text) {
  return Math.max(1, Math.ceil(text.trim().split(/\s+/).filter(Boolean).length / 238));
}

// ── Render backend fallback ───────────────────────────────────────────────────
async function callBackend(backendUrl, { title, content, mode }) {
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

      // Safe JSON parsing — backend may return plain text errors
      const text = await res.text().catch(() => "");
      let data = {};
      try { data = JSON.parse(text); } catch {
        if (!res.ok) throw new Error(text.trim() || `HTTP_${res.status}`);
      }

      if (!res.ok) {
        const code = data?.error || `HTTP_${res.status}`;
        if (res.status === 429)                             throw new Error("RATE_LIMITED");
        if (res.status === 504)                             throw new Error("TIMEOUT");
        if (res.status === 400)                             throw new Error(data?.error || "INVALID_INPUT");
        if (res.status >= 500 && attempt < MAX_RETRIES - 1) { lastError = new Error(code); continue; }
        throw new Error(code);
      }

      if (!data.summary || !Array.isArray(data.summary)) throw new Error("EMPTY_RESPONSE");
      return data;

    } catch (err) {
      clearTimeout(timer);
      if (err.name === "AbortError") {
        lastError = new Error("TIMEOUT");
      } else if (err.message === "Failed to fetch" || err.message.includes("NetworkError")) {
        lastError = new Error("BACKEND_UNREACHABLE");
      } else {
        lastError = err;
      }
      if (["RATE_LIMITED", "INVALID_INPUT", "TOO_SHORT"].includes(lastError.message)) break;
    }
  }

  throw lastError || new Error("SERVER_ERROR");
}

// ── Ping backend ──────────────────────────────────────────────────────────────
async function pingBackend() {
  const settings = await getSettings();
  const backendUrl = (settings.backendUrl || DEFAULT_BACKEND).replace(/\/$/, "");
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(`${backendUrl}/health`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  }
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