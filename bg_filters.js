// QuietBrowse - filter list updater + cosmetic seeding (importScripts into SW)

let filterUpdateInProgress = false;

// ── Integrity helpers ─────────────────────────────────────────────────────────

// Default EasyList is ~3.5 MB, EasyPrivacy ~1.5 MB. Anything under 100 KB for a
// default list is either a truncated response or a CDN error page.
const DEFAULT_LIST_MIN_BYTES = 100_000;
const CUSTOM_LIST_MIN_BYTES  = 500;
const FILTER_FETCH_TIMEOUT_MS = 30_000;
const MAX_FILTER_LIST_BYTES = 20 * 1024 * 1024;
const MAX_FILTER_UPDATE_BYTES = 50 * 1024 * 1024;

// Reject a new compiled set if its block-rule count drops more than 50 % below
// the last accepted count — guards against a poisoned or stripped replacement.
const MAX_RULE_DROP_FRACTION = 0.50;

function defaultOptionalToggles() {
  const out = {};
  for (const list of OPTIONAL_FILTER_LISTS) {
    out[list.id] = !!list.defaultEnabled;
  }
  return out;
}

let __rulesetIndexCache = null;
async function getRulesetIndex() {
  if (__rulesetIndexCache) return __rulesetIndexCache;
  try {
    const res = await fetch(chrome.runtime.getURL("ruleset_index.json"));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    __rulesetIndexCache = await res.json();
  } catch {
    __rulesetIndexCache = {};
  }
  return __rulesetIndexCache;
}

async function getAvailableStaticRuleCount() {
  try {
    const fn = chrome.declarativeNetRequest.getAvailableStaticRuleCount;
    if (!fn) return null;
    const n = await fn();
    // Chrome returns a number; if object in future, attempt to extract a field.
    if (typeof n === "number") return n;
    if (n && typeof n.available === "number") return n.available;
  } catch {
    /* not supported on this channel */
  }
  return null;
}

async function readFilterResponse(res, maxBytes = MAX_FILTER_LIST_BYTES) {
  const declared = Number(res.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`response is too large (${declared} bytes; limit ${maxBytes})`);
  }

  if (!res.body?.getReader) {
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > maxBytes) throw new Error(`response exceeds ${maxBytes} bytes`);
    return { text: new TextDecoder().decode(buffer), bytes: buffer.byteLength };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel("filter list too large").catch(() => {});
        throw new Error(`response exceeds ${maxBytes} bytes`);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return { text, bytes };
  } finally {
    reader.releaseLock?.();
  }
}

async function fetchFilterList(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FILTER_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { cache: "no-cache", signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await readFilterResponse(res);
  } finally {
    clearTimeout(timer);
  }
}

async function getEnabledFilterUrls() {
  const data = await chrome.storage.local.get({
    optionalFilterLists: null,
    customFilterLists: [],
    staticEnabledOptionals: {}
  });
  const toggles = data.optionalFilterLists || defaultOptionalToggles();
  const urls = [...DEFAULT_FILTER_URLS];
  // If a list is enabled via static rulesets, skip it in the dynamic updater to avoid duplication.
  const staticEnabled = data.staticEnabledOptionals || {};
  for (const list of OPTIONAL_FILTER_LISTS) {
    if (toggles[list.id] && !staticEnabled[list.id]) urls.push(list.url);
  }
  for (const list of data.customFilterLists || []) {
    if (list.enabled && list.url) urls.push(list.url);
  }
  return [...new Set(urls)];
}

async function applyUpdatedRulesToDnr(rules) {
  if (!Array.isArray(rules)) throw new Error("Updated rules must be an array");
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing
    .filter((r) => r.id >= UPDATE_ALLOW_ID_START && r.id <= UPDATE_ID_END)
    .map((r) => r.id);
  const otherDynamic = existing.length - removeRuleIds.length;
  const maxDynamic =
    chrome.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_RULES || 30000;
  if (otherDynamic + rules.length > maxDynamic) {
    throw new Error(
      `Updated lists need ${rules.length} dynamic rules, but only ` +
        `${Math.max(0, maxDynamic - otherDynamic)} are available`
    );
  }

  // One atomic update: if the replacement is invalid, Chrome keeps the old rules.
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds,
    addRules: rules
  });
}

