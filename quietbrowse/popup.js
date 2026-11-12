// QuietBrowse - popup logic

const siteEl = document.getElementById("site");
const faviconEl = document.getElementById("favicon");
const trustRowEl = document.getElementById("trustRow");
const trustScoreEl = document.getElementById("trustScore");
const trustLabelEl = document.getElementById("trustLabel");
const trustDetailEl = document.getElementById("trustDetail");
const trustReasonsEl = document.getElementById("trustReasons");
const trustActivityEl = document.getElementById("trustActivity");
const shieldBtn = document.getElementById("shieldBtn");
const pageCountEl = document.getElementById("pageCount");
const totalCountEl = document.getElementById("totalCount");
const trackerListEl = document.getElementById("trackerList");
const diagnosticsListEl = document.getElementById("diagnosticsList");
const siteModeSelect = document.getElementById("siteMode");
const siteRow = document.getElementById("siteRow");
const learnedEl = document.getElementById("learned");
const hintEl = document.getElementById("hint");
const filterHealthEl = document.getElementById("filterHealth");
const cookieOutcomeEl = document.getElementById("cookieOutcome");
const pageFixActiveEl = document.getElementById("pageFixActive");
const recoveryActionsEl = document.getElementById("recoveryActions");
const keepFixBtn = document.getElementById("keepFixBtn");
const restoreFixBtn = document.getElementById("restoreFixBtn");
const zapBtn = document.getElementById("zapBtn");
const fixSiteBtn = document.getElementById("fixSiteBtn");
const reportCheck = document.getElementById("reportCheck");
const optionsLink = document.getElementById("optionsLink");
const allowAdsBtn = document.getElementById("allowAdsBtn");

const CATEGORY_ORDER = ["advertising", "analytics", "social", "other", "learned"];

const TRUST_KEYS = {
  excellent: "trustExcellent",
  good: "trustGood",
  caution: "trustCaution",
  danger: "trustDanger",
  unknown: "trustUnknown",
  off: "trustOff"
};

let currentDomain = null;
let currentTabId = null;
let currentTabUrl = null;
let protectionEnabled = true;
let currentRecoveryStage = null;

optionsLink.href = chrome.runtime.getURL("options.html");

init();

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "tabUpdated" && msg.tabId === currentTabId) {
    pageCountEl.textContent = formatCount(msg.count);
    renderTrackers(msg.trackers);
    renderDiagnostics(msg.diagnostics || []);
    if (msg.learnedCount > 0) {
      learnedEl.textContent = i18n("learnedFooter", String(msg.learnedCount));
    }
  } else if (msg.type === "trustScoreUpdated" && currentTabId) {
    loadTrustScore(currentTabId);
  }
});

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id ?? null;
  currentTabUrl = tab?.url ?? null;

  if (tab?.url && /^https?:/.test(tab.url)) {
    currentDomain = new URL(tab.url).hostname.replace(/^www\./, "");
    siteEl.textContent = currentDomain;
    faviconEl.hidden = false;
    faviconEl.src = chrome.runtime.getURL("icons/icon48.png");
    loadTrustScore(tab.id);
  } else {
    siteEl.textContent = i18n("popupSiteFallback");
    siteRow.classList.add("disabled");
    zapBtn.disabled = true;
    fixSiteBtn.disabled = true;
    allowAdsBtn.disabled = true;
  }

  const data = await chrome.storage.local.get({
    enabled: true,
    siteModes: {},
    totalBlocked: 0,
    siteContentExceptions: {},
    lastFilterUpdate: 0,
    filterUpdateError: null
  });

  protectionEnabled = data.enabled;
  updateShieldButton(data.enabled);

  if (currentDomain) {
    const mode = resolveSiteMode(currentDomain, data.siteModes);
    siteModeSelect.value = mode;
    const exception = getSiteContentException(currentDomain, data.siteContentExceptions);
    showRecoveryStage(exception?.stage || null, exception?.permanent === true);
    chrome.tabs.sendMessage(tab.id, { type: "getCookieOutcome" }, (result) => {
      if (chrome.runtime.lastError || !result?.outcome) return;
      cookieOutcomeEl.textContent = {
        "dismissed-after-attempt": "Cookie banner dismissed after rejection attempt",
        attempted: "Cookie rejection attempted",
        "hide-fallback": "Cookie banner hidden without a rejection"
      }[result.outcome] || "";
    });
  }

  totalCountEl.textContent = formatCount(data.totalBlocked);
  setRowsEnabled(data.enabled);
  const lastUpdate = data.lastFilterUpdate ? new Date(data.lastFilterUpdate).toLocaleDateString() : null;
  const listSource = lastUpdate ? `Last successful list update ${lastUpdate}` : "Using bundled lists";
  filterHealthEl.textContent = data.filterUpdateError ? `List update failed. ${listSource}.` : listSource;

  if (currentTabId !== null) {
    chrome.runtime.sendMessage(
      { type: "getTabInfo", tabId: currentTabId },
      (res) => {
        if (!res) return;
        pageCountEl.textContent = formatCount(res.count);
        renderTrackers(res.trackers);
        if (res.learnedCount > 0) {
          learnedEl.textContent = i18n("learnedFooter", String(res.learnedCount));
        }
        if (Array.isArray(res.learnedBlocked)) {
          knownLearned = new Set(res.learnedBlocked);
          renderTrackers(res.trackers);
        }
        renderDiagnostics(res.diagnostics || []);
      }
    );
  }

}

