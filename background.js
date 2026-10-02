// QuietBrowse - background service worker

// Chrome loads this file as a service worker (importScripts available).
// Firefox loads all files via manifest background.scripts — skip the import.
if (typeof importScripts === "function") {
  importScripts(
    "trackers.js",
    "psl_data.js",
    "utils.js",
    "phish_score.js",
    "filter_compiler.js",
    "cosmetic_filters.js",
    "bg_constants.js",
    "bg_filters.js",
    "bg_cname.js",
    "bg_scriptlets.js",
    "bg_learning.js",
    "bg_custom.js",
    "bg_sync.js"
  );
}

const tabData = {};
let swEnabled = true;
let learnedSeen = {};
let learnedBlocked = [];
let learnedBlockedSet = new Set();
function rebuildLearnedSet() { learnedBlockedSet = new Set(learnedBlocked); }
let learnedCandidates = {};
let observedTrackers = {};
let customRules = [];
let customFilterLists = [];
let saveTimer = null;
let persistTimer = null;
let suppressRollback = false;

const BLOCKED_ERRORS = new Set([
  "net::ERR_BLOCKED_BY_CLIENT",
  "NS_ERROR_ABORT"
]);

const broadcastTimers = {};

function getTab(tabId) {
  if (!tabData[tabId]) {
    tabData[tabId] = {
      count: 0,
      trackers: {},
      diagnostics: [],
      url: null,
      baseDomain: null
    };
  }
  return tabData[tabId];
}

function schedulePersistTabs() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    chrome.storage.session.set({ [SESSION_KEY]: tabData }).catch(() => {});
  }, 500);
}

function broadcastTabUpdate(tabId) {
  const tab = tabData[tabId];
  if (!tab) return;
  chrome.runtime
    .sendMessage({
      type: "tabUpdated",
      tabId,
      count: tab.count,
      trackers: Object.entries(tab.trackers).map(([domain, t]) => ({
        domain,
        ...t
      })),
      diagnostics: (tab.diagnostics || []).slice(),
      learnedCount: learnedBlocked.length
    })
    .catch(() => {});
}

function scheduleBroadcastUpdate(tabId) {
  if (broadcastTimers[tabId]) return;
  broadcastTimers[tabId] = setTimeout(() => {
    delete broadcastTimers[tabId];
    broadcastTabUpdate(tabId);
  }, 200);
}

let pendingBlockCount = 0;
let blockFlushTimer = null;

function recordDailyBlock() {
  pendingBlockCount++;
  if (blockFlushTimer) return;
  blockFlushTimer = setTimeout(flushDailyBlocks, 2000);
}

function flushDailyBlocks() {
  blockFlushTimer = null;
  const count = pendingBlockCount;
  if (count === 0) return;
  pendingBlockCount = 0;
  const key = todayKey();
  chrome.storage.local.get({ totalBlocked: 0, dailyBlocked: {} }, (data) => {
    const daily = { ...data.dailyBlocked };
    daily[key] = (daily[key] || 0) + count;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - DAILY_RETENTION_DAYS);
    const cutoffStr = localDateStr(cutoff);
    for (const d of Object.keys(daily)) {
      if (d < cutoffStr) delete daily[d];
    }
    chrome.storage.local.set({
      totalBlocked: data.totalBlocked + count,
      dailyBlocked: daily
    });
  });
}

// Store-safe block counting: webRequest observes ERR_BLOCKED_BY_CLIENT
// (works in published extensions; onRuleMatchedDebug is dev-only).
function recordBlockedRequest(tabId, url) {
  if (tabId < 0) return;

  const hostname = safeHostname(url);
  const tab = getTab(tabId);
  tab.count++;

  let observedDomain = null;
  let observedName = null;
  let observedCategory = null;

  if (hostname) {
    const known = lookupTracker(hostname);
    const domain = known ? known.domain : getBaseDomain(hostname);
    let category = known ? known.category : "other";
    if (!known && learnedBlockedSet.has(domain)) category = "learned";
    const entry = tab.trackers[domain] || {
      name: known ? known.name : domain,
      category,
      count: 0
    };
    entry.count++;
    tab.trackers[domain] = entry;

    observedDomain = domain;
    observedName = entry.name;
    observedCategory = category;
    recordBlockDiagnostic(tab, {
      domain,
      name: entry.name,
      category,
      url,
      source: classifyBlockSource(domain, hostname),
      at: Date.now()
    });
  }

  schedulePersistTabs();
  scheduleBroadcastUpdate(tabId);
  recordDailyBlock();
  if (observedDomain && observedDomain !== tab.baseDomain) {
    updateObservedTracker(observedDomain, observedName, observedCategory, tab.baseDomain);
  }
}

