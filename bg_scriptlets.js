// QuietBrowse - dynamic MAIN-world scriptlet registration

async function syncScriptlets() {
  const data = await chrome.storage.local.get({
    enabled: true,
    siteModes: {},
    antiAdblock: false,
    scriptletCatalog: true
  });

  const ids = ["quiet-yt", "quiet-antiadblock", "quiet-catalog"];
  try {
    await chrome.scripting.unregisterContentScripts({ ids });
  } catch {
    /* not registered yet */
  }

  if (!data.enabled) return;

  const excludeMatches = Object.entries(data.siteModes || {})
    .filter(([, mode]) => mode === SITE_MODE.OFF || mode === SITE_MODE.ADS)
    .flatMap(([domain]) => [`*://${domain}/*`, `*://*.${domain}/*`])
    .slice(0, 100);

  const registrations = [];

  const ytMode = resolveSiteMode("youtube.com", data.siteModes);
  if (ytMode !== SITE_MODE.OFF && ytMode !== SITE_MODE.ADS) {
    registrations.push({
      id: "quiet-yt",
      matches: ["*://*.youtube.com/*", "*://*.youtube-nocookie.com/*"],
      js: ["scriptlets.js"],
      runAt: "document_start",
      world: "MAIN"
    });
  }

  if (data.scriptletCatalog !== false) {
    const reg = {
      id: "quiet-catalog",
      matches: ["http://*/*", "https://*/*"],
      js: ["scriptlets_catalog.js"],
      runAt: "document_start",
      world: "MAIN",
      allFrames: false
    };
    if (excludeMatches.length) reg.excludeMatches = excludeMatches;
    registrations.push(reg);
  }

  if (data.antiAdblock === true) {
    const reg = {
      id: "quiet-antiadblock",
      matches: ["http://*/*", "https://*/*"],
      js: ["scriptlets_antiadblock.js"],
      runAt: "document_start",
      world: "MAIN",
      allFrames: false
    };
    if (excludeMatches.length) reg.excludeMatches = excludeMatches;
    registrations.push(reg);
  }

  if (registrations.length === 0) return;
  try {
    await chrome.scripting.registerContentScripts(registrations);
  } catch (e) {
    console.warn("QuietBrowse: scriptlet registration failed:", e.message);
  }
}
