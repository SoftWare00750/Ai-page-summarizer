# PageMind — AI Page Summarizer

A Chrome Extension (Manifest V3) that extracts content from any webpage and uses AI to generate structured summaries, key insights, topics, and reading time estimates.

---

## Features

- **Instant summaries** — bullet-point summaries in Brief / Standard / Detailed modes
- **Key insights** — AI-extracted insights beyond the summary
- **Topic chips** — detected topics with one-click in-page highlighting
- **Reading time** — estimated from word count
- **Sentiment & content type** — quick context at a glance
- **Per-URL caching** — 30-minute cache prevents duplicate API calls
- **Dual AI provider** — OpenAI (GPT-4o mini / GPT-4o / GPT-3.5) or Google Gemini 1.5 Flash
- **Zero key exposure** — API key stored only in `chrome.storage.local`; all API calls made from background service worker
- **Dark UI** — clean, minimal popup

---

## Setup Instructions

### 1. Generate Icons

Open `icons/generate-icons.html` in your browser and click **Download** for each size (`icon16.png`, `icon32.png`, `icon48.png`, `icon128.png`). Save them into the `icons/` folder.

Alternatively, if you have Node.js + `canvas` installed:
```bash
cd icons
npm install canvas
node generate-icons.js
```

### 2. Get an API Key

