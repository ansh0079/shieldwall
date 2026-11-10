// Signal metadata: which evidence family a signal belongs to, how strong a warning it is, where it came from, and how
// much we trust it. Kept central so producers stay simple and the scoring rules are auditable in one place.

export const FAMILIES = {
  safety: "Site safety", identity: "Business identity", reputation: "Reputation",
  history: "Operational history", transparency: "Store transparency", price: "Price risk", reports: "Unverified customer reports"
};
const FAMILY_BY_ID = {
  https: "safety", ip: "safety", punycode: "safety", tld: "safety", pattern: "safety", subdomains: "safety", lookalike: "safety",
  sb: "safety", "pay-http": "safety",
  company: "identity", known: "identity", marketplace: "identity",
  tp: "reputation",
  age: "history", archive: "history", reuse: "history", tenant: "history",
  policies: "transparency", urgency: "transparency",
  price: "price",
  buyers: "reports"
};
const SOURCE_BY_ID = {
  https: "Page address", ip: "Page address", punycode: "Page address", tld: "Page address", pattern: "Page address", subdomains: "Page address",
  lookalike: "Page address", known: "Built-in retailer list", marketplace: "Built-in marketplace list", sb: "Google Safe Browsing", "pay-http": "Page scan",
  company: "Companies House", tp: "Trustpilot", age: "Domain registry (RDAP)", archive: "Internet Archive", reuse: "Registry + Internet Archive",
  tenant: "Public Suffix List", policies: "Page scan", urgency: "Page scan", price: "Prices on the results page", buyers: "TrustCheck report server"
};
// Setup notices describe configuration, not the shop: shown separately from evidence.
export const SETUP_IDS = new Set(["co-off", "sb-off", "tp-off", "age-off", "archive-off"]);
const STRONG_WHEN_BAD = new Set(["lookalike", "ip", "https", "age", "company", "tp"]);

export const familyOf = (s) => s.family || FAMILY_BY_ID[s.id] || (SETUP_IDS.has(s.id) ? "setup" : "other");

// null for neutral/positive signals; otherwise authoritative | strong | moderate | weak
export function strengthOf(s) {
  if (s.status !== "bad" && s.status !== "warn") return null;
  if ((s.id === "sb" || s.id === "pay-http") && s.status === "bad") return "authoritative";
  if (s.id === "price") return s.status === "bad" ? "moderate" : "weak";   // price never stands alone as a strong warning
  if (s.status === "bad" && STRONG_WHEN_BAD.has(s.id)) return "strong";
  return "weak";
}

// verified: an authoritative provider told us | inferred: our own heuristic | user-reported | unavailable | stale
export function provenanceOf(s) {
  if (s.availability === "unavailable") return "unavailable";
  if (s.verification === "unverified") return "user-reported";
  if (s.verification === "verified") return "verified";
  return ["sb", "age", "archive", "company", "tp", "reuse"].includes(s.id) && !s.inferred ? "verified" : "inferred";
}

// Positive evidence that can count towards "lower risk": must come from an independent source about THIS shop.
// HTTPS, policy links and the page's own claims never qualify; domain age counts (history) but cannot stand alone.
export function isPositiveEvidence(s) {
  return s.status === "good" && !s.partial && provenanceOf(s) !== "unavailable" && ["sb", "company", "tp", "age", "known"].includes(s.id);
}

export function annotate(s, { checkedAt = Date.now(), ttlMs = null } = {}) {
  return {
    ...s,
    family: familyOf(s), source: s.source || SOURCE_BY_ID[s.id] || "TrustCheck",
    scope: s.scope || (["sb"].includes(s.id) ? "url" : ["company"].includes(s.id) ? "company" : "domain"),
    provenance: provenanceOf(s), strength: strengthOf(s), effect: s.points || 0,
    checkedAt, expiresAt: ttlMs ? checkedAt + ttlMs : null,
    explanation: s.detail || s.label
  };
}
