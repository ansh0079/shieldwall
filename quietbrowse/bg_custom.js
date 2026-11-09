// QuietBrowse - custom DNR rules + custom filter-list URLs

function buildCustomDnrRule(rule, index) {
  const id =
    rule.action === "allow"
      ? CUSTOM_ALLOW_ID_START + index
      : CUSTOM_BLOCK_ID_START + index;
  const cond = {};
  if (rule.type === "domain") {
    cond.requestDomains = [rule.value];
    if (rule.action === "block" && rule.scope === "thirdParty") {
      cond.domainType = "thirdParty";
    }
  } else if (rule.type === "urlContains") {
    cond.urlFilter = rule.value;
    if (rule.scope === "thirdParty") cond.domainType = "thirdParty";
  }
  return {
    id,
    priority: rule.action === "allow" ? 90 : 2,
    action: { type: rule.action },
    condition: cond
  };
}

async function syncCustomRules() {
  const enabled = customRules.filter((r) => r.enabled);
  const rules = [];
  let blockIndex = 0;
  let allowIndex = 0;
  for (const rule of enabled) {
    const index = rule.action === "allow" ? allowIndex++ : blockIndex++;
    rules.push(buildCustomDnrRule(rule, index));
  }
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing
    .filter(
      (r) =>
        (r.id >= CUSTOM_BLOCK_ID_START && r.id < CUSTOM_ALLOW_ID_START) ||
        (r.id >= CUSTOM_ALLOW_ID_START && r.id <= CUSTOM_ALLOW_ID_START + CUSTOM_RULES_MAX)
    )
    .map((r) => r.id);
  const maxDynamic = chrome.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_RULES || 30000;
  if (existing.length - removeRuleIds.length + rules.length > maxDynamic) {
    throw new Error("Not enough dynamic-rule capacity for custom rules");
  }

  // Replace the complete custom range atomically so a failed install retains
  // the last working ruleset.
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: rules });
}

function validateCustomRule(rule) {
  if (!rule || typeof rule !== "object") return "Invalid rule";
  if (!["block", "allow"].includes(rule.action)) return "Action must be block or allow";
  if (!["domain", "urlContains"].includes(rule.type)) return "Type must be domain or urlContains";
  if (!rule.value || typeof rule.value !== "string") return "Value is required";
  if (rule.type === "domain") {
    const d = rule.value
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "")
      .replace(/^www\./, "");
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d)) {
      return "Invalid domain";
    }
    rule.value = d;
  } else if (rule.type === "urlContains") {
    if (rule.value.length < 2) return "URL pattern too short";
  }
  if (rule.scope && !["all", "thirdParty"].includes(rule.scope)) rule.scope = "all";
  return null;
}

function normalizeCustomRule(rule) {
  return {
    id: rule.id || crypto.randomUUID?.() || Math.random().toString(36).slice(2),
    name: (rule.name || "").trim() || rule.value,
    action: rule.action,
    type: rule.type,
    value: rule.value,
    scope: ["all", "thirdParty"].includes(rule.scope) ? rule.scope : "all",
    enabled: typeof rule.enabled === "boolean" ? rule.enabled : true,
    createdAt: rule.createdAt || new Date().toISOString()
  };
}

async function addCustomRule(rule) {
  const err = validateCustomRule(rule);
  if (err) return { ok: false, error: err };
  if (customRules.length >= CUSTOM_RULES_MAX) {
    return { ok: false, error: "Maximum 200 custom rules" };
  }
  const normalized = normalizeCustomRule(rule);
  customRules = [...customRules, normalized];
  await pushRollbackAction({
    type: "customRuleAdd",
    ruleId: normalized.id,
    label: `Remove custom rule ${normalized.name || normalized.value}`
  });
  await chrome.storage.local.set({ customRules });
  const { enabled } = await chrome.storage.local.get({ enabled: true });
  if (enabled) await syncCustomRules();
  return { ok: true, rule: normalized };
}

