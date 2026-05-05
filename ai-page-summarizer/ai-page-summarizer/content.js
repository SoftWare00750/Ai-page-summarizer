// content.js — Content Script
// Extracts clean, readable content from the page.
// Runs in the page context but communicates safely via chrome.runtime messaging.

(function () {
  // ── Message listener ──────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "EXTRACT_CONTENT") {
      const extracted = extractContent();
      sendResponse(extracted);
    }

    if (message.type === "HIGHLIGHT_TOPICS") {
      highlightTopics(message.payload?.topics || []);
      sendResponse({ ok: true });
    }

    if (message.type === "CLEAR_HIGHLIGHTS") {
      clearHighlights();
      sendResponse({ ok: true });
    }

    return true;
  });

  // ── Content extractor ─────────────────────────────────────────────────────
  function extractContent() {
    const title = getTitle();
    const text = getMainContent();
    const wordCount = text.trim().split(/\s+/).length;
    const url = window.location.href;

    return { title, text, wordCount, url };
  }

  function getTitle() {
    // Prefer OG title, then document title, then h1
    const og = document.querySelector('meta[property="og:title"]');
    if (og?.content) return og.content.trim();

    const h1 = document.querySelector("h1");
    if (h1?.innerText) return h1.innerText.trim();

    return document.title.trim();
  }

  function getMainContent() {
    // Priority order: semantic article > main > largest text block > body
    const candidates = [
      document.querySelector("article"),
      document.querySelector('[role="main"]'),
      document.querySelector("main"),
      document.querySelector(".post-content, .article-body, .entry-content, .content-body"),
      document.querySelector("#content, #main-content, #article-body"),
      document.body,
    ].filter(Boolean);

    for (const el of candidates) {
      const text = extractText(el);
      if (text.length > 400) return text;
    }

    return extractText(document.body);
  }

  function extractText(root) {
    // Clone to avoid mutating the DOM
    const clone = root.cloneNode(true);

    // Remove noisy elements
    const noisy = [
      "script", "style", "noscript", "iframe", "nav", "header",
      "footer", "aside", "form", "button", "input", "select",
      "textarea", "figure > figcaption", ".ad", ".ads", ".advertisement",
      ".sidebar", ".widget", ".comment", ".comments", ".related",
      ".share", ".social", ".navigation", ".menu", ".cookie",
      "[aria-hidden='true']", ".visually-hidden",
    ];

    noisy.forEach((sel) => {
      clone.querySelectorAll(sel).forEach((el) => el.remove());
    });

    // Get text with spacing preserved
    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
    const parts = [];
    let node;

    while ((node = walker.nextNode())) {
      const text = node.textContent.trim();
      if (text.length > 20) {
        // Filter short fragments (nav items, labels)
        parts.push(text);
      }
    }

    return parts.join(" ").replace(/\s{2,}/g, " ").trim();
  }

  // ── Highlighter ───────────────────────────────────────────────────────────
  const HIGHLIGHT_CLASS = "pagemind-highlight";
  const HIGHLIGHT_MARK_CLASS = "pagemind-mark";

  function highlightTopics(topics) {
    clearHighlights();
    if (!topics.length) return;

    injectHighlightStyles();

    const pattern = topics
      .filter((t) => t.length > 2)
      .map((t) => escapeRegex(t))
      .join("|");

    if (!pattern) return;

    const regex = new RegExp(`(${pattern})`, "gi");
    walkAndHighlight(document.body, regex);
  }

  function walkAndHighlight(node, regex) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent;
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
        mark.textContent = match[0];
        frag.appendChild(mark);
        last = regex.lastIndex;
      }

      if (last < text.length) {
        frag.appendChild(document.createTextNode(text.slice(last)));
      }

      node.parentNode?.replaceChild(frag, node);
      return;
    }

    // Skip scripts, styles, and our own marks
    if (
      node.nodeType !== Node.ELEMENT_NODE ||
      node.tagName === "SCRIPT" ||
      node.tagName === "STYLE" ||
      node.tagName === "MARK" ||
      node.classList?.contains(HIGHLIGHT_MARK_CLASS)
    )
      return;

    // Process children (static array to avoid live list issues)
    Array.from(node.childNodes).forEach((child) => walkAndHighlight(child, regex));
  }

  function clearHighlights() {
    document.querySelectorAll(`.${HIGHLIGHT_MARK_CLASS}`).forEach((mark) => {
      const parent = mark.parentNode;
      if (!parent) return;
      parent.replaceChild(document.createTextNode(mark.textContent), mark);
      parent.normalize();
    });

    const style = document.getElementById("pagemind-styles");
    if (style) style.remove();
  }

  function injectHighlightStyles() {
    if (document.getElementById("pagemind-styles")) return;
    const style = document.createElement("style");
    style.id = "pagemind-styles";
    // Sanitized inline — no user content in CSS
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
