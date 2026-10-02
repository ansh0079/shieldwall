// QuietBrowse - options page

const tabs = document.querySelectorAll(".tab");
const panels = document.querySelectorAll(".panel");
const statTotal = document.getElementById("statTotal");
const statToday = document.getElementById("statToday");
const statLearned = document.getElementById("statLearned");
const statsChart = document.getElementById("statsChart");
const whitelistForm = document.getElementById("whitelistForm");
const whitelistInput = document.getElementById("whitelistInput");
const whitelistMode = document.getElementById("whitelistMode");
const whitelistList = document.getElementById("whitelistList");
const whitelistEmpty = document.getElementById("whitelistEmpty");
const learnedList = document.getElementById("learnedList");
const learnedEmpty = document.getElementById("learnedEmpty");
const zappedGroups = document.getElementById("zappedGroups");
const zappedEmpty = document.getElementById("zappedEmpty");
const filterStatus = document.getElementById("filterStatus");
const dnrBudgetEl = document.getElementById("dnrBudget");
const updateFiltersBtn = document.getElementById("updateFiltersBtn");
const updateFiltersBtnStats = document.getElementById("updateFiltersBtnStats");
const defaultFilterList = document.getElementById("defaultFilterList");
const optionalFilterList = document.getElementById("optionalFilterList");
const customFilterForm = document.getElementById("customFilterForm");
const customFilterUrl = document.getElementById("customFilterUrl");
const customFilterTitle = document.getElementById("customFilterTitle");
const customFilterError = document.getElementById("customFilterError");
const customFilterList = document.getElementById("customFilterList");
const customFilterEmpty = document.getElementById("customFilterEmpty");
const antiAdblockToggle = document.getElementById("antiAdblockToggle");
const scriptletCatalogToggle = document.getElementById("scriptletCatalogToggle");
const cnameToggle = document.getElementById("cnameToggle");
const privacyToggle = document.getElementById("privacyToggle");
const cookieToggle = document.getElementById("cookieToggle");
const shieldToggle = document.getElementById("shieldToggle");
const phishToggle = document.getElementById("phishToggle");
const downloadToggle = document.getElementById("downloadToggle");
const autoBlockToggle = document.getElementById("autoBlockToggle");
const undoLastBtn = document.getElementById("undoLastBtn");
const exportReportsBtn = document.getElementById("exportReportsBtn");
const clearReportsBtn = document.getElementById("clearReportsBtn");
const reportsList = document.getElementById("reportsList");
const reportsEmpty = document.getElementById("reportsEmpty");
const observedFilter = document.getElementById("observedFilter");
const observedSort = document.getElementById("observedSort");
const observedCount = document.getElementById("observedCount");
const clearObservedBtn = document.getElementById("clearObservedBtn");
const observedList = document.getElementById("observedList");
const observedEmpty = document.getElementById("observedEmpty");
const watchingList = document.getElementById("watchingList");
const watchingEmpty = document.getElementById("watchingEmpty");
const customRuleForm = document.getElementById("customRuleForm");
const customRuleName = document.getElementById("customRuleName");
const customRuleAction = document.getElementById("customRuleAction");
const customRuleType = document.getElementById("customRuleType");
const customRuleScope = document.getElementById("customRuleScope");
const customRuleValue = document.getElementById("customRuleValue");
const customRuleEnabled = document.getElementById("customRuleEnabled");
const customRuleError = document.getElementById("customRuleError");
const customRuleList = document.getElementById("customRuleList");
const customRuleEmpty = document.getElementById("customRuleEmpty");
const exportCustomRulesBtn = document.getElementById("exportCustomRulesBtn");
const importCustomRulesBtn = document.getElementById("importCustomRulesBtn");
const importCustomRulesFile = document.getElementById("importCustomRulesFile");
const exportAllBtn = document.getElementById("exportAllBtn");
const importAllBtn = document.getElementById("importAllBtn");
const importAllFile = document.getElementById("importAllFile");
const filterStatusStats = document.getElementById("filterStatusStats");

let state = {
  siteModes: {},
  learnedSeen: {},
  learnedBlocked: [],
  learnedCandidates: {},
  observedTrackers: {},
  customRules: [],
  customFilterLists: [],
  zappedElements: {},
  totalBlocked: 0,
  dailyBlocked: {},
  dnrBudget: null,
  breakageReports: [],
  rollbackActions: []
};

