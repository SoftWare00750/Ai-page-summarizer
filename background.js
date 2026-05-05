// background.js — Service Worker
// Handles all AI API calls. The API key NEVER touches the popup or content script.

const CACHE_TTL_MS  = 30 * 60 * 1000; // 30 minutes
const FETCH_TIMEOUT = 45_000;          // 45-second per-request timeout (increased for slower networks)
const MAX_RETRIES   = 3;               // attempts before giving up

// ── Message router ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "SUMMARIZE") {
    handleSummarize(message.payload)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true; // keep channel open for async
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
  const provider = settings.provider || "openai";

  if (provider === "gemini") {
    const geminiModel = settings.geminiModel || "gemini-2.0-flash";
    result = await callGemini(settings.apiKey, geminiModel, prompt);
  } else if (provider === "claude") {
    const claudeModel = settings.claudeModel || "claude-haiku-4-5-20251001";
    result = await callClaude(settings.apiKey, claudeModel, prompt);
  } else {
    // Default: OpenAI
    result = await callOpenAI(settings.apiKey, settings.model || "gpt-4o-mini", prompt);
  }

  const parsed      = parseAIResponse(result);
  const readingTime = estimateReadingTime(content);
  const response    = { ...parsed, readingTime, fromCache: false };

  await setCached(cacheKey, response);
  return response;
}

// ── Fetch with timeout + exponential-backoff retry ────────────────────────────
async function fetchWithRetry(url, options, retries = MAX_RETRIES) {
  let lastError;

  for (let attempt = 0; attempt < retries; attempt++) {
    // Exponential back-off before every retry (not before the first attempt)
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
        const retryAfterHeader = res.headers.get("Retry-After");
        const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) : 0;
        if (retryAfter > 0) {
          await sleep(retryAfter * 1000);
        }
        lastError = new Error("RATE_LIMITED");
        continue; // retry
      }

      // Retry on 5xx server errors (except last attempt)
      if (res.status >= 500 && attempt < retries - 1) {
        lastError = new Error("SERVER_ERROR");
        continue;
      }

      return res; // all other statuses returned to caller
    } catch (err) {
      clearTimeout(timer);
      if (err.name === "AbortError") {
        lastError = new Error("REQUEST_TIMEOUT");
      } else {
        lastError = new Error("NETWORK_ERROR");
      }
      // Network failures are retried automatically by the loop
    }
  }

  throw lastError || new Error("NETWORK_ERROR");
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
      // Use max_completion_tokens for newer models; fall back gracefully
      max_completion_tokens: 1200,
    }),
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    const msg = errData?.error?.message || `HTTP ${res.status}`;
    if (res.status === 401) throw new Error("INVALID_API_KEY");
    if (res.status === 429) throw new Error("RATE_LIMITED");
    if (res.status === 400 && msg.includes("max_completion_tokens")) {
      // Older model compatibility: retry with max_tokens
      return callOpenAILegacy(apiKey, model, prompt);
    }
    throw new Error(msg);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("EMPTY_RESPONSE");
  return content;
}

// Fallback for models that don't support max_completion_tokens
async function callOpenAILegacy(apiKey, model, prompt) {
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
      max_tokens: 1200,
    }),
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    const msg = errData?.error?.message || `HTTP ${res.status}`;
    if (res.status === 401) throw new Error("INVALID_API_KEY");
    if (res.status === 429) throw new Error("RATE_LIMITED");
    throw new Error(msg);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("EMPTY_RESPONSE");
  return content;
}

// ── Gemini API call ───────────────────────────────────────────────────────────
async function callGemini(apiKey, model, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const requestBody = {
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }]
      }
    ],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 1200,
      responseMimeType: "application/json"  // Force JSON response where supported
    },
    systemInstruction: {
      parts: [
        {
          text: "You are an expert content analyst. Always respond with valid JSON only — no markdown fences, no extra text.",
        },
      ],
    },
  };

  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    const errMsg  = errData?.error?.message || `HTTP ${res.status}`;

    if (res.status === 400) {
      // Could be invalid key OR model not found OR responseMimeType not supported
      if (errMsg.toLowerCase().includes("api key") || errMsg.toLowerCase().includes("api_key")) {
        throw new Error("INVALID_API_KEY");
      }
      if (
        errMsg.toLowerCase().includes("not found") ||
        errMsg.toLowerCase().includes("does not exist") ||
        errMsg.toLowerCase().includes("invalid model") ||
        errMsg.toLowerCase().includes("unsupported")
      ) {
        // Retry without responseMimeType (older models don't support it)
        return callGeminiLegacy(apiKey, model, prompt);
      }
      // Generic 400 - try legacy call
      return callGeminiLegacy(apiKey, model, prompt);
    }
    if (res.status === 401 || res.status === 403) throw new Error("INVALID_API_KEY");
    if (res.status === 429) throw new Error("RATE_LIMITED");
    if (res.status >= 500) throw new Error("SERVER_ERROR");
    throw new Error(errMsg);
  }

  const data = await res.json();
  return extractGeminiText(data, model);
}