function loadTrustScore(tabId) {
  chrome.tabs.sendMessage(tabId, { type: "getTrustScore" }, (res) => {
    if (chrome.runtime.lastError || !res) {
      trustRowEl.hidden = false;
      trustRowEl.className = "trust-row trust-unknown";
      trustScoreEl.textContent = "—";
      trustLabelEl.textContent = i18n("trustUnavailable");
      if (trustDetailEl) trustDetailEl.hidden = true;
      return;
    }
    if (!protectionEnabled) {
      showTrust({ level: "off", trustScore: null });
      return;
    }
    showTrust(res);
  });
}

function showTrust({ level, trustScore, reasons, activityNote }) {
  trustRowEl.hidden = false;
  trustRowEl.className = "trust-row trust-" + level;
  const reasonText = (reasons || []).join(" · ");
  const safety = document.getElementById("safetyReasons");
  if (safety) safety.textContent = reasonText;
  if (trustDetailEl) trustDetailEl.hidden = false;
  if (trustReasonsEl) trustReasonsEl.textContent = reasonText;
  if (trustActivityEl) trustActivityEl.textContent = activityNote || "";
  if (level === "off") {
    trustScoreEl.textContent = i18n("trustScoreOff");
    trustLabelEl.textContent = i18n(TRUST_KEYS.off);
    return;
  }
  trustScoreEl.textContent = trustScore == null ? "—" : trustScore + "/100";
  trustLabelEl.textContent = i18n(TRUST_KEYS[level] || "trustUnknown");
}

function updateShieldButton(enabled) {
  shieldBtn.classList.toggle("on", enabled);
  shieldBtn.classList.toggle("off", !enabled);
  shieldBtn.title = i18n(enabled ? "shieldBtnOn" : "shieldBtnOff");
  shieldBtn.setAttribute("aria-pressed", String(enabled));
}

function applySiteMode(mode) {
  if (!currentDomain) return;
  siteModeSelect.value = mode;
  chrome.runtime.sendMessage(
    { type: "setSiteMode", domain: currentDomain, mode },
    () => {
      setRowsEnabled(protectionEnabled);
      const label = SITE_MODE_LABELS[mode] || mode;
      flashHint(i18n("hintSiteMode", label));
      if (currentTabId) loadTrustScore(currentTabId);
    }
  );
}

function renderTrackers(trackers) {
  if (!trackers || trackers.length === 0) {
    trackerListEl.innerHTML =
      '<div class="empty">No trackers blocked on this page yet.</div>';
    return;
  }
  trackerListEl.innerHTML = "";

  for (const cat of CATEGORY_ORDER) {
    const inCat = trackers
      .filter((t) => t.category === cat)
      .sort((a, b) => b.count - a.count);
    if (inCat.length === 0) continue;

    const section = document.createElement("div");
    section.className = "category";

    const header = document.createElement("div");
    header.className = "category-header";
    const dot = document.createElement("span");
    dot.className = `category-dot dot-${cat}`;
    header.appendChild(dot);
    header.appendChild(
      document.createTextNode(CATEGORY_LABELS[cat] || cat)
    );
    section.appendChild(header);

    for (const t of inCat) {
      const row = document.createElement("div");
      row.className = "tracker";
      const name = document.createElement("span");
      name.className = "tracker-name";
      name.textContent = t.name;
      name.title = t.domain;
      const count = document.createElement("span");
      count.className = "tracker-count";
      count.textContent = `×${t.count}`;
      const blockBtn = document.createElement("button");
      blockBtn.type = "button";
      blockBtn.className = "tracker-block";
      blockBtn.textContent = "Block";
      blockBtn.title = "Always block " + t.domain;
      if (t.category === "learned" || learnedBlockedHas(t.domain)) {
        blockBtn.disabled = true;
        blockBtn.textContent = "On";
      }
      blockBtn.addEventListener("click", () => {
        blockBtn.disabled = true;
        chrome.runtime.sendMessage(
          { type: "blockTracker", domain: t.domain },
          (res) => {
            if (res?.ok) {
              blockBtn.textContent = "On";
              flashHint(i18n("hintBlockingTracker", t.name));
            } else {
              blockBtn.disabled = false;
              flashHint(res?.error || i18n("hintCouldNotBlockTracker"));
            }
          }
        );
      });
      row.appendChild(name);
      row.appendChild(count);
      row.appendChild(blockBtn);
      section.appendChild(row);
    }
    trackerListEl.appendChild(section);
  }
}

