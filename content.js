// content.js — Content script
// Runs in the page context. Handles content extraction and topic highlighting.

(() => {
  // Guard against being injected multiple times
  if (window.__pageMindInjected) return;
  window.__pageMindInjected = true;

  // ── Message listener ─────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "EXTRACT_CONTENT") {
      try {
        const data = extractContent();
        sendResponse(data);
      } catch (err) {
        sendResponse({ error: err.message, title: "", text: "", url: "" });
      }
      return true;
    }

    if (message.type === "HIGHLIGHT_TOPICS") {
      try {
        highlightTopics(message.payload?.topics || []);
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ error: err.message });
      }
      return true;
    }

    if (message.type === "CLEAR_HIGHLIGHTS") {
      try {
        clearHighlights();
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ error: err.message });
      }
      return true;
    }
  });

  // ── Content extraction ───────────────────────────────────────────────────
  function extractContent() {
    const title = document.title || "";
    const url   = location.href  || "";

    // Remove noisy elements before extracting text
    const NOISE_SELECTORS = [
      "script", "style", "noscript", "iframe", "svg", "canvas",
      "nav", "header", "footer", "aside",
      '[role="navigation"]', '[role="banner"]', '[role="complementary"]',
      ".cookie-banner", ".ad", ".advertisement", ".sidebar",
      "#cookie-notice", "#newsletter-signup",
    ];

    // Clone body so we don't mutate the live DOM
    const clone = document.body?.cloneNode(true);
    if (!clone) return { title, url, text: "" };

    clone.querySelectorAll(NOISE_SELECTORS.join(",")).forEach((el) => el.remove());

    // Prefer semantic content containers
    const CONTENT_SELECTORS = [
      "article", "main", '[role="main"]',
      ".post-content", ".article-body", ".entry-content",
      ".content", "#content", ".post", "#main",
    ];

    let container = null;
    for (const sel of CONTENT_SELECTORS) {
      container = clone.querySelector(sel);
      if (container) break;
    }

    const source = container || clone;
    let text = source.innerText || source.textContent || "";

    // Normalise whitespace
    text = text
      .replace(/\t/g, " ")
      .replace(/[ ]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    return { title, url, text };
  }

  // ── Topic highlighting ───────────────────────────────────────────────────
  const HIGHLIGHT_STYLE_ID = "pagemind-highlight-style";
  const HIGHLIGHT_CLASS     = "pagemind-highlight";

  function highlightTopics(topics) {
    clearHighlights();
    if (!topics.length) return;

    // Inject highlight CSS once
    if (!document.getElementById(HIGHLIGHT_STYLE_ID)) {
      const style       = document.createElement("style");
      style.id          = HIGHLIGHT_STYLE_ID;
      style.textContent = `.${HIGHLIGHT_CLASS} {
        background: rgba(79, 255, 176, 0.28) !important;
        border-radius: 2px;
        outline: 1px solid rgba(79, 255, 176, 0.5);
      }`;
      document.head.appendChild(style);
    }

    // Build case-insensitive regex for all topics
    const escaped = topics.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const pattern = new RegExp(`\\b(${escaped.join("|")})\\b`, "gi");

    highlightInNode(document.body, pattern);
  }

  function highlightInNode(node, pattern) {
    if (!node) return;

    // Skip invisible or interactive elements
    const SKIP_TAGS = new Set([
      "SCRIPT", "STYLE", "NOSCRIPT", "IFRAME",
      "INPUT", "TEXTAREA", "SELECT", "BUTTON",
      "CODE", "PRE",
    ]);

    if (node.nodeType === Node.ELEMENT_NODE && SKIP_TAGS.has(node.tagName)) return;

    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || "";
      if (!pattern.test(text)) return;
      pattern.lastIndex = 0;

      const fragment = document.createDocumentFragment();
      let last = 0;
      let match;

      pattern.lastIndex = 0;
      while ((match = pattern.exec(text)) !== null) {
        if (match.index > last) {
          fragment.appendChild(document.createTextNode(text.slice(last, match.index)));
        }
        const mark       = document.createElement("mark");
        mark.className   = HIGHLIGHT_CLASS;
        mark.textContent = match[0];
        fragment.appendChild(mark);
        last = match.index + match[0].length;
      }

      if (last < text.length) {
        fragment.appendChild(document.createTextNode(text.slice(last)));
      }

      node.parentNode?.replaceChild(fragment, node);
      return;
    }

    // Recurse on children (iterate over a static copy to avoid live-NodeList issues)
    Array.from(node.childNodes).forEach((child) => highlightInNode(child, pattern));
  }

  function clearHighlights() {
    document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach((mark) => {
      const parent = mark.parentNode;
      if (!parent) return;
      parent.replaceChild(document.createTextNode(mark.textContent || ""), mark);
      parent.normalize();
    });
  }
})();