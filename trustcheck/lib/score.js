export function buildReport({ url, domain, signals, reviews, links, flagged, feedback = [], buyerTotal = 0 }) {
  const raw = 50 + signals.reduce((s, x) => s + (x.points || 0), 0);
  let score = Math.max(0, Math.min(100, raw));
  if (flagged) score = Math.min(score, 10);
  // Evidence = signals that tell us something about the shop itself (not just HTTPS / having a footer).
  const EVIDENCE = new Set(["age", "sb", "tp", "buyers", "company", "known"]);
  const evidence = signals.filter((x) => EVIDENCE.has(x.id) && x.status !== "info").length;
  let verdict = score >= 70 ? "trusted" : score >= 40 ? "caution" : "risky";
  // Middling score with nothing known about the shop is not "caution", it is "unverified".
  if (verdict === "caution" && evidence === 0) verdict = "unverified";
  const order = { bad: 0, warn: 1, info: 2, good: 3 };
  signals = [...signals].sort((a, b) => order[a.status] - order[b.status]);
  return { url, domain, score, verdict, evidence, signals, reviews: reviews || null, feedback, buyerTotal, links, checkedAt: Date.now() };
}
