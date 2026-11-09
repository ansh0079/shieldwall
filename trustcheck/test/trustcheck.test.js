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
test("http + raw IP is a strong warning but, from one family, not yet 'high risk'", () => {
  const r = rep("http://192.168.4.4/pay");
  assert.equal(r.verdict, "caution"); assert.ok(r.score <= 69);
});
test("insecure payment form is dangerous", () => {
  const r = rep("http://shop.example/pay", pageSignals({ hasPaymentFields: true, https: false }));
  assert.equal(r.verdict, "dangerous"); assert.ok(r.score <= 10);
});
test("safe browsing flag caps score and forces 'dangerous'", () => {
  const r = buildReport({ url: "https://x.com", domain: "x.com", signals: [{ id: "age", points: 50, status: "good" }], links: [], flagged: true });
  assert.ok(r.score <= 10 && r.verdict === "dangerous");
});
test("missing store policies penalised", () => {
  const s = pageSignals({ isShop: true, https: true });
  assert.equal(s[0].id, "policies"); assert.equal(s[0].status, "bad");
});
