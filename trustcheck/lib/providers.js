import { summarizeThemes } from "./themes.js";
// Network providers. Only the registrable domain is ever sent to third parties.
const ok = async (res) => { if (!res.ok) throw new Error("HTTP " + res.status); return res.json(); };

export async function domainAge(domain) {
  const data = await ok(await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, { headers: { accept: "application/rdap+json" } }));
  const reg = (data.events || []).find((e) => e.eventAction === "registration");
  if (!reg) return [];
  const days = Math.floor((Date.now() - new Date(reg.eventDate).getTime()) / 86400000);
  const years = (days / 365).toFixed(1);
  const mk = (status, points, label) => [{ id: "age", label, status, points, detail: `Registered ${reg.eventDate.slice(0, 10)} (${days} days ago).` }];
  if (days < 30) return mk("bad", -30, `Domain registered only ${days} days ago`);
  if (days < 180) return mk("warn", -15, "Domain is under 6 months old");
  if (days < 730) return mk("info", 0, `Domain is ${years} years old`);
  if (days < 1825) return mk("good", 12, `Domain is ${years} years old`);
  return mk("good", 20, `Established domain (${years} years)`);
}

export async function safeBrowsing(url, key) {
  const body = {
    client: { clientId: "trustcheck", clientVersion: "0.1.0" },
    threatInfo: {
      threatTypes: ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE", "POTENTIALLY_HARMFUL_APPLICATION"],
      platformTypes: ["ANY_PLATFORM"], threatEntryTypes: ["URL"], threatEntries: [{ url }]
    }
  };
  const data = await ok(await fetch(`https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${encodeURIComponent(key)}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
  }));
  if (data.matches?.length) {
    const kinds = [...new Set(data.matches.map((m) => m.threatType))].join(", ");
    return { flagged: true, signals: [{ id: "sb", label: "Flagged by Google Safe Browsing", status: "bad", points: -60, detail: kinds }] };
  }
  return { flagged: false, signals: [{ id: "sb", label: "Not on Google Safe Browsing blocklists", status: "good", points: 5, detail: "No known malware/phishing match." }] };
}

export async function trustpilot(domain, key) {
  const q = (p) => `https://api.trustpilot.com/v1/${p}${p.includes("?") ? "&" : "?"}apikey=${encodeURIComponent(key)}`;
  let unit;
  try { unit = await ok(await fetch(q(`business-units/find?name=${encodeURIComponent(domain)}`))); }
  catch { return { reviews: null, signals: [] }; }
  const detail = await ok(await fetch(q(`business-units/${unit.id}`)));
  const score = detail.score?.trustScore, n = detail.numberOfReviews?.total ?? 0;
  const reviews = { source: "Trustpilot", score, count: n, url: `https://www.trustpilot.com/review/${domain}`, themes: [], sample: 0 };
  try { // recent reviews -> theme counts (no review text is stored or shown)
    const rv = await ok(await fetch(q(`business-units/${unit.id}/reviews?perPage=100&orderBy=createdat.desc`)));
    const t = summarizeThemes((rv.reviews || []).map((r) => `${r.title || ""} ${r.text || ""}`));
    reviews.themes = t.themes; reviews.sample = t.sample;
  } catch { /* themes are optional */ }
  let sig;
  if (n < 5) sig = { status: "info", points: 0, label: "Few or no Trustpilot reviews" };
  else if (score >= 4) sig = { status: "good", points: 18, label: `Trustpilot ${score.toFixed(1)}/5` };
  else if (score >= 3) sig = { status: "warn", points: 0, label: `Trustpilot ${score.toFixed(1)}/5 (mixed)` };
  else sig = { status: "bad", points: -20, label: `Trustpilot ${score.toFixed(1)}/5 (poor)` };
  return { reviews, signals: [{ id: "tp", ...sig, detail: `${n.toLocaleString()} reviews.` }] };
}

// Always available: deep links to independent review sources.
export function reviewLinks(domain) {
  const d = encodeURIComponent(domain);
  return [
    { name: "Trustpilot", url: `https://www.trustpilot.com/review/${d}` },
    { name: "ScamAdviser", url: `https://www.scamadviser.com/check-website/${d}` },
    { name: "Reddit discussions", url: `https://www.reddit.com/search/?q=${d}%20scam%20OR%20legit` },
    { name: "Google: reviews", url: `https://www.google.com/search?q=${d}+reviews+scam` },
    { name: "Who.is record", url: `https://who.is/whois/${d}` }
  ];
}