**OpenAI:**
1. Go to [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
2. Click **Create new secret key**
3. Copy the key (starts with `sk-`)

**Google Gemini (free tier available):**
1. Go to [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)
2. Click **Create API key**
3. Copy the key (starts with `AIza`)

### 3. Load the Extension in Chrome

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `ai-page-summarizer` folder
5. The PageMind icon appears in your toolbar (pin it for easy access)

### 4. Configure Your API Key

1. Click the PageMind icon in your toolbar
2. Click the **⚙ Settings** icon (top-right of popup)
3. Choose your AI provider and model
4. Paste your API key
5. Click **Save Settings**

### 5. Summarize a Page

1. Navigate to any article, blog post, or documentation page
2. Click the PageMind icon
3. Choose a summary mode (Brief / Standard / Detailed)
4. Click **Summarize**

---

## File Structure

```
ai-page-summarizer/
├── manifest.json          # MV3 manifest
├── background.js          # Service worker — AI API calls, caching
├── content.js             # Content script — page extraction + highlighting
├── popup/
│   ├── popup.html         # Popup markup
│   ├── popup.js           # Popup controller
│   └── popup.css          # Popup styles
├── settings/
│   ├── settings.html      # Settings page
│   ├── settings.js        # Settings controller
│   └── settings.css       # Settings styles
└── icons/
    ├── icon16.png          # (generate via generate-icons.html)
    ├── icon32.png
    ├── icon48.png
    ├── icon128.png
    ├── generate-icons.html # Browser-based icon generator
    └── generate-icons.js   # Node.js icon generator
```

---

## Architecture

```
┌─────────────┐   EXTRACT_CONTENT   ┌──────────────┐
│  popup.js   │ ──────────────────► │  content.js  │
│  (UI layer) │ ◄────────────────── │ (page layer) │
└──────┬──────┘   {title,text,url}  └──────────────┘
       │
       │ SUMMARIZE {url,title,content,mode}
       ▼
┌─────────────────┐   fetch()   ┌──────────────────┐
│  background.js  │ ──────────► │  OpenAI / Gemini │
│ (service worker)│ ◄────────── │   AI API         │
└─────────────────┘             └──────────────────┘
       │
       │ chrome.storage.local
       ▼
  ┌──────────┐
  │  Cache   │  Per-URL, 30-min TTL
  └──────────┘
```

### Component Responsibilities

| Component | Responsibility |
|-----------|---------------|
| `popup.js` | UI state, user interactions, message passing |
| `content.js` | DOM extraction, topic highlighting |
| `background.js` | AI API calls, caching, error handling |
| `settings.js` | API key management, provider selection |

### Message Types

| Type | Direction | Payload |
|------|-----------|---------|
| `EXTRACT_CONTENT` | popup → content | — |
| `SUMMARIZE` | popup → background | `{url, title, content, mode}` |
| `CLEAR_CACHE` | popup → background | `{url?}` |
| `GET_SETTINGS` | popup → background | — |
| `HIGHLIGHT_TOPICS` | popup → content | `{topics}` |
| `CLEAR_HIGHLIGHTS` | popup → content | — |

---

## AI Integration

### Provider Support

| Provider | Models | Notes |
|----------|--------|-------|
| OpenAI | gpt-4o-mini, gpt-4o, gpt-3.5-turbo | Recommended: gpt-4o-mini (fast + cheap) |
| Google Gemini | gemini-1.5-flash | Free tier available |

### Prompt Design

The extension sends a structured prompt instructing the model to return **only JSON** (no markdown fences). The response schema:

```json
{
  "summary": ["bullet 1", "bullet 2"],
  "keyInsights": ["insight 1"],
  "topics": ["topic1", "topic2"],
  "sentiment": "positive | neutral | negative",
  "contentType": "article | news | documentation | blog | other"
}
```

Content is truncated to 6,000 characters before sending to stay within token limits.

### Summary Modes

| Mode | Summary bullets | Key insights | Topics |
|------|----------------|-------------|--------|
| Brief | 3 | 1 | up to 3 |
| Standard | 4–6 | 3 | up to 5 |
| Detailed | 7–10 | 5 | up to 8 |

---

## Security Decisions

| Decision | Rationale |
|----------|-----------|
| API key in `chrome.storage.local` (not `sync`) | Prevents key from syncing across devices via Google account |
| All API calls in `background.js` | The key never touches `popup.js` or `content.js` — it lives only in the service worker context |
| No API key in `content_scripts` | Content scripts run in page context; any data there is accessible to page JS |
| `content_security_policy` set | Restricts script sources to `'self'` only |
| Minimal permissions | Only `activeTab`, `scripting`, `storage` + specific `host_permissions` for the two AI APIs |
| DOM sanitization via `textContent` | All AI-generated text inserted via `.textContent` (never `.innerHTML`), preventing XSS |
| CSS-only highlight injection | Highlight styles use a static `<style>` tag with no user-controlled values |
| Input validation in settings | Provider-specific key format checks before saving |

---

## Trade-offs

| Trade-off | Decision |
|-----------|----------|
| **Client-side vs proxy server** | Chosen: client-side (background SW). Pro: no server to maintain, no additional cost. Con: extension must store key locally. Mitigated by using `chrome.storage.local` (not `sync`, not `session`). |
| **Token limit vs quality** | Content truncated to 6,000 chars. Enough for most articles; may miss content on very long pages. |
| **Cache TTL** | 30 minutes balances freshness vs. API costs. Configurable in `background.js`. |
| **Readability parser** | Used heuristic extraction (semantic selectors + noise removal) instead of a bundled readability library to keep the extension lightweight (no build step required). |
| **Single-file extension** | No bundler/transpiler needed — plain ES modules. Pro: simple to load and audit. Con: no tree-shaking. |

---

## Local Installation (No Chrome Web Store)

This extension is **not** published to the Chrome Web Store. To install:

1. Download or clone this repository
2. Follow steps in **Setup Instructions** above
3. The extension stays in **Developer mode** — Chrome will show a banner; this is expected for unpacked extensions
4. To update: edit files, then click the ↺ refresh icon on `chrome://extensions`

---

## Development Notes

- To inspect the background service worker: `chrome://extensions` → PageMind → **Service Worker** link
- To inspect the popup: right-click the popup → **Inspect**
- To see content script logs: open DevTools on the page being summarized → Console

---

## Requirements

- Chrome 88+ (Manifest V3 support)
- An OpenAI or Google Gemini API key with sufficient quota