function classifyBlockSource(domain, hostname) {
  const known = lookupTracker(hostname || domain);
  if (known) {
    return {
      type: "known-tracker",
      label: "Known tracker list",
      confidence: "high",
      detail: `${known.name} (${known.category || "tracker"})`
    };
  }
  if (learnedBlockedSet.has(domain)) {
    return {
      type: "learned",
      label: "Learned tracker",
      confidence: "high",
      detail: "Seen across multiple sites and blocked locally"
    };
  }
  const custom = customRules.find(
    (r) =>
      r.enabled &&
      r.action === "block" &&
      r.type === "domain" &&
      (domain === r.value || domain.endsWith("." + r.value))
  );
  if (custom) {
    return {
      type: "custom",
      label: "Custom block rule",
      confidence: "medium",
      detail: custom.name || custom.value
    };
  }
  if (typeof cnameMap !== "undefined" && cnameMap?.[hostname]) {
    return {
      type: "cname",
      label: "CNAME uncloaking",
      confidence: "medium",
      detail: cnameMap[hostname]
    };
  }
  return {
    type: "estimated",
    label: "Network block estimate",
    confidence: "estimated",
    detail: "Chrome reported ERR_BLOCKED_BY_CLIENT; another blocker may also contribute"
  };
}

function recordBlockDiagnostic(tab, info) {
  if (!tab.diagnostics) tab.diagnostics = [];
  const existing = tab.diagnostics.find((d) => d.domain === info.domain);
  if (existing) {
    existing.count = (existing.count || 0) + 1;
    existing.lastUrl = info.url;
    existing.at = info.at;
    existing.source = info.source;
    return;
  }
  tab.diagnostics.unshift({
    domain: info.domain,
    name: info.name,
    category: info.category,
    count: 1,
    lastUrl: info.url,
    source: info.source,
    at: info.at
  });
  tab.diagnostics = tab.diagnostics.slice(0, 30);
}

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    if (!swEnabled) return;
    if (!BLOCKED_ERRORS.has(details.error)) return;
    recordBlockedRequest(details.tabId, details.url);
  },
  { urls: ["<all_urls>"] }
);

async function enableActionCountBadge() {
  try {
    await chrome.declarativeNetRequest.setExtensionActionOptions({
      displayActionCountAsBadgeText: true
    });
  } catch (e) {
    console.warn("QuietBrowse: badge options failed:", e.message);
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading") {
    const host = tab.url ? safeHostname(tab.url) : null;
    tabData[tabId] = {
      count: 0,
      trackers: {},
      diagnostics: [],
      url: tab.url || null,
      baseDomain: host ? getBaseDomain(host) : null
    };
    schedulePersistTabs();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (broadcastTimers[tabId]) {
    clearTimeout(broadcastTimers[tabId]);
    delete broadcastTimers[tabId];
  }
  delete tabData[tabId];
  schedulePersistTabs();
});

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId !== 0 || details.tabId < 0) return;
  chrome.tabs
    .sendMessage(details.tabId, {
      type: "historyStateUpdated",
      url: details.url
    })
    .catch(() => {});
});

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (!swEnabled) return;
    if (!details.initiator || details.tabId < 0) return;
    if (!LEARNABLE_RESOURCE_TYPES.has(details.type)) return;

    const requestHost = safeHostname(details.url);
    const initiatorHost = safeHostname(details.initiator);
    if (!requestHost || !initiatorHost) return;

    const requestBase = getBaseDomain(requestHost);
    const initiatorBase = getBaseDomain(initiatorHost);

    if (requestBase === initiatorBase) return;
    if (lookupTracker(requestHost)) return;
    if (learnedBlockedSet.has(requestBase)) return;
    if (isInfrastructureDomain(requestBase)) return;

    const sites = learnedSeen[requestBase] || [];
    if (!sites.includes(initiatorBase)) {
      sites.push(initiatorBase);
      if (sites.length > 5) sites.splice(0, sites.length - 5);
      learnedSeen[requestBase] = sites;
      pruneLearnedSeen();
      scheduleSave();

      if (sites.length >= LEARN_THRESHOLD) {
        reviewLearnedCandidate(requestBase).catch((e) =>
          console.warn("QuietBrowse: learning error:", e.message)
        );
      }
    }
  },
  { urls: ["<all_urls>"] }
);

// Learning helpers: bg_learning.js
// Custom rules: bg_custom.js

