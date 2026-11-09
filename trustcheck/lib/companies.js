// UK Companies House check. A shop's company number is read from its page footer, then looked up.
const DAY = 86400000;

// Finds e.g. "Company No. 12345678", "registered number: SC123456", "Registered in England and Wales (No. 09876543)".
export function extractCompanyNumber(text) {
  const m = /(?:company|registered|registration|reg\.?)\s*(?:no\.?|number|#)?\s*[:.\-(]*\s*((?:SC|NI|OC|SO|NC)\d{6}|\d{8})\b/i.exec(text || "");
  return m ? m[1].toUpperCase() : null;
}

export async function fetchCompany(number, key) {
  const res = await fetch(`https://api.company-information.service.gov.uk/company/${encodeURIComponent(number)}`, {
    headers: { Authorization: "Basic " + btoa(key + ":") }
  });
  if (res.status === 404) return null;                 // number does not exist
  if (!res.ok) throw new Error("HTTP " + res.status);  // rate limit, bad key...
  return res.json();
}

const strip = (n) => String(n).toLowerCase().replace(/\b(limited|ltd|plc|llp|uk|the)\b/g, "").replace(/[^a-z0-9 ]/g, " ").trim();

// Does the registered name show up on the page / domain? Guards against quoting someone else's company number.
export function nameMatches(companyName, haystack) {
  const words = strip(companyName).split(/\s+/).filter((w) => w.length >= 4);
  if (!words.length) return true; // nothing meaningful to compare
  const h = String(haystack || "").toLowerCase().replace(/[^a-z0-9 ]/g, "");
  return words.some((w) => h.includes(w));
}

export function companySignals({ number, profile, haystack = "", now = Date.now() }) {
  const push = (status, points, label, detail) => [{ id: "company", label, status, points, detail }];
  if (!number) return [];
  if (profile === null) return push("bad", -25, `Company number ${number} not found at Companies House`, "The registration number shown on the site does not exist.");
  const name = profile.company_name;
  if (profile.company_status && profile.company_status !== "active")
    return push("bad", -25, `${name} is ${profile.company_status} at Companies House`, `Company ${number}.`);
  const days = profile.date_of_creation ? Math.floor((now - new Date(profile.date_of_creation).getTime()) / DAY) : null;
  const out = [];
  if (days !== null && days < 90) out.push(...push("warn", -15, `${name} was incorporated only ${days} days ago`, `Company ${number}, registered ${profile.date_of_creation}.`));
  else out.push(...push("good", 12, `Registered UK company: ${name}`, `Company ${number}${profile.date_of_creation ? ", incorporated " + profile.date_of_creation.slice(0, 4) : ""}, status active.`));
  if (!nameMatches(name, haystack))
    out.push(...push("warn", -10, "Registered company name not found on this site", `Companies House lists "${name}". Check it is really the business you are buying from.`));
  return out;
}
