// popup.js — Popup controller (no API keys needed!)

(() => {
  const $ = (id) => document.getElementById(id);
  const el = {
    pageTitle:      $("pageTitle"),
    pageUrl:        $("pageUrl"),
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
    return RESTRICTED_PREFIXES.some(p => url.startsWith(p));
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  async function init() {
    state.activeTab = await getActiveTab();
    if (!state.activeTab) return showError("Could not access the current tab.");

    state.currentUrl = state.activeTab.url || "";
    setPageMeta(state.activeTab.title, state.currentUrl);

    if (isRestrictedUrl(state.currentUrl)) {
      showError("PageMind cannot run on browser internal pages. Navigate to a regular webpage.");
      el.summarizeBtn.disabled = true;
    }
  }

  // ── Event listeners ────────────────────────────────────────────────────────
  el.summarizeBtn.addEventListener("click", handleSummarize);
  el.clearBtn.addEventListener("click", handleClear);
  el.settingsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());
  el.copySummary.addEventListener("click", handleCopy);
  el.highlightBtn.addEventListener("click", handleHighlightToggle);

  el.modeTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      el.modeTabs.forEach(t => { t.classList.remove("active"); t.setAttribute("aria-selected", "false"); });
      tab.classList.add("active");
      tab.setAttribute("aria-selected", "true");
      state.mode = tab.dataset.mode;
    });
  });

  // ── Summarize ──────────────────────────────────────────────────────────────
  async function handleSummarize() {
    clearError();
    setLoading(true, "Extracting content…");
    el.emptyState.hidden = true;
    el.results.hidden    = true;
    el.clearBtn.hidden   = true;

    try {
      const extracted = await ensureContentScriptAndExtract(state.activeTab.id);

      if (!extracted) {
        throw new Error("Could not connect to this page. Try refreshing (Ctrl+R) and summarizing again.");
      }
      if (extracted.error) {
        throw new Error("Failed to extract page content. Try refreshing and summarizing again.");
      }
      if (!extracted.text || extracted.text.length < 80) {
        throw new Error("Not enough readable text found on this page. Try a different page or wait for it to fully load.");
      }

      setLoadingText("Sending to AI… (this may take 15–30 seconds)");

      const result = await sendToBackground({
        type: "SUMMARIZE",
        payload: {
          url:     extracted.url,
          title:   extracted.title,
          content: extracted.text,
          mode:    state.mode,
        },
      });

      if (result?.error) throw new Error(friendlyError(result.error));
      if (!result || !result.summary) throw new Error("Received an unexpected response. Please try again.");

      renderResults(result);

    } catch (err) {
      showError(err.message);
      el.emptyState.hidden = false;
    } finally {
      setLoading(false);
    }
  }

  async function ensureContentScriptAndExtract(tabId) {
    const first = await sendToTab(tabId, { type: "EXTRACT_CONTENT" });
    if (first !== null) return first;

    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    } catch {
      return null;
    }

    for (let i = 0; i < 3; i++) {
      await sleep(300);
      const attempt = await sendToTab(tabId, { type: "EXTRACT_CONTENT" });
      if (attempt !== null) return attempt;
    }
    return null;
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  function renderResults(data) {
    el.readingTime.textContent = data.readingTime ?? "—";
    el.contentType.textContent = data.contentType ?? "—";

    const sentiment             = data.sentiment || "neutral";
    el.sentimentBadge.className = `stat sentiment-badge ${sentiment}`;
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

    state.lastSummaryText  = (data.summary || []).map(b => `• ${b}`).join("\n");
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

  async function handleCopy() {
    if (!state.lastSummaryText) return;
    try {
      await navigator.clipboard.writeText(state.lastSummaryText);
      el.copySummary.classList.add("copied");
      setTimeout(() => el.copySummary.classList.remove("copied"), 1800);
    } catch {}
  }

  async function handleHighlightToggle() {
    if (!state.currentTopics.length) return;
    if (state.highlightsActive) {
      await sendToTab(state.activeTab.id, { type: "CLEAR_HIGHLIGHTS" });
      state.highlightsActive = false;
      el.highlightBtn.classList.remove("active");
    } else {
      await sendToTab(state.activeTab.id, { type: "HIGHLIGHT_TOPICS", payload: { topics: state.currentTopics } });
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
    if (text) el.loadingText.textContent = text;
  }

  function setLoadingText(text) { el.loadingText.textContent = text; }
  function showError(msg)  { el.errorAlert.hidden = false; el.errorMsg.textContent = msg; }
  function clearError()    { el.errorAlert.hidden = true; el.errorMsg.textContent = ""; }
  function sleep(ms)       { return new Promise(r => setTimeout(r, ms)); }

  function sendToBackground(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
        else resolve(response);
      });
    });
  }

  function sendToTab(tabId, message) {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(response);
      });
    });
  }

  async function getActiveTab() {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs?.[0] || null));
    });
  }

  function sanitize(str) { return String(str ?? "").slice(0, 800); }

  function friendlyError(code) {
    if (!code) return "Something went wrong. Please try again.";
    const map = {
      RATE_LIMITED:        "Too many requests. Please wait a moment and try again.",
      TIMEOUT:             "Gemini took too long to respond (90s). Please try again.",
      NETWORK_ERROR:       "Network error — check your internet connection.",
      BACKEND_UNREACHABLE: "Cannot reach the PageMind backend. Make sure it is deployed on Render and the URL is set correctly in Settings.",
      SERVER_ERROR:        "Server error. Please try again shortly.",
      EMPTY_RESPONSE:      "AI returned an empty response. Try a different page or mode.",
      TOO_SHORT:           "Not enough text on this page to summarize.",
    };
    return map[code] || code;
  }

  init();
})();