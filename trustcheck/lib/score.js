export function buildReport({ url, domain, signals, reviews, links, flagged, feedback = [], buyerTotal = 0 }) {
  const raw = 50 + signals.reduce((s, x) => s + (x.points || 0), 0);
  let score = Math.max(0, Math.min(100, raw));
  if (flagged) score = Math.min(score, 10);
  const verdict = score >= 70 ? "trusted" : score >= 40 ? "caution" : "risky";
  const order = { bad: 0, warn: 1, info: 2, good: 3 };
  signals = [...signals].sort((a, b) => order[a.status] - order[b.status]);
  return { url, domain, score, verdict, signals, reviews: reviews || null, feedback, buyerTotal, links, checkedAt: Date.now() };
}
