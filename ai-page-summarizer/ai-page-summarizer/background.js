// background.js — Service Worker
// Handles all AI API calls. The API key NEVER touches the popup or content script.

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

// ── Message router ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "SUMMARIZE") {
    handleSummarize(message.payload)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true; // keep channel open for async response
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
  // 1. Load settings (API key, provider)
  const settings = await getSettings();
  if (!settings.apiKey) {
    throw new Error("NO_API_KEY");
  }

  // 2. Check cache
  const cacheKey = `cache_${hashUrl(url)}_${mode || "default"}`;
  const cached = await getCached(cacheKey);
  if (cached) {
    return { ...cached, fromCache: true };
  }

  // 3. Build prompt
  const prompt = buildPrompt(title, content, mode);

  // 4. Call AI provider
  let result;
  if (settings.provider === "gemini") {
    // Use stored geminiModel, falling back to gemini-2.0-flash
    const geminiModel = settings.geminiModel || "gemini-2.0-flash";
    result = await callGemini(settings.apiKey, geminiModel, prompt);
  } else {
    result = await callOpenAI(settings.apiKey, settings.model || "gpt-4o-mini", prompt);
  }

  // 5. Parse structured response
  const parsed = parseAIResponse(result);
  const readingTime = estimateReadingTime(content);
  const response = { ...parsed, readingTime, fromCache: false };

  // 6. Cache it
  await setCached(cacheKey, response);

  return response;
}

// ── OpenAI API call ───────────────────────────────────────────────────────────
async function callOpenAI(apiKey, model, prompt) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
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
  // Use v1beta endpoint with the caller-supplied model name
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
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
    const err = await res.json().catch(() => ({}));
    const errMsg = err?.error?.message || `HTTP ${res.status}`;
    if (res.status === 400 && errMsg.includes("API_KEY"))
      throw new Error("INVALID_API_KEY");
    if (res.status === 400 && errMsg.toLowerCase().includes("not found"))
      throw new Error(`MODEL_NOT_FOUND: ${model}`);
    if (res.status === 429) throw new Error("RATE_LIMITED");
    throw new Error(errMsg);
  }

  const data = await res.json();
  return data.candidates[0].content.parts[0].text;
}

// ── Prompt builder ────────────────────────────────────────────────────────────
function buildPrompt(title, content, mode) {
  const truncated = content.slice(0, 6000); // stay within token limits

  const instructions = {
    default: `Summarize this article in 4–6 bullet points, identify 3 key insights, and list up to 5 important topics.`,
    brief: `Summarize this article in exactly 3 bullet points, identify 1 key insight, and list up to 3 important topics.`,
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
    // Strip any accidental markdown fences
    const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    return JSON.parse(cleaned);
  } catch {
    // Fallback: extract what we can
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
  const minutes = Math.ceil(words / 238); // average reading speed
  return minutes;
}

function hashUrl(url) {
  // Simple deterministic hash for cache keys
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    hash = (hash << 5) - hash + url.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

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
      // Clear all modes for this URL
      chrome.storage.local.get(null, (all) => {
        const keysToRemove = Object.keys(all).filter((k) => k.startsWith(key));
        chrome.storage.local.remove(keysToRemove, resolve);
      });
    } else {
      // Clear all cache entries
      chrome.storage.local.get(null, (all) => {
        const keysToRemove = Object.keys(all).filter((k) => k.startsWith("cache_"));
        chrome.storage.local.remove(keysToRemove, resolve);
      });
    }
  });
        }
