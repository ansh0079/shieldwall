// QuietBrowse - shared helpers (content scripts + service worker via importScripts)
// Full PSL (psl_data.js) loads in the service worker only. Content scripts use a
// compact multi-part suffix set so we do not inject ~158 KB on every page.

let pslRuleSet = null;
let pslWildcardSet = null;
let pslExceptionSet = null;
let pslFullyLoaded = false;

// Common multi-part public suffixes for content-script fallback (phishing signals).
// Blocking / learning still use the full PSL in the service worker.
const COMPACT_MULTI_SUFFIXES = new Set([
  "ac.uk", "co.uk", "gov.uk", "ltd.uk", "me.uk", "net.uk", "org.uk", "plc.uk",
  "sch.uk", "com.au", "net.au", "org.au", "edu.au", "gov.au", "asn.au", "id.au",
  "co.jp", "or.jp", "ne.jp", "ac.jp", "go.jp", "ed.jp", "gr.jp", "lg.jp",
  "com.br", "net.br", "org.br", "gov.br", "edu.br", "art.br", "blog.br",
  "co.nz", "net.nz", "org.nz", "govt.nz", "ac.nz", "school.nz",
  "co.in", "net.in", "org.in", "gen.in", "firm.in", "ind.in",
  "co.kr", "co.za", "org.za", "web.za", "net.za", "gov.za", "ac.za",
  "com.mx", "org.mx", "gob.mx", "edu.mx", "com.ar", "gov.ar", "org.ar",
  "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn", "com.tw", "org.tw", "edu.tw",
  "com.hk", "org.hk", "edu.hk", "gov.hk", "com.sg", "org.sg", "edu.sg", "gov.sg",
  "com.my", "org.my", "edu.my", "gov.my", "com.ph", "org.ph", "gov.ph",
  "co.id", "or.id", "go.id", "ac.id", "co.th", "or.th", "ac.th", "go.th",
  "com.tr", "org.tr", "gov.tr", "edu.tr", "com.ua", "org.ua", "gov.ua",
  "com.pl", "net.pl", "org.pl", "gov.pl", "edu.pl", "com.ru", "net.ru", "org.ru",
  "com.pt", "gov.pt", "org.pt", "edu.pt", "co.il", "org.il", "ac.il", "gov.il",
  "com.eg", "edu.eg", "gov.eg", "org.eg", "co.ke", "or.ke", "ac.ke", "go.ke",
  "com.ng", "org.ng", "gov.ng", "edu.ng", "co.ug", "or.ug", "ac.ug", "go.ug",
  "github.io", "blogspot.com", "azurewebsites.net", "cloudfront.net"
]);

function ensurePslSets() {
  if (pslRuleSet) return;
  const hasFull =
    typeof PUBLIC_SUFFIX_RULES !== "undefined" &&
    Array.isArray(PUBLIC_SUFFIX_RULES) &&
    PUBLIC_SUFFIX_RULES.length > 0;
  pslFullyLoaded = hasFull;
  pslRuleSet = new Set(hasFull ? PUBLIC_SUFFIX_RULES : []);
  pslWildcardSet = new Set(
    typeof PUBLIC_SUFFIX_WILDCARDS !== "undefined" ? PUBLIC_SUFFIX_WILDCARDS : []
  );
  pslExceptionSet = new Set(
    typeof PUBLIC_SUFFIX_EXCEPTIONS !== "undefined" ? PUBLIC_SUFFIX_EXCEPTIONS : []
  );
}

function getBaseDomain(hostname) {
  const host = String(hostname || "")
    .toLowerCase()
    .replace(/\.$/, "");
  if (!host || !host.includes(".")) return host;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host;

  const labels = host.split(".").filter(Boolean);
  if (labels.length <= 2) return host;

  ensurePslSets();

  if (pslFullyLoaded) {
    let suffixLabels = 1;
    for (let i = 0; i < labels.length; i++) {
      const candidate = labels.slice(i).join(".");
      if (pslExceptionSet.has(candidate)) {
        suffixLabels = labels.length - i - 1;
        break;
      }
      if (pslRuleSet.has(candidate)) {
        suffixLabels = Math.max(suffixLabels, labels.length - i);
      }
      const wildcardBase = labels.slice(i + 1).join(".");
      if (wildcardBase && pslWildcardSet.has(wildcardBase)) {
        suffixLabels = Math.max(suffixLabels, labels.length - i);
      }
    }
    if (labels.length <= suffixLabels) return host;
    return labels.slice(-(suffixLabels + 1)).join(".");
  }

  // Compact fallback for content scripts (no psl_data.js injected).
  for (let i = 0; i < labels.length - 1; i++) {
    const candidate = labels.slice(i).join(".");
    if (COMPACT_MULTI_SUFFIXES.has(candidate)) {
      if (i === 0) return host;
      return labels.slice(i - 1).join(".");
    }
  }
  return labels.slice(-2).join(".");
}

function siteKey(hostname) {
  return hostname.replace(/^www\./, "");
}

function localDateStr(date) {
  return (
    date.getFullYear() +
    "-" +
    String(date.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(date.getDate()).padStart(2, "0")
  );
}

function todayKey() {
  return localDateStr(new Date());
}

function formatCount(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

const SITE_MODE = {
  FULL: "full",
  ADS: "ads",
  OFF: "off"
};

const SITE_MODE_LABELS = {
  full: i18n("siteModeFull"),
  ads: i18n("siteModeAds"),
  off: i18n("siteModeOff")
};

// Longest matching domain wins (sub.example.com matches example.com).
function safeHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function resolveSiteMode(hostname, siteModes) {
  if (!siteModes || typeof siteModes !== "object") return SITE_MODE.FULL;
  const host = siteKey(hostname);
  let matched = null;
  let matchedLen = -1;
  for (const [domain, mode] of Object.entries(siteModes)) {
    if (host === domain || host.endsWith("." + domain)) {
      if (domain.length > matchedLen) {
        matchedLen = domain.length;
        matched = mode;
      }
    }
  }
  return matched || SITE_MODE.FULL;
}

function i18n(key, ...args) {
  if (typeof chrome !== "undefined" && chrome.i18n && typeof chrome.i18n.getMessage === "function") {
    return chrome.i18n.getMessage(key, args) || key;
  }
  return key;
}