function localizePage() {
  if (typeof chrome?.i18n?.getMessage !== "function") return;
  for (const el of document.querySelectorAll("[data-i18n]")) {
    const msg = chrome.i18n.getMessage(el.dataset.i18n);
    if (msg) el.textContent = msg;
  }
  for (const el of document.querySelectorAll("[data-i18n-placeholder]")) {
    const msg = chrome.i18n.getMessage(el.dataset.i18nPlaceholder);
    if (msg) el.placeholder = msg;
  }
  for (const el of document.querySelectorAll("[data-i18n-title]")) {
    const msg = chrome.i18n.getMessage(el.dataset.i18nTitle);
    if (msg) el.title = msg;
  }
}

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    tabs.forEach((t) => t.classList.remove("active"));
    panels.forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById("panel-" + tab.dataset.tab).classList.add("active");
  });
});

whitelistForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const raw = whitelistInput.value.trim().toLowerCase();
  if (!raw) return;
  const domain = raw.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
    alert(i18n("alertInvalidDomain"));
    return;
  }
  state.siteModes = { ...state.siteModes, [domain]: whitelistMode.value };
  saveSiteModes();
  whitelistInput.value = "";
});

observedFilter?.addEventListener("input", renderObserved);
observedSort?.addEventListener("change", renderObserved);
clearObservedBtn?.addEventListener("click", () => {
  if (!confirm(i18n("dialogConfirmClearObserved"))) return;
  chrome.runtime.sendMessage({ type: "clearObservedTrackers" }, () => load());
});

customRuleForm?.addEventListener("submit", (e) => {
  e.preventDefault();
  customRuleError.textContent = "";
  const rule = {
    name: customRuleName.value.trim(),
    action: customRuleAction.value,
    type: customRuleType.value,
    value: customRuleValue.value.trim(),
    scope: customRuleScope.value,
    enabled: customRuleEnabled.checked
  };
  chrome.runtime.sendMessage({ type: "addCustomRule", rule }, (res) => {
    if (res?.ok) {
      customRuleName.value = "";
      customRuleValue.value = "";
      load();
    } else {
      customRuleError.textContent = res?.error || i18n("genericAddFailed");
    }
  });
});

exportCustomRulesBtn?.addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state.customRules || [], null, 2)], {
    type: "application/json"
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "quietbrowse-custom-rules.json";
  a.click();
  URL.revokeObjectURL(a.href);
});

importCustomRulesBtn?.addEventListener("click", () => {
  importCustomRulesFile?.click();
});

importCustomRulesFile?.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const rules = JSON.parse(String(reader.result));
      chrome.runtime.sendMessage({ type: "importCustomRules", rules }, (res) => {
        importCustomRulesFile.value = "";
        if (res?.ok) {
          alert(i18n("alertImportResult", String(res.added), String(res.replaced), String(res.skipped)));
          load();
        } else {
          alert(i18n("importFailed", res?.error || "unknown error"));
        }
      });
    } catch (err) {
      importCustomRulesFile.value = "";
      alert(i18n("alertInvalidJson", err.message));
    }
  };
  reader.readAsText(file);
});

exportAllBtn?.addEventListener("click", () => {
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    enabled: state.enabled,
    privacySignals: state.privacySignals,
    hideCookiePopups: state.hideCookiePopups,
    passwordShield: state.passwordShield,
    phishingWarn: state.phishingWarn,
    downloadGuard: state.downloadGuard,
    autoBlockLearned: state.autoBlockLearned,
    cnameUncloak: state.cnameUncloak,
    scriptletCatalog: state.scriptletCatalog,
    siteModes: state.siteModes,
    learnedSeen: state.learnedSeen,
    learnedBlocked: state.learnedBlocked,
    learnedCandidates: state.learnedCandidates,
    observedTrackers: state.observedTrackers,
    customRules: state.customRules,
    customFilterLists: state.customFilterLists,
    zappedElements: state.zappedElements,
    totalBlocked: state.totalBlocked,
    dailyBlocked: state.dailyBlocked,
    breakageReports: state.breakageReports,
    rollbackActions: state.rollbackActions
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "quietbrowse-backup.json";
  a.click();
  URL.revokeObjectURL(a.href);
});