// Fallback Gemini call without responseMimeType (for older/unsupported models)
async function callGeminiLegacy(apiKey, model, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }]
        }
      ],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 1200,
      },
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
    const errData = await res.json().catch(() => ({}));
    const errMsg  = errData?.error?.message || `HTTP ${res.status}`;
    if (res.status === 400 && (errMsg.toLowerCase().includes("api key") || errMsg.toLowerCase().includes("api_key")))
      throw new Error("INVALID_API_KEY");
    if (res.status === 400 && (errMsg.toLowerCase().includes("not found") || errMsg.toLowerCase().includes("does not exist")))
      throw new Error(`MODEL_NOT_FOUND: ${model}`);
    if (res.status === 401 || res.status === 403) throw new Error("INVALID_API_KEY");
    if (res.status === 429) throw new Error("RATE_LIMITED");
    if (res.status >= 500) throw new Error("SERVER_ERROR");
    throw new Error(errMsg);
  }

  const data = await res.json();
  return extractGeminiText(data, model);
}

function extractGeminiText(data, model) {
  const candidate = data?.candidates?.[0];
  if (!candidate) {
    const blockReason = data?.promptFeedback?.blockReason;
    if (blockReason) throw new Error(`BLOCKED: ${blockReason}`);
    throw new Error("EMPTY_RESPONSE");
  }

  // Handle different finish reasons
  const finishReason = candidate.finishReason;
  if (finishReason === "SAFETY") throw new Error("BLOCKED: SAFETY");
  if (finishReason === "RECITATION") throw new Error("BLOCKED: RECITATION");

  const text = candidate?.content?.parts?.[0]?.text;
  if (!text) throw new Error("EMPTY_RESPONSE");
  return text;
}

// ── Anthropic (Claude) API call ───────────────────────────────────────────────
async function callClaude(apiKey, model, prompt) {
  const res = await fetchWithRetry("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1200,
      system: "You are an expert content analyst. Always respond with valid JSON only — no markdown fences, no extra text.",
      messages: [
        { role: "user", content: prompt }
      ],
    }),
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    const msg = errData?.error?.message || `HTTP ${res.status}`;
    if (res.status === 401) throw new Error("INVALID_API_KEY");
    if (res.status === 403) throw new Error("INVALID_API_KEY");
    if (res.status === 429) throw new Error("RATE_LIMITED");
    if (res.status >= 500) throw new Error("SERVER_ERROR");
    throw new Error(msg);
  }

  const data = await res.json();
  const content = data?.content?.[0]?.text;
  if (!content) throw new Error("EMPTY_RESPONSE");
  return content;
}

// ── Prompt builder ────────────────────────────────────────────────────────────
function buildPrompt(title, content, mode) {
  // Truncate to 6000 chars but try to end at a sentence boundary
  let truncated = content.slice(0, 6000);
  if (content.length > 6000) {
    const lastPeriod = truncated.lastIndexOf('. ');
    if (lastPeriod > 4000) truncated = truncated.slice(0, lastPeriod + 1);
  }

  const instructions = {
    default:  `Summarize this article in 4–6 bullet points, identify 3 key insights, and list up to 5 important topics.`,
    brief:    `Summarize this article in exactly 3 bullet points, identify 1 key insight, and list up to 3 important topics.`,
    detailed: `Provide a thorough summary in 7–10 bullet points, identify 5 key insights, and list up to 8 important topics.`,
  };

  return `${instructions[mode] || instructions.default}

Page Title: ${title}

Page Content:
${truncated}

Respond ONLY with this exact JSON structure (no markdown, no backticks, just raw JSON):
{
  "summary": ["bullet 1", "bullet 2", "bullet 3"],
  "keyInsights": ["insight 1", "insight 2"],
  "topics": ["topic1", "topic2"],
  "sentiment": "positive",
  "contentType": "article"
}

For sentiment use ONLY one of: positive, neutral, negative
For contentType use ONLY one of: article, news, documentation, blog, other`;
}

// ── Response parser ───────────────────────────────────────────────────────────
function parseAIResponse(raw) {
  if (!raw || typeof raw !== "string") {
    return buildFallbackResponse("Empty response from AI.");
  }

  try {
    // Strip markdown code fences if present
    let cleaned = raw
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```\s*$/i, "")
      .trim();

    // Try to extract JSON object if surrounded by other text
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) cleaned = jsonMatch[0];

    const parsed = JSON.parse(cleaned);

    // Validate and normalise the parsed object
    return {
      summary:     Array.isArray(parsed.summary)     ? parsed.summary     : ["No summary available."],
      keyInsights: Array.isArray(parsed.keyInsights)  ? parsed.keyInsights : [],
      topics:      Array.isArray(parsed.topics)       ? parsed.topics      : [],
      sentiment:   ["positive", "neutral", "negative"].includes(parsed.sentiment)
                     ? parsed.sentiment : "neutral",
      contentType: ["article", "news", "documentation", "blog", "other"].includes(parsed.contentType)
                     ? parsed.contentType : "other",
    };
  } catch (e) {
    // Attempt line-by-line extraction as last resort
    return buildFallbackResponse("Could not parse AI response. Please try again.");
  }
}

function buildFallbackResponse(msg) {
  return {
    summary:     [msg],
    keyInsights: [],
    topics:      [],
    sentiment:   "neutral",
    contentType: "other",
  };
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

// ── Storage helpers ───────────────────────────────────────────────────────────
async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      ["apiKey", "provider", "model", "geminiModel", "claudeModel"],
      resolve
    );
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