async function getDnrBudget(candidateUpdateRuleCount = null) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const updateRules = existing.filter(
    (r) => r.id >= UPDATE_ALLOW_ID_START && r.id <= UPDATE_ID_END
  ).length;
  const otherDynamicRules = existing.length - updateRules;
  const maxDynamicRules =
    chrome.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_RULES || 30000;
  const updateRuleCount =
    typeof candidateUpdateRuleCount === "number"
      ? candidateUpdateRuleCount
      : updateRules;
  return {
    maxDynamicRules,
    otherDynamicRules,
    updateRules,
    projectedUpdateRules: updateRuleCount,
    projectedTotalDynamicRules: otherDynamicRules + updateRuleCount,
    remainingDynamicRules: Math.max(
      0,
      maxDynamicRules - otherDynamicRules - updateRuleCount
    ),
    exceedsBudget: otherDynamicRules + updateRuleCount > maxDynamicRules
  };
}

async function updateFilterLists() {
  if (filterUpdateInProgress) {
    throw new Error("Filter update already in progress");
  }
  filterUpdateInProgress = true;

  const prev = await chrome.storage.local.get({
    updatedRules: null,
    useUpdatedLists: false,
    genericSelectors: null
  });
  const { enabled } = await chrome.storage.local.get({ enabled: true });

  try {
    const urls = await getEnabledFilterUrls();
    const texts = [];
    let totalBytes = 0;
    let defaultOk = 0;
    for (const url of urls) {
      try {
        const downloaded = await fetchFilterList(url);
        totalBytes += downloaded.bytes;
        if (totalBytes > MAX_FILTER_UPDATE_BYTES) {
          throw new Error(`combined filter lists exceed ${MAX_FILTER_UPDATE_BYTES} bytes`);
        }
        const text = downloaded.text;
        const minBytes = DEFAULT_FILTER_URLS.includes(url)
          ? DEFAULT_LIST_MIN_BYTES
          : CUSTOM_LIST_MIN_BYTES;
        if (text.length < minBytes) {
          console.warn(
            `QuietBrowse: filter list too small ${url}: ${text.length} bytes (expected ≥${minBytes})`
          );
          continue;
        }
        if (!text.includes("!") && !text.includes("#") && !text.includes("||")) {
          console.warn(`QuietBrowse: filter list ${url} does not look like a filter list`);
          continue;
        }
        // Log the embedded EasyList checksum for audit visibility.
        const csm = text.match(/^! Checksum:\s*(\S+)/m);
        if (csm) {
          console.log(
            `QuietBrowse: checksum present for ${new URL(url).hostname} — ${csm[1]}`
          );
        }
        texts.push(text);
        if (DEFAULT_FILTER_URLS.includes(url)) defaultOk++;
      } catch (e) {
        console.warn(`QuietBrowse: filter list fetch failed ${url}: ${e.message}`);
      }
    }

    if (defaultOk < DEFAULT_FILTER_URLS.length) {
      throw new Error("One or more default filter lists could not be fetched");
    }

    const c = compileFilters(texts);
    if (c.blockRules.length < MIN_SANE_BLOCK_RULES) {
      throw new Error(
        `Compiled only ${c.blockRules.length} block rules ` +
          `(expected ${MIN_SANE_BLOCK_RULES}+) — aborting to keep current lists safe`
      );
    }
    const prevRuleCount = prev.updatedRules?.length ?? 0;
    if (prevRuleCount > 0 && c.blockRules.length < prevRuleCount * (1 - MAX_RULE_DROP_FRACTION)) {
      throw new Error(
        `Compiled ${c.blockRules.length} block rules but last accepted count was ` +
          `${prevRuleCount} — drop exceeds ${MAX_RULE_DROP_FRACTION * 100}%, ` +
          `rejecting to protect against stripped list`
      );
    }

    const rules = [
      ...c.allowRules.map((r, i) => ({ ...r, id: UPDATE_ALLOW_ID_START + i })),
      ...c.blockRules.map((r, i) => ({ ...r, id: UPDATE_BLOCK_ID_START + i })),
      ...(c.paramRules || []).map((r, i) => ({
        ...r,
        id: UPDATE_BLOCK_ID_START + c.blockRules.length + i
      }))
    ];

    if (enabled) {
      try {
        await applyUpdatedRulesToDnr(rules);
      } catch (e) {
        if (prev.useUpdatedLists && prev.updatedRules?.length) {
          try {
            await applyUpdatedRulesToDnr(prev.updatedRules);
          } catch {
            await chrome.declarativeNetRequest
              .updateEnabledRulesets({ enableRulesetIds: [EASYLIST_RULESET_ID] })
              .catch(() => {});
          }
        } else {
          await chrome.declarativeNetRequest
            .updateEnabledRulesets({ enableRulesetIds: [EASYLIST_RULESET_ID] })
            .catch(() => {});
        }
        throw new Error("Dynamic rule install failed: " + e.message);
      }

      await chrome.declarativeNetRequest.updateEnabledRulesets({
        disableRulesetIds: [EASYLIST_RULESET_ID]
      });
    }

    await seedSiteCosmetics(c.siteHide, c.siteUnhide);
    await seedProceduralRules(c.proceduralRules);

    await chrome.storage.local.set({
      updatedRules: rules,
      genericSelectors: c.genericSelectors,
      lastFilterUpdate: Date.now(),
      useUpdatedLists: true,
      dnrBudget: await getDnrBudget(rules.length),
      filterUpdateError: null
    });

    console.log(`QuietBrowse: filter lists updated (${rules.length} rules from ${texts.length} lists)`);
    return rules.length;
  } catch (e) {
    await chrome.storage.local.set({
      filterUpdateError: { message: String(e.message || e), at: Date.now() }
    });
    throw e;
  } finally {
    filterUpdateInProgress = false;
  }
}

