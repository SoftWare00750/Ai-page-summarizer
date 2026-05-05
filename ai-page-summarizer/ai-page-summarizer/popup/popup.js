// popup.js — Popup controller

(() => {
  // ── DOM refs ───────────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const el = {
    pageTitle:    $("pageTitle"),
    pageUrl:      $("pageUrl"),
    noKeyAlert:   $("noKeyAlert"),
    goToSettings: $("goToSettings"),
    errorAlert:   $("errorAlert"),
    errorMsg:     $("errorMsg"),
    settingsBtn:  $("settingsBtn"),
    summarizeBtn: $("summarizeBtn"),
    clearBtn:     $("clearBtn"),
    loadingState: $("loadingState"),
    loadingText:  $("loadingText"),
    results:      $("results"),
    emptyState:   $("emptyState"),
    readingTime:  $("readingTime"),
    contentType:  $("contentType"),
    sentimentBadge: $("sentimentBadge"),
    sentimentText:  $("sentimentText"),
    cacheBadge:   $("cacheBadge"),
    summaryList:  $("summaryList"),
    insightList:  $("insightList"),
    topicsList:   $("topicsList"),
    copySummary:  $("copySummary"),
    highlightBtn: $("highlightBtn"),
    modeTabs:     document.querySelectorAll(".mode-tab"),
  };

  // ── State ──────────────────────────────────────────────────────────────────
  let state = {
    mode: "default",
    activeTab: null,
    currentUrl: "",
    highlightsActive: false,
    currentTopics: [],
    lastSummaryText: "",
  };

  // ── Init ───────────────────────────────────────────────────────────────────
  async function init() {
    state.activeTab = await getActiveTab();
    if (!state.activeTab) return showError("Could not access the current tab.");

    state.currentUrl = state.activeTab.url || "";
    setPageMeta(state.activeTab.title, state.currentUrl);

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
      el.modeTabs.forEach((t) => { t.classList.remove("active"); t.setAttribute("aria-selected","false"); });
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
    el.results.hidden = true;
    el.clearBtn.hidden = true;

    try {
      // 1. Extract page content via content script
      const extracted = await sendToTab(state.activeTab.id, { type: "EXTRACT_CONTENT" });
      if (!extracted?.text || extracted.text.length < 100) {
        throw new Error("Not enough readable content found on this page.");
      }

      setLoadingText("Summarizing with AI…");

      // 2. Send to background for AI call
      const result = await sendToBackground({
        type: "SUMMARIZE",
        payload: {
          url: extracted.url,
          title: extracted.title,
          content: extracted.text,
          mode: state.mode,
        },
      });

      if (result?.error) {
        throw new Error(friendlyError(result.error));
      }

      // 3. Render results
      renderResults(result);

    } catch (err) {
      showError(err.message);
      el.emptyState.hidden = false;
    } finally {
      setLoading(false);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  function renderResults(data) {
    // Stats
    el.readingTime.textContent  = data.readingTime ?? "—";
    el.contentType.textContent  = data.contentType ?? "—";

    const sentiment = data.sentiment || "neutral";
    el.sentimentBadge.className = `stat sentiment-badge ${sentiment}`;
    el.sentimentText.textContent = sentiment;
    el.cacheBadge.hidden = !data.fromCache;

    // Summary bullets
    el.summaryList.innerHTML = "";
    (data.summary || []).forEach((point) => {
      const li = document.createElement("li");
      li.textContent = sanitize(point);
      el.summaryList.appendChild(li);
    });

    // Key insights
    el.insightList.innerHTML = "";
    (data.keyInsights || []).forEach((insight) => {
      const li = document.createElement("li");
      li.textContent = sanitize(insight);
      el.insightList.appendChild(li);
    });

    // Topics chips
    state.currentTopics = data.topics || [];
    el.topicsList.innerHTML = "";
    state.currentTopics.forEach((topic) => {
      const chip = document.createElement("span");
      chip.className = "topic-chip";
      chip.textContent = sanitize(topic);
      el.topicsList.appendChild(chip);
    });

    // Copy text
    state.lastSummaryText = (data.summary || []).join("\n• ");

    // Show / hide
    el.results.hidden = false;
    el.clearBtn.hidden = false;
    el.emptyState.hidden = true;
    state.highlightsActive = false;
    el.highlightBtn.classList.remove("active");
  }

  // ── Clear ──────────────────────────────────────────────────────────────────
  async function handleClear() {
    // Clear highlights if active
    if (state.highlightsActive) {
      await sendToTab(state.activeTab.id, { type: "CLEAR_HIGHLIGHTS" });
      state.highlightsActive = false;
    }

    // Clear from cache
    await sendToBackground({ type: "CLEAR_CACHE", payload: { url: state.currentUrl } });

    el.results.hidden = true;
    el.clearBtn.hidden = true;
    el.emptyState.hidden = false;
    clearError();
  }

  // ── Copy summary ───────────────────────────────────────────────────────────
  async function handleCopy() {
    if (!state.lastSummaryText) return;
    try {
      await navigator.clipboard.writeText(`• ${state.lastSummaryText}`);
      el.copySummary.classList.add("copied");
      setTimeout(() => el.copySummary.classList.remove("copied"), 1800);
    } catch {
      // Clipboard API may not be available in all extension contexts
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
        type: "HIGHLIGHT_TOPICS",
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
    el.loadingState.hidden = !on;
    el.summarizeBtn.disabled = on;
    if (text) setLoadingText(text);
  }

  function setLoadingText(text) {
    el.loadingText.textContent = text;
  }

  function showError(msg) {
    el.errorAlert.hidden = false;
    el.errorMsg.textContent = msg;
  }

  function clearError() {
    el.errorAlert.hidden = true;
    el.errorMsg.textContent = "";
  }

  function openSettings() {
    chrome.runtime.openOptionsPage();
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
    // Only use .textContent assignment (already XSS-safe) — this is a belt-and-suspenders guard
    return String(str).slice(0, 500);
  }

  // ── Error messages ─────────────────────────────────────────────────────────
  function friendlyError(code) {
    const map = {
      NO_API_KEY:      "No API key set. Click the settings icon to add one.",
      INVALID_API_KEY: "Invalid API key. Please check your settings.",
      RATE_LIMITED:    "AI API rate limit hit. Wait a moment and try again.",
    };
    return map[code] || code || "Something went wrong. Please try again.";
  }

  // ── Start ──────────────────────────────────────────────────────────────────
  init();
})();