function renderDiagnostics(items) {
  if (!diagnosticsListEl) return;
  if (!items || items.length === 0) {
    diagnosticsListEl.innerHTML =
      '<div class="empty">' + i18n("popupDiagnosticsEmpty") + "</div>";
    return;
  }
  diagnosticsListEl.innerHTML = "";
  for (const item of items.slice(0, 5)) {
    const row = document.createElement("div");
    row.className = "diagnostic";
    const title = document.createElement("div");
    title.className = "diagnostic-title";
    title.textContent = item.name || item.domain;
    const meta = document.createElement("div");
    meta.className = "diagnostic-meta";
    const source = item.source || {};
    const confidence = source.confidence ? `, ${source.confidence}` : "";
    meta.textContent = `${source.label || "Estimated block"}${confidence} - ${source.detail || item.domain} (${item.count || 1})`;
    row.title = item.lastUrl || item.domain;
    row.appendChild(title);
    row.appendChild(meta);
    diagnosticsListEl.appendChild(row);
  }
}

let knownLearned = new Set();
function learnedBlockedHas(domain) {
  return knownLearned.has(domain);
}

function setRowsEnabled(enabled) {
  siteRow.classList.toggle("disabled", !enabled || currentDomain === null);
  siteModeSelect.disabled = !enabled || !currentDomain;
  const mode = siteModeSelect.value;
  zapBtn.disabled = !enabled || !currentDomain || mode === "off";
  fixSiteBtn.disabled = !enabled || !currentDomain || mode === "off" || currentRecoveryStage === "page";
  allowAdsBtn.disabled = !enabled || !currentDomain;
}

function showRecoveryStage(stage, permanent = false) {
  currentRecoveryStage = stage;
  pageFixActiveEl.hidden = !stage;
  recoveryActionsEl.hidden = !stage;
  keepFixBtn.hidden = !stage || permanent;
  if (stage === "cosmetics") {
    pageFixActiveEl.textContent = permanent
      ? "Cosmetic filtering is paused for this site."
      : "Cosmetic filtering is paused for 24 hours.";
    fixSiteBtn.textContent = "Try stronger page fix";
  } else if (stage === "page") {
    pageFixActiveEl.textContent = permanent
      ? "Page filtering and scriptlets are paused for this site."
      : "Page filtering and scriptlets are paused for 24 hours.";
    fixSiteBtn.textContent = "Strongest page fix active";
  } else {
    fixSiteBtn.textContent = "Fix page display";
  }
  setRowsEnabled(protectionEnabled);
}

function flashHint(text) {
  hintEl.textContent = text;
  setTimeout(() => {
    if (hintEl.textContent === text) hintEl.textContent = "";
  }, 2500);
}

shieldBtn.addEventListener("click", () => {
  const next = !protectionEnabled;
  chrome.runtime.sendMessage(
    { type: "setGlobalEnabled", enabled: next },
    () => {
      protectionEnabled = next;
      updateShieldButton(next);
      setRowsEnabled(next);
      if (next && currentTabId) loadTrustScore(currentTabId);
      else showTrust({ level: "off", trustScore: null });
      flashHint(i18n(next ? "hintProtectionEnabled" : "hintProtectionDisabled"));
    }
  );
});

siteModeSelect.addEventListener("change", () => {
  applySiteMode(siteModeSelect.value);
});

fixSiteBtn.addEventListener("click", () => {
  if (!currentDomain || !currentTabUrl) return;
  fixSiteBtn.disabled = true;
  chrome.runtime.sendMessage(
    {
      type: "fixSiteBreakage",
      domain: currentDomain,
      url: currentTabUrl,
      saveReport: reportCheck.checked
    },
    (res) => {
      fixSiteBtn.disabled = false;
      if (!res?.ok) {
        flashHint(res?.error || i18n("hintCouldNotFixSite"));
        return;
      }
      showRecoveryStage(res.stage);
      setRowsEnabled(protectionEnabled);
      flashHint(
        reportCheck.checked
          ? "Page display fix applied. Local report saved."
          : "Page display fix applied."
      );
      if (currentTabId !== null) chrome.tabs.reload(currentTabId).catch(() => {
        flashHint("Page display fix applied. Reload the page to finish.");
      });
    }
  );
});

restoreFixBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "clearContentException", domain: currentDomain }, (res) => {
    if (!res?.ok) return flashHint(res?.error || "Could not restore page protection.");
    showRecoveryStage(null);
    if (currentTabId !== null) chrome.tabs.reload(currentTabId);
  });
});

keepFixBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "keepContentException", domain: currentDomain }, (res) => {
    if (!res?.ok) return flashHint(res?.error || "Could not save the fix.");
    showRecoveryStage(currentRecoveryStage, true);
    flashHint("Page display fix saved for this site.");
  });
});

zapBtn.addEventListener("click", () => {
  if (!currentTabId) return;
  chrome.runtime.sendMessage({ type: "startZapperOnTab", tabId: currentTabId }, (res) => {
    if (res?.ok) {
      window.close();
    } else {
      flashHint(i18n("hintCantZap"));
    }
  });
});

allowAdsBtn.addEventListener("click", () => {
  if (!currentDomain) return;
  applySiteMode("ads");
});