importAllBtn?.addEventListener("click", () => {
  importAllFile?.click();
});

importAllFile?.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(String(reader.result));
      if (!data || typeof data !== "object") throw new Error(i18n("alertInvalidBackup"));
      chrome.runtime.sendMessage({ type: "restoreBackup", data }, (res) => {
        importAllFile.value = "";
        if (res?.ok) {
          alert(i18n("alertBackupRestored"));
          load();
        } else {
          alert(i18n("alertRestoreFailed", res?.error || "unknown error"));
        }
      });
    } catch (err) {
      importAllFile.value = "";
      alert(i18n("alertInvalidBackupFile", err.message));
    }
  };
  reader.readAsText(file);
});

undoLastBtn?.addEventListener("click", () => {
  undoLastBtn.disabled = true;
  chrome.runtime.sendMessage({ type: "undoLastAction" }, (res) => {
    if (!res?.ok) {
      alert(res?.error || i18n("alertNothingToUndo"));
    }
    load();
  });
});

function load() {
  chrome.runtime.sendMessage({ type: "getOptionsData" }, (data) => {
    if (!data) return;
    state = data;
    renderAll();
  });
}

function renderAll() {
  statTotal.textContent = formatCount(state.totalBlocked);
  const today = todayKey();
  statToday.textContent = formatCount(state.dailyBlocked[today] || 0);
  statLearned.textContent = String(state.learnedBlocked.length);
  drawChart(state.dailyBlocked);
  renderFilterStatus();
  renderDnrBudget();
  renderFilterLists();
  renderSiteModes();
  renderWatching();
  renderObserved();
  renderCustomRules();
  renderLearned();
  renderZapped();
  renderReports();
  if (antiAdblockToggle) {
    antiAdblockToggle.checked = state.antiAdblock === true;
  }
  if (scriptletCatalogToggle) {
    scriptletCatalogToggle.checked = state.scriptletCatalog !== false;
  }
  if (cnameToggle) {
    cnameToggle.checked = state.cnameUncloak !== false;
  }
  if (privacyToggle) {
    privacyToggle.checked = state.privacySignals !== false;
  }
  if (cookieToggle) {
    cookieToggle.checked = state.hideCookiePopups !== false;
  }
  if (shieldToggle) {
    shieldToggle.checked = state.passwordShield !== false;
  }
  if (phishToggle) {
    phishToggle.checked = state.phishingWarn !== false;
  }
  if (downloadToggle) {
    downloadToggle.checked = state.downloadGuard === true;
  }
  if (autoBlockToggle) {
    autoBlockToggle.checked = state.autoBlockLearned === true;
  }
  renderUndoState();
}

function renderDnrBudget() {
  if (!dnrBudgetEl) return;
  const b = state.dnrBudget;
  if (!b) {
    dnrBudgetEl.textContent = "DNR budget unavailable until the extension finishes loading.";
    dnrBudgetEl.classList.remove("warning");
    return;
  }
  dnrBudgetEl.classList.toggle("warning", b.remainingDynamicRules < 1000 || b.exceedsBudget);
  dnrBudgetEl.textContent =
    `Dynamic rule budget: ${formatCount(b.projectedTotalDynamicRules)} / ` +
    `${formatCount(b.maxDynamicRules)} used. ` +
    `${formatCount(b.remainingDynamicRules)} remaining. ` +
    `Filter updates: ${formatCount(b.updateRules)}; other dynamic rules: ${formatCount(b.otherDynamicRules)}.`;
}

function renderUndoState() {
  if (!undoLastBtn) return;
  const latest = (state.rollbackActions || [])[0];
  undoLastBtn.disabled = !latest;
  undoLastBtn.textContent = latest
    ? `Undo: ${latest.label || "last change"}`
    : "Undo last change";
}

function renderFilterStatus() {
  let text = "";
  if (state.useUpdatedLists && state.lastFilterUpdate) {
    text = i18n(
      "filterStatusLastUpdated",
      formatDate(new Date(state.lastFilterUpdate).toISOString())
    );
  } else {
    text = i18n("filterStatusBundled");
  }
  if (state.filterUpdateError?.message) {
    const when = state.filterUpdateError.at
      ? formatDate(new Date(state.filterUpdateError.at).toISOString())
      : "";
    text += i18n("filterStatusFailed", when, state.filterUpdateError.message);
  }
  filterStatus.textContent = text;
  if (filterStatusStats) filterStatusStats.textContent = text;
}

