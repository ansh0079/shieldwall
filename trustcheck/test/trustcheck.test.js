import test from "node:test";
import assert from "node:assert/strict";
import { registrableDomain } from "../lib/domain.js";
import { urlSignals, pageSignals } from "../lib/heuristics.js";
import { buildReport } from "../lib/score.js";
import { isRetailPage } from "../lib/retail.js";
import { reviewLinks } from "../lib/providers.js";
import { ignoreClosedTab } from "../lib/tab-race.js";

const ids = (s) => s.map((x) => x.id);
const rep = (url, extra = []) => buildReport({ url, domain: registrableDomain(new URL(url).hostname), signals: [...urlSignals(url), ...extra], links: [] });

test("checks only pages with retail or order activity", () => {
  assert.equal(isRetailPage(null), false);
  assert.equal(isRetailPage({ isShop: false, isCheckout: false, purchaseObserved: false }), false);
  assert.equal(isRetailPage({ isShop: true }), true);
  assert.equal(isRetailPage({ isCheckout: true }), true);
  assert.equal(isRetailPage({ purchaseObserved: true }), true);
});
test("seller source links identify the domain without implying imported scores", () => {
  const links = Object.fromEntries(reviewLinks("zeravi.co.uk").map(({ name, url }) => [name, url]));
  assert.match(links["Google: reviews"], /zeravi\.co\.uk%20reviews/);
  assert.equal(links.ScamAdviser, "https://www.scamadviser.com/check-website/zeravi.co.uk");
  assert.equal(links["Who.is record"], "https://who.is/whois/zeravi.co.uk");
});
test("closed-tab UI races never become unhandled extension errors", async () => {
  assert.equal(await ignoreClosedTab(() => Promise.reject(new Error("No tab with id"))), null);
  assert.equal(await ignoreClosedTab(() => { throw new Error("No tab with id"); }), null);
  assert.equal(await ignoreClosedTab(() => Promise.resolve("sent")), "sent");
});

test("registrable domain", () => {
  assert.equal(registrableDomain("shop.example.co.uk"), "example.co.uk");
  assert.equal(registrableDomain("a.b.example.com"), "example.com");
});
test("lookalike domain flagged", () => {
  assert.ok(ids(urlSignals("https://amaz0n.com/")).includes("lookalike"));
  assert.ok(ids(urlSignals("https://amazon-deals-store.com/")).includes("lookalike"));
});
test("real retailer not flagged as lookalike; marketplaces are not 'well-known retailers'", () => {
  const retailer = ids(urlSignals("https://www.ikea.com/"));
  assert.ok(retailer.includes("known") && !retailer.includes("lookalike"));
  const market = ids(urlSignals("https://www.amazon.com/"));
  assert.ok(market.includes("marketplace") && !market.includes("known") && !market.includes("lookalike"));
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
test("analysis attaches Trustpilot reviews without inventing delivery claims", async () => {
  const { signalsFromTrustpilotReviews } = await import("../lib/providers.js");
  const reviews = { source: "Trustpilot", score: 2.4, count: 20, url: "https://www.trustpilot.com/review/shop.example" };
  const { signals } = signalsFromTrustpilotReviews(reviews);
  const r = buildReport({
    url: "https://shop.example",
    domain: "shop.example",
    signals: [{ id: "age", label: "Domain is 2 years old", status: "good", points: 10 }, ...signals],
    reviews,
    links: []
  });
  assert.equal(r.reviews.score, 2.4);
  assert.equal(r.reviews.count, 20);
  const tp = r.signals.find((signal) => signal.id === "tp");
  assert.ok(tp);
  assert.equal(tp.status, "bad");
  assert.doesNotMatch(tp.label + (tp.detail || ""), /never arrived/);
});
