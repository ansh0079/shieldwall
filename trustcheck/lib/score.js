// Turns annotated signals into an assessment. The verdict comes from decision rules over independent evidence
// families, NOT from a score threshold, so weak evidence can never produce a strong positive verdict.
import { FAMILIES, SETUP_IDS, annotate, isPositiveEvidence } from "./signals.js";

export const VERDICT_LABEL = {
  dangerous: "Dangerous", risky: "High risk", caution: "Caution", limited: "Limited evidence", lower: "Lower risk indicators"
};
export const CONFIDENCE_LABEL = { low: "Low", medium: "Medium", high: "High" };
export const DISCLAIMER = "TrustCheck cannot guarantee a seller or a transaction. It reports the evidence it could find.";

// Families that carry independent evidence about the shop itself (a clean HTTPS page or a footer link is not evidence).
const EVIDENCE_FAMILIES = ["safety", "identity", "reputation", "history"];
const order = { bad: 0, warn: 1, info: 2, good: 3 };

const isEvidence = (s) => s.provenance === "verified" && s.availability !== "unavailable" &&
  ["sb", "company", "tp", "age", "archive"].includes(s.id) && EVIDENCE_FAMILIES.includes(s.family);

export function decide(signals) {
  const warns = signals.filter((s) => s.strength);
  const strong = warns.filter((s) => s.strength === "strong"), moderate = warns.filter((s) => s.strength === "moderate");
  const weak = warns.filter((s) => s.strength === "weak");
  const famsOf = (xs) => new Set(xs.map((s) => s.family));
  const positives = signals.filter(isPositiveEvidence);
  const positiveFams = famsOf(positives);
  // Things that make a positive verdict unsafe even when two families look good (each found by evaluating the rules).
  const blockers = [];
  if (signals.some((s) => (s.id === "age" || s.id === "reuse") && s.strength)) blockers.push("the domain is young or was re-used, and reviews and clean scans are easy to fake for new sites");
  if (signals.some((s) => s.id === "sb" && s.availability === "unavailable")) blockers.push("the malware/phishing check was unavailable");
  if (signals.some((s) => s.id === "marketplace")) blockers.push("this is a marketplace, where each seller must be assessed separately");

  let verdict;
  if (warns.some((s) => s.strength === "authoritative")) verdict = "dangerous";                 // malware/phishing match or insecure payment
  else if (strong.length >= 1 && famsOf([...strong, ...moderate]).size >= 2) verdict = "risky";   // multiple independent strong warnings
  else if (strong.length || moderate.length || famsOf(weak).size >= 2) verdict = "caution";       // one strong warning or several weaker ones
  else if (positiveFams.size >= 2 && weak.length < 2 && !blockers.length) verdict = "lower";      // needs two independent families
  else verdict = "limited";
  return { verdict, strong, moderate, weak, positives, positiveFams, blockers };
}

export function buildReport({ url, domain, signals, reviews, links, flagged, feedback = [], buyerTotal = 0, now = Date.now() }) {
  signals = signals.map((s) => (s.family && s.provenance ? s : annotate(s, { checkedAt: now })));
  const d = decide(signals);
  let verdict = flagged ? "dangerous" : d.verdict;      // an authoritative threat match always wins
  const scoring = signals.filter((s) => s.family !== "reports" && s.family !== "setup");
  const raw = Math.max(0, Math.min(100, 50 + scoring.reduce((n, s) => n + (s.points || 0), 0)));
  // Score is the "evidence score". It is kept consistent with the verdict so the two can never disagree.
  let score = raw;
  if (verdict === "dangerous" || flagged) score = Math.min(raw, 10);
  else if (verdict === "risky") score = Math.min(raw, 35);
  else if (verdict === "caution") score = Math.max(36, Math.min(raw, 69));
  else if (verdict === "lower") { if (raw < 70) { verdict = "limited"; score = Math.max(36, Math.min(raw, 69)); } else score = raw; }   // no warnings, but not enough weight for a positive verdict
  else score = Math.max(36, Math.min(raw, 69));

  const evFams = new Set(signals.filter(isEvidence).map((s) => s.family));
  const archiveEvidence = signals.some((s) => s.id === "archive" && s.provenance === "verified");
  if (archiveEvidence) evFams.add("history");
  let confidence = evFams.size >= 3 ? "high" : evFams.size === 2 ? "medium" : "low";
  if (verdict === "dangerous" && signals.some((s) => s.id === "sb" && s.strength === "authoritative")) confidence = "high";
  else if ((verdict === "dangerous" || verdict === "risky") && confidence === "low") confidence = "medium";

  if (verdict === "limited") confidence = "low";          // "limited evidence" and "high confidence" would contradict each other
  const missingChecks = signals.filter((s) => s.availability === "unavailable");
  const setup = signals.filter((s) => SETUP_IDS.has(s.id));
  const shown = signals.filter((s) => !SETUP_IDS.has(s.id) && s.availability !== "unavailable")
    .sort((a, b) => order[a.status] - order[b.status]);

  // Decisive findings: strongest warnings first, otherwise the best verified positives.
  const rank = { authoritative: 0, strong: 1, moderate: 2, weak: 3 };
  const warnings = shown.filter((s) => s.strength).sort((a, b) => rank[a.strength] - rank[b.strength]);
  const findings = (warnings.length ? warnings : d.positives.filter((s) => s.id !== "known" || d.positives.length === 1)).slice(0, 3)
    .map((s) => ({ id: s.id, label: s.label, status: s.status, family: s.family }));

  // Plain-language summary: what was found, what it means, what is missing.
  const bits = [];
  const good = d.positives.map((s) => ({ age: "established domain", company: "active registered company", tp: "good review-site rating", sb: "page not on Safe Browsing lists", known: "recognised retailer domain" }[s.id])).filter(Boolean);
  if (good.length) bits.push(`Found: ${good.join(", ")}.`);
  if (warnings.length) bits.push(`${warnings.slice(0, 2).map((s) => s.label).join("; ")}.`);
  const gaps = [];
  if (!evFams.has("reputation")) gaps.push("no independent review source");
  if (!evFams.has("identity")) gaps.push("no verified company record");
  if (missingChecks.length) gaps.push(`${missingChecks.length} check${missingChecks.length === 1 ? "" : "s"} unavailable`);
  if (gaps.length && verdict !== "dangerous") bits.push(`Missing: ${gaps.join(", ")}.`);
  if (verdict === "limited" && d.positiveFams.size >= 2 && d.blockers.length) bits.push(`Not rated lower risk because ${d.blockers[0]}.`);
  if (buyerTotal) bits.push(`${buyerTotal} unverified customer report${buyerTotal === 1 ? "" : "s"} (not scored).`);

  const groups = Object.keys(FAMILIES).map((id) => ({ id, label: FAMILIES[id], signals: shown.filter((s) => s.family === id) })).filter((g) => g.signals.length);

  return {
    url, domain, score, verdict, verdictLabel: VERDICT_LABEL[verdict], confidence, confidenceLabel: CONFIDENCE_LABEL[confidence],
    headline: `${VERDICT_LABEL[verdict]} · ${CONFIDENCE_LABEL[confidence]} confidence`, summary: bits.join(" "),
    findings, signals: shown, groups, missingChecks, setup, disclaimer: DISCLAIMER,
    reviews: reviews || null, feedback, buyerTotal, links, checkedAt: now
  };
}