async function syncUpdatedRules() {
  const data = await chrome.storage.local.get({
    updatedRules: null,
    useUpdatedLists: false
  });
  if (!data.useUpdatedLists || !data.updatedRules?.length) return;
  try {
    await applyUpdatedRulesToDnr(data.updatedRules);
  } catch (e) {
    console.warn("QuietBrowse: syncUpdatedRules failed:", e.message);
  }
}

async function setOptionalFilterList(id, enabled) {
  const known = OPTIONAL_FILTER_LISTS.some((l) => l.id === id);
  if (!known) return { ok: false, error: "Unknown list" };
  const data = await chrome.storage.local.get({
    optionalFilterLists: defaultOptionalToggles(),
    staticEnabledOptionals: {}
  });
  const toggles = { ...(data.optionalFilterLists || defaultOptionalToggles()), [id]: !!enabled };
  const staticEnabled = { ...(data.staticEnabledOptionals || {}) };

  if (!enabled) {
    // Disable static rulesets if they were enabled
    try {
      const index = await getRulesetIndex();
      const info = index[id];
      if (info?.ids?.length) {
        await chrome.declarativeNetRequest.updateEnabledRulesets({
          disableRulesetIds: info.ids
        });
      }
      delete staticEnabled[id];
    } catch (e) {
      console.warn("QuietBrowse: disable optional static failed:", e.message);
    }
    await chrome.storage.local.set({ optionalFilterLists: toggles, staticEnabledOptionals: staticEnabled });
    return { ok: true, toggles };
  }

  // Try to enable as static rulesets first.
  let enabledStatically = false;
  try {
    const index = await getRulesetIndex();
    const info = index[id];
    if (info?.ids?.length) {
      const needed = (info.total || 0) - 0;
      const avail = await getAvailableStaticRuleCount();
      if (avail == null || avail >= needed) {
        await chrome.declarativeNetRequest.updateEnabledRulesets({
          enableRulesetIds: info.ids
        });
        staticEnabled[id] = true;
        enabledStatically = true;
      } else {
        console.warn(`QuietBrowse: static pool low (${avail} rules left), falling back to dynamic for ${id}`);
      }
    }
  } catch (e) {
    console.warn("QuietBrowse: enable optional static failed:", e.message);
  }

  await chrome.storage.local.set({ optionalFilterLists: toggles, staticEnabledOptionals: staticEnabled });
  return { ok: true, toggles, mode: enabledStatically ? "static" : "dynamic" };
}

