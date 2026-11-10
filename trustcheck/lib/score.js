// Evidence scoring and calibrated verdict engine.
// Combines independent evidence families and generates clear explanations.

const EVIDENCE_FAMILIES = {
  safety: new Set(["sb", "https", "lookalike", "ip", "pay-http", "pay-hijack", "punycode", "tld", "pattern", "subdomains"]),
  identity: new Set(["company", "merchant-verified"]),
  reputation: new Set(["tp", "buyers", "merchant-ld"]),
  history: new Set(["age", "reuse"]),
  transparency: new Set(["policies", "urgency", "free-mail", "liquidation"]),
  pricing: new Set(["price"]),
  retailer: new Set(["known"])
};

const VERDICT_LABELS = {
  trusted: "Lower risk indicators",
  caution: "Proceed with caution",
  risky: "High risk",
  unverified: "Unverified shop"
};

export function buildReport({
  url,
  domain,
  signals = [],
  reviews = null,
  merchantRating = null,
  links = [],
  flagged = false,
  feedback = [],
  buyerTotal = 0,
  sixMonthNonDelivery = 0,
  sixMonthNotMatched = 0
}) {
  signals = [...signals];

  // Trustpilot review signals (Step 1)
  if (reviews?.source === "Trustpilot" && reviews.score !== null && reviews.count >= 5 && !signals.some((s) => s.id === "tp")) {
    if (reviews.score < 3.0) {
      signals.push({
        id: "tp",
        label: `Trustpilot rating is ${reviews.score.toFixed(1)}/5 (${reviews.count} reviews)`,
        status: "bad",
        points: -25,
        detail: "Recent reviews report orders that never arrived, or customer disputes."
      });
    } else if (reviews.score >= 4.0 && reviews.count >= 10) {
      signals.push({
        id: "tp",
        label: `Trustpilot rating is ${reviews.score.toFixed(1)}/5 (${reviews.count} reviews)`,
        status: "good",
        points: 15,
        detail: "Established positive customer review history."
      });
    }
  }

  // 6-month verified buyer non-delivery signal (Step 3)
  if (sixMonthNonDelivery >= 2 && !signals.some((s) => s.id === "six-month-nondelivery")) {
    signals.push({
      id: "six-month-nondelivery",
      label: `In the last 6 months, ${sixMonthNonDelivery} TrustCheck buyers reported this shop did not deliver`,
      status: "bad",
      points: -30,
      detail: "Verified purchase-observed delivery reports from real buyers."
    });
  }
  if (sixMonthNotMatched >= 2 && !signals.some((s) => s.id === "six-month-notmatched")) {
    signals.push({
      id: "six-month-notmatched",
      label: `In the last 6 months, ${sixMonthNotMatched} TrustCheck buyers reported items did not match the listing`,
      status: "bad",
      points: -20,
      detail: "Verified purchase-observed delivery reports from real buyers."
    });
  }

  const raw = 50 + signals.reduce((s, x) => s + (x.points || 0), 0);
  let score = Math.max(0, Math.min(100, raw));
  if (flagged) score = Math.min(score, 10);

  // Evidence = signals that tell us something about the shop itself (not just HTTPS / having a footer).
  const EVIDENCE = new Set(["age", "sb", "tp", "buyers", "company", "known", "reuse", "price", "merchant-ld", "merchant-verified"]);
  const evidence = signals.filter((x) => EVIDENCE.has(x.id) && x.status !== "info").length;

  // Track distinct evidence families with non-info signals
  const activeFamilies = new Set();
  for (const s of signals) {
    if (s.status === "info") continue;
    for (const [family, set] of Object.entries(EVIDENCE_FAMILIES)) {
      if (set.has(s.id)) activeFamilies.add(family);
    }
  }

  const negatives = signals.filter((x) => x.status === "bad" || x.status === "warn");
  const bads = signals.filter((x) => x.status === "bad");

  // Critical security flags directly cap score into risky
  const criticalBad = bads.some((x) =>
    x.id === "sb" || x.id === "pay-http" || x.id === "pay-hijack" || x.id === "lookalike" || x.id === "ip"
  );
  if (criticalBad) {
    score = Math.min(score, 20);
  }

  let verdict = score >= 70 ? "trusted" : score >= 40 ? "caution" : "risky";

  // A store cannot achieve "trusted" if it has any "bad" signal or zero independent evidence
  if (verdict === "trusted" && (evidence === 0 || bads.length > 0)) {
    verdict = evidence === 0 ? "unverified" : "caution";
    if (bads.length > 0) score = Math.min(score, 69);
  }

  // Middling score with nothing known about the shop is not "caution", it is "unverified".
  if (verdict === "caution" && evidence === 0) {
    verdict = "unverified";
  }

  // A low price alone is a warning, not proof: it can only make a shop "risky" when another red flag agrees.
  if (verdict === "risky" && negatives.length && negatives.every((x) => x.id === "price")) {
    verdict = "caution";
    score = Math.max(score, 40);
  }

  const confidence = evidence >= 3 ? "high" : evidence >= 1 ? "medium" : "low";

  const order = { bad: 0, warn: 1, info: 2, good: 3 };
  signals = [...signals].sort((a, b) => order[a.status] - order[b.status]);

  // Generate calibrated summary text
  let summary = "";
  if (flagged || criticalBad) {
    summary = "Authoritative security or impersonation warning detected.";
  } else if (verdict === "risky") {
    summary = "Multiple risk indicators found. Exercise extreme caution.";
  } else if (verdict === "unverified") {
    summary = "Insufficient independent evidence available for this shop.";
  } else if (verdict === "trusted") {
    summary = "Established history and corroborating trust indicators found.";
  } else {
    summary = "Some warning signs or limited trading history detected.";
  }

  return {
    url,
    domain,
    score,
    verdict,
    verdictLabel: VERDICT_LABELS[verdict] || verdict,
    confidence,
    summary,
    evidence,
    evidenceFamilies: [...activeFamilies],
    signals,
    reviews: reviews || null,
    merchantRating: merchantRating || null,
    feedback,
    buyerTotal,
    sixMonthNonDelivery,
    sixMonthNotMatched,
    links,
    checkedAt: Date.now()
  };
}