async function updateCustomRule(id, updates) {
  const idx = customRules.findIndex((r) => r.id === id);
  if (idx < 0) return { ok: false, error: "Rule not found" };
  const merged = { ...customRules[idx], ...updates, id };
  const err = validateCustomRule(merged);
  if (err) return { ok: false, error: err };
  const normalized = normalizeCustomRule(merged);
  await pushRollbackAction({
    type: "customRuleUpdate",
    rule: customRules[idx],
    label: `Restore custom rule ${customRules[idx].name || customRules[idx].value}`
  });
  customRules = customRules.map((r) => (r.id === id ? normalized : r));
  await chrome.storage.local.set({ customRules });
  const { enabled } = await chrome.storage.local.get({ enabled: true });
  if (enabled) await syncCustomRules();
  return { ok: true, rule: normalized };
}

async function removeCustomRule(id) {
  const removed = customRules.find((r) => r.id === id);
  customRules = customRules.filter((r) => r.id !== id);
  if (removed) {
    await pushRollbackAction({
      type: "customRuleRemove",
      rule: removed,
      label: `Restore custom rule ${removed.name || removed.value}`
    });
  }
  await chrome.storage.local.set({ customRules });
  const { enabled } = await chrome.storage.local.get({ enabled: true });
  if (enabled) await syncCustomRules();
  return { ok: true };
}

async function importCustomRules(rules) {
  if (!Array.isArray(rules)) return { ok: false, error: "Expected an array" };
  const byId = {};
  for (const r of customRules) byId[r.id] = r;
  let added = 0;
  let replaced = 0;
  let skipped = 0;
  for (const raw of rules) {
    const copy = { ...raw };
    const err = validateCustomRule(copy);
    if (err) {
      skipped++;
      continue;
    }
    const normalized = normalizeCustomRule(copy);
    if (byId[normalized.id]) replaced++;
    else added++;
    byId[normalized.id] = normalized;
  }
  customRules = Object.values(byId);
  if (customRules.length > CUSTOM_RULES_MAX) {
    customRules = customRules.slice(0, CUSTOM_RULES_MAX);
  }
  await chrome.storage.local.set({ customRules });
  const { enabled } = await chrome.storage.local.get({ enabled: true });
  if (enabled) await syncCustomRules();
  return { ok: true, added, replaced, skipped, total: customRules.length };
}

function validateCustomFilterList(list) {
  if (!list || typeof list !== "object") return "Invalid list";
  if (!list.url || typeof list.url !== "string") return "URL is required";
  try {
    const u = new URL(list.url);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return "URL must be http or https";
    }
  } catch {
    return "Invalid URL";
  }
  return null;
}

function normalizeCustomFilterList(list) {
  return {
    id: list.id || crypto.randomUUID?.() || Math.random().toString(36).slice(2),
    url: list.url.trim(),
    title: (list.title || "").trim() || list.url.trim(),
    enabled: typeof list.enabled === "boolean" ? list.enabled : true,
    addedAt: list.addedAt || new Date().toISOString()
  };
}

async function addCustomFilterList(list) {
  const err = validateCustomFilterList(list);
  if (err) return { ok: false, error: err };
  const normalized = normalizeCustomFilterList(list);
  if (customFilterLists.some((l) => l.url === normalized.url)) {
    return { ok: false, error: "This filter list URL is already added" };
  }
  customFilterLists = [...customFilterLists, normalized];
  await chrome.storage.local.set({ customFilterLists });
  return { ok: true, list: normalized };
}

async function updateCustomFilterList(id, updates) {
  const idx = customFilterLists.findIndex((l) => l.id === id);
  if (idx < 0) return { ok: false, error: "List not found" };
  const merged = { ...customFilterLists[idx], ...updates, id };
  const err = validateCustomFilterList(merged);
  if (err) return { ok: false, error: err };
  const normalized = normalizeCustomFilterList(merged);
  customFilterLists = customFilterLists.map((l) => (l.id === id ? normalized : l));
  await chrome.storage.local.set({ customFilterLists });
  return { ok: true, list: normalized };
}

async function removeCustomFilterList(id) {
  customFilterLists = customFilterLists.filter((l) => l.id !== id);
  await chrome.storage.local.set({ customFilterLists });
  return { ok: true };
}