// Backup files are user-editable JSON — validate shapes before applying so a
// malformed file can't leave storage half-restored or feed bad values to DNR.
function sanitizeBackup(data) {
  const patch = {};
  const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

  for (const key of [
    "enabled",
    "privacySignals",
    "hideCookiePopups",
    "passwordShield",
    "phishingWarn",
    "downloadGuard",
    "autoBlockLearned",
    "cnameUncloak",
    "scriptletCatalog"
  ]) {
    if (typeof data[key] === "boolean") patch[key] = data[key];
  }

  if (isPlainObject(data.siteModes)) {
    const validModes = new Set(Object.values(SITE_MODE));
    patch.siteModes = {};
    for (const [domain, mode] of Object.entries(data.siteModes)) {
      if (validModes.has(mode)) patch.siteModes[domain] = mode;
    }
  }

  if (isPlainObject(data.learnedSeen)) {
    patch.learnedSeen = {};
    for (const [domain, sites] of Object.entries(data.learnedSeen)) {
      if (!Array.isArray(sites)) continue;
      patch.learnedSeen[domain] = sites
        .filter((s) => typeof s === "string")
        .slice(-5);
    }
  }

  if (Array.isArray(data.learnedBlocked)) {
    patch.learnedBlocked = data.learnedBlocked.filter(
      (d) => typeof d === "string" && d.includes(".")
    );
  }

  if (isPlainObject(data.learnedCandidates)) {
    patch.learnedCandidates = {};
    for (const [domain, entry] of Object.entries(data.learnedCandidates)) {
      if (isPlainObject(entry)) patch.learnedCandidates[domain] = entry;
    }
  }

  // deserializeObserved() fills defaults per entry; only require the container shape.
  if (isPlainObject(data.observedTrackers)) {
    patch.observedTrackers = data.observedTrackers;
  }

  if (Array.isArray(data.customRules)) {
    patch.customRules = [];
    for (const raw of data.customRules) {
      const copy = { ...raw };
      if (!validateCustomRule(copy)) patch.customRules.push(normalizeCustomRule(copy));
    }
    patch.customRules = patch.customRules.slice(0, CUSTOM_RULES_MAX);
  }

  if (Array.isArray(data.customFilterLists)) {
    patch.customFilterLists = data.customFilterLists
      .filter((l) => !validateCustomFilterList(l))
      .map(normalizeCustomFilterList);
  }

  if (Array.isArray(data.rollbackActions)) {
    patch.rollbackActions = data.rollbackActions.filter(isPlainObject).slice(0, 25);
  }

  if (isPlainObject(data.optionalFilterLists)) {
    patch.optionalFilterLists = {};
    for (const [id, on] of Object.entries(data.optionalFilterLists)) {
      patch.optionalFilterLists[id] = on === true;
    }
  }

  if (isPlainObject(data.zappedElements)) {
    patch.zappedElements = {};
    for (const [domain, items] of Object.entries(data.zappedElements)) {
      if (!Array.isArray(items)) continue;
      const clean = items.filter(
        (z) => isPlainObject(z) && typeof z.selector === "string" && z.selector.length
      );
      if (clean.length) patch.zappedElements[domain] = clean;
    }
  }

  if (Number.isFinite(data.totalBlocked) && data.totalBlocked >= 0) {
    patch.totalBlocked = Math.floor(data.totalBlocked);
  }

  if (isPlainObject(data.dailyBlocked)) {
    patch.dailyBlocked = {};
    for (const [day, count] of Object.entries(data.dailyBlocked)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(count) && count >= 0) {
        patch.dailyBlocked[day] = Math.floor(count);
      }
    }
  }

  if (Array.isArray(data.breakageReports)) {
    patch.breakageReports = data.breakageReports.filter(isPlainObject).slice(0, 100);
  }

  return patch;
}

async function restoreBackup(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, error: "Invalid backup file" };
  }
  const patch = sanitizeBackup(data);
  await chrome.storage.local.set(patch);

  if (patch.learnedSeen) learnedSeen = patch.learnedSeen;
  if (patch.learnedBlocked) { learnedBlocked = patch.learnedBlocked; rebuildLearnedSet(); }
  if (patch.learnedCandidates) learnedCandidates = patch.learnedCandidates;
  if (patch.observedTrackers) observedTrackers = deserializeObserved(patch.observedTrackers);
  if (patch.customRules) customRules = Array.isArray(patch.customRules) ? patch.customRules : [];
  if (patch.customFilterLists) customFilterLists = Array.isArray(patch.customFilterLists) ? patch.customFilterLists : [];

  const { enabled } = await chrome.storage.local.get({ enabled: true });
  if (enabled) {
    const siteModes = await migrateSiteModes();
    await syncSiteModeRules(siteModes);
    await syncLearnedRules();
    await syncCustomRules();
    await syncUpdatedRules();
    await syncCnameRules();
  } else {
    await setGlobalEnabled(false);
  }
  await syncScriptlets();
  await notifyContentScripts();
  return { ok: true };
}

async function notifyContentScripts() {
  await chrome.storage.local.set({ [SETTINGS_REVISION_KEY]: Date.now() });
}

function optionalPermissionApiAvailable() {
  return !!chrome.permissions?.contains && !!chrome.permissions?.request;
}

async function hasOptionalPermission(permission) {
  if (!optionalPermissionApiAvailable()) return true;
  return chrome.permissions.contains({ permissions: [permission] });
}

async function requestOptionalPermission(permission) {
  if (!optionalPermissionApiAvailable()) return true;
  const granted = await chrome.permissions.request({ permissions: [permission] });
  return !!granted;
}

async function setDownloadGuardEnabled(enabled) {
  if (enabled) {
    const granted = await requestOptionalPermission("downloads");
    if (!granted) {
      await chrome.storage.local.set({ downloadGuard: false });
      return { ok: false, error: "Download permission was not granted" };
    }
    registerDownloadGuardListener();
  }
  await chrome.storage.local.set({ downloadGuard: !!enabled });
  return { ok: true };
}

async function pushRollbackAction(action) {
  if (suppressRollback || !action) return;
  const data = await chrome.storage.local.get({ rollbackActions: [] });
  const rollbackActions = [
    {
      ...action,
      id: Date.now() + "-" + Math.random().toString(36).slice(2),
      at: new Date().toISOString()
    },
    ...(Array.isArray(data.rollbackActions) ? data.rollbackActions : [])
  ].slice(0, 25);
  await chrome.storage.local.set({ rollbackActions });
}

