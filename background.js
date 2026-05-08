// background.js — Service Worker
// Handles all AI API calls. The API key NEVER touches the popup or content script.

const CACHE_TTL_MS       = 30 * 60 * 1000; // 30 minutes
const FETCH_TIMEOUT      = 60_000;          // 60-second per-request timeout
const MAX_RETRIES        = 3;               // attempts for OpenAI / Claude
const GEMINI_MAX_RETRIES = 2;              // fewer retries for Gemini to avoid quota exhaustion

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
    if (attempt > 0) {
      const delay = Math.pow(2, attempt - 1) * 1000;
      await sleep(delay);
    }

    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);

      if (res.status === 429 && attempt < retries - 1) {
        const retryAfterHeader = res.headers.get("Retry-After");
        const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) : 2;
        await sleep(retryAfter * 1000);
        lastError = new Error("RATE_LIMITED");
        continue;
      }

      if (res.status >= 500 && attempt < retries - 1) {
        lastError = new Error("SERVER_ERROR");
        continue;
      }

      return res;
    } catch (err) {
      clearTimeout(timer);
      if (err.name === "AbortError") {
        lastError = new Error("REQUEST_TIMEOUT");
      } else {
        lastError = new Error("NETWORK_ERROR");
      }
      if (attempt === retries - 1) break;
    }
  }

  throw lastError || new Error("NETWORK_ERROR");
}

// ── OpenAI API call ───────────────────────────────────────────────────────────
async function callOpenAI(apiKey, model, prompt) {
  const body = {
    model,
    messages: [
      {
        role: "system",
        content: "You are an expert content analyst. Always respond with valid JSON only — no markdown fences, no extra text.",
      },
      { role: "user", content: prompt },
    ],
    temperature: 0.3,
    max_tokens: 1200,
  };

  const res = await fetchWithRetry("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    const msg = errData?.error?.message || `HTTP ${res.status}`;
    if (res.status === 401) throw new Error("INVALID_API_KEY");
    if (res.status === 429) throw new Error("RATE_LIMITED");
    if (res.status === 403) throw new Error("INVALID_API_KEY");
    throw new Error(msg);
  }

  const data    = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("EMPTY_RESPONSE");
  return content.trim();
}

// ── Gemini API call ───────────────────────────────────────────────────────────
async function callGemini(apiKey, model, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 1200,
        responseMimeType: "application/json",
      },
      systemInstruction: {
        parts: [{
          text: "You are an expert content analyst. Always respond with valid JSON only — no markdown fences, no extra text.",
        }],
      },
    }),
  }, GEMINI_MAX_RETRIES);

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    const errMsg  = errData?.error?.message || `HTTP ${res.status}`;
    const errStatus = errData?.error?.status || "";

    if (res.status === 429) {
      if (
        errStatus === "RESOURCE_EXHAUSTED" ||
        errMsg.toLowerCase().includes("quota") ||
        errMsg.toLowerCase().includes("resource has been exhausted")
      ) {
        throw new Error("QUOTA_EXCEEDED");
      }
      throw new Error("RATE_LIMITED");
    }

    if (res.status === 400) {
      if (errMsg.toLowerCase().includes("api key") || errMsg.toLowerCase().includes("api_key")) {
        throw new Error("INVALID_API_KEY");
      }
      return callGeminiLegacy(apiKey, model, prompt);
    }

    if (res.status === 401 || res.status === 403) throw new Error("INVALID_API_KEY");
    if (res.status === 404) return callGeminiLegacy(apiKey, model, prompt);
    if (res.status >= 500) throw new Error("SERVER_ERROR");
    throw new Error(errMsg);
  }

  const data = await res.json();
  return extractGeminiText(data);
}

// Fallback: no responseMimeType for older/unsupported models
async function callGeminiLegacy(apiKey, model, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 1200 },
      systemInstruction: {
        parts: [{
          text: "You are an expert content analyst. Always respond with valid JSON only — no markdown fences, no extra text.",
        }],
      },
    }),
  }, GEMINI_MAX_RETRIES);

  if (!res.ok) {
    const errData  = await res.json().catch(() => ({}));
    const errMsg   = errData?.error?.message || `HTTP ${res.status}`;
    const errStatus = errData?.error?.status || "";

    if (res.status === 429) {
      if (
        errStatus === "RESOURCE_EXHAUSTED" ||
        errMsg.toLowerCase().includes("quota") ||
        errMsg.toLowerCase().includes("resource has been exhausted")
      ) {
        throw new Error("QUOTA_EXCEEDED");
      }
      throw new Error("RATE_LIMITED");
    }

    if (res.status === 400) {
      if (errMsg.toLowerCase().includes("api key") || errMsg.toLowerCase().includes("api_key"))
        throw new Error("INVALID_API_KEY");
      if (
        errMsg.toLowerCase().includes("not found") ||
        errMsg.toLowerCase().includes("does not exist") ||
        errStatus === "NOT_FOUND"
      )
        throw new Error(`MODEL_NOT_FOUND: ${model}`);
      throw new Error(`GEMINI_ERROR: ${errMsg}`);
    }

    if (res.status === 401 || res.status === 403) throw new Error("INVALID_API_KEY");
    if (res.status >= 500) throw new Error("SERVER_ERROR");
    throw new Error(errMsg);
  }

  const data = await res.json();
  return extractGeminiText(data);
}

