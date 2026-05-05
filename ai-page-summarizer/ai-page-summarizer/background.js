// background.js — Service Worker
// Handles all AI API calls. The API key NEVER touches the popup or content script.

const CACHE_TTL_MS  = 30 * 60 * 1000; // 30 minutes
const FETCH_TIMEOUT = 30_000;          // 30-second per-request timeout
const MAX_RETRIES   = 3;               // attempts before giving up

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
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
});

// ── Main summarize handler ────────────────────────────────────────────────────
async function handleSummarize({ url, title, content, mode }) {
  const settings = await getSettings();
  if (!settings.apiKey) throw new Error("NO_API_KEY");

  const cacheKey = `cache_${hashUrl(url)}_${mode || "default"}`;
  const cached   = await getCached(cacheKey);
  if (cached) return { ...cached, fromCache: true };

  const prompt = buildPrompt(title, content, mode);

  let result;
  if (settings.provider === "gemini") {
    const geminiModel = settings.geminiModel || "gemini-2.0-flash";
    result = await callGemini(settings.apiKey, geminiModel, prompt);
  } else {
    result = await callOpenAI(settings.apiKey, settings.model || "gpt-4o-mini", prompt);
  }

  const parsed      = parseAIResponse(result);
  const readingTime = estimateReadingTime(content);
  const response    = { ...parsed, readingTime, fromCache: false };

  await setCached(cacheKey, response);
  return response;
}

// ── Fetch with timeout + exponential-backoff retry ────────────────────────────
/**
 * Wraps fetch() with:
 *   • A per-attempt AbortController timeout (FETCH_TIMEOUT ms)
 *   • Automatic retries for network errors and 429 responses
 *   • Exponential back-off: 1 s, 2 s, 4 s … between attempts
 *
 * @param {string}  url
 * @param {object}  options  — standard fetch options (method, headers, body)
 * @param {number}  [retries=MAX_RETRIES]
 * @returns {Promise<Response>}  — always a resolved Response (caller checks .ok)
 */
async function fetchWithRetry(url, options, retries = MAX_RETRIES) {
  let lastError;

  for (let attempt = 0; attempt < retries; attempt++) {
    // Back-off before every retry (not before the first attempt)
    if (attempt > 0) {
      const delay = Math.pow(2, attempt - 1) * 1000; // 1 s, 2 s, 4 s …
      await sleep(delay);
    }

    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);

      // Retry on 429 (rate-limited) only if we have attempts left
      if (res.status === 429 && attempt < retries - 1) {
        // Honour Retry-After header if present
        const retryAfter = parseInt(res.headers.get("Retry-After") || "0", 10);
        if (retryAfter > 0) await sleep(retryAfter * 1000);
        continue; // retry
      }

      return res; // all other statuses (including errors) returned to caller
    } catch (err) {
      clearTimeout(timer);
      if (err.name === "AbortError") {
        lastError = new Error("REQUEST_TIMEOUT");
      } else {
        // Network-level failure (DNS, TCP, etc.) — retry
        lastError = new Error("NETWORK_ERROR");
      }
    }
  }

  throw lastError; // exhausted all retries
}

// ── OpenAI API call ───────────────────────────────────────────────────────────
async function callOpenAI(apiKey, model, prompt) {
  const res = await fetchWithRetry("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content:
            "You are an expert content analyst. Always respond with valid JSON only — no markdown fences, no extra text.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.3,
      max_tokens: 1024,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err?.error?.message || `HTTP ${res.status}`;
    if (res.status === 401) throw new Error("INVALID_API_KEY");
    if (res.status === 429) throw new Error("RATE_LIMITED");
    throw new Error(msg);
  }

  const data = await res.json();
  return data.choices[0].message.content;
}

// ── Gemini API call ───────────────────────────────────────────────────────────
async function callGemini(apiKey, model, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 1024 },
      systemInstruction: {
        parts: [
          {
            text: "You are an expert content analyst. Always respond with valid JSON only — no markdown fences, no extra text.",
          },
        ],
      },
    }),
  });

  if (!res.ok) {
    const err    = await res.json().catch(() => ({}));
    const errMsg = err?.error?.message || `HTTP ${res.status}`;
    if (res.status === 400 && errMsg.includes("API_KEY"))
      throw new Error("INVALID_API_KEY");
    if (res.status === 400 && errMsg.toLowerCase().includes("not found"))
      throw new Error(`MODEL_NOT_FOUND: ${model}`);
    if (res.status === 401 || res.status === 403)
      throw new Error("INVALID_API_KEY");
    if (res.status === 429)
      throw new Error("RATE_LIMITED");
    if (res.status >= 500)
      throw new Error("SERVER_ERROR");
    throw new Error(errMsg);
  }

  const data = await res.json();

  // Guard against empty / blocked responses
  const candidate = data?.candidates?.[0];
  if (!candidate) {
    const blockReason = data?.promptFeedback?.blockReason;
    if (blockReason) throw new Error(`BLOCKED: ${blockReason}`);
    throw new Error("EMPTY_RESPONSE");
  }

  return candidate.content.parts[0].text;
}

// ── Prompt builder ────────────────────────────────────────────────────────────
function buildPrompt(title, content, mode) {
  const truncated = content.slice(0, 6000);

  const instructions = {
    default:  `Summarize this article in 4–6 bullet points, identify 3 key insights, and list up to 5 important topics.`,
    brief:    `Summarize this article in exactly 3 bullet points, identify 1 key insight, and list up to 3 important topics.`,
    detailed: `Provide a thorough summary in 7–10 bullet points, identify 5 key insights, and list up to 8 important topics.`,
  };

  return `${instructions[mode] || instructions.default}

Page Title: ${title}

Page Content:
${truncated}

Respond ONLY with this exact JSON structure:
{
  "summary": ["bullet 1", "bullet 2", "bullet 3"],
  "keyInsights": ["insight 1", "insight 2"],
  "topics": ["topic1", "topic2"],
  "sentiment": "positive | neutral | negative",
  "contentType": "article | news | documentation | blog | other"
}`;
}

// ── Response parser ───────────────────────────────────────────────────────────
function parseAIResponse(raw) {
  try {
    const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    return JSON.parse(cleaned);
  } catch {
    return {
      summary: ["The AI returned an unexpected format. Please try again."],
      keyInsights: [],
      topics: [],
      sentiment: "neutral",
      contentType: "other",
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function estimateReadingTime(text) {
  const words = text.trim().split(/\s+/).length;
  return Math.ceil(words / 238);
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

// ── Storage helpers ───────────────────────────────────────────────────────────
async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["apiKey", "provider", "model", "geminiModel"], resolve);
  });
}

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
        chrome.storage.local.remove(keysToRemove, resolve);
      });
    } else {
      chrome.storage.local.get(null, (all) => {
        const keysToRemove = Object.keys(all).filter((k) => k.startsWith("cache_"));
        chrome.storage.local.remove(keysToRemove, resolve);
      });
    }
  });
}