async function undoLastAction() {
  const data = await chrome.storage.local.get({ rollbackActions: [] });
  const [action, ...rest] = Array.isArray(data.rollbackActions)
    ? data.rollbackActions
    : [];
  if (!action) return { ok: false, error: "Nothing to undo" };

  suppressRollback = true;
  try {
    if (action.type === "siteMode") {
      const siteModes = { ...(await chrome.storage.local.get({ siteModes: {} })).siteModes };
      if (action.previousMode) siteModes[action.domain] = action.previousMode;
      else delete siteModes[action.domain];
      await chrome.storage.local.set({ siteModes });
      await syncSiteModeRules(siteModes);
      await syncScriptlets();
      await notifyContentScripts();
    } else if (action.type === "customRuleAdd") {
      customRules = customRules.filter((r) => r.id !== action.ruleId);
      await chrome.storage.local.set({ customRules });
      await syncCustomRules();
    } else if (action.type === "customRuleRemove") {
      customRules = [...customRules, action.rule].slice(0, CUSTOM_RULES_MAX);
      await chrome.storage.local.set({ customRules });
      await syncCustomRules();
    } else if (action.type === "customRuleUpdate") {
      customRules = customRules.map((r) => (r.id === action.rule.id ? action.rule : r));
      if (!customRules.some((r) => r.id === action.rule.id)) customRules.push(action.rule);
      await chrome.storage.local.set({ customRules });
      await syncCustomRules();
    } else if (action.type === "learnedBlock") {
      learnedBlocked = learnedBlocked.filter((d) => d !== action.domain);
      rebuildLearnedSet();
      if (action.seen) learnedSeen[action.domain] = action.seen;
      if (action.candidate) learnedCandidates[action.domain] = action.candidate;
      await chrome.storage.local.set({ learnedSeen, learnedBlocked, learnedCandidates });
      await syncLearnedRules();
    } else if (action.type === "learnedForget") {
      if (!learnedBlockedSet.has(action.domain)) { learnedBlocked.push(action.domain); rebuildLearnedSet(); }
      if (action.seen) learnedSeen[action.domain] = action.seen;
      if (action.candidate) learnedCandidates[action.domain] = action.candidate;
      await chrome.storage.local.set({ learnedSeen, learnedBlocked, learnedCandidates });
      await syncLearnedRules();
    } else if (action.type === "zappedRemove") {
      const zapped = { ...(await chrome.storage.local.get({ zappedElements: {} })).zappedElements };
      zapped[action.domain] = action.items;
      await chrome.storage.local.set({ zappedElements: zapped });
      await notifyContentScripts();
    } else {
      return { ok: false, error: "Unsupported undo action" };
    }
  } finally {
    suppressRollback = false;
  }
  await chrome.storage.local.set({ rollbackActions: rest });
  return { ok: true, action };
}

async function migrateSiteModes() {
  const data = await chrome.storage.local.get({ whitelist: [], siteModes: {} });
  const siteModes = { ...data.siteModes };
  let changed = false;
  for (const domain of data.whitelist || []) {
    if (!siteModes[domain]) {
      siteModes[domain] = SITE_MODE.OFF;
      changed = true;
    }
  }
  if (changed) {
    await chrome.storage.local.set({ siteModes });
  }
  return siteModes;
}

async function syncSiteModeRules(siteModes) {
  await removeDynamicRange(WHITELIST_ID_START, LEARNED_ID_START - 1);
  const entries = Object.entries(siteModes || {}).filter(
    ([, mode]) => mode === SITE_MODE.OFF || mode === SITE_MODE.ADS
  );
  if (entries.length === 0) return;

  const adDomains = getAdvertisingDomains();
  const rules = [];
  let id = WHITELIST_ID_START;

  for (const [domain, mode] of entries) {
    if (id >= LEARNED_ID_START) break;
    if (mode === SITE_MODE.OFF) {
      rules.push({
        id: id++,
        priority: 100,
        action: { type: "allow" },
        condition: { initiatorDomains: [domain] }
      });
    } else if (mode === SITE_MODE.ADS && adDomains.length) {
      for (let i = 0; i < adDomains.length; i += 400) {
        if (id >= LEARNED_ID_START) break;
        rules.push({
          id: id++,
          priority: 100,
          action: { type: "allow" },
          condition: {
            initiatorDomains: [domain],
            requestDomains: adDomains.slice(i, i + 400)
          }
        });
      }
    }
  }

  for (let i = 0; i < rules.length; i += 4000) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      addRules: rules.slice(i, i + 4000)
    });
  }
}

async function removeDynamicRange(min, max) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const ids = existing
    .filter((r) => r.id >= min && r.id <= max)
    .map((r) => r.id);
  if (ids.length > 0) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: ids
    });
  }
}

// A single high-priority allow-all rule that instantly disables blocking
// without tearing down and reinstalling thousands of dynamic rules.
const GLOBAL_PAUSE_RULE_ID = 9999;

