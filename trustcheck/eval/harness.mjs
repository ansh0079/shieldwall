// Evaluation harness: turns a recorded evidence profile into mocked provider responses and runs the REAL
// analysis code (validators, caches, scoring) against it with a fixed clock, so results are deterministic.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";
import { analyze } from "../lib/analyze.js";
import { EvidenceCache, memoryStore } from "../lib/cache.js";
import { domainAge, firstArchived, safeBrowsing, trustpilot } from "../lib/providers.js";
import { fetchCompany } from "../lib/companies.js";
import { fetchSummary } from "../lib/buyers.js";

globalThis.crypto ??= webcrypto;                       // Node 18 has no global Web Crypto (browsers and Node 20+ do)
export const CORPUS_VERSION = "v1";
export const EVAL_NOW = "2026-11-09T12:00:00Z";
const here = path.dirname(fileURLToPath(import.meta.url));

export function loadCorpus(set, version = CORPUS_VERSION) {
  const file = path.join(here, "corpus", version, `${set}.jsonl`);
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const SCANS = {
  full: { isShop: true, hasContact: true, hasReturns: true, hasPrivacyTerms: true, hasAbout: true },
  partial: { isShop: true, hasContact: true, hasPrivacyTerms: true },
  bare: { isShop: true },
  none: { isShop: false },
  "pay-http": { isShop: true, hasPaymentFields: true, isCheckout: true }
};
const J = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const fail = () => { throw new TypeError("Failed to fetch"); };

export function buildFetch(c) {
  const e = c.ev;
  return async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.host === "rdap.org" || u.host === "rdap.verisign.com") {
      if (e.age === undefined || e.age === "err") fail();
      return J(e.age === "none" ? {} : { events: [{ eventAction: "registration", eventDate: `${e.age}T00:00:00Z` }] });
    }
    if (u.host === "web.archive.org") {
      if (e.arch === undefined || e.arch === "err") fail();
      return J(e.arch === "never" ? [] : [["timestamp"], [`${e.arch.replace(/-/g, "")}000000`]]);
    }
    if (u.host === "safebrowsing.googleapis.com") {
      if (e.sb === "err") fail();
      const target = JSON.parse(init.body).threatInfo.threatEntries[0].url;
      const hit = e.sb && e.sb.flagged && e.sb.flagged.some((p) => target.includes(p));
      return J(hit ? { matches: [{ threatType: "SOCIAL_ENGINEERING" }] } : {});
    }
    if (u.host === "api.trustpilot.com") {
      if (e.tp === "err") fail();
      if (e.tp === "none") return J({}, 404);
      if (u.pathname.endsWith("/find")) return J({ id: "4b5c6d7e8f90a1b2c3d4e5f6" });
      if (u.pathname.endsWith("/reviews")) return J({ reviews: (e.tpTexts || []).map((text) => ({ title: "", text })) });
      return J({ score: { trustScore: e.tp[0] }, numberOfReviews: { total: e.tp[1] } });
    }
    if (u.host === "api.company-information.service.gov.uk") {
      if (e.co === "err") fail();
      if (e.co.status === "notfound") return J({}, 404);
      return J({ company_name: e.co.name, company_status: e.co.status, date_of_creation: e.co.created });
    }
    if (u.host === "reports.fixture.test") return J(e.buyers);
    throw new Error("unexpected provider call in corpus run: " + u.host);
  };
}

export function buildInputs(c) {
  const e = c.ev, ratio = e.price;
  const scan = { ...(SCANS[e.scan || "full"]), legal: [], title: c.url, urgency: false, ...(e.scanExtra || {}) };
  if (e.co && e.co.number) {
    scan.legal = [`Registered in England and Wales. Company No. ${e.co.number}`];
    scan.title = e.co.legalMismatch ? "Fixture Shop" : e.co.name;
  }
  return {
    scan,
    price: ratio ? { cur: "£", price: ratio * 100, median: 100, n: 9 } : null,
    settings: { sbKey: e.sb !== undefined ? "k" : "", tpKey: e.tp !== undefined ? "k" : "", chKey: e.co ? "k" : "", backend: e.buyers ? "https://reports.fixture.test" : "", sbTtlMin: 30 }
  };
}