function runFilterUpdate(btn) {
  if (!btn) return;
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = "Updating…";
  chrome.runtime.sendMessage({ type: "updateFilters" }, (res) => {
    btn.disabled = false;
    btn.textContent = prev;
    if (res?.ok) {
      alert(i18n("filterUpdateSuccess", String(res.ruleCount)));
      load();
    } else {
      alert(i18n("filterUpdateFailed", res?.error || "unknown error"));
    }
  });
}

updateFiltersBtn?.addEventListener("click", () => runFilterUpdate(updateFiltersBtn));
updateFiltersBtnStats?.addEventListener("click", () => runFilterUpdate(updateFiltersBtnStats));

document.querySelectorAll("button.linkish[data-tab]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tab = document.querySelector(`.tab[data-tab="${btn.dataset.tab}"]`);
    tab?.click();
  });
});

function renderFilterLists() {
  const defaults = state.defaultFilterLists || [];
  defaultFilterList.innerHTML = "";
  for (const url of defaults) {
    const li = document.createElement("li");
    const main = document.createElement("div");
    main.className = "item-main";
    const title = url.includes("easyprivacy") ? "EasyPrivacy" : "EasyList";
    main.innerHTML =
      `<div class="item-title">${escapeHtml(title)}</div>` +
      `<div class="item-meta">${escapeHtml(url)}</div>`;
    li.appendChild(main);
    defaultFilterList.appendChild(li);
  }

  optionalFilterList.innerHTML = "";
  for (const list of state.optionalFilterLists || []) {
    const li = document.createElement("li");
    const main = document.createElement("div");
    main.className = "item-main";
    main.innerHTML =
      `<div class="item-title">${escapeHtml(list.title)}</div>` +
      `<div class="item-meta">${escapeHtml(list.note || list.url)}</div>`;

    const actions = document.createElement("div");
    actions.className = "item-actions";
    const toggleBtn = document.createElement("button");
    toggleBtn.className = "btn-sm";
    toggleBtn.textContent = list.enabled ? i18n("btnDisable") : i18n("btnEnable");
    toggleBtn.onclick = () => {
      chrome.runtime.sendMessage(
        { type: "setOptionalFilterList", id: list.id, enabled: !list.enabled },
        (res) => {
          if (!res?.ok) {
            alert(res?.error || i18n("alertUpdateListFailed"));
            return;
          }
          if (
            confirm(
              list.enabled
                ? i18n("optionalListDisabledPrompt")
                : i18n("optionalListEnabledPrompt")
            )
          ) {
            runFilterUpdate(updateFiltersBtn || updateFiltersBtnStats);
          } else {
            load();
          }
        }
      );
    };
    actions.appendChild(toggleBtn);
    li.appendChild(main);
    li.appendChild(actions);
    optionalFilterList.appendChild(li);
  }

  const lists = state.customFilterLists || [];
  customFilterList.innerHTML = "";
  customFilterEmpty.classList.toggle("hidden", lists.length > 0);

  for (const list of lists) {
    const li = document.createElement("li");
    const main = document.createElement("div");
    main.className = "item-main";
    main.innerHTML =
      `<div class="item-title">${escapeHtml(list.title || list.url)}</div>` +
      `<div class="item-meta">${escapeHtml(list.url)}</div>`;

    const actions = document.createElement("div");
    actions.className = "item-actions";

    const toggleBtn = document.createElement("button");
    toggleBtn.className = "btn-sm";
    toggleBtn.textContent = list.enabled ? i18n("btnDisable") : i18n("btnEnable");
    toggleBtn.onclick = () => {
      chrome.runtime.sendMessage(
        { type: "updateCustomFilterList", id: list.id, updates: { enabled: !list.enabled } },
        () => load()
      );
    };

    const removeBtn = document.createElement("button");
    removeBtn.className = "btn-sm danger";
    removeBtn.textContent = i18n("btnRemove");
    removeBtn.onclick = () => {
      chrome.runtime.sendMessage(
        { type: "removeCustomFilterList", id: list.id },
        () => load()
      );
    };

    actions.appendChild(toggleBtn);
    actions.appendChild(removeBtn);
    li.appendChild(main);
    li.appendChild(actions);
    customFilterList.appendChild(li);
  }
}