async function setGlobalEnabled(enabled) {
  swEnabled = enabled;
  await chrome.storage.local.set({ enabled });
  const data = await chrome.storage.local.get({
    privacySignals: true,
    siteModes: {},
    useUpdatedLists: false
  });

  if (enabled) {
    // Remove the blanket allow rule to re-enable blocking.
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [GLOBAL_PAUSE_RULE_ID]
    });

    const enableIds = [RULESET_ID];
    const disableIds = [];
    (data.useUpdatedLists ? disableIds : enableIds).push(EASYLIST_RULESET_ID);
    (data.privacySignals ? enableIds : disableIds).push(PRIVACY_RULESET_ID);
    await chrome.declarativeNetRequest.updateEnabledRulesets({
      enableRulesetIds: enableIds,
      disableRulesetIds: disableIds
    });
    await syncSiteModeRules(data.siteModes);
    await syncLearnedRules();
    await syncCustomRules();
    await syncUpdatedRules();
    await syncCnameRules();
  } else {
    // Install a single allow-all rule instead of removing everything.
    await chrome.declarativeNetRequest.updateDynamicRules({
      addRules: [{
        id: GLOBAL_PAUSE_RULE_ID,
        priority: 10000,
        action: { type: "allow" },
        condition: { urlFilter: "*" }
      }]
    });
    await chrome.declarativeNetRequest.updateEnabledRulesets({
      disableRulesetIds: [PRIVACY_RULESET_ID]
    });
  }
  await syncScriptlets();
  await notifyContentScripts();
}

async function setPrivacySignals(on) {
  await chrome.storage.local.set({ privacySignals: on });
  const data = await chrome.storage.local.get({ enabled: true });
  if (!data.enabled) return;
  await chrome.declarativeNetRequest.updateEnabledRulesets(
    on
      ? { enableRulesetIds: [PRIVACY_RULESET_ID] }
      : { disableRulesetIds: [PRIVACY_RULESET_ID] }
  );
}

async function setSiteMode(domain, mode) {
  const data = await chrome.storage.local.get({ siteModes: {} });
  const siteModes = { ...data.siteModes };
  const previousMode = siteModes[domain] || null;
  if (mode === SITE_MODE.FULL) {
    delete siteModes[domain];
  } else {
    siteModes[domain] = mode;
  }
  await pushRollbackAction({
    type: "siteMode",
    domain,
    previousMode,
    nextMode: mode,
    label: `Restore site mode for ${domain}`
  });
  await chrome.storage.local.set({ siteModes });
  try {
    await syncSiteModeRules(siteModes);
    await syncScriptlets();
    await notifyContentScripts();
  } catch (e) {
    console.warn("QuietBrowse: site mode sync failed:", e.message);
    throw e;
  }
}

async function fixSiteBreakage(domain, url, saveReport, note) {
  await setSiteMode(domain, SITE_MODE.OFF);
  if (saveReport) {
    const data = await chrome.storage.local.get({ breakageReports: [] });
    const reports = [
      {
        id: Date.now(),
        domain,
        url,
        note: note || "",
        version: chrome.runtime.getManifest().version,
        at: new Date().toISOString()
      },
      ...(data.breakageReports || [])
    ].slice(0, 100);
    await chrome.storage.local.set({ breakageReports: reports });
  }
  return { ok: true };
}

async function setSiteWhitelisted(domain, whitelisted) {
  await setSiteMode(domain, whitelisted ? SITE_MODE.OFF : SITE_MODE.FULL);
}

// Filter updater + cosmetics: bg_filters.js
// Scriptlets: bg_scriptlets.js
// Learning: bg_learning.js

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === FILTER_UPDATE_ALARM) {
    updateFilterLists().catch((e) =>
      console.warn("QuietBrowse: filter update failed:", e.message)
    );
  }
});

function ensureUpdateAlarm() {
  chrome.alarms.get(FILTER_UPDATE_ALARM, (a) => {
    if (!a) {
      chrome.alarms.create(FILTER_UPDATE_ALARM, {
        periodInMinutes: FILTER_UPDATE_PERIOD_MIN,
        delayInMinutes: FILTER_UPDATE_PERIOD_MIN
      });
    }
  });
}
ensureUpdateAlarm();

const EXEC_EXT_RE =
  /\.(exe|scr|bat|cmd|com|msi|msix|vbs|vbe|js|jse|wsf|wsh|jar|ps1|psm1|hta|pif|cpl|reg|iso|img|application|appx|lnk)$/i;
const DOUBLE_EXT_RE =
  /\.(pdf|docx?|xlsx?|pptx?|txt|jpe?g|png|gif|mp[34]|avi|mov|zip|html?)\.(exe|scr|bat|cmd|com|msi|vbs|js|jar|ps1|hta|pif|lnk)$/i;

let downloadGuardRegistered = false;