export async function evaluateCase(c) {
  const realFetch = globalThis.fetch, realNow = Date.now, fixed = Date.parse(c.now || EVAL_NOW);
  globalThis.fetch = buildFetch(c); Date.now = () => fixed;
  try {
    const { scan, price, settings } = buildInputs(c);
    const deps = { cache: new EvidenceCache(memoryStore()), settings,
      providers: { domainAge, firstArchived, safeBrowsing, trustpilot, fetchCompany, fetchSummary } };
    const r = await analyze(c.url, deps, { scan, price, hover: !!c.hover });
    return { id: c.id, cat: c.cat, label: c.label, gap: c.gap || null, verdict: r.verdict, confidence: r.confidence, score: r.score, headline: r.headline };
  } finally { globalThis.fetch = realFetch; Date.now = realNow; }
}

export async function runCases(cases) { const out = []; for (const c of cases) out.push(await evaluateCase(c)); return out; }

// ---------------- metrics ----------------
export const SEVERITY = ["dangerous", "risky", "caution", "limited", "lower"];            // most to least severe
// Documented prior: how likely a case in each verdict bucket is to be fraudulent. Calibration compares these with observed rates.
export const PRIOR = { dangerous: 0.95, risky: 0.8, caution: 0.35, limited: 0.15, lower: 0.03 };
const alarm = (v) => v === "dangerous" || v === "risky";
const warn = (v) => alarm(v) || v === "caution";
const ratio = (a, b) => (b ? a / b : null);
// 95% Wilson score interval: with a few dozen cases a bare percentage says much less than it appears to.
export function wilson(k, n, z = 1.96) {
  if (!n) return null;
  const p = k / n, d = 1 + (z * z) / n, c = p + (z * z) / (2 * n), w = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - w) / d), Math.min(1, (c + w) / d)];
}

export function computeMetrics(results) {
  const scored = results.filter((r) => !r.gap);                          // known gaps are reported separately, never hidden or counted
  const fraud = scored.filter((r) => r.label === "fraud"), legit = scored.filter((r) => r.label === "legit");
  const tpAlarm = fraud.filter((r) => alarm(r.verdict)).length, fpAlarm = legit.filter((r) => alarm(r.verdict)).length;
  const m = {
    n: scored.length, fraud: fraud.length, legit: legit.length, prevalence: ratio(fraud.length, scored.length),
    recallAlarm: ratio(tpAlarm, fraud.length), recallWarn: ratio(fraud.filter((r) => warn(r.verdict)).length, fraud.length),
    fnrAlarm: ratio(fraud.length - tpAlarm, fraud.length),
    fprAlarm: ratio(fpAlarm, legit.length), fprWarn: ratio(legit.filter((r) => warn(r.verdict)).length, legit.length),
    precisionAlarm: ratio(tpAlarm, tpAlarm + fpAlarm),
    ci: { recallAlarm: wilson(tpAlarm, fraud.length), fprAlarm: wilson(fpAlarm, legit.length),
      recallWarn: wilson(fraud.filter((r) => warn(r.verdict)).length, fraud.length), fprWarn: wilson(legit.filter((r) => warn(r.verdict)).length, legit.length) },
    falseReassurance: fraud.filter((r) => r.verdict === "lower").length,
    legitDangerous: legit.filter((r) => r.verdict === "dangerous").length
  };
  // calibration: observed fraud rate per verdict bucket
  const buckets = {};
  for (const v of SEVERITY) { const b = scored.filter((r) => r.verdict === v); buckets[v] = { n: b.length, observed: ratio(b.filter((r) => r.label === "fraud").length, b.length), prior: PRIOR[v] }; }
  const usable = SEVERITY.filter((v) => buckets[v].n >= 3);
  let ece = 0, brier = 0;
  for (const r of scored) { const p = PRIOR[r.verdict]; brier += (p - (r.label === "fraud" ? 1 : 0)) ** 2; }
  for (const v of SEVERITY) if (buckets[v].n) ece += (buckets[v].n / scored.length) * Math.abs(buckets[v].observed - PRIOR[v]);
  m.calibration = { buckets, ece, brier: scored.length ? brier / scored.length : null,
    monotone: usable.every((v, i) => i === 0 || buckets[v].observed <= buckets[usable[i - 1]].observed + 1e-9),
    usableBuckets: usable };
  const byConf = {};
  for (const c of ["low", "medium", "high"]) { const b = scored.filter((r) => r.confidence === c); byConf[c] = { n: b.length, observedFraud: ratio(b.filter((r) => r.label === "fraud").length, b.length) }; }
  // "Decided" = any verdict except Limited evidence. Correct = fraud flagged Caution or worse, or legit not flagged.
  for (const c of ["low", "medium", "high"]) {
    const d = scored.filter((r) => r.confidence === c && r.verdict !== "limited");
    byConf[c].decided = d.length; byConf[c].accuracy = ratio(d.filter((r) => (r.label === "fraud") === warn(r.verdict)).length, d.length);
  }
  m.byConfidence = byConf;
  const gaps = results.filter((r) => r.gap);
  m.gaps = { total: gaps.length, missed: gaps.filter((r) => (r.label === "fraud" ? !warn(r.verdict) : warn(r.verdict))).length,
    falseReassurance: gaps.filter((r) => r.label === "fraud" && r.verdict === "lower").length };
  // per category
  m.categories = {};
  for (const cat of [...new Set(scored.map((r) => r.cat))].sort()) {
    const rs = scored.filter((r) => r.cat === cat), verdicts = {};
    for (const v of SEVERITY) verdicts[v] = rs.filter((r) => r.verdict === v).length;
    const f = rs.filter((r) => r.label === "fraud"), l = rs.filter((r) => r.label === "legit");
    m.categories[cat] = { n: rs.length, fraud: f.length, legit: l.length, verdicts,
      fraudWarned: f.filter((r) => warn(r.verdict)).length, legitWarned: l.filter((r) => warn(r.verdict)).length };
  }
  return m;
}

