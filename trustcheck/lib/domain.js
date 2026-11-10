// Hostname helpers. High-precision registrable-domain extraction with Public Suffix List support.
import { PUBLIC_SUFFIX_SET } from "./psl_data.js";

const SECOND_LEVEL = new Set(["co", "com", "org", "net", "gov", "edu", "ac", "ne", "or"]);

export function registrableDomain(hostname) {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":")) return h;
  const p = h.split(".");
  if (p.length <= 1) return h;

  // Check known multi-level public/private suffixes from longest (3 labels down to 2)
  const maxCheck = Math.min(p.length - 1, 3);
  for (let k = maxCheck; k >= 2; k--) {
    const candidateSuffix = p.slice(-k).join(".");
    if (PUBLIC_SUFFIX_SET.has(candidateSuffix)) {
      return p.slice(-(k + 1)).join(".");
    }
  }

  // Fallback for standard ccTLD two-level domains (e.g. .co.xx)
  const tld = p[p.length - 1];
  const sld = p[p.length - 2];
  if (p.length >= 3 && tld.length === 2 && SECOND_LEVEL.has(sld)) {
    return p.slice(-3).join(".");
  }

  return p.slice(-2).join(".");
}

export function isIp(hostname) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":");
}

export function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
  return dp[a.length][b.length];
}

// Search engines are not shops: rating the engine's own domain says nothing about the results on it.
const SEARCH_LABELS = new Set(["google", "bing", "duckduckgo", "yahoo", "ecosia", "startpage", "brave", "yandex", "baidu", "qwant"]);
export function isSearchEngine(hostname) {
  const h = hostname.toLowerCase();
  const parts = h.split(".");
  if (parts.length < 2) return false;
  const reg = registrableDomain(h).split(".");
  return SEARCH_LABELS.has(reg[0]) && reg.length >= 2;
}
