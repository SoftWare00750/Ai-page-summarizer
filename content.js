// content.js — Content Script
// Extracts clean, readable content from the page.
// Runs in the page context but communicates safely via chrome.runtime messaging.

(function () {
  // Guard: avoid double-injection
  if (window.__pageMindInjected) return;
  window.__pageMindInjected = true;

  // ── Message listener ──────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    try {
      if (message.type === "EXTRACT_CONTENT") {
        const extracted = extractContent();
        sendResponse(extracted);
        return true;
      }

      if (message.type === "HIGHLIGHT_TOPICS") {
        highlightTopics(message.payload?.topics || []);
        sendResponse({ ok: true });
        return true;
      }

      if (message.type === "CLEAR_HIGHLIGHTS") {
        clearHighlights();
        sendResponse({ ok: true });
        return true;
      }
    } catch (err) {
      sendResponse({ error: err.message });
    }

    return true; // keep channel open for all paths
  });

  // ── Content extractor ─────────────────────────────────────────────────────
  function extractContent() {
    const title     = getTitle();
    const text      = getMainContent();
    const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
    const url       = window.location.href;

    return { title, text, wordCount, url };
  }

  function getTitle() {
    // Prefer OG title > h1 > document.title
    const og = document.querySelector('meta[property="og:title"]');
    if (og?.content?.trim()) return og.content.trim();

    const h1 = document.querySelector("h1");
    if (h1?.innerText?.trim()) return h1.innerText.trim();

    return document.title.trim();
  }

  function getMainContent() {
    // Priority order: semantic article > main > largest text block > body
    const candidates = [
      document.querySelector("article"),
      document.querySelector('[role="main"]'),
      document.querySelector("main"),
      document.querySelector(".post-content"),
      document.querySelector(".article-body"),
      document.querySelector(".entry-content"),
      document.querySelector(".content-body"),
      document.querySelector("#content"),
      document.querySelector("#main-content"),
      document.querySelector("#article-body"),
      document.body,
    ].filter(Boolean);

    for (const el of candidates) {
      const text = extractText(el);
      if (text.length > 400) return text;
    }

    return extractText(document.body);
  }

  function extractText(root) {
    if (!root) return "";

    // Clone to avoid mutating the DOM
    const clone = root.cloneNode(true);

    // Remove noisy elements
    const noisy = [
      "script", "style", "noscript", "iframe", "nav", "header",
      "footer", "aside", "form", "button", "input", "select",
      "textarea", "figcaption", ".ad", ".ads", ".advertisement",
      ".sidebar", ".widget", ".comment", ".comments", ".related",
      ".share", ".social", ".navigation", ".menu", ".cookie",
      "[aria-hidden='true']", ".visually-hidden", "[hidden]",
      ".pagemind-mark",  // don't re-extract our own highlights
    ];

    noisy.forEach((sel) => {
      try {
        clone.querySelectorAll(sel).forEach((el) => el.remove());
      } catch (e) {
        // Invalid selector — skip it
      }
    });

    // Prefer innerText for rendered text (respects visibility)
    // Fall back to TreeWalker for cloned nodes
    const parts = [];
    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
    let node;

    while ((node = walker.nextNode())) {
      const text = node.textContent.trim();
      if (text.length > 20) {
        parts.push(text);
      }
    }

    return parts.join(" ").replace(/\s{2,}/g, " ").trim();
  }

  // ── Highlighter ───────────────────────────────────────────────────────────
  const HIGHLIGHT_MARK_CLASS = "pagemind-mark";
  const STYLE_ID = "pagemind-styles";

  function highlightTopics(topics) {
    clearHighlights();
    if (!topics || !topics.length) return;

    injectHighlightStyles();

    const validTopics = topics.filter((t) => typeof t === "string" && t.length > 2);
    if (!validTopics.length) return;

    const pattern = validTopics.map((t) => escapeRegex(t)).join("|");
    if (!pattern) return;

    const regex = new RegExp(`(${pattern})`, "gi");

    // Limit highlighting to main content area to avoid nav/footer noise
    const target = document.querySelector("article, [role='main'], main, #content, body") || document.body;
    walkAndHighlight(target, regex);
  }

  function walkAndHighlight(node, regex) {
    if (!node) return;

    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent;
      regex.lastIndex = 0;
      if (!regex.test(text)) return;
      regex.lastIndex = 0;

      const frag = document.createDocumentFragment();
      let last = 0;
      let match;

      while ((match = regex.exec(text)) !== null) {
        if (match.index > last) {
          frag.appendChild(document.createTextNode(text.slice(last, match.index)));
        }
        const mark = document.createElement("mark");
        mark.className = HIGHLIGHT_MARK_CLASS;
        mark.textContent = match[0]; // safe: textContent, not innerHTML
        frag.appendChild(mark);
        last = regex.lastIndex;
      }

      if (last < text.length) {
        frag.appendChild(document.createTextNode(text.slice(last)));
      }

      node.parentNode?.replaceChild(frag, node);
      return;
    }

    // Skip non-element nodes and excluded tags
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const tag = node.tagName?.toUpperCase();
    if (
      tag === "SCRIPT" ||
      tag === "STYLE" ||
      tag === "MARK" ||
      tag === "NOSCRIPT" ||
      tag === "TEXTAREA" ||
      tag === "INPUT" ||
      node.classList?.contains(HIGHLIGHT_MARK_CLASS)
    ) return;

    // Process children (static snapshot to avoid live list mutation issues)
    Array.from(node.childNodes).forEach((child) => walkAndHighlight(child, regex));
  }

  function clearHighlights() {
    document.querySelectorAll(`.${HIGHLIGHT_MARK_CLASS}`).forEach((mark) => {
      const parent = mark.parentNode;
      if (!parent) return;
      parent.replaceChild(document.createTextNode(mark.textContent || ""), mark);
      parent.normalize();
    });

    const style = document.getElementById(STYLE_ID);
    if (style) style.remove();
  }

  function injectHighlightStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .${HIGHLIGHT_MARK_CLASS} {
        background: rgba(99, 211, 168, 0.35) !important;
        color: inherit !important;
        border-radius: 2px !important;
        padding: 0 2px !important;
        border-bottom: 2px solid rgba(99, 211, 168, 0.8) !important;
      }
    `;
    document.head.appendChild(style);
  }

  function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

})();