customFilterForm?.addEventListener("submit", (e) => {
  e.preventDefault();
  customFilterError.textContent = "";
  const list = {
    url: customFilterUrl.value.trim(),
    title: customFilterTitle.value.trim()
  };
  chrome.runtime.sendMessage({ type: "addCustomFilterList", list }, (res) => {
    if (res?.ok) {
      customFilterUrl.value = "";
      customFilterTitle.value = "";
      load();
    } else {
      customFilterError.textContent = res?.error || "Failed to add list";
    }
  });
});

function drawChart(dailyBlocked) {
  const ctx = statsChart.getContext("2d");
  const days = [];
  const now = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    days.push(localDateStr(d));
  }
  const values = days.map((d) => dailyBlocked[d] || 0);
  const max = Math.max(...values, 1);

  const W = statsChart.width;
  const H = statsChart.height;
  const pad = { top: 16, right: 16, bottom: 36, left: 40 };
  const chartW = W - pad.left - pad.right;
  const chartH = H - pad.top - pad.bottom;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#f9fafb";
  ctx.fillRect(pad.left, pad.top, chartW, chartH);

  ctx.strokeStyle = "#e5e7eb";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (chartH * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + chartW, y);
    ctx.stroke();
    const val = Math.round(max - (max * i) / 4);
    ctx.fillStyle = "#9ca3af";
    ctx.font = "11px Segoe UI, system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(String(val), pad.left - 6, y + 4);
  }

  const barW = chartW / days.length - 2;
  values.forEach((v, i) => {
    const h = (v / max) * chartH;
    const x = pad.left + i * (chartW / days.length) + 1;
    const y = pad.top + chartH - h;
    ctx.fillStyle = v > 0 ? "#1a73e8" : "#e5e7eb";
    ctx.fillRect(x, y, barW, h || 2);
  });

  ctx.fillStyle = "#6b7280";
  ctx.font = "10px Segoe UI, system-ui, sans-serif";
  ctx.textAlign = "center";
  [0, 14, 29].forEach((i) => {
    const label = days[i].slice(5);
    const x = pad.left + i * (chartW / days.length) + barW / 2;
    ctx.fillText(label, x, H - 10);
  });
}

function renderSiteModes() {
  whitelistList.innerHTML = "";
  const domains = Object.keys(state.siteModes).sort();
  whitelistEmpty.classList.toggle("hidden", domains.length > 0);

  for (const domain of domains) {
    const mode = state.siteModes[domain];
    const li = document.createElement("li");
    const main = document.createElement("div");
    main.className = "item-main";
    main.innerHTML =
      `<div class="item-title">${escapeHtml(domain)}</div>` +
      `<div class="item-meta">${escapeHtml(SITE_MODE_LABELS[mode] || mode)}</div>`;

    const modeSelect = document.createElement("select");
    modeSelect.className = "mode-select";
    for (const value of ["ads", "off"]) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = SITE_MODE_LABELS[value];
      if (value === mode) opt.selected = true;
      modeSelect.appendChild(opt);
    }
    modeSelect.onchange = () => {
      state.siteModes = { ...state.siteModes, [domain]: modeSelect.value };
      saveSiteModes();
    };

    const removeBtn = document.createElement("button");
    removeBtn.className = "btn-sm danger";
    removeBtn.textContent = i18n("btnRemove");
    removeBtn.onclick = () => {
      const next = { ...state.siteModes };
      delete next[domain];
      state.siteModes = next;
      saveSiteModes();
    };

    const actions = document.createElement("div");
    actions.className = "item-actions";
    actions.appendChild(modeSelect);
    actions.appendChild(removeBtn);
    li.appendChild(main);
    li.appendChild(actions);
    whitelistList.appendChild(li);
  }
}

