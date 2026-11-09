// Hostname helpers. Heuristic registrable-domain extraction (no full PSL).
const SECOND_LEVEL = new Set(["co", "com", "org", "net", "gov", "edu", "ac", "ne", "or"]);

export function registrableDomain(hostname) {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":")) return h;
  const p = h.split(".");
  if (p.length <= 2) return h;
  const tld = p[p.length - 1];
  const sld = p[p.length - 2];
  if (tld.length === 2 && SECOND_LEVEL.has(sld)) return p.slice(-3).join(".");
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