function handleDownloadFilename(item, suggest) {
  suggest();
  chrome.storage.local.get({ enabled: true, downloadGuard: false }, (data) => {
    if (!data.enabled || !data.downloadGuard) return;
    const name = (item.filename || "").toLowerCase();
    if (DOUBLE_EXT_RE.test(name)) {
      chrome.downloads.cancel(item.id);
      notify(
        i18n("notifyDangerousDownloadTitle"),
        i18n("notifyDangerousDownloadMsg", item.filename)
      );
    } else if (EXEC_EXT_RE.test(name)) {
      notify(
        i18n("notifyRiskyDownloadTitle"),
        i18n("notifyRiskyDownloadMsg", item.filename)
      );
    }
  });
}

function registerDownloadGuardListener() {
  if (downloadGuardRegistered || !chrome.downloads?.onDeterminingFilename) {
    return false;
  }
  chrome.downloads.onDeterminingFilename.addListener(handleDownloadFilename);
  downloadGuardRegistered = true;
  return true;
}

registerDownloadGuardListener();

function notify(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon128.png",
    title,
    message,
    priority: 2
  });
}

function startZapperOnActiveTab(tabId) {
  chrome.tabs.sendMessage(tabId, { type: "startZapper" }).catch(() => {
    notify(i18n("notifyCantZapTitle"), i18n("notifyCantZapMsg"));
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "quiet-zap" || !tab?.id) return;
  startZapperOnActiveTab(tab.id);
});

