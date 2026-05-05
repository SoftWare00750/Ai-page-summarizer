// popup.js — Popup controller

(() => {
  // ── DOM refs ───────────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const el = {
    pageTitle:      $("pageTitle"),
    pageUrl:        $("pageUrl"),
    noKeyAlert:     $("noKeyAlert"),
    goToSettings:   $("goToSettings"),
    errorAlert:     $("errorAlert"),
    errorMsg:       $("errorMsg"),
    settingsBtn:    $("settingsBtn"),
    summarizeBtn:   $("summarizeBtn"),
    clearBtn:       $("clearBtn"),
    loadingState:   $("loadingState"),
    loadingText:    $("loadingText"),
    results:        $("results"),
    emptyState:     $("emptyState"),
    readingTime:    $("readingTime"),
    contentType:    $("contentType"),
    sentimentBadge: $("sentimentBadge"),
    sentimentText:  $("sentimentText"),
    cacheBadge:     $("cacheBadge"),
    summaryList:    $("summaryList"),
    insightList:    $("insightList"),
    topicsList:     $("topicsList"),
    copySummary:    $("copySummary"),
    highlightBtn:   $("highlightBtn"),
    modeTabs:       document.querySelectorAll(".mode-tab"),
  };

  // ── State ──────────────────────────────────────────────────────────────────
  let state = {
    mode:             "default",
    activeTab:        null,
    currentUrl:       "",
    highlightsActive: false,
    currentTopics:    [],
    lastSummaryText:  "",
  };

  const RESTRICTED_PREFIXES = [
    "chrome://", "chrome-extension://", "about:", "edge://",
    "brave://", "opera://", "vivaldi://", "moz-extension://",
    "file://", "data:", "javascript:",
  ];

  function isRestrictedUrl(url) {
    if (!url) return true;
    return RESTRICTED_PREFIXES.some((prefix) => url.startsWith(prefix));
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  async function init() {
    state.activeTab = await getActiveTab();
    if (!state.activeTab) return showError("Could not access the current tab.");

    state.currentUrl = state.activeTab.url || "";
    setPageMeta(state.activeTab.title, state.currentUrl);

    if (isRestrictedUrl(state.currentUrl)) {
      showError("PageMind cannot run on browser internal pages. Please navigate to a regular webpage.");
      el.summarizeBtn.disabled = true;
      return;
    }

    const settings = await sendToBackground({ type: "GET_SETTINGS" });
    if (!settings?.apiKey) {
      el.noKeyAlert.hidden = false;
    }
  }

  // ── Event listeners ────────────────────────────────────────────────────────
  el.summarizeBtn.addEventListener("click", handleSummarize);
  el.clearBtn.addEventListener("click", handleClear);
  el.settingsBtn.addEventListener("click", openSettings);
  el.goToSettings.addEventListener("click", openSettings);
  el.copySummary.addEventListener("click", handleCopy);
  el.highlightBtn.addEventListener("click", handleHighlightToggle);

  el.modeTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      el.modeTabs.forEach((t) => {
        t.classList.remove("active");
        t.setAttribute("aria-selected", "false");
      });
      tab.classList.add("active");
      tab.setAttribute("aria-selected", "true");
      state.mode = tab.dataset.mode;
    });
  });

  // ── Summarize ──────────────────────────────────────────────────────────────
  async function handleSummarize() {
    clearError();
    el.noKeyAlert.hidden = true;

    setLoading(true, "Extracting content…");
    el.emptyState.hidden = true;
    el.results.hidden    = true;
    el.clearBtn.hidden   = true;

    try {
      await ensureContentScript(state.activeTab.id);

      const extracted = await sendToTab(state.activeTab.id, { type: "EXTRACT_CONTENT" });

      if (!extracted) {
        throw new Error(
          "Could not connect to this page. Try refreshing the page (Ctrl+R) and summarizing again."
        );
      }

      if (!extracted.text || extracted.text.length < 80) {
        throw new Error(
          "Not enough readable text found on this page. " +
          "Try a different page or wait for the page to fully load."
        );
      }

      setLoadingText("Summarizing with AI…");

      const result = await sendToBackground({
        type: "SUMMARIZE",
        payload: {
          url:     extracted.url,
          title:   extracted.title,
          content: extracted.text,
          mode:    state.mode,
        },
      });

      if (result?.error) {
        throw new Error(friendlyError(result.error));
      }

      if (!result || !result.summary) {
        throw new Error("Received an unexpected response from AI. Please try again.");
      }

      renderResults(result);

    } catch (err) {
      showError(err.message);
      el.emptyState.hidden = false;
    } finally {
      setLoading(false);
    }
  }

  // ── Inject content script if needed ───────────────────────────────────────
  async function ensureContentScript(tabId) {
    try {
      const probe = await sendToTab(tabId, { type: "EXTRACT_CONTENT" });
      if (probe !== null) return;
    } catch (e) {
      // fall through to injection
    }

    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      await sleep(150);
    } catch (e) {
      // Injection may fail on restricted pages — caller handles null response
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  function renderResults(data) {
    el.readingTime.textContent = data.readingTime ?? "—";
    el.contentType.textContent = data.contentType ?? "—";

    const sentiment              = data.sentiment || "neutral";
    el.sentimentBadge.className  = `stat sentiment-badge ${sentiment}`;
    el.sentimentText.textContent = sentiment;
    el.cacheBadge.hidden         = !data.fromCache;

    el.summaryList.innerHTML = "";
    (data.summary || []).forEach((point) => {
      const li = document.createElement("li");
      li.textContent = sanitize(point);
      el.summaryList.appendChild(li);
    });

    el.insightList.innerHTML = "";
    (data.keyInsights || []).forEach((insight) => {
      const li = document.createElement("li");
      li.textContent = sanitize(insight);
      el.insightList.appendChild(li);
    });

    state.currentTopics     = data.topics || [];
    el.topicsList.innerHTML = "";
    state.currentTopics.forEach((topic) => {
      const chip       = document.createElement("span");
      chip.className   = "topic-chip";
      chip.textContent = sanitize(topic);
      el.topicsList.appendChild(chip);
    });

    state.lastSummaryText = (data.summary || []).map((b) => `• ${b}`).join("\n");

    el.results.hidden      = false;
    el.clearBtn.hidden     = false;
    el.emptyState.hidden   = true;
    state.highlightsActive = false;
    el.highlightBtn.classList.remove("active");
  }

  // ── Clear ──────────────────────────────────────────────────────────────────
  async function handleClear() {
    if (state.highlightsActive) {
      await sendToTab(state.activeTab.id, { type: "CLEAR_HIGHLIGHTS" });
      state.highlightsActive = false;
    }
    await sendToBackground({ type: "CLEAR_CACHE", payload: { url: state.currentUrl } });

    el.results.hidden    = true;
    el.clearBtn.hidden   = true;
    el.emptyState.hidden = false;
    clearError();
  }

  // ── Copy summary ───────────────────────────────────────────────────────────
  async function handleCopy() {
    if (!state.lastSummaryText) return;
    try {
      await navigator.clipboard.writeText(state.lastSummaryText);
      el.copySummary.classList.add("copied");
      setTimeout(() => el.copySummary.classList.remove("copied"), 1800);
    } catch {
      // Clipboard API may be unavailable
    }
  }

  // ── Highlight toggle ───────────────────────────────────────────────────────
  async function handleHighlightToggle() {
    if (!state.currentTopics.length) return;

    if (state.highlightsActive) {
      await sendToTab(state.activeTab.id, { type: "CLEAR_HIGHLIGHTS" });
      state.highlightsActive = false;
      el.highlightBtn.classList.remove("active");
    } else {
      await sendToTab(state.activeTab.id, {
        type:    "HIGHLIGHT_TOPICS",
        payload: { topics: state.currentTopics },
      });
      state.highlightsActive = true;
      el.highlightBtn.classList.add("active");
    }
  }

  // ── UI helpers ─────────────────────────────────────────────────────────────
  function setPageMeta(title, url) {
    el.pageTitle.textContent = title || "Untitled page";
    try {
      const u = new URL(url);
      el.pageUrl.textContent = u.hostname + (u.pathname !== "/" ? u.pathname : "");
    } catch {
      el.pageUrl.textContent = "";
    }
  }

  function setLoading(on, text) {
    el.loadingState.hidden   = !on;
    el.summarizeBtn.disabled = on;
    if (text) setLoadingText(text);
  }

  function setLoadingText(text) {
    el.loadingText.textContent = text;
  }

  function showError(msg) {
    el.errorAlert.hidden    = false;
    el.errorMsg.textContent = msg;
  }

  function clearError() {
    el.errorAlert.hidden    = true;
    el.errorMsg.textContent = "";
  }

  function openSettings() {
    chrome.runtime.openOptionsPage();
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // ── Messaging helpers ──────────────────────────────────────────────────────
  function sendToBackground(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ error: chrome.runtime.lastError.message });
        } else {
          resolve(response);
        }
      });
    });
  }

  function sendToTab(tabId, message) {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          resolve(null);
        } else {
          resolve(response);
        }
      });
    });
  }

  async function getActiveTab() {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        resolve(tabs?.[0] || null);
      });
    });
  }

  // ── Security: sanitise text before inserting into DOM ─────────────────────
  function sanitize(str) {
    return String(str ?? "").slice(0, 800);
  }

  // ── Friendly error messages ────────────────────────────────────────────────
  function friendlyError(code) {
    if (!code) return "Something went wrong. Please try again.";

    const map = {
      NO_API_KEY:      "No API key set. Click the settings icon (⚙) to add one.",
      INVALID_API_KEY: "Invalid API key. Please check your key in Settings.",
      RATE_LIMITED:    "Rate limit reached. Please wait a moment and try again.",
      QUOTA_EXCEEDED:  "Gemini API quota exhausted for today. Try again tomorrow, switch to a different model (Gemini 2.0 Flash is recommended), or upgrade to a paid plan.",
      NETWORK_ERROR:   "Network error — check your internet connection and try again.",
      REQUEST_TIMEOUT: "The request timed out (45s). Check your connection and try again.",
      EMPTY_RESPONSE:  "The AI returned an empty response. Try a different page or mode.",
      SERVER_ERROR:    "The AI service is temporarily unavailable. Please try again shortly.",
    };

    if (code.startsWith("MODEL_NOT_FOUND:")) {
      const model = code.split(":")[1]?.trim();
      return `Model "${model}" not found or not available on your plan. Please select a different model in Settings.`;
    }

    if (code.startsWith("GEMINI_ERROR:")) {
      const detail = code.split(":").slice(1).join(":").trim();
      return `Gemini API error: ${detail}. Please check your API key and model selection in Settings.`;
    }

    if (code.startsWith("BLOCKED:")) {
      return "This page's content was blocked by the AI's safety filters.";
    }

    return map[code] || code;
  }

  // ── Start ──────────────────────────────────────────────────────────────────
  init();
})();