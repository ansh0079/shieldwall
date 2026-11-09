// Schema checks for third-party payloads. Anything unexpected throws ProviderError("invalid") and is shown as an
// unavailable check rather than flowing into scoring or the UI.
import { ProviderError } from "./http.js";
import { TAGS } from "./vocab.js";

const bad = (what) => { throw new ProviderError("invalid", `unexpected ${what} in response`); };
const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
const isInt = (n) => Number.isInteger(n) && n >= 0 && n < 1e9;
const isoOk = (s, { allowFuture = false } = {}) => {
  const t = typeof s === "string" ? Date.parse(s) : NaN;
  return Number.isFinite(t) && t > Date.parse("1985-01-01") && (allowFuture || t <= Date.now() + 86400000);
};

// RDAP: returns the registration date (ISO) or null if the record has none.
export function validateRdap(d) {
  if (!isObj(d)) bad("RDAP payload");
  if (d.events === undefined) return null;
  if (!Array.isArray(d.events)) bad("RDAP events");
  const reg = d.events.find((e) => isObj(e) && e.eventAction === "registration");
  if (!reg) return null;
  if (!isoOk(reg.eventDate)) bad("registration date");
  return reg.eventDate;
}

// Internet Archive CDX: [["timestamp"],["20190314123456"]] -> ISO or null (never archived).
export function validateCdx(rows) {
  if (!Array.isArray(rows)) bad("archive payload");
  if (rows.length < 2) return null;
  const ts = Array.isArray(rows[1]) ? rows[1][0] : null;
  if (typeof ts !== "string" || !/^\d{14}$/.test(ts)) bad("archive timestamp");
  const iso = `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T00:00:00Z`;
  if (!isoOk(iso)) bad("archive date");
  return iso;
}

export function validateSafeBrowsing(d) {
  if (!isObj(d)) bad("Safe Browsing payload");
  if (d.matches === undefined) return [];
  if (!Array.isArray(d.matches) || d.matches.some((m) => !isObj(m) || typeof m.threatType !== "string")) bad("Safe Browsing matches");
  return d.matches.map((m) => m.threatType.replace(/[^A-Z_]/g, "").slice(0, 40)).filter(Boolean);
}

export function validateTrustpilotUnit(d) {
  if (!isObj(d) || typeof d.id !== "string" || !/^[a-f0-9]{8,40}$/i.test(d.id)) bad("Trustpilot business id");
  return d.id;
}
export function validateTrustpilotDetail(d) {
  const score = d?.score?.trustScore, total = d?.numberOfReviews?.total;
  if (typeof score !== "number" || !(score >= 0 && score <= 5)) bad("Trustpilot score");
  if (!isInt(total)) bad("Trustpilot review count");
  return { score, total };
}
export function validateTrustpilotReviews(d) {
  if (!isObj(d) || !Array.isArray(d.reviews)) bad("Trustpilot reviews");
  return d.reviews.slice(0, 100).map((r) => `${typeof r?.title === "string" ? r.title : ""} ${typeof r?.text === "string" ? r.text : ""}`.slice(0, 2000));
}

export function validateCompany(p) {
  if (!isObj(p) || typeof p.company_name !== "string" || !p.company_name || p.company_name.length > 300) bad("company profile");
  if (p.company_status !== undefined && typeof p.company_status !== "string") bad("company status");
  if (p.date_of_creation !== undefined && !(typeof p.date_of_creation === "string" && isoOk(p.date_of_creation))) bad("company incorporation date");
  return { company_name: p.company_name, company_status: p.company_status, date_of_creation: p.date_of_creation };
}

export function validateBuyerSummary(s) {
  if (!isObj(s) || typeof s.domain !== "string" || !isInt(s.total)) bad("buyer-report summary");
  const out = { domain: s.domain, total: s.total, hidden: !!s.hidden, windowDays: isInt(s.windowDays) ? s.windowDays : 30 };
  if (s.outcomes !== undefined) {
    const o = s.outcomes;
    if (!isObj(o) || !isInt(o.ok) || !isInt(o.problem) || !isInt(o.never) || o.ok + o.problem + o.never > s.total) bad("buyer-report outcomes");
    out.outcomes = { ok: o.ok, problem: o.problem, never: o.never };
    out.tags = {};
    if (s.tags !== undefined) {
      if (!isObj(s.tags)) bad("buyer-report tags");
      for (const [k, n] of Object.entries(s.tags)) { if (!TAGS[k] || !isInt(n)) bad("buyer-report tag"); out.tags[k] = n; }
    }
  }
  return out;
}
