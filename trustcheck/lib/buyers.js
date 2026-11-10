// Buyer-report client logic. Reports are ANONYMOUS and UNVERIFIED: they are shown as context but have no effect on the score
// until the server can issue signed identities and resist bursts (see IMPROVEMENT_PLAN items 5-6).
import { fetchJson } from "./http.js";
import { validateBuyerSummary } from "./validate.js";
import { solvePow } from "./pow.js";
import { OUTCOMES, TAGS } from "./vocab.js";
export { OUTCOMES, TAGS };

const trim = (base) => base.replace(/\/$/, "");

export async function fetchSummary(base, domain, opts = {}) {
  const d = await fetchJson(`${trim(base)}/v1/summary?domain=${encodeURIComponent(domain)}`, { timeoutMs: 6000, maxBytes: 64 * 1024, ...opts });
  return validateBuyerSummary(d);
}

// Enrolment: fetch a challenge, solve the proof of work, receive a server-signed credential. Identities are issued by the
// server, rate-limited per network, and carry no weight until they have aged (see server/DEPLOY.md).
export async function enroll(base, opts = {}) {
  const c = await fetchJson(`${trim(base)}/v1/challenge`, { timeoutMs: 6000, maxBytes: 4096, ...opts });
  if (!c || typeof c.challenge !== "string" || !Number.isInteger(c.bits)) throw new Error("unexpected challenge from the report server");
  const solution = await solvePow(c.challenge, c.bits, opts);
  const r = await fetchJson(`${trim(base)}/v1/enroll`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ challenge: c.challenge, solution }), timeoutMs: 8000, maxBytes: 4096, ...opts });
  if (!r || typeof r.token !== "string" || r.token.length > 512) throw new Error("unexpected credential from the report server");
  return r.token;
}

const fail = (e) => { const err = new Error(e?.detail || e?.message || "request failed"); err.status = e?.status; return err; };
export async function submitReport(base, token, domain, outcome, tags, opts = {}) {
  try {
    return await fetchJson(`${trim(base)}/v1/report`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ domain, outcome, tags }), timeoutMs: 8000, maxBytes: 16 * 1024, ...opts });
  } catch (e) { throw fail(e); }
}
export async function eraseMyReports(base, token, opts = {}) {
  try { return await fetchJson(`${trim(base)}/v1/credential`, { method: "DELETE", headers: { authorization: `Bearer ${token}` }, timeoutMs: 8000, maxBytes: 4096, ...opts }); }
  catch (e) { throw fail(e); }
}

export const UNVERIFIED_NOTE = "Anonymous, unverified reports. They are context only and do not change the score. Suspicious clusters are held back, but reports can still be wrong or coordinated.";

// Context lines only: points are always 0 and status is always "info".
export function buyerSignals(sum) {
  const sig = (label, detail) => [{ id: "buyers", label, status: "info", points: 0, verification: "unverified", scope: "domain", detail }];
  if (!sum) return [];
  if (!sum.total) return sig("No buyer reports yet", "Be the first to report your experience from the popup.");
  const days = sum.windowDays || 30;
  if (sum.hidden) return sig(`${sum.total} unverified report${sum.total === 1 ? "" : "s"} - too few to show`, "Reports are shown only once several have been received.");
  const { ok = 0, problem = 0, never = 0 } = sum.outcomes || {}, t = sum.total;
  const label = never / t >= 0.4 ? `${never} of ${t} unverified reports say the order never arrived`
    : (never + problem) / t >= 0.5 ? `${never + problem} of ${t} unverified reports describe a problem`
    : ok / t >= 0.8 ? `${ok} of ${t} unverified reports say the order arrived fine`
    : `Mixed unverified reports (${ok} fine, ${never + problem} problems)`;
  const extra = [sum.clusters ? `from ${sum.clusters} separate networks` : "", sum.problemRate ? `smoothed problem rate ${Math.round(sum.problemRate.mean * 100)}% (range ${Math.round(sum.problemRate.low * 100)}-${Math.round(sum.problemRate.high * 100)}%)` : "",
    sum.disputed ? "The merchant has disputed these reports (ownership verified)." : ""].filter(Boolean).join("; ");
  return sig(label, `${UNVERIFIED_NOTE} ${t} reports, last ${days} days${extra ? "; " + extra : ""}.`);
}

// Most common reported problems, for the badge / interstitial lists.
export function buyerFeedback(sum) {
  if (!sum || sum.hidden || !sum.total) return [];
  const out = [];
  if (sum.outcomes?.never) out.push({ count: sum.outcomes.never, label: "order never arrived" });
  for (const [tag, n] of Object.entries(sum.tags || {}).sort((a, b) => b[1] - a[1]))
    if (TAGS[tag]) out.push({ count: n, label: TAGS[tag] });
  return out.slice(0, 4);
}
