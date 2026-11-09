// QuietBrowse - shared data-i18n DOM applier (popup, options, onboarding)
// Replaces element text/placeholder/title with localized messages.
// Falls back silently to the HTML's built-in English when a key is missing.

function applyI18nDom(root) {
  if (typeof chrome === "undefined" || typeof chrome.i18n?.getMessage !== "function") return;
  const scope = root || document;
  for (const el of scope.querySelectorAll("[data-i18n]")) {
    const msg = chrome.i18n.getMessage(el.dataset.i18n);
    if (msg) el.textContent = msg;
  }
  for (const el of scope.querySelectorAll("[data-i18n-placeholder]")) {
    const msg = chrome.i18n.getMessage(el.dataset.i18nPlaceholder);
    if (msg) el.placeholder = msg;
  }
  for (const el of scope.querySelectorAll("[data-i18n-title]")) {
    const msg = chrome.i18n.getMessage(el.dataset.i18nTitle);
    if (msg) el.title = msg;
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => applyI18nDom(), { once: true });
} else {
  applyI18nDom();
}