// Regression guards: thresholds are set at CURRENT performance to stop silent regressions. They are not adequacy targets.
export function checkGates(m, t) {
  const pct = (x) => (x === null ? "n/a" : `${(x * 100).toFixed(0)}%`), bad = [];
  if (!t) return ["no thresholds defined"];
  if (m.recallAlarm < t.minRecallAlarm) bad.push(`recall(alarm) ${pct(m.recallAlarm)} < ${pct(t.minRecallAlarm)}`);
  if (m.recallWarn < t.minRecallWarn) bad.push(`recall(warn) ${pct(m.recallWarn)} < ${pct(t.minRecallWarn)}`);
  if (m.fprAlarm > t.maxFprAlarm) bad.push(`FPR(alarm) ${pct(m.fprAlarm)} > ${pct(t.maxFprAlarm)}`);
  if (m.fprWarn > t.maxFprWarn) bad.push(`FPR(warn) ${pct(m.fprWarn)} > ${pct(t.maxFprWarn)}`);
  if (m.precisionAlarm !== null && m.precisionAlarm < t.minPrecisionAlarm) bad.push(`precision ${pct(m.precisionAlarm)} < ${pct(t.minPrecisionAlarm)}`);
  if (m.falseReassurance > t.maxFalseReassurance) bad.push(`false reassurance ${m.falseReassurance} > ${t.maxFalseReassurance}`);
  if (m.gaps.falseReassurance > t.maxGapFalseReassurance) bad.push(`known-gap cases rated Lower risk ${m.gaps.falseReassurance} > ${t.maxGapFalseReassurance}`);
  if (m.legitDangerous > t.maxLegitDangerous) bad.push(`legit rated Dangerous ${m.legitDangerous} > ${t.maxLegitDangerous}`);
  if (t.requireMonotoneCalibration && !m.calibration.monotone) bad.push("calibration is not monotone in severity");
  if (m.calibration.ece > t.maxEce) bad.push(`ECE ${m.calibration.ece.toFixed(3)} > ${t.maxEce}`);
  return bad;
}
