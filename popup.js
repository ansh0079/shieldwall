// QuietBrowse - popup logic

const siteEl = document.getElementById("site");
const faviconEl = document.getElementById("favicon");
const trustRowEl = document.getElementById("trustRow");
const trustScoreEl = document.getElementById("trustScore");
const trustLabelEl = document.getElementById("trustLabel");
const shieldBtn = document.getElementById("shieldBtn");
const pageCountEl = document.getElementById("pageCount");
const totalCountEl = document.getElementById("totalCount");
const trackerListEl = document.getElementById("trackerList");
const diagnosticsListEl = document.getElementById("diagnosticsList");
const siteModeSelect = document.getElementById("siteMode");
const siteRow = document.getElementById("siteRow");
const learnedEl = document.getElementById("learned");
const hintEl = document.getElementById("hint");
const zapBtn = document.getElementById("zapBtn");
const fixSiteBtn = document.getElementById("fixSiteBtn");
const reportCheck = document.getElementById("reportCheck");
const optionsLink = document.getElementById("optionsLink");
const allowAdsBtn = document.getElementById("allowAdsBtn");
const promoSection = document.getElementById("promo");
const reviewPromptEl = document.getElementById("reviewPrompt");
const reviewCtaBtn = document.getElementById("reviewCta");
const reviewDismissBtn = document.getElementById("reviewDismiss");
const shareCardEl = document.getElementById("shareMilestone");
const shareTitleEl = document.getElementById("shareTitle");
const shareBtn = document.getElementById("shareBtn");

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
    if (protectionEnabled && currentTabId) loadTrustScore(currentTabId);
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
    installAt: null,
    reviewPromptDone: false,
    milestoneShared_10000: false
  });

  protectionEnabled = data.enabled;
  updateShieldButton(data.enabled);

  if (currentDomain) {
    const mode = resolveSiteMode(currentDomain, data.siteModes);
    siteModeSelect.value = mode;
  }

  totalCountEl.textContent = formatCount(data.totalBlocked);
  setRowsEnabled(data.enabled);
  maybeShowPromos(data);

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

  // Wire promo actions
  reviewCtaBtn?.addEventListener("click", () => {
    chrome.storage.local.set({ reviewPromptDone: true }, () => {
      reviewPromptEl.hidden = true;
      maybeHidePromoContainer();
      chrome.tabs.create({
        url: "https://chromewebstore.google.com/detail/quietbrowse/ocpnpehnpilheklhbicgaaacaogipaml/reviews"
      });
    });
  });
  reviewDismissBtn?.addEventListener("click", () => {
    chrome.storage.local.set({ reviewPromptDone: true }, () => {
      reviewPromptEl.hidden = true;
      maybeHidePromoContainer();
    });
  });
  shareBtn?.addEventListener("click", async () => {
    const countText = totalCountEl.textContent || "10k";
    const text = `I've blocked ${countText} trackers with QuietBrowse — zero data collection. Try it: https://chromewebstore.google.com/detail/quietbrowse/ocpnpehnpilheklhbicgaaacaogipaml`;
    try {
      if (navigator.share && typeof navigator.share === "function") {
        await navigator.share({ text });
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        flashHint(i18n("shareCopied"));
      }
    } catch {
      /* ignore */
    }
    chrome.storage.local.set({ milestoneShared_10000: true }, () => {
      shareCardEl.hidden = true;
      maybeHidePromoContainer();
    });
  });
}

function maybeShowPromos(data) {
  // Ensure installAt is set for older installs
  if (!data.installAt) chrome.storage.local.set({ installAt: Date.now() });
  const now = Date.now();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  const hasTime = data.installAt && now - data.installAt >= sevenDaysMs;
  const ENOUGH_BLOCKS = 1000;
  const hasBlocks = (data.totalBlocked || 0) >= ENOUGH_BLOCKS;

  const showReview = !data.reviewPromptDone && (hasTime || hasBlocks);

  // Milestone: 10,000 trackers blocked
  const showShare = !data.milestoneShared_10000 && (data.totalBlocked || 0) >= 10000;
  if (showShare) {
    const pretty = formatCount(data.totalBlocked);
    if (shareTitleEl) {
      shareTitleEl.textContent = i18n("milestoneTitle", pretty);
    }
    shareCardEl.hidden = false;
  } else {
    shareCardEl.hidden = true;
  }

  reviewPromptEl.hidden = !showReview;
  promoSection.hidden = reviewPromptEl.hidden && shareCardEl.hidden;
}

function maybeHidePromoContainer() {
  if (reviewPromptEl.hidden && shareCardEl.hidden) promoSection.hidden = true;
}

function loadTrustScore(tabId) {
  chrome.tabs.sendMessage(tabId, { type: "getTrustScore" }, (res) => {
    if (chrome.runtime.lastError || !res) {
      trustRowEl.hidden = false;
      trustRowEl.className = "trust-row trust-unknown";
      trustScoreEl.textContent = "—";
      trustLabelEl.textContent = i18n("trustUnavailable");
      return;
    }
    if (!protectionEnabled) {
      showTrust({ level: "off", trustScore: null });
      return;
    }
    showTrust(res);
  });
}

function showTrust({ level, trustScore, reasons }) {
  trustRowEl.hidden = false;
  trustRowEl.className = "trust-row trust-" + level;
  if (level === "off") {
    trustScoreEl.textContent = i18n("trustScoreOff");
    trustLabelEl.textContent = i18n(TRUST_KEYS.off);
    return;
  }
  trustScoreEl.textContent = trustScore + "/100";
  trustLabelEl.textContent = i18n(TRUST_KEYS[level] || level);
  if (reasons?.length) {
    trustRowEl.title = reasons.join("\n");
  }
}

function updateShieldButton(enabled) {
  shieldBtn.classList.toggle("on", enabled);
  shieldBtn.classList.toggle("off", !enabled);
  shieldBtn.title = i18n(enabled ? "shieldBtnOn" : "shieldBtnOff");
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
  const mode = siteModeSelect.value;
  zapBtn.disabled = !enabled || !currentDomain || mode === "off";
  fixSiteBtn.disabled = !currentDomain;
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
      siteModeSelect.value = "off";
      setRowsEnabled(protectionEnabled);
      flashHint(
        reportCheck.checked
          ? i18n("hintSitePausedReport")
          : i18n("hintSitePaused")
      );
    }
  );
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
