// Network providers. Only the registrable domain is sent to most third parties (see README privacy table).
// Every call goes through fetchJson (timeout, size limit, content-type check) and validated payloads.
import { fetchJson, ProviderError } from "./http.js";
import { validateRdap, validateCdx, validateSafeBrowsing, validateTrustpilotUnit, validateTrustpilotDetail, validateTrustpilotReviews } from "./validate.js";
import { summarizeThemes } from "./themes.js";

// rdap.org redirects to the registry; for .com/.net also try Verisign's registry directly (confirmed endpoint).
// Returns the registration date (ISO) or null when the registry publishes none.
export async function rdapLookup(domain, opts = {}) {
  const d = encodeURIComponent(domain), tld = domain.split(".").pop();
  const urls = [`https://rdap.org/domain/${d}`];
  if (tld === "com" || tld === "net") urls.push(`https://rdap.verisign.com/${tld}/v1/domain/${d}`);
  const errors = [];
  for (const u of urls) {
    try { return validateRdap(await fetchJson(u, { headers: { accept: "application/rdap+json" }, timeoutMs: 8000, maxBytes: 512 * 1024, accept: /json/i, ...opts })); }
    catch (e) { if (e instanceof ProviderError && e.kind === "aborted") throw e; errors.push(e.message); }
  }
  throw new ProviderError("network", errors.join("; "));
}

export async function domainAge(domain, opts = {}) {
  const reg = await rdapLookup(domain, opts);
  if (!reg) return [{ id: "age", label: "Domain registration date not published", status: "info", points: 0, scope: "domain", detail: "The registry did not return a registration date for this domain." }];
  const days = Math.floor((Date.now() - new Date(reg).getTime()) / 86400000);
  const years = (days / 365).toFixed(1);
  const mk = (status, points, label) => [{ id: "age", label, status, points, since: reg, scope: "domain", verification: "verified", detail: `Registered ${reg.slice(0, 10)} (${days} days ago).` }];
  if (days < 30) return mk("bad", -30, `Domain registered only ${days} days ago`);
  if (days < 180) return mk("warn", -15, "Domain is under 6 months old");
  if (days < 730) return mk("info", 0, `Domain is ${years} years old`);
  if (days < 1825) return mk("good", 12, `Domain is ${years} years old`);
  return mk("good", 20, `Established domain (${years} years)`);
}

// Full page URL check. A provider failure THROWS (shown as "unavailable"), it is never reported as clean.
export async function safeBrowsing(url, key, opts = {}) {
  const body = {
    client: { clientId: "trustcheck", clientVersion: "0.3.0" },
    threatInfo: {
      threatTypes: ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE", "POTENTIALLY_HARMFUL_APPLICATION"],
      platformTypes: ["ANY_PLATFORM"], threatEntryTypes: ["URL"], threatEntries: [{ url }]
    }
  };
  const threats = validateSafeBrowsing(await fetchJson(`https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${encodeURIComponent(key)}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), timeoutMs: 8000, maxBytes: 256 * 1024, ...opts }));
  if (threats.length) return { flagged: true, signals: [{ id: "sb", label: "This page is flagged by Google Safe Browsing", status: "bad", points: -60, scope: "url", verification: "verified", detail: [...new Set(threats)].join(", ") }] };
  return { flagged: false, signals: [{ id: "sb", label: "This page is not on Google Safe Browsing lists", status: "good", points: 5, scope: "url", verification: "verified", detail: "No known malware/phishing match for this exact URL." }] };
}

export async function trustpilot(domain, key, opts = {}) {
  const q = (p) => `https://api.trustpilot.com/v1/${p}${p.includes("?") ? "&" : "?"}apikey=${encodeURIComponent(key)}`;
  const o = { timeoutMs: 8000, maxBytes: 512 * 1024, ...opts };
  let id;
  try { id = validateTrustpilotUnit(await fetchJson(q(`business-units/find?name=${encodeURIComponent(domain)}`), o)); }
  catch (e) {
    if (e instanceof ProviderError && e.kind === "http" && e.status === 404) // absence is not negative evidence
      return { reviews: null, signals: [{ id: "tp", label: "No Trustpilot page found", status: "info", points: 0, scope: "domain", detail: "Absence from a review site is not a warning on its own." }] };
    throw e;
  }
  const { score, total } = validateTrustpilotDetail(await fetchJson(q(`business-units/${id}`), o));
  const reviews = { source: "Trustpilot", score, count: total, url: `https://www.trustpilot.com/review/${domain}`, themes: [], sample: 0 };
  try { // recent reviews -> theme counts (no review text is stored or shown)
    const t = summarizeThemes(validateTrustpilotReviews(await fetchJson(q(`business-units/${id}/reviews?perPage=100&orderBy=createdat.desc`), o)));
    reviews.themes = t.themes; reviews.sample = t.sample;
  } catch (e) { if (e instanceof ProviderError && e.kind === "aborted") throw e; /* themes are optional */ }
  return signalsFromTrustpilotReviews(reviews);
}

// Earliest Internet Archive snapshot of the site (when it first appeared online), ISO or null if never archived.
export async function firstArchived(domain, opts = {}) {
  return validateCdx(await fetchJson(`https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(domain)}&limit=1&fl=timestamp&output=json`,
    { timeoutMs: 8000, maxBytes: 64 * 1024, ...opts }));
}


// Convert a Trustpilot reviews payload (from the API or the /v1/check proxy) into score signals.
export function signalsFromTrustpilotReviews(reviews) {
  if (!reviews || !Number.isFinite(Number(reviews.score)) || !Number.isFinite(Number(reviews.count))) {
    return reviews ? { reviews, signals: [] } : { reviews: null, signals: [] };
  }
  const score = Number(reviews.score), total = Number(reviews.count);
  let sig;
  if (total < 5) sig = { status: "info", points: 0, label: "Few or no Trustpilot reviews" };
  else if (score >= 4) sig = { status: "good", points: 18, label: `Trustpilot ${score.toFixed(1)}/5` };
  else if (score >= 3) sig = { status: "warn", points: 0, label: `Trustpilot ${score.toFixed(1)}/5 (mixed)` };
  else sig = { status: "bad", points: -20, label: `Trustpilot ${score.toFixed(1)}/5 (poor)` };
  return { reviews, signals: [{ id: "tp", ...sig, scope: "domain", detail: `${total.toLocaleString()} reviews.` }] };
}

// Always available: deep links to independent review sources.
export function reviewLinks(domain) {
  const d = encodeURIComponent(domain);
  return [
    { name: "Trustpilot", url: `https://www.trustpilot.com/review/${d}` },
    { name: "ScamAdviser", url: `https://www.scamadviser.com/check-website/${d}` },
    { name: "Google: reviews", url: `https://www.google.com/search?q=${encodeURIComponent(`${d} reviews`)}` },
    { name: "Who.is record", url: `https://who.is/whois/${d}` }
  ];
}
