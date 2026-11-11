import test from "node:test";
import assert from "node:assert/strict";
import { registrableDomain } from "../lib/domain.js";
import { urlSignals, pageSignals } from "../lib/heuristics.js";
import { buildReport } from "../lib/score.js";

const ids = (s) => s.map((x) => x.id);
const rep = (url, extra = []) => buildReport({ url, domain: registrableDomain(new URL(url).hostname), signals: [...urlSignals(url), ...extra], links: [] });

test("registrable domain", () => {
  assert.equal(registrableDomain("shop.example.co.uk"), "example.co.uk");
  assert.equal(registrableDomain("a.b.example.com"), "example.com");
});
test("lookalike domain flagged", () => {
  assert.ok(ids(urlSignals("https://amaz0n.com/")).includes("lookalike"));
  assert.ok(ids(urlSignals("https://amazon-deals-store.com/")).includes("lookalike"));
});
test("real retailer not flagged as lookalike", () => {
  const s = ids(urlSignals("https://www.amazon.com/"));
  assert.ok(s.includes("known") && !s.includes("lookalike"));
});
test("http + ip is risky", () => {
  assert.equal(rep("http://192.168.4.4/pay").verdict, "risky");
});
test("safe browsing flag caps score", () => {
  const r = buildReport({ url: "https://x.com", domain: "x.com", signals: [{ points: 50, status: "good" }], links: [], flagged: true });
  assert.ok(r.score <= 10 && r.verdict === "risky");
});
test("missing store policies penalised", () => {
  const s = pageSignals({ isShop: true, https: true });
  assert.equal(s[0].id, "policies"); assert.equal(s[0].status, "bad");
});
test("analysis reports coverage without inventing review claims", () => {
  const r = buildReport({
    url: "https://shop.example",
    domain: "shop.example",
    signals: [{ id: "age", label: "Domain is 2 years old", status: "good", points: 10 }],
    reviews: { source: "Trustpilot", score: 2.4, count: 20, url: "https://www.trustpilot.com/review/shop.example" },
    links: []
  });
  assert.ok(r.analysis.checkedCount >= 2);
  assert.match(r.signals.find((signal) => signal.id === "tp").detail, /Open the source/);
  assert.doesNotMatch(r.signals.find((signal) => signal.id === "tp").detail, /never arrived/);
});