if (chrome.commands?.onCommand) {
  chrome.commands.onCommand.addListener(async (command) => {
    if (command !== "start-zapper") return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) startZapperOnActiveTab(tab.id);
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "getTabInfo") {
    const tabId = msg.tabId ?? sender.tab?.id;
    const tab = (tabId != null ? tabData[tabId] : null) || { count: 0, trackers: {} };
    sendResponse({
      count: tab.count,
      trackers: Object.entries(tab.trackers).map(([domain, t]) => ({
        domain,
        ...t
      })),
      learnedCount: learnedBlocked.length,
      learnedBlocked: learnedBlocked.slice(),
      diagnostics: (tab.diagnostics || []).slice()
    });
  } else if (msg.type === "getDiagnostics") {
    const tabId = msg.tabId ?? sender.tab?.id;
    const tab = (tabId != null ? tabData[tabId] : null) || { diagnostics: [] };
    sendResponse({
      ok: true,
      diagnostics: (tab.diagnostics || []).slice()
    });
  } else if (msg.type === "setGlobalEnabled") {
    setGlobalEnabled(msg.enabled).then(() => sendResponse({ ok: true }));
    return true;
  } else if (msg.type === "setSiteWhitelisted") {
    setSiteWhitelisted(msg.domain, msg.whitelisted).then(() =>
      sendResponse({ ok: true })
    );
    return true;
  } else if (msg.type === "setSiteMode") {
    setSiteMode(msg.domain, msg.mode).then(() => sendResponse({ ok: true }));
    return true;
  } else if (msg.type === "fixSiteBreakage") {
    fixSiteBreakage(msg.domain, msg.url, !!msg.saveReport, msg.note || "")
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  } else if (msg.type === "clearBreakageReports") {
    chrome.storage.local.set({ breakageReports: [] }, () =>
      sendResponse({ ok: true })
    );
    return true;
  } else if (msg.type === "setContentSettings") {
    const patch = {};
    if ("hideCookiePopups" in msg) patch.hideCookiePopups = msg.hideCookiePopups;
    if ("passwordShield" in msg) patch.passwordShield = msg.passwordShield;
    if ("phishingWarn" in msg) patch.phishingWarn = msg.phishingWarn;
    (async () => {
      if (Object.keys(patch).length) await chrome.storage.local.set(patch);
      if ("downloadGuard" in msg) {
        const result = await setDownloadGuardEnabled(!!msg.downloadGuard);
        if (!result.ok) {
          sendResponse(result);
          return;
        }
      }
      await notifyContentScripts();
      sendResponse({ ok: true });
    })().catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  } else if (msg.type === "setPrivacySignals") {
    setPrivacySignals(msg.enabled).then(() => sendResponse({ ok: true }));
    return true;
  } else if (msg.type === "analyzePhish") {
    try {
      const result = PhishScore.analyze(
        msg.hostname || "",
        msg.protocol || "https:",
        !!msg.hasPasswordField,
        msg.signals || {}
      );
      sendResponse({ ok: true, ...result });
    } catch (e) {
      sendResponse({ ok: false, error: e.message || String(e) });
    }
  } else if (msg.type === "getOptionsData") {
    chrome.storage.local.get(
      {
        siteModes: {},
        zappedElements: {},
        totalBlocked: 0,
        dailyBlocked: {},
        enabled: true,
        privacySignals: true,
        hideCookiePopups: true,
        passwordShield: true,
        phishingWarn: true,
        downloadGuard: false,
        lastFilterUpdate: 0,
        useUpdatedLists: false,
        breakageReports: [],
        antiAdblock: false,
        autoBlockLearned: false,
        filterUpdateError: null,
        dnrBudget: null,
        optionalFilterLists: null,
        cnameUncloak: true,
        scriptletCatalog: true,
        rollbackActions: []
      },
      async (data) => {
        const toggles = data.optionalFilterLists || defaultOptionalToggles();
        let dnrBudget = data.dnrBudget;
        try {
          dnrBudget = await getDnrBudget();
        } catch {
          /* keep stored budget or null */
        }
        sendResponse({
          siteModes: data.siteModes,
          learnedBlocked,
          learnedSeen,
          learnedCandidates,
          observedTrackers: serializeObserved(),
          customRules,
          customFilterLists,
          defaultFilterLists: DEFAULT_FILTER_URLS,
          optionalFilterLists: OPTIONAL_FILTER_LISTS.map((l) => ({
            ...l,
            enabled: !!toggles[l.id]
          })),
          zappedElements: data.zappedElements,
          totalBlocked: data.totalBlocked,
          dailyBlocked: data.dailyBlocked,
          enabled: data.enabled,
          privacySignals: data.privacySignals !== false,
          hideCookiePopups: data.hideCookiePopups !== false,
          passwordShield: data.passwordShield !== false,
          phishingWarn: data.phishingWarn !== false,
          downloadGuard: data.downloadGuard === true,
          lastFilterUpdate: data.lastFilterUpdate,
          useUpdatedLists: data.useUpdatedLists,
          breakageReports: data.breakageReports || [],
          antiAdblock: data.antiAdblock === true,
          autoBlockLearned: data.autoBlockLearned === true,
          filterUpdateError: data.filterUpdateError,
          dnrBudget,
          cnameUncloak: data.cnameUncloak !== false,
          scriptletCatalog: data.scriptletCatalog !== false,
          rollbackActions: data.rollbackActions || []
        });
      }
    );
    return true;
  } else if (msg.type === "clearObservedTrackers") {
    observedTrackers = {};
    chrome.storage.local.set({ observedTrackers: {} }, () => sendResponse({ ok: true }));
    return true;
  } else if (msg.type === "undoLastAction") {
    undoLastAction().then((result) => sendResponse(result));
    return true;
  } else if (msg.type === "forgetWatching") {
    if (msg.domain) delete learnedSeen[msg.domain];
    if (msg.domain) delete learnedCandidates[msg.domain];
    chrome.storage.local.set({ learnedSeen, learnedBlocked, learnedCandidates }, () =>
      sendResponse({ ok: true })
    );
    return true;
  } else if (msg.type === "setAutoBlockLearned") {
    (async () => {
      if (msg.enabled) {
        const granted = await requestOptionalPermission("cookies");
        if (!granted) {
          await chrome.storage.local.set({ autoBlockLearned: false });
          sendResponse({ ok: false, error: "Cookie permission was not granted" });
          return;
        }
      }
      await chrome.storage.local.set({ autoBlockLearned: !!msg.enabled });
      sendResponse({ ok: true });
    })().catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  } else if (msg.type === "setAntiAdblock") {
    chrome.storage.local.set({ antiAdblock: !!msg.enabled }, async () => {
      await syncScriptlets();
      sendResponse({ ok: true });
    });
    return true;
  } else if (msg.type === "setScriptletCatalog") {
    chrome.storage.local.set({ scriptletCatalog: !!msg.enabled }, async () => {
      await syncScriptlets();
      sendResponse({ ok: true });
    });
    return true;
  } else if (msg.type === "setCnameUncloak") {
    chrome.storage.local.set({ cnameUncloak: !!msg.enabled }, async () => {
      await syncCnameRules();
      sendResponse({ ok: true });
    });
    return true;
  } else if (msg.type === "setOptionalFilterList") {
    setOptionalFilterList(msg.id, msg.enabled).then((result) => sendResponse(result));
    return true;
  } else if (msg.type === "getCustomRules") {
    sendResponse({ rules: customRules });
  } else if (msg.type === "getFilterLists") {
    sendResponse({ defaults: DEFAULT_FILTER_URLS, custom: customFilterLists });
  } else if (msg.type === "addCustomFilterList") {
    addCustomFilterList(msg.list).then((result) => sendResponse(result));
    return true;
  } else if (msg.type === "updateCustomFilterList") {
    updateCustomFilterList(msg.id, msg.updates).then((result) => sendResponse(result));
    return true;
  } else if (msg.type === "removeCustomFilterList") {
    removeCustomFilterList(msg.id).then((result) => sendResponse(result));
    return true;
  } else if (msg.type === "addCustomRule") {
    addCustomRule(msg.rule).then((result) => sendResponse(result));
    return true;
  } else if (msg.type === "updateCustomRule") {
    updateCustomRule(msg.id, msg.updates).then((result) => sendResponse(result));
    return true;
  } else if (msg.type === "removeCustomRule") {
    removeCustomRule(msg.id).then((result) => sendResponse(result));
    return true;
  } else if (msg.type === "importCustomRules") {
    importCustomRules(msg.rules).then((result) => sendResponse(result));
    return true;
  } else if (msg.type === "restoreBackup") {
    restoreBackup(msg.data).then((result) => sendResponse(result));
    return true;
  } else if (msg.type === "updateFilters") {
    updateFilterLists()
      .then((n) => sendResponse({ ok: true, ruleCount: n }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  } else if (msg.type === "updateSiteModes") {
    chrome.storage.local.set({ siteModes: msg.siteModes }, async () => {
      await syncSiteModeRules(msg.siteModes);
      await syncScriptlets();
      await notifyContentScripts();
      sendResponse({ ok: true });
    });
    return true;
  } else if (msg.type === "updateWhitelist") {
    const siteModes = {};
    for (const domain of msg.whitelist || []) siteModes[domain] = SITE_MODE.OFF;
    chrome.storage.local.set({ siteModes }, async () => {
      await syncSiteModeRules(siteModes);
      await syncScriptlets();
      await notifyContentScripts();
      sendResponse({ ok: true });
    });
    return true;
  } else if (msg.type === "forgetLearned") {
    forgetLearnedTracker(msg.domain).then(() => sendResponse({ ok: true }));
    return true;
  } else if (msg.type === "blockTracker") {
    blockTrackerDomain(msg.domain).then((result) => sendResponse(result));
    return true;
  } else if (msg.type === "removeZapped") {
    chrome.storage.local.get({ zappedElements: {} }, async (data) => {
      const all = { ...data.zappedElements };
      if (msg.domain && all[msg.domain]) {
        const previousItems = all[msg.domain].slice();
        if (typeof msg.index === "number") {
          all[msg.domain] = all[msg.domain].filter((_, i) => i !== msg.index);
          if (all[msg.domain].length === 0) delete all[msg.domain];
        } else {
          delete all[msg.domain];
        }
        await pushRollbackAction({
          type: "zappedRemove",
          domain: msg.domain,
          items: previousItems,
          label: `Restore zapped elements for ${msg.domain}`
        });
      }
      chrome.storage.local.set({ zappedElements: all }, async () => {
        sendResponse({ ok: true });
        await notifyContentScripts();
      });
    });
    return true;
  } else if (msg.type === "startZapperOnTab") {
    const tabId = msg.tabId;
    if (!tabId) return sendResponse({ ok: false });
    chrome.tabs
      .sendMessage(tabId, { type: "startZapper" })
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  } else if (msg.type === "broadcastSettings") {
    notifyContentScripts().then(() => sendResponse({ ok: true }));
    return true;
  }
});

// safeHostname is now in utils.js (shared with content scripts)

async function restoreState() {
  const data = await chrome.storage.local.get({
    learnedSeen: {},
    learnedBlocked: [],
    learnedCandidates: {},
    observedTrackers: {},
    customRules: [],
    customFilterLists: []
  });
  learnedSeen = data.learnedSeen;
  learnedBlocked = data.learnedBlocked;
  rebuildLearnedSet();
  learnedCandidates = data.learnedCandidates || {};
  observedTrackers = deserializeObserved(data.observedTrackers);
  customRules = Array.isArray(data.customRules) ? data.customRules : [];
  customFilterLists = Array.isArray(data.customFilterLists) ? data.customFilterLists : [];

  try {
    const session = await chrome.storage.session.get(SESSION_KEY);
    if (session[SESSION_KEY]) {
      Object.assign(tabData, session[SESSION_KEY]);
    }
  } catch {
    /* session storage unavailable */
  }
}

restoreState();
enableActionCountBadge();

migrateSiteModes().then(async (siteModes) => {
  await pullPrefsFromSync();
  const { enabled } = await chrome.storage.local.get({ enabled: true });
  swEnabled = enabled;
  if (enabled) {
    await syncSiteModeRules(siteModes);
    await syncCustomRules();
  } else {
    await setGlobalEnabled(false);
  }
  await seedBundledCosmetics();
  await syncScriptlets();
  await syncCnameRules();
  watchSyncPrefs();
});

chrome.runtime.onInstalled.addListener(async (details) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "quiet-zap",
      title: "Zap element on this page (QuietBrowse)",
      contexts: ["page", "frame"]
    });
  });

  await enableActionCountBadge();

  const data = await chrome.storage.local.get({
    enabled: true,
    privacySignals: true,
    hideCookiePopups: true,
    passwordShield: true,
    phishingWarn: true,
    downloadGuard: false,
    antiAdblock: false,
    autoBlockLearned: false,
    cnameUncloak: true,
    scriptletCatalog: true,
    optionalFilterLists: defaultOptionalToggles(),
    siteModes: {},
    totalBlocked: 0,
    dailyBlocked: {},
    zappedElements: {},
    learnedSeen: {},
    learnedBlocked: [],
    learnedCandidates: {},
    observedTrackers: {},
    customRules: [],
    customFilterLists: [],
    breakageReports: [],
    lastFilterUpdate: 0,
    useUpdatedLists: false,
    installAt: null
  });
  // Set first-install timestamp once (used for gentle review prompt timing).
  const installAt = data.installAt || Date.now();
  await chrome.storage.local.set({ ...data, installAt });
  const siteModes = await migrateSiteModes();
  await chrome.storage.local.set({ siteModes });
  await restoreState();
  await setGlobalEnabled(data.enabled);
  await seedBundledCosmetics();
  await syncCnameRules();
  ensureUpdateAlarm();

  chrome.runtime.setUninstallURL("https://ansh0079.github.io/shieldwall/?uninstalled=1");

  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });
  }
});