function renderWatching() {
  if (!watchingList || !watchingEmpty) return;
  watchingList.innerHTML = "";
  const seen = state.learnedSeen || {};
  const domains = Object.keys(seen).sort(
    (a, b) => (seen[b]?.length || 0) - (seen[a]?.length || 0)
  );
  watchingEmpty.classList.toggle("hidden", domains.length > 0);

  const THRESHOLD = 3;
  const candidates = state.learnedCandidates || {};
  for (const domain of domains) {
    const sites = seen[domain] || [];
    const progress = Math.min(sites.length, THRESHOLD);
    const ready = Boolean(candidates[domain]) || sites.length >= THRESHOLD;
    const meta = ready
      ? i18n("watchingReadyForReview", String(sites.length))
      : i18n("watchingProgress", String(sites.length), String(progress), String(THRESHOLD));
    const li = document.createElement("li");
    const main = document.createElement("div");
    main.className = "item-main";
    main.innerHTML =
      `<div class="item-title">${escapeHtml(domain)}</div>` +
      `<div class="item-meta">${escapeHtml(meta)}</div>` +
      `<div class="progress-bar"><span style="width:${(progress / THRESHOLD) * 100}%"></span></div>`;

    const actions = document.createElement("div");
    actions.className = "item-actions";

    const blockBtn = document.createElement("button");
    blockBtn.className = "btn-sm";
    blockBtn.textContent = i18n("btnBlockNow");
    blockBtn.onclick = () => {
      chrome.runtime.sendMessage(
        {
          type: "addCustomRule",
          rule: {
            name: `Block ${domain}`,
            action: "block",
            type: "domain",
            value: domain,
            scope: "thirdParty"
          }
        },
        () => load()
      );
    };

    const forgetBtn = document.createElement("button");
    forgetBtn.className = "btn-sm danger";
    forgetBtn.textContent = i18n("btnForget");
    forgetBtn.onclick = () => {
      chrome.runtime.sendMessage({ type: "forgetWatching", domain }, () => load());
    };

    actions.appendChild(blockBtn);
    actions.appendChild(forgetBtn);
    li.appendChild(main);
    li.appendChild(actions);
    watchingList.appendChild(li);
  }
}

function getObservedEntries() {
  const raw = Object.values(state.observedTrackers || {});
  const filter = (observedFilter?.value || "").trim().toLowerCase();
  const filtered = filter
    ? raw.filter(
        (t) =>
          (t.name || "").toLowerCase().includes(filter) ||
          (t.domain || "").toLowerCase().includes(filter) ||
          (t.category || "").toLowerCase().includes(filter)
      )
    : raw;
  const sort = observedSort?.value || "lastSeen";
  filtered.sort((a, b) => {
    if (sort === "lastSeen") return b.lastSeen.localeCompare(a.lastSeen);
    if (sort === "totalCount") return b.totalCount - a.totalCount;
    if (sort === "siteCount") return b.siteCount - a.siteCount;
    return (a.name || a.domain).localeCompare(b.name || b.domain);
  });
  return filtered;
}

function renderObserved() {
  observedList.innerHTML = "";
  const entries = getObservedEntries();
  observedEmpty.classList.toggle("hidden", entries.length > 0);
  observedCount.textContent = i18n("observedCountMeta", String(entries.length));

  for (const t of entries) {
    const li = document.createElement("li");
    const main = document.createElement("div");
    main.className = "item-main";
    main.innerHTML =
      `<div class="item-title">${escapeHtml(t.name || t.domain)}</div>` +
      `<div class="item-meta">${escapeHtml(t.domain)} · ${escapeHtml(CATEGORY_LABELS[t.category] || t.category || "Other")}</div>` +
      `<div class="item-meta">${i18n("observedItemMeta", formatCount(t.totalCount), String(t.siteCount), formatDate(t.lastSeen))}</div>`;

    const actions = document.createElement("div");
    actions.className = "item-actions";

    const blockBtn = document.createElement("button");
    blockBtn.className = "btn-sm";
    blockBtn.textContent = i18n("btnBlock");
    blockBtn.title = "Add to custom block rules";
    blockBtn.onclick = () => {
      chrome.runtime.sendMessage(
        {
          type: "addCustomRule",
          rule: {
            name: `Block ${t.domain}`,
            action: "block",
            type: "domain",
            value: t.domain,
            scope: "all"
          }
        },
        () => load()
      );
    };

    const allowBtn = document.createElement("button");
    allowBtn.className = "btn-sm";
    allowBtn.textContent = i18n("btnAllowSite");
    allowBtn.title = "Pause blocking on this domain";
    allowBtn.onclick = () => {
      state.siteModes = { ...state.siteModes, [t.domain]: SITE_MODE.OFF };
      saveSiteModes();
    };

    actions.appendChild(blockBtn);
    actions.appendChild(allowBtn);
    li.appendChild(main);
    li.appendChild(actions);
    observedList.appendChild(li);
  }
}

