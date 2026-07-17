// QuietBrowse - CNAME uncloaking via bundled cloaked-host map
// MV3 cannot resolve DNS CNAMEs at request time the way uBO Lite once could.
// We ship a curated list of first-party aliases of known trackers and block them.

let cnameMap = {};

async function loadCnameMap() {
  try {
    const res = await fetch(chrome.runtime.getURL("cname_trackers.json"));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json && typeof json === "object" && !Array.isArray(json)) {
      cnameMap = { ...json };
      delete cnameMap._comment;
    } else {
      cnameMap = {};
    }
  } catch (e) {
    cnameMap = {};
    console.warn("QuietBrowse: CNAME map load failed:", e.message);
  }
  return cnameMap;
}

async function syncCnameRules() {
  const data = await chrome.storage.local.get({
    enabled: true,
    cnameUncloak: true
  });

  await removeDynamicRange(CNAME_ID_START, CNAME_ID_END);
  if (!data.enabled || data.cnameUncloak === false) return;

  await loadCnameMap();
  let hosts = Object.keys(cnameMap).filter((h) => h.includes("."));
  if (hosts.length === 0) return;

  const max = CNAME_ID_END - CNAME_ID_START + 1;
  hosts = [...new Set(hosts.map((h) => h.toLowerCase()))].slice(0, max);
  if (hosts.length === 0) return;

  const rules = [];
  // DNR allows many domains per rule; keep chunks modest.
  const CHUNK = 200;
  let id = CNAME_ID_START;
  for (let i = 0; i < hosts.length && id <= CNAME_ID_END; i += CHUNK) {
    rules.push({
      id: id++,
      priority: 2,
      action: { type: "block" },
      condition: {
        requestDomains: hosts.slice(i, i + CHUNK),
        resourceTypes: [
          "script",
          "xmlhttprequest",
          "image",
          "sub_frame",
          "ping",
          "websocket",
          "other"
        ]
      }
    });
  }

  for (let i = 0; i < rules.length; i += 100) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      addRules: rules.slice(i, i + 100)
    });
  }
}