async function seedSiteCosmetics(siteHide, siteUnhide) {
  const { cosmeticDomains: oldDomains = [] } = await chrome.storage.local.get({
    cosmeticDomains: []
  });

  const entries = {};
  for (const [d, sels] of Object.entries(siteHide || {})) {
    entries["cs_" + d] = sels;
  }
  for (const [d, sels] of Object.entries(siteUnhide || {})) {
    entries["cx_" + d] = sels;
  }

  const newDomains = [...new Set([
    ...Object.keys(siteHide || {}),
    ...Object.keys(siteUnhide || {})
  ])];
  const keys = Object.keys(entries);

  for (let i = 0; i < keys.length; i += 2000) {
    const chunk = {};
    for (const k of keys.slice(i, i + 2000)) chunk[k] = entries[k];
    await chrome.storage.local.set(chunk);
  }

  await chrome.storage.local.set({ cosmeticDomains: newDomains });

  const oldKeys = oldDomains.flatMap((d) => ["cs_" + d, "cx_" + d]);
  const newKeySet = new Set(keys);
  const removeKeys = oldKeys.filter((key) => !newKeySet.has(key));
  if (removeKeys.length) {
    for (let i = 0; i < removeKeys.length; i += 5000) {
      await chrome.storage.local.remove(removeKeys.slice(i, i + 5000));
    }
  }
}

const MAX_PROC_RULES = 2000;

async function seedProceduralRules(proceduralRules) {
  if (!proceduralRules || typeof proceduralRules !== "object") return;
  const flat = [];
  // Site-specific first (higher value, lower volume)
  for (const [domain, rules] of Object.entries(proceduralRules)) {
    if (!domain) continue;
    if (flat.length >= MAX_PROC_RULES) break;
    for (const r of rules) {
      if (flat.length >= MAX_PROC_RULES) break;
      flat.push({ ...r, domains: [domain] });
    }
  }
  // Generic rules up to remaining cap
  for (const r of (proceduralRules[""] || [])) {
    if (flat.length >= MAX_PROC_RULES) break;
    flat.push({ ...r, domains: [] });
  }
  await chrome.storage.local.set({ proceduralRules: flat });
}

async function seedBundledCosmetics() {
  const version = chrome.runtime.getManifest().version;
  const data = await chrome.storage.local.get({
    cosmeticSeedVersion: "",
    useUpdatedLists: false,
    genericSelectors: null
  });
  if (data.useUpdatedLists || data.cosmeticSeedVersion === version) {
    if (
      !data.genericSelectors?.length &&
      typeof GENERIC_HIDE_SELECTORS !== "undefined" &&
      Array.isArray(GENERIC_HIDE_SELECTORS)
    ) {
      await chrome.storage.local.set({ genericSelectors: GENERIC_HIDE_SELECTORS });
    }
    return;
  }
  try {
    const res = await fetch(chrome.runtime.getURL("cosmetic_sites.json"));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { hide, unhide } = await res.json();
    await seedSiteCosmetics(hide, unhide);

    if (typeof GENERIC_HIDE_SELECTORS !== "undefined" && Array.isArray(GENERIC_HIDE_SELECTORS)) {
      await chrome.storage.local.set({ genericSelectors: GENERIC_HIDE_SELECTORS });
    }

    if (typeof BUNDLED_PROCEDURAL_RULES !== "undefined" && Array.isArray(BUNDLED_PROCEDURAL_RULES)) {
      await chrome.storage.local.set({ proceduralRules: BUNDLED_PROCEDURAL_RULES });
    }

    await chrome.storage.local.set({ cosmeticSeedVersion: version });
  } catch (e) {
    console.warn("QuietBrowse: cosmetic seeding failed:", e.message);
  }
}
