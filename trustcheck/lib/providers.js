// Network providers. Only the registrable domain is ever sent to third parties.
const ok = async (res) => { if (!res.ok) throw new Error("HTTP " + res.status); return res.json(); };

// rdap.org redirects to the registry; for .com/.net also try Verisign's registry directly (confirmed endpoint).
export async function rdapLookup(domain) {
  const d = encodeURIComponent(domain), tld = domain.split(".").pop();
  const urls = [`https://rdap.org/domain/${d}`];
  if (tld === "com" || tld === "net") urls.push(`https://rdap.verisign.com/${tld}/v1/domain/${d}`);
  const errors = [];
  for (const u of urls) {
    try { return await ok(await fetch(u, { headers: { accept: "application/rdap+json" } })); }
    catch (e) { errors.push(`${new URL(u).host}: ${e.message}`); }
  }
  throw new Error(errors.join("; "));
}

export async function domainAge(domain) {
  const data = await rdapLookup(domain);
  const reg = (data.events || []).find((e) => e.eventAction === "registration");
  if (!reg) return [];
  const days = Math.floor((Date.now() - new Date(reg.eventDate).getTime()) / 86400000);
  const years = (days / 365).toFixed(1);
  const mk = (status, points, label) => [{ id: "age", label, status, points, since: reg.eventDate, detail: `Registered ${reg.eventDate.slice(0, 10)} (${days} days ago).` }];
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

// Earliest Internet Archive snapshot of the domain (when the site first appeared online).
export async function firstArchived(domain) {
  const res = await fetch(`https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(domain)}&limit=1&fl=timestamp&output=json`);
  if (!res.ok) throw new Error("HTTP " + res.status);
  const rows = await res.json();
  const ts = rows?.[1]?.[0];                       // [["timestamp"],["20190314123456"]]
  if (!ts || !/^\d{8}/.test(ts)) return null;
  return `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T00:00:00Z`;
}
