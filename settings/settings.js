// settings.js — Settings page controller v2

(() => {
  const $ = (id) => document.getElementById(id);

  const el = {
    providerSelect:    $("providerSelect"),
    modelSelect:       $("modelSelect"),
    modelField:        $("modelField"),
    geminiModelSelect: $("geminiModelSelect"),
    geminiModelField:  $("geminiModelField"),
    claudeModelSelect: $("claudeModelSelect"),
    claudeModelField:  $("claudeModelField"),
    apiKeyInput:       $("apiKeyInput"),
    keyLabel:          $("keyLabel"),
    keyHint:           $("keyHint"),
    toggleKey:         $("toggleKey"),
    backendUrlInput:   $("backendUrlInput"),
    pingBtn:           $("pingBtn"),
    pingResult:        $("pingResult"),
    clearCacheBtn:     $("clearCacheBtn"),
    saveBtn:           $("saveBtn"),
    cancelBtn:         $("cancelBtn"),
    toast:             $("toast"),
    directPanel:       $("directPanel"),
    backendPanel:      $("backendPanel"),
    modeToggle:        $("modeToggle"),
  };

  let currentMode = "direct"; // "direct" | "backend"

  const PROVIDER_META = {
    openai: {
      label:       "OpenAI API Key",
      placeholder: "sk-…",
      hint: `Get your key at <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener">platform.openai.com/api-keys</a>`,
      prefix: "sk-",
    },
    gemini: {
      label:       "Google Gemini API Key",
      placeholder: "AIza…",
      hint: `Get your free key at <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener">aistudio.google.com/app/apikey</a>`,
      prefix: "AIza",
    },
    claude: {
      label:       "Anthropic API Key",
      placeholder: "sk-ant-…",
      hint: `Get your key at <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com/settings/keys</a>`,
      prefix: "sk-ant-",
    },
  };

  // ── Load saved settings ───────────────────────────────────────────────────
  function load() {
    chrome.storage.local.get(
      ["apiKey", "provider", "model", "geminiModel", "claudeModel", "backendUrl", "aiMode"],
      (data) => {
        // Restore mode
        const mode = data.aiMode || (data.apiKey ? "direct" : "backend");
        setMode(mode, false);

        // Provider + models
        el.providerSelect.value    = data.provider    || "openai";
        el.modelSelect.value       = data.model       || "gpt-4o-mini";
        el.geminiModelSelect.value = data.geminiModel || "gemini-2.0-flash";
        el.claudeModelSelect.value = data.claudeModel || "claude-haiku-4-5-20251001";
        el.apiKeyInput.value       = data.apiKey      || "";

        // Backend URL
        el.backendUrlInput.value   = data.backendUrl  || "";

        updateProviderUI(el.providerSelect.value);
      }
    );
  }

  // ── Switch mode ───────────────────────────────────────────────────────────
  function setMode(mode, updateStorage = true) {
    currentMode = mode;
    el.directPanel.hidden  = mode !== "direct";
    el.backendPanel.hidden = mode !== "backend";

    el.modeToggle.querySelectorAll(".mode-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.mode === mode);
    });
  }

  // ── Update UI based on provider ───────────────────────────────────────────
  function updateProviderUI(provider) {
    const meta = PROVIDER_META[provider] || PROVIDER_META.openai;
    el.keyLabel.textContent    = meta.label;
    el.apiKeyInput.placeholder = meta.placeholder;
    el.keyHint.innerHTML       = meta.hint;

    el.modelField.hidden       = provider !== "openai";
    el.geminiModelField.hidden = provider !== "gemini";
    el.claudeModelField.hidden = provider !== "claude";
  }

  // ── Save ──────────────────────────────────────────────────────────────────
  function save() {
    const provider    = el.providerSelect.value;
    const model       = el.modelSelect.value;
    const geminiModel = el.geminiModelSelect.value;
    const claudeModel = el.claudeModelSelect.value;
    const backendUrl  = el.backendUrlInput.value.trim();

    if (currentMode === "direct") {
      const apiKey = el.apiKeyInput.value.trim();

      if (!apiKey) {
        showToast("Please enter an API key.", "error");
        el.apiKeyInput.focus();
        return;
      }

      const meta = PROVIDER_META[provider];
      if (meta && !apiKey.startsWith(meta.prefix)) {
        showToast(`${meta.label} should start with "${meta.prefix}". Please check your key.`, "error");
        return;
      }

      chrome.storage.local.set(
        { apiKey, provider, model, geminiModel, claudeModel, aiMode: "direct", backendUrl: backendUrl || "" },
        () => {
          if (chrome.runtime.lastError) {
            showToast("Failed to save settings.", "error");
          } else {
            showToast("✓ Settings saved!", "success");
          }
        }
      );
    } else {
      // Backend mode — clear apiKey so background.js falls through to backend
      const url = backendUrl || "https://pagemind-backend.onrender.com";
      chrome.storage.local.set(
        { apiKey: "", provider, model, geminiModel, claudeModel, aiMode: "backend", backendUrl: url },
        () => {
          if (chrome.runtime.lastError) {
            showToast("Failed to save settings.", "error");
          } else {
            showToast("✓ Settings saved!", "success");
          }
        }
      );
    }
  }

  // ── Test backend connection ───────────────────────────────────────────────
  async function pingBackend() {
    const url = (el.backendUrlInput.value.trim() || "https://pagemind-backend.onrender.com").replace(/\/$/, "");
    el.pingBtn.disabled = true;
    el.pingBtn.textContent = "Testing…";
    el.pingResult.hidden = true;

    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 12_000);
      const res = await fetch(`${url}/health`, { signal: controller.signal });
      const data = await res.json().catch(() => ({}));

      el.pingResult.hidden = false;
      if (res.ok) {
        el.pingResult.className = "ping-result ping-ok";
        el.pingResult.textContent = `✓ Connected — uptime ${data.uptime || "?"}`;
      } else {
        el.pingResult.className = "ping-result ping-fail";
        el.pingResult.textContent = `✗ Server returned ${res.status}`;
      }
    } catch (err) {
      el.pingResult.hidden = false;
      el.pingResult.className = "ping-result ping-fail";
      el.pingResult.textContent = err.name === "AbortError"
        ? "✗ Timed out — server may be cold-starting (wait 30s and retry)"
        : "✗ Could not reach server — check the URL";
    } finally {
      el.pingBtn.disabled = false;
      el.pingBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg> Test Connection`;
    }
  }

  // ── Clear cache ───────────────────────────────────────────────────────────
  function clearCache() {
    chrome.runtime.sendMessage({ type: "CLEAR_CACHE" }, () => {
      showToast("✓ Cache cleared.", "success");
    });
  }

  // ── Toast ─────────────────────────────────────────────────────────────────
  let toastTimer;
  function showToast(msg, type = "success") {
    el.toast.textContent = msg;
    el.toast.className   = `toast ${type}`;
    el.toast.hidden      = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, 3500);
  }

  // ── Toggle key visibility ─────────────────────────────────────────────────
  function toggleKeyVisibility() {
    const isPassword    = el.apiKeyInput.type === "password";
    el.apiKeyInput.type = isPassword ? "text" : "password";
    el.toggleKey.innerHTML = isPassword
      ? `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`
      : `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
  }

  // ── Event listeners ───────────────────────────────────────────────────────
  el.modeToggle.querySelectorAll(".mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => setMode(btn.dataset.mode));
  });

  el.providerSelect.addEventListener("change", (e) => updateProviderUI(e.target.value));
  el.saveBtn.addEventListener("click", save);
  el.cancelBtn.addEventListener("click", () => window.close());
  el.clearCacheBtn.addEventListener("click", clearCache);
  el.toggleKey.addEventListener("click", toggleKeyVisibility);
  el.pingBtn.addEventListener("click", pingBackend);
  el.apiKeyInput.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });

  // ── Init ──────────────────────────────────────────────────────────────────
  load();
})();