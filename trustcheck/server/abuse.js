// Pure abuse-resistance logic: network ranges, report weighting, coordination detection, Bayesian smoothing.
// Everything here is a heuristic with known limits (see eval/README and server/DEPLOY.md): it raises the cost of
// manipulation and keeps suspicious clusters out of the aggregate; it cannot stop a patient, diverse attacker.
import crypto from "node:crypto";

export const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
export const DEFAULTS = {
  windowDays: 30, retentionDays: 90, halfLifeDays: 30, verifiedMultiplier: 2,
  powBits: 16,
  limits: { enrollPerNetPerDay: 3, enrollPerHour: 200, reportsPerCredPerDay: 20, reportsPerNetPerHour: 30,
    newIdentityReportsPerDomainPerDay: 5, correctionsPerCredPerDomain: 3, maxCredentials: 1_000_000, maxReports: 1_000_000 },
  maturity: { zeroBelowMs: DAY, partialBelowMs: 7 * DAY, partialWeight: 0.3 },
  display: { minEffective: 5, minClusters: 4 },
  prior: { mean: 0.15, strength: 10 },                       // placeholder prior for the problem rate until real data exists
  detect: { netBurstMin: 4, timingWindowMs: 10 * MIN, timingMin: 5, timingShare: 0.5, payloadMin: 5, youngDays: 7,
    skewMin: 8, skewOutcome: 0.95, skewYoungShare: 0.7, skewYoungDays: 14 }
};
export function mergeConfig(over = {}) {
  const out = JSON.parse(JSON.stringify(DEFAULTS));
  for (const [k, v] of Object.entries(over)) out[k] = v && typeof v === "object" && !Array.isArray(v) ? { ...out[k], ...v } : v;
  return out;
}

// /24 for IPv4, /48 for IPv6: one household or office is one network; a botnet spans many.
export function netRange(ip) {
  if (typeof ip !== "string") return "unknown";
  ip = ip.trim().replace(/^::ffff:/i, "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return "v4:" + ip.split(".").slice(0, 3).join(".");
  if (ip.includes(":") && /^[0-9a-f:]+$/i.test(ip)) {
    const [l, r] = ip.split("::"), left = l ? l.split(":") : [], right = r !== undefined ? (r ? r.split(":") : []) : [];
    const groups = r === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
    if (groups.length === 8) return "v6:" + groups.slice(0, 3).map((g) => parseInt(g || "0", 16).toString(16)).join(":");
  }
  return "unknown";
}
export const netHash = (range, salt) => crypto.createHmac("sha256", salt).update(range).digest("hex").slice(0, 16);

export function identityWeight(ageMs, m) { return ageMs < m.zeroBelowMs ? 0 : ageMs < m.partialBelowMs ? m.partialWeight : 1; }
export function recencyWeight(ageMs, halfLifeDays) { return 0.5 ** (Math.max(0, ageMs) / (halfLifeDays * DAY)); }
export const payloadKey = (r) => `${r.outcome}:${[...r.tags].sort().join(",")}`;

// Weight of each report = identity maturity (AT REPORT TIME) x recency x verification. Unverified reports are then capped so
// that one network contributes at most 1.0 in total to a domain, however many credentials or reports it has. Verified purchases
// are anchored to a proof, so they are not capped (they only exist once a purchase verifier is configured).
export function weigh(reports, now, cfg) {
  const base = reports.map((r) => ({ r, verified: r.evidence === "verified",
    w: identityWeight(r.idAgeMs, cfg.maturity) * recencyWeight(now - r.at, cfg.halfLifeDays) * (r.evidence === "verified" ? cfg.verifiedMultiplier : 1) }));
  const perNet = new Map();
  for (const x of base) if (!x.verified) perNet.set(x.r.net, (perNet.get(x.r.net) || 0) + x.w);
  return new Map(base.map((x) => [x.r.id, !x.verified && perNet.get(x.r.net) > 1 ? x.w / perNet.get(x.r.net) : x.w]));
}

// Coordination detection over one domain's reports. Returns Map(reportId -> Set(reason)). Moderator-approved reports are
// exempt (handled by the caller). Rules are deliberately simple and explainable.
export function detect(reports, now, cfg) {
  const d = cfg.detect, flags = new Map(), flag = (r, why) => { if (!flags.has(r.id)) flags.set(r.id, new Set()); flags.get(r.id).add(why); };
  const byNet = new Map();
  for (const r of reports) { if (!byNet.has(r.net)) byNet.set(r.net, []); byNet.get(r.net).push(r); }
  for (const g of byNet.values()) if (g.length >= d.netBurstMin) g.forEach((r) => flag(r, "same_network_burst"));

  const sorted = [...reports].sort((a, b) => a.at - b.at);
  if (sorted.length >= d.timingMin) {
    for (let i = 0, j = 0; i < sorted.length; i++) {
      while (sorted[i].at - sorted[j].at > d.timingWindowMs) j++;
      const win = sorted.slice(j, i + 1);
      if (win.length >= d.timingMin && new Set(win.map((r) => r.cred)).size >= d.timingMin && win.length / sorted.length >= d.timingShare) win.forEach((r) => flag(r, "timing_burst"));
    }
  }
  const young = reports.filter((r) => r.idAgeMs < d.youngDays * DAY), byPayload = new Map();
  for (const r of young) { const k = payloadKey(r); if (!byPayload.has(k)) byPayload.set(k, []); byPayload.get(k).push(r); }
  for (const g of byPayload.values()) if (g.length >= d.payloadMin && new Set(g.map((r) => r.cred)).size >= d.payloadMin) g.forEach((r) => flag(r, "repeated_payload_new_identities"));

  if (reports.length >= d.skewMin) {
    const youngSkew = reports.filter((r) => r.idAgeMs < d.skewYoungDays * DAY), counts = {};
    for (const r of reports) counts[r.outcome] = (counts[r.outcome] || 0) + 1;
    const top = Math.max(...Object.values(counts)) / reports.length;
    if (top >= d.skewOutcome && youngSkew.length / reports.length >= d.skewYoungShare) youngSkew.forEach((r) => flag(r, "young_identity_skew"));
  }
  return flags;
}

// Beta-Binomial smoothing of the problem rate. Posterior is approximated by a normal (documented approximation).
export function smooth(problemWeight, effectiveN, prior) {
  const a0 = prior.mean * prior.strength, b0 = (1 - prior.mean) * prior.strength;
  const a = a0 + problemWeight, b = b0 + Math.max(0, effectiveN - problemWeight), s = a + b, mean = a / s, sd = Math.sqrt((a * b) / (s * s * (s + 1)));
  return { mean, low: Math.max(0, mean - 1.96 * sd), high: Math.min(1, mean + 1.96 * sd) };
}