function renderCustomRules() {
  customRuleList.innerHTML = "";
  const rules = state.customRules || [];
  customRuleEmpty.classList.toggle("hidden", rules.length > 0);

  for (const rule of rules) {
    const li = document.createElement("li");
    const main = document.createElement("div");
    main.className = "item-main";
    const scopeLabel = rule.scope === "thirdParty" ? i18n("customRuleScopeThirdParty") : i18n("customRuleScopeAll");
    main.innerHTML =
      `<div class="item-title">${escapeHtml(rule.name || rule.value)}</div>` +
      `<div class="item-meta">${escapeHtml(rule.action)} ${rule.type === "domain" ? "domain" : "URL"} · ${escapeHtml(rule.value)} · ${scopeLabel}</div>`;

    const actions = document.createElement("div");
    actions.className = "item-actions";

    const toggleBtn = document.createElement("button");
    toggleBtn.className = "btn-sm";
    toggleBtn.textContent = rule.enabled ? i18n("btnDisable") : i18n("btnEnable");
    toggleBtn.onclick = () => {
      chrome.runtime.sendMessage(
        { type: "updateCustomRule", id: rule.id, updates: { enabled: !rule.enabled } },
        () => load()
      );
    };

    const removeBtn = document.createElement("button");
    removeBtn.className = "btn-sm danger";
    removeBtn.textContent = i18n("btnRemove");
    removeBtn.onclick = () => {
      chrome.runtime.sendMessage(
        { type: "removeCustomRule", id: rule.id },
        () => load()
      );
    };

    actions.appendChild(toggleBtn);
    actions.appendChild(removeBtn);
    li.appendChild(main);
    li.appendChild(actions);
    customRuleList.appendChild(li);
  }
}

function renderLearned() {
  learnedList.innerHTML = "";
  learnedEmpty.classList.toggle("hidden", state.learnedBlocked.length > 0);
  for (const domain of state.learnedBlocked.sort()) {
    const seen = state.learnedSeen?.[domain];
    const li = document.createElement("li");
    const main = document.createElement("div");
    main.className = "item-main";
    main.innerHTML = `<div class="item-title">${escapeHtml(domain)}</div>`;
    if (seen?.length) {
      const meta = document.createElement("div");
      meta.className = "item-meta";
      meta.textContent = i18n("learnedSeenOnSites", String(seen.length));
      main.appendChild(meta);
    }
    const btn = document.createElement("button");
    btn.className = "btn-sm danger";
    btn.textContent = i18n("btnUnblock");
    btn.onclick = () => {
      chrome.runtime.sendMessage({ type: "forgetLearned", domain }, () => load());
    };
    const actions = document.createElement("div");
    actions.className = "item-actions";
    actions.appendChild(btn);
    li.appendChild(main);
    li.appendChild(actions);
    learnedList.appendChild(li);
  }
}

function renderZapped() {
  zappedGroups.innerHTML = "";
  const domains = Object.keys(state.zappedElements).sort();
  zappedEmpty.classList.toggle("hidden", domains.length > 0);
  for (const domain of domains) {
    const items = state.zappedElements[domain];
    if (!items?.length) continue;

    const group = document.createElement("div");
    group.className = "zapped-group";

    const header = document.createElement("div");
    header.className = "zapped-group-header";
    header.innerHTML = `<span>${escapeHtml(domain)} (${items.length})</span>`;
    const clearBtn = document.createElement("button");
    clearBtn.className = "btn-sm danger";
    clearBtn.textContent = i18n("btnClearAll");
    clearBtn.onclick = () => {
      chrome.runtime.sendMessage({ type: "removeZapped", domain }, () => load());
    };
    header.appendChild(clearBtn);
    group.appendChild(header);

    items.forEach((z, index) => {
      const row = document.createElement("div");
      row.className = "zapped-item";
      const main = document.createElement("div");
      main.className = "item-main";
      main.innerHTML =
        `<div class="zapped-selector">${escapeHtml(z.selector)}</div>` +
        (z.label ? `<div class="item-meta">${escapeHtml(z.label)}</div>` : "") +
        (z.addedAt ? `<div class="item-meta">${i18n("zappedAddedAt", formatDate(z.addedAt))}</div>` : "");
      const btn = document.createElement("button");
      btn.className = "btn-sm danger";
    btn.textContent = i18n("btnRemove");
      btn.onclick = () => {
        chrome.runtime.sendMessage(
          { type: "removeZapped", domain, index },
          () => load()
        );
      };
      const actions = document.createElement("div");
      actions.className = "item-actions";
      actions.appendChild(btn);
      row.appendChild(main);
      row.appendChild(actions);
      group.appendChild(row);
    });

    zappedGroups.appendChild(group);
  }
}