function extractGeminiText(data) {
  const candidate = data?.candidates?.[0];
  if (!candidate) {
    const blockReason = data?.promptFeedback?.blockReason;
    if (blockReason) throw new Error(`BLOCKED: ${blockReason}`);
    throw new Error("EMPTY_RESPONSE");
  }

  const finishReason = candidate.finishReason;
  if (finishReason === "SAFETY")     throw new Error("BLOCKED: SAFETY");
  if (finishReason === "RECITATION") throw new Error("BLOCKED: RECITATION");

  const part = candidate?.content?.parts?.[0];
  if (!part) throw new Error("EMPTY_RESPONSE");

  const text = part.text;
  if (!text || !text.trim()) throw new Error("EMPTY_RESPONSE");
  return text.trim();
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
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    const errType = errData?.error?.type || "";
    const msg = errData?.error?.message || `HTTP ${res.status}`;

    if (res.status === 401 || res.status === 403 || errType === "authentication_error") {
      throw new Error("INVALID_API_KEY");
    }
    if (res.status === 429 || errType === "rate_limit_error") {
      throw new Error("RATE_LIMITED");
    }
    if (res.status === 400 && errType === "invalid_request_error") {
      throw new Error(`CLAUDE_ERROR: ${msg}`);
    }
    if (res.status >= 500 || errType === "api_error" || errType === "overloaded_error") {
      throw new Error("SERVER_ERROR");
    }
    throw new Error(msg);
  }

  const data = await res.json();

  if (!data?.content || !Array.isArray(data.content) || data.content.length === 0) {
    throw new Error("EMPTY_RESPONSE");
  }

  const textBlock = data.content.find((block) => block.type === "text");
  if (!textBlock || !textBlock.text) {
    throw new Error("EMPTY_RESPONSE");
  }

  return textBlock.text.trim();
}

// ── Prompt builder ────────────────────────────────────────────────────────────
function buildPrompt(title, content, mode) {
  let truncated = content.slice(0, 6000);
  if (content.length > 6000) {
    const lastPeriod = truncated.lastIndexOf('. ');
    if (lastPeriod > 4000) truncated = truncated.slice(0, lastPeriod + 1);
  }

  const modeKey = ["brief", "detailed"].includes(mode) ? mode : "default";

  const instructions = {
    default:  `Summarize this page in 4–6 bullet points, identify 3 key insights, and list up to 5 important topics.`,
    brief:    `Summarize this page in exactly 3 bullet points, identify 1 key insight, and list up to 3 important topics.`,
    detailed: `Provide a thorough summary in 7–10 bullet points, identify 5 key insights, and list up to 8 important topics.`,
  };

  return `${instructions[modeKey]}

Page Title: ${title || "Untitled"}

Page Content:
${truncated}

You MUST respond with ONLY the following JSON structure. No markdown, no backticks, no explanation — raw JSON only:
{
  "summary": ["point 1", "point 2", "point 3"],
  "keyInsights": ["insight 1", "insight 2"],
  "topics": ["topic1", "topic2"],
  "sentiment": "neutral",
  "contentType": "article"
}

Rules:
- summary: array of strings (bullet points)
- keyInsights: array of strings
- topics: array of short keyword strings
- sentiment: EXACTLY one of: positive, neutral, negative
- contentType: EXACTLY one of: article, news, documentation, blog, other`;
}

// ── Response parser ───────────────────────────────────────────────────────────
function parseAIResponse(raw) {
  if (!raw || typeof raw !== "string") {
    return buildFallbackResponse("Empty response from AI.");
  }

  try {
    let cleaned = raw.trim();

    cleaned = cleaned
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```\s*$/i, "")
      .trim();

    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) cleaned = jsonMatch[0];

    const parsed = JSON.parse(cleaned);

    const validSentiments  = ["positive", "neutral", "negative"];
    const validContentTypes = ["article", "news", "documentation", "blog", "other"];

    return {
      summary: Array.isArray(parsed.summary)
        ? parsed.summary.filter((s) => typeof s === "string" && s.trim())
        : ["No summary available."],
      keyInsights: Array.isArray(parsed.keyInsights)
        ? parsed.keyInsights.filter((s) => typeof s === "string" && s.trim())
        : [],
      topics: Array.isArray(parsed.topics)
        ? parsed.topics.filter((s) => typeof s === "string" && s.trim())
        : [],
      sentiment: validSentiments.includes(parsed.sentiment)
        ? parsed.sentiment
        : "neutral",
      contentType: validContentTypes.includes(parsed.contentType)
        ? parsed.contentType
        : "other",
    };
  } catch (e) {
    const summaryMatch = raw.match(/"summary"\s*:\s*\[([\s\S]*?)\]/);
    if (summaryMatch) {
      try {
        const partialSummary = JSON.parse(`[${summaryMatch[1]}]`);
        if (Array.isArray(partialSummary) && partialSummary.length > 0) {
          return {
            summary: partialSummary,
            keyInsights: [],
            topics: [],
            sentiment: "neutral",
            contentType: "other",
          };
        }
      } catch (_) { /* fall through */ }
    }
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
      (result) => {
        resolve({
          apiKey:      result.apiKey      || "",
          provider:    result.provider    || "openai",
          model:       result.model       || "gpt-4o-mini",
          geminiModel: result.geminiModel || "gemini-2.0-flash",
          claudeModel: result.claudeModel || "claude-haiku-4-5-20251001",
        });
      }
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