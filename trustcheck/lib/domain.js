// Hostname handling backed by the complete Public Suffix List (ICANN + private sections).
// Private suffixes (github.io, pages.dev, blogspot.com ...) make every tenant its own "site",
// so evidence caches never leak between tenants or inherit the hosting platform's age/reputation.
import { ICANN, PRIVATE, WILD_ICANN, WILD_PRIVATE, EXCEPTIONS } from "./psl_data.js";

const RULES_ICANN = new Set(ICANN), RULES_PRIVATE = new Set(PRIVATE);
const WILD_I = new Set(WILD_ICANN), WILD_P = new Set(WILD_PRIVATE), EXC = new Set(EXCEPTIONS);

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

export function isIpv4(h) { return IPV4.test(h); }
export function isIpv6(h) { return h.includes(":") && /^[0-9a-f:.]+$/.test(h); }
export function isIp(h) { h = normalizeHost(h) || ""; return isIpv4(h) || isIpv6(h); }

// Lower-case, ASCII (punycode) hostname without port/brackets/trailing dots, or null if malformed.
export function normalizeHost(input) {
  if (typeof input !== "string") return null;
  let h = input.trim();
  if (!h || h.length > 300 || /[\s/\\@?#%<>"'`|^{}]/.test(h)) return null;
  if (h.startsWith("[")) { const e = h.indexOf("]"); if (e < 0) return null; h = h.slice(1, e); }
  else if (/^[^:]+:\d+$/.test(h)) h = h.slice(0, h.lastIndexOf(":"));    // host:port
  h = h.replace(/\.+$/, "").toLowerCase();
  if (!h) return null;
  if (isIpv6(h)) return h;
  if (!/^[\x00-\x7f]*$/.test(h)) { try { h = new URL("http://" + h).hostname; } catch { return null; } }
  if (isIpv4(h)) return h;
  const labels = h.split(".");
  if (labels.some((l) => !l || l.length > 63 || !/^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?$/.test(l))) return null;
  if (/^\d+$/.test(labels[labels.length - 1])) return null;               // numeric TLD / malformed IPv4
  return h;
}

// Applies the PSL algorithm. Returns { suffix, labels, isPrivate, host } or null for IPs/malformed hosts.
export function publicSuffixInfo(input) {
  const host = normalizeHost(input);
  if (!host || isIp(host)) return null;
  const labels = host.split(".");
  let best = 1, priv = false;
  for (let i = 0; i < labels.length; i++) {
    const cand = labels.slice(i).join("."), n = labels.length - i;
    if (EXC.has(cand)) return { host, suffix: labels.slice(i + 1).join("."), labels: n - 1, isPrivate: false };
    if (RULES_PRIVATE.has(cand) && n >= best) { best = n; priv = true; }
    else if (RULES_ICANN.has(cand) && n > best) { best = n; priv = false; }
    if (i + 1 < labels.length) {
      const base = labels.slice(i + 1).join(".");
      if (WILD_P.has(base) && n >= best) { best = n; priv = true; }
      else if (WILD_I.has(base) && n > best) { best = n; priv = false; }
    }
  }
  return { host, suffix: labels.slice(-best).join("."), labels: best, isPrivate: priv };
}

// The "site": one label above the public suffix. For a bare suffix/localhost/IP the host itself.
// Returns "" for malformed input.
export function registrableDomain(input) {
  const host = normalizeHost(input);
  if (!host) return "";
  if (isIp(host)) return host;
  const info = publicSuffixInfo(host);
  const labels = host.split(".");
  if (!info || labels.length <= info.labels) return host;
  return labels.slice(-(info.labels + 1)).join(".");
}

export function isPublicSuffix(input) {
  const host = normalizeHost(input);
  if (!host || isIp(host)) return false;
  const info = publicSuffixInfo(host);
  return !!info && host.split(".").length <= info.labels;
}

// Name of the hosting platform (e.g. "github.io") when the site is a tenant under a private suffix, else null.
export function tenantPlatform(input) {
  const info = publicSuffixInfo(input);
  if (!info || !info.isPrivate) return null;
  return info.host.split(".").length > info.labels ? info.suffix : null;   // needs a label above the suffix
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
  const reg = registrableDomain(hostname);
  if (!reg || !reg.includes(".")) return false;
  return SEARCH_LABELS.has(reg.split(".")[0]) && !tenantPlatform(hostname);
}