function renderReports() {
  reportsList.innerHTML = "";
  const reports = state.breakageReports || [];
  reportsEmpty.classList.toggle("hidden", reports.length > 0);
  for (const r of reports) {
    const li = document.createElement("li");
    const main = document.createElement("div");
    main.className = "item-main";
    main.innerHTML =
      `<div class="item-title">${escapeHtml(r.domain)}</div>` +
      `<div class="item-meta">${escapeHtml(r.url || "")}</div>` +
      `<div class="item-meta">${formatDate(r.at)} · v${escapeHtml(r.version || "?")}</div>`;
    li.appendChild(main);
    reportsList.appendChild(li);
  }
}

exportReportsBtn.addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state.breakageReports || [], null, 2)], {
    type: "application/json"
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "quietbrowse-site-reports.json";
  a.click();
  URL.revokeObjectURL(a.href);
});

clearReportsBtn.addEventListener("click", () => {
  if (!confirm(i18n("dialogConfirmClearReports"))) return;
  chrome.runtime.sendMessage({ type: "clearBreakageReports" }, () => load());
});

antiAdblockToggle?.addEventListener("change", () => {
  chrome.runtime.sendMessage(
    { type: "setAntiAdblock", enabled: antiAdblockToggle.checked },
    () => {}
  );
});

privacyToggle?.addEventListener("change", () => {
  chrome.runtime.sendMessage(
    { type: "setPrivacySignals", enabled: privacyToggle.checked },
    () => {}
  );
});

cookieToggle?.addEventListener("change", () => {
  chrome.runtime.sendMessage(
    { type: "setContentSettings", hideCookiePopups: cookieToggle.checked },
    () => {}
  );
});

shieldToggle?.addEventListener("change", () => {
  chrome.runtime.sendMessage(
    { type: "setContentSettings", passwordShield: shieldToggle.checked },
    () => {}
  );
});

phishToggle?.addEventListener("change", () => {
  chrome.runtime.sendMessage(
    { type: "setContentSettings", phishingWarn: phishToggle.checked },
    () => {}
  );
});

downloadToggle?.addEventListener("change", () => {
  chrome.runtime.sendMessage(
    { type: "setContentSettings", downloadGuard: downloadToggle.checked },
    (res) => {
      if (!res?.ok) {
        downloadToggle.checked = false;
        alert(res?.error || i18n("hintDownloadGuardDenied"));
      }
    }
  );
});

scriptletCatalogToggle?.addEventListener("change", () => {
  chrome.runtime.sendMessage(
    { type: "setScriptletCatalog", enabled: scriptletCatalogToggle.checked },
    () => {}
  );
});

autoBlockToggle?.addEventListener("change", () => {
  chrome.runtime.sendMessage(
    { type: "setAutoBlockLearned", enabled: autoBlockToggle.checked },
    (res) => {
      if (!res?.ok) {
        alert(res?.error || i18n("alertAutoBlockFailed"));
        autoBlockToggle.checked = false;
      }
      load();
    }
  );
});

cnameToggle?.addEventListener("change", () => {
  chrome.runtime.sendMessage(
    { type: "setCnameUncloak", enabled: cnameToggle.checked },
    () => {}
  );
});

function saveSiteModes() {
  chrome.runtime.sendMessage(
    { type: "updateSiteModes", siteModes: state.siteModes },
    () => renderSiteModes()
  );
}

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric"
    });
  } catch {
    return iso;
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

load();
