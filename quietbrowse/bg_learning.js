// QuietBrowse - Privacy Badger-style learning + observed trackers

function isInfrastructureDomain(domain) {
  return LEARNING_INFRASTRUCTURE_ALLOWLIST.some(
    (d) => domain === d || domain.endsWith("." + d)
  );
}

async function reviewLearnedCandidate(domain) {
  const canReadCookies = !!chrome.cookies?.getAll && (await hasOptionalPermission("cookies"));
  const cookies = canReadCookies ? await chrome.cookies.getAll({ domain }) : [];
  if (learnedBlockedSet.has(domain)) return;

  learnedCandidates[domain] = {
    domain,
    sites: learnedSeen[domain] || [],
    cookieCount: cookies.length,
    cookieAccess: canReadCookies,
    firstReadyAt: learnedCandidates[domain]?.firstReadyAt || new Date().toISOString(),
    lastReadyAt: new Date().toISOString()
  };
  scheduleSave();

  const data = await chrome.storage.local.get({
    enabled: true,
    autoBlockLearned: false
  });
  if (!data.autoBlockLearned) return;
  if (!canReadCookies || cookies.length === 0) return;

  await pushRollbackAction({
    type: "learnedBlock",
    domain,
    seen: learnedSeen[domain] || null,
    candidate: learnedCandidates[domain] || null,
    label: `Unblock learned tracker ${domain}`
  });
  learnedBlocked.push(domain);
  rebuildLearnedSet();
  delete learnedSeen[domain];
  delete learnedCandidates[domain];
  scheduleSave();

  if (data.enabled) await syncLearnedRules();
  console.log(`QuietBrowse learned a new tracker: ${domain}`);
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    chrome.storage.local.set({ learnedSeen, learnedBlocked, learnedCandidates });
  }, 2000);
}

function pruneLearnedSeen() {
  const keys = Object.keys(learnedSeen);
  if (keys.length <= LEARNED_SEEN_MAX) return;
  const sorted = keys
    .map((k) => ({ key: k, count: (learnedSeen[k] || []).length }))
    .sort((a, b) => a.count - b.count);
  const remove = sorted.slice(0, sorted.length - LEARNED_SEEN_MAX);
  for (const { key } of remove) delete learnedSeen[key];
}

async function syncLearnedRules() {
  await removeDynamicRange(LEARNED_ID_START, LEARNED_ID_END);
  if (learnedBlocked.length === 0) return;
  await chrome.declarativeNetRequest.updateDynamicRules({
    addRules: [
      {
        id: LEARNED_ID_START,
        priority: 1,
        action: { type: "block" },
        condition: {
          requestDomains: learnedBlocked,
          domainType: "thirdParty"
        }
      }
    ]
  });
}

async function forgetLearnedTracker(domain) {
  const wasBlocked = learnedBlockedSet.has(domain);
  const previousSeen = learnedSeen[domain] || null;
  const previousCandidate = learnedCandidates[domain] || null;
  learnedBlocked = learnedBlocked.filter((d) => d !== domain);
  rebuildLearnedSet();
  delete learnedSeen[domain];
  delete learnedCandidates[domain];
  if (wasBlocked) {
    await pushRollbackAction({
      type: "learnedForget",
      domain,
      seen: previousSeen,
      candidate: previousCandidate,
      label: `Restore learned tracker ${domain}`
    });
  }
  await chrome.storage.local.set({ learnedSeen, learnedBlocked, learnedCandidates });
  const data = await chrome.storage.local.get({ enabled: true });
  if (data.enabled) await syncLearnedRules();
}

async function blockTrackerDomain(domain) {
  const d = String(domain || "")
    .toLowerCase()
    .replace(/^www\./, "");
  if (!d || !d.includes(".")) return { ok: false, error: "Invalid domain" };
  if (learnedBlockedSet.has(d)) return { ok: true, already: true };
  await pushRollbackAction({
    type: "learnedBlock",
    domain: d,
    seen: learnedSeen[d] || null,
    candidate: learnedCandidates[d] || null,
    label: `Unblock tracker ${d}`
  });
  learnedBlocked.push(d);
  rebuildLearnedSet();
  delete learnedSeen[d];
  delete learnedCandidates[d];
  await chrome.storage.local.set({ learnedSeen, learnedBlocked, learnedCandidates });
  const { enabled } = await chrome.storage.local.get({ enabled: true });
  if (enabled) await syncLearnedRules();
  return { ok: true };
}

function updateObservedTracker(domain, name, category, siteBase) {
  const now = new Date().toISOString();
  const entry = observedTrackers[domain] || {
    domain,
    name,
    category,
    firstSeen: now,
    lastSeen: now,
    siteCount: 0,
    sites: [],
    totalCount: 0
  };

  entry.lastSeen = now;
  entry.name = name;
  entry.category = category;
  entry.totalCount++;
  if (siteBase && !entry.sites.includes(siteBase)) {
    entry.sites.push(siteBase);
    if (entry.sites.length > 50) entry.sites.shift();
    entry.siteCount = entry.sites.length;
  }
  observedTrackers[domain] = entry;

  pruneObservedTrackers();
  scheduleSaveObserved();
}

function pruneObservedTrackers() {
  const keys = Object.keys(observedTrackers);
  if (keys.length <= OBSERVED_TRACKERS_MAX) return;
  const sorted = keys
    .map((k) => ({ key: k, lastSeen: observedTrackers[k].lastSeen }))
    .sort((a, b) => String(a.lastSeen).localeCompare(String(b.lastSeen)));
  const remove = sorted.slice(0, sorted.length - OBSERVED_TRACKERS_MAX);
  for (const { key } of remove) delete observedTrackers[key];
}

let observedSaveTimer = null;
function scheduleSaveObserved() {
  if (observedSaveTimer) return;
  observedSaveTimer = setTimeout(() => {
    observedSaveTimer = null;
    chrome.storage.local.set({ observedTrackers: serializeObserved() });
  }, 2000);
}

function serializeObserved() {
  const out = {};
  for (const [domain, entry] of Object.entries(observedTrackers)) {
    out[domain] = {
      domain: entry.domain,
      name: entry.name,
      category: entry.category,
      firstSeen: entry.firstSeen,
      lastSeen: entry.lastSeen,
      siteCount: entry.siteCount,
      sites: entry.sites,
      totalCount: entry.totalCount
    };
  }
  return out;
}

function deserializeObserved(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const out = {};
  for (const [domain, entry] of Object.entries(data)) {
    if (!entry || typeof entry !== "object") continue;
    out[domain] = {
      domain: entry.domain || domain,
      name: entry.name || domain,
      category: entry.category || "other",
      firstSeen: entry.firstSeen || new Date().toISOString(),
      lastSeen: entry.lastSeen || new Date().toISOString(),
      siteCount: entry.siteCount || (entry.sites || []).length,
      sites: Array.isArray(entry.sites) ? entry.sites : [],
      totalCount: entry.totalCount || 0
    };
  }
  return out;
}
