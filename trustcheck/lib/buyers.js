// Buyer-report client logic. Reports are ANONYMOUS and UNVERIFIED: they are shown as context but have no effect on the score
// until the server can issue signed identities and resist bursts (see IMPROVEMENT_PLAN items 5-6).
import { fetchJson } from "./http.js";
import { validateBuyerSummary } from "./validate.js";
import { OUTCOMES, TAGS } from "./vocab.js";
export { OUTCOMES, TAGS };

const trim = (base) => base.replace(/\/$/, "");

export async function fetchSummary(base, domain, opts = {}) {
  const d = await fetchJson(`${trim(base)}/v1/summary?domain=${encodeURIComponent(domain)}`, { timeoutMs: 6000, maxBytes: 64 * 1024, ...opts });
  return validateBuyerSummary(d);
}

export async function submitReport(base, installId, domain, outcome, tags, opts = {}) {
  try {
    return await fetchJson(`${trim(base)}/v1/report`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ installId, domain, outcome, tags }), timeoutMs: 8000, maxBytes: 16 * 1024, ...opts
    });
  } catch (e) { throw new Error(e?.detail || e?.message || "could not send report"); }
}

export const UNVERIFIED_NOTE = "Anonymous, unverified reports. They are context only, do not change the score, and may not come from independent buyers.";

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
  return sig(label, `${UNVERIFIED_NOTE} ${t} reports, last ${days} days.`);
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
