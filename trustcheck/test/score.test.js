import test from "node:test";
import assert from "node:assert/strict";
import { buildReport, decide, DISCLAIMER } from "../lib/score.js";
import { annotate } from "../lib/signals.js";

const S = (id, status, points = 0, extra = {}) => ({ id, label: `${id} ${status}`, status, points, ...extra });
const report = (...sigs) => buildReport({ url: "https://s.example/", domain: "s.example", signals: sigs.map((s) => annotate(s)), links: [] });
const https = S("https", "good", 5), policies = S("policies", "good", 8);
const ageOld = S("age", "good", 20, { verification: "verified", since: "2015-01-01T00:00:00Z" });
const company = S("company", "good", 12, { verification: "verified" }), sbOk = S("sb", "good", 5, { verification: "verified" });
const tpGood = S("tp", "good", 18, { verification: "verified" });

test("no evidence at all => limited evidence, low confidence", () => {
  const r = report(https, policies, S("age", "info", 0, { availability: "unavailable" }));
  assert.equal(r.verdict, "limited"); assert.equal(r.confidence, "low"); assert.match(r.headline, /Limited evidence · Low confidence/);
});
test("HTTPS, policy links and domain age alone never establish reliability", () => {
  const r = report(https, policies, ageOld);
  assert.equal(r.verdict, "limited");
  assert.notEqual(r.verdict, "lower");
});
test("two independent evidence families allow 'lower risk indicators'", () => {
  for (const pair of [[ageOld, company], [ageOld, sbOk], [company, tpGood], [ageOld, tpGood]]) {
    const r = report(https, ...pair);
    assert.equal(r.verdict, "lower", pair.map((p) => p.id).join("+")); assert.ok(r.score >= 70);
    assert.ok(["medium", "high"].includes(r.confidence));
  }
  assert.equal(report(https, ageOld, company, tpGood).confidence, "high");
});
test("positives from the same family do not count twice", () => {
  assert.equal(report(https, ageOld, S("known", "good", 20)).verdict, "lower");   // history + identity: two families
  assert.equal(report(https, S("age", "good", 12, { verification: "verified" })).verdict, "limited");
});
test("authoritative signals => dangerous", () => {
  assert.equal(report(ageOld, company, S("sb", "bad", -60, { verification: "verified" })).verdict, "dangerous");
  const r = report(S("pay-http", "bad", -30));
  assert.equal(r.verdict, "dangerous"); assert.ok(r.score <= 10);
});
test("one strong warning => caution; two independent strong warnings => high risk", () => {
  assert.equal(report(https, S("age", "bad", -30, { verification: "verified" })).verdict, "caution");
  assert.equal(report(https, S("age", "bad", -30, { verification: "verified" }), S("lookalike", "bad", -35)).verdict, "risky");
  assert.equal(report(S("https", "bad", -25), S("ip", "bad", -25)).verdict, "caution");   // same family: not independent
});
test("price is moderate: never high risk by itself, only with an independent strong warning", () => {
  assert.equal(report(https, S("price", "bad", -25)).verdict, "caution");
  assert.equal(report(https, S("price", "bad", -25), S("age", "bad", -30, { verification: "verified" })).verdict, "risky");
});
test("several weaker warnings across families => caution; a single weak warning is not enough", () => {
  assert.equal(report(https, S("policies", "bad", -15), S("urgency", "warn", -6)).verdict, "limited");        // both 'transparency'
  assert.equal(report(https, S("policies", "bad", -15), S("tld", "warn", -8)).verdict, "caution");              // transparency + safety
});
test("contradictory evidence: strong warnings beat positives", () => {
  assert.notEqual(report(https, ageOld, tpGood, S("lookalike", "bad", -35)).verdict, "lower");
  assert.equal(report(https, ageOld, company, S("company", "bad", -25)).verdict === "lower", false);
});
test("raw evidence too low for a positive verdict => limited, not caution", () => {
  const r = report(S("age", "good", 12, { verification: "verified" }), S("known", "good", 12), S("tld", "warn", -8));
  assert.ok(["limited", "lower"].includes(r.verdict));
  if (r.verdict === "lower") assert.ok(r.score >= 70);
});
test("score always agrees with the verdict band", () => {
  const bands = { dangerous: [0, 10], risky: [0, 35], caution: [36, 69], limited: [36, 69], lower: [70, 100] };
  const pool = [https, policies, ageOld, company, sbOk, tpGood, S("age", "bad", -30), S("lookalike", "bad", -35), S("price", "bad", -25), S("tld", "warn", -8), S("policies", "bad", -15), S("sb", "bad", -60), S("pay-http", "bad", -30)];
  for (let mask = 0; mask < 1 << pool.length; mask += 7) {
    const r = report(...pool.filter((_, i) => mask & (1 << i))), [lo, hi] = bands[r.verdict];
    assert.ok(r.score >= lo && r.score <= hi, `${r.verdict} score ${r.score} mask ${mask}`);
  }
});
test("monotonic: adding a warning never improves the verdict; adding positives never worsens the score", () => {
  const sev = { lower: 0, limited: 1, caution: 2, risky: 3, dangerous: 4 };
  const warns = [S("age", "bad", -30), S("lookalike", "bad", -35), S("price", "bad", -25), S("tld", "warn", -8), S("policies", "bad", -15), S("pay-http", "bad", -30)];
  const base = [https, ageOld, company];
  for (const w of warns) assert.ok(sev[report(...base, w).verdict] >= sev[report(...base).verdict], w.id);
  for (let i = 0; i < warns.length; i++) for (let j = i + 1; j < warns.length; j++)
    assert.ok(sev[report(...base, warns[i], warns[j]).verdict] >= sev[report(...base, warns[i]).verdict], `${warns[i].id}+${warns[j].id}`);
  const withWarn = report(S("tld", "warn", -8)).score;
  assert.ok(report(S("tld", "warn", -8), ageOld).score >= withWarn);
});
test("unverified buyer reports and setup notices never change the assessment", () => {
  const base = report(https, ageOld);
  const bad = report(https, ageOld, S("buyers", "info", 0, { verification: "unverified" }), S("sb-off", "info", 0), S("tp-off", "info", 0));
  assert.equal(bad.verdict, base.verdict); assert.equal(bad.score, base.score);
  assert.equal(bad.setup.length, 2); assert.ok(!bad.signals.some((s) => s.id === "sb-off"));
});
test("summary, findings and the permanent disclaimer", () => {
  const r = report(https, ageOld, company, S("price", "bad", -25));
  assert.equal(r.findings[0].id, "price");
  assert.match(r.summary, /Found: established domain, active registered company\./);
  assert.match(r.summary, /Missing: no independent review source/);
  assert.equal(r.disclaimer, DISCLAIMER); assert.match(DISCLAIMER, /cannot guarantee/);
  assert.ok(r.groups.every((g) => g.signals.length));
});
test("unavailable checks are listed as missing, not as findings", () => {
  const r = report(https, S("sb", "info", 0, { availability: "unavailable", label: "Malware/phishing check unavailable" }));
  assert.equal(r.missingChecks.length, 1); assert.ok(!r.signals.some((s) => s.id === "sb"));
  assert.match(r.summary, /1 check unavailable/);
});
