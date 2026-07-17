// QuietBrowse - sync small prefs via chrome.storage.sync (cross-device toggles only)

const SYNC_PREF_KEYS = [
  "enabled",
  "privacySignals",
  "hideCookiePopups",
  "passwordShield",
  "phishingWarn",
  "downloadGuard",
  "antiAdblock",
  "autoBlockLearned",
  "cnameUncloak",
  "scriptletCatalog",
  "optionalFilterLists"
];

const SYNC_REV_KEY = "prefsUpdatedAt";

let syncWriteInProgress = false;
let syncApplyInProgress = false;

function pickSyncPrefs(data) {
  const out = {};
  for (const key of SYNC_PREF_KEYS) {
    if (key in data) out[key] = data[key];
  }
  if (data[SYNC_REV_KEY] != null) out[SYNC_REV_KEY] = data[SYNC_REV_KEY];
  return out;
}

async function pushPrefsToSync(patch) {
  if (!chrome.storage.sync) return;
  const data = pickSyncPrefs(patch);
  if (Object.keys(data).length === 0) return;
  if (data[SYNC_REV_KEY] == null) data[SYNC_REV_KEY] = Date.now();
  syncWriteInProgress = true;
  try {
    await chrome.storage.sync.set(data);
  } catch (e) {
    console.warn("QuietBrowse: sync write failed:", e.message);
  } finally {
    setTimeout(() => {
      syncWriteInProgress = false;
    }, 250);
  }
}

async function pullPrefsFromSync() {
  if (!chrome.storage.sync) return;
  try {
    const syncKeys = [...SYNC_PREF_KEYS, SYNC_REV_KEY];
    const syncData = await chrome.storage.sync.get(syncKeys);
    const localData = await chrome.storage.local.get([SYNC_REV_KEY]);
    const syncRev = syncData[SYNC_REV_KEY] || 0;
    const localRev = localData[SYNC_REV_KEY] || 0;
    if (syncRev <= localRev) return;

    const patch = {};
    for (const key of SYNC_PREF_KEYS) {
      if (syncData[key] !== undefined) patch[key] = syncData[key];
    }
    patch[SYNC_REV_KEY] = syncRev;
    if (Object.keys(patch).length <= 1) return;

    syncApplyInProgress = true;
    await chrome.storage.local.set(patch);
    setTimeout(() => { syncApplyInProgress = false; }, 250);
  } catch (e) {
    syncApplyInProgress = false;
    console.warn("QuietBrowse: sync pull failed:", e.message);
  }
}

function watchSyncPrefs() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && !syncApplyInProgress) {
      const patch = {};
      for (const key of SYNC_PREF_KEYS) {
        if (changes[key]) patch[key] = changes[key].newValue;
      }
      if (Object.keys(patch).length) {
        patch[SYNC_REV_KEY] = Date.now();
        chrome.storage.local.set({ [SYNC_REV_KEY]: patch[SYNC_REV_KEY] }, () => {
          pushPrefsToSync(patch);
        });
      }
    }
    if (area === "sync" && !syncWriteInProgress) {
      const patch = {};
      for (const key of SYNC_PREF_KEYS) {
        if (changes[key] && changes[key].newValue !== undefined) {
          patch[key] = changes[key].newValue;
        }
      }
      if (changes[SYNC_REV_KEY] && changes[SYNC_REV_KEY].newValue != null) {
        patch[SYNC_REV_KEY] = changes[SYNC_REV_KEY].newValue;
      }
      if (Object.keys(patch).length === 0) return;

      chrome.storage.local.get([SYNC_REV_KEY], (localData) => {
        const incomingRev = patch[SYNC_REV_KEY] || 0;
        const localRev = localData[SYNC_REV_KEY] || 0;
        if (incomingRev <= localRev) return;

        syncApplyInProgress = true;
        chrome.storage.local.set(patch, async () => {
          syncApplyInProgress = false;
          if ("enabled" in patch) await setGlobalEnabled(!!patch.enabled);
          else {
            if ("cnameUncloak" in patch) {
              const { enabled: cnameEnabled } = await chrome.storage.local.get({ enabled: true });
              if (cnameEnabled) await syncCnameRules();
            }
            if ("antiAdblock" in patch || "scriptletCatalog" in patch) {
              await syncScriptlets();
            }
            await notifyContentScripts();
          }
        });
      });
    }
  });
}
