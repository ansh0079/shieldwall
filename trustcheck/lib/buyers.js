// Buyer-report client logic + shared vocabulary. Pure helpers are unit-tested.
export const OUTCOMES = ["ok", "problem", "never"];
export const TAGS = {
  delayed: "order delayed",
  wrong_item: "wrong item received",
  fake_tracking: "tracking never updated / not genuine",
  missing_items: "items missing from order",
  not_as_described: "item not as described",
  poor_quality: "poor quality",
  counterfeit: "counterfeit or fake goods",
  damaged: "item arrived damaged",
  refund_refused: "refund refused",
  unresponsive: "seller unresponsive",
  hidden_fees: "hidden fees or extra charges",
  charged_no_confirmation: "charged but no order confirmation",
  card_misuse: "card or account misused afterwards"
};

export async function fetchSummary(base, domain) {
  const res = await fetch(`${base.replace(/\/$/, "")}/v1/summary?domain=${encodeURIComponent(domain)}`);
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

export async function submitReport(base, installId, domain, outcome, tags) {
  const res = await fetch(`${base.replace(/\/$/, "")}/v1/report`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ installId, domain, outcome, tags })
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "HTTP " + res.status);
  return res.json();
}

// Turn an aggregate summary into score signals.
export function buyerSignals(sum) {
  const info = (label, detail) => [{ id: "buyers", label, status: "info", points: 0, detail }];
  if (!sum) return [];
  if (!sum.total) return info("No buyer reports yet", "Be the first to report your experience from the popup.");
  if (sum.hidden) return info(`${sum.total} buyer report(s) - too few to show`, "Reports are shown once several independent buyers agree.");
  const { ok = 0, problem = 0, never = 0 } = sum.outcomes || {};
  const t = sum.total, days = sum.windowDays || 30;
  const mk = (status, points, label) => [{ id: "buyers", label, status, points, detail: `Based on ${t} buyer reports in the last ${days} days.` }];
  if (never / t >= 0.4) return mk("bad", -35, `${never} of ${t} buyers say their order never arrived`);
  if ((never + problem) / t >= 0.5) return mk("bad", -20, `${never + problem} of ${t} buyers reported a problem`);
  if (ok / t >= 0.8 && t >= 5) return mk("good", 15, `${ok} of ${t} buyers received their order fine`);
  return mk("warn", -5, `Mixed buyer reports (${ok} fine, ${never + problem} problems)`);
}

// Most common feedback points for the badge / interstitial.
export function buyerFeedback(sum) {
  if (!sum || sum.hidden || !sum.total) return [];
  const out = [];
  if (sum.outcomes?.never) out.push({ count: sum.outcomes.never, label: "order never arrived" });
  for (const [tag, n] of Object.entries(sum.tags || {}).sort((a, b) => b[1] - a[1]))
    if (TAGS[tag]) out.push({ count: n, label: TAGS[tag] });
  return out.slice(0, 4);
}
