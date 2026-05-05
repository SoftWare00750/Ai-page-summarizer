// settings.js — Settings page controller

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
    checkModelsLink:   $("checkModelsLink"),
    apiKeyInput:       $("apiKeyInput"),
    keyLabel:          $("keyLabel"),
    keyHint:           $("keyHint"),
    toggleKey:         $("toggleKey"),
    clearCacheBtn:     $("clearCacheBtn"),
    saveBtn:           $("saveBtn"),
    cancelBtn:         $("cancelBtn"),
    toast:             $("toast"),
  };

  const PROVIDER_META = {
    openai: {
      label:       "OpenAI API Key",
      placeholder: "sk-…",
      hint: `Get your key at <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener">platform.openai.com/api-keys</a>`,
    },
    gemini: {
      label:       "Google Gemini API Key",
      placeholder: "AIza…",
      hint: `Get your free key at <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener">aistudio.google.com/app/apikey</a>`,
    },
    claude: {
      label:       "Anthropic API Key",
      placeholder: "sk-ant-…",
      hint: `Get your key at <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com/settings/keys</a>`,
    },
  };

  // ── Load saved settings ──────────────────────────────────────────────────
  function load() {
    chrome.storage.local.get(
      ["apiKey", "provider", "model", "geminiModel", "claudeModel"],
      (data) => {
        el.providerSelect.value    = data.provider    || "openai";
        el.modelSelect.value       = data.model       || "gpt-4o-mini";
        el.geminiModelSelect.value = data.geminiModel || "gemini-2.0-flash";
        el.claudeModelSelect.value = data.claudeModel || "claude-haiku-4-5-20251001";
        el.apiKeyInput.value       = data.apiKey      || "";
        updateProviderUI(el.providerSelect.value);
      }
    );
  }

  // ── Update UI based on selected provider ─────────────────────────────────
  function updateProviderUI(provider) {
    const meta = PROVIDER_META[provider] || PROVIDER_META.openai;
    el.keyLabel.textContent    = meta.label;
    el.apiKeyInput.placeholder = meta.placeholder;
    el.keyHint.innerHTML       = meta.hint; // trusted static strings only

    el.modelField.hidden       = provider !== "openai";
    el.geminiModelField.hidden = provider !== "gemini";
    el.claudeModelField.hidden = provider !== "claude";

    updateCheckModelsLink();
  }

  // ── Keep the "check available models" link current ───────────────────────
  function updateCheckModelsLink() {
    if (!el.checkModelsLink) return;
    const key = el.apiKeyInput.value.trim();
    el.checkModelsLink.href = key
      ? `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`
      : "https://aistudio.google.com/app/apikey";
  }

  // ── Save ──────────────────────────────────────────────────────────────────
  function save() {
    const apiKey      = el.apiKeyInput.value.trim();
    const provider    = el.providerSelect.value;
    const model       = el.modelSelect.value;
    const geminiModel = el.geminiModelSelect.value;
    const claudeModel = el.claudeModelSelect.value;

    if (!apiKey) {
      showToast("Please enter an API key.", "error");
      el.apiKeyInput.focus();
      return;
    }

    // Provider-specific key format validation
    if (provider === "openai" && !apiKey.startsWith("sk-")) {
      showToast("OpenAI keys start with sk-. Please check your key.", "error");
      return;
    }

    if (provider === "gemini" && !apiKey.startsWith("AIza")) {
      showToast("Gemini keys start with AIza. Please check your key.", "error");
      return;
    }

    if (provider === "claude" && !apiKey.startsWith("sk-ant-")) {
      showToast("Anthropic keys start with sk-ant-. Please check your key.", "error");
      return;
    }

    chrome.storage.local.set({ apiKey, provider, model, geminiModel, claudeModel }, () => {
      if (chrome.runtime.lastError) {
        showToast("Failed to save settings.", "error");
      } else {
        showToast("✓ Settings saved!", "success");
      }
    });
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
    const isPassword        = el.apiKeyInput.type === "password";
    el.apiKeyInput.type     = isPassword ? "text" : "password";
    el.toggleKey.innerHTML  = isPassword
      ? `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`
      : `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
  }

  // ── Event listeners ───────────────────────────────────────────────────────
  el.providerSelect.addEventListener("change", (e) => updateProviderUI(e.target.value));
  el.saveBtn.addEventListener("click", save);
  el.cancelBtn.addEventListener("click", () => window.close());
  el.clearCacheBtn.addEventListener("click", clearCache);
  el.toggleKey.addEventListener("click", toggleKeyVisibility);
  el.apiKeyInput.addEventListener("input", updateCheckModelsLink);
  el.apiKeyInput.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });

  // ── Init ──────────────────────────────────────────────────────────────────
  load();
})();