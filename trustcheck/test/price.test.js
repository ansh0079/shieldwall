import test from "node:test";
import assert from "node:assert/strict";
import { parsePrice, median, priceContext, priceSignals } from "../lib/price.js";

const page = ["£99.00", "£106.89", "£144.99", "£121.61", "£133.19", "£113.31", "£93.49", "£59.99", "£126.00"];

test("parses prices", () => {
  assert.deepEqual(parsePrice("Asics Gel-Kayano 31 £59.99 Koadclo"), { cur: "£", value: 59.99 });
  assert.deepEqual(parsePrice("$1,299.00"), { cur: "$", value: 1299 });
  assert.equal(parsePrice("Free delivery"), null);
});
test("median", () => { assert.equal(median([3, 1, 2]), 2); assert.equal(median([1, 2, 3, 4]), 2.5); });
test("koadclo-style listing is flagged", () => {
  const ctx = priceContext({ cardText: "Gel-Kayano 31 | Cushioned Stability £59.99 Koadclo Free of charge", pagePrices: page });
  assert.equal(ctx.median, 113.31);
  const s = priceSignals(ctx);
  assert.equal(s[0].status, "bad");   // 59.99 / 113.31 = 0.53 (47% below)
  assert.match(s[0].label, /47% below the typical £113/);
});
test("thresholds", () => {
  const mk = (price) => priceSignals({ cur: "£", price, median: 100, n: 9 });
  assert.equal(mk(45)[0].status, "bad");
  assert.equal(mk(65)[0].status, "warn");
  assert.deepEqual(mk(80), []);
  assert.match(mk(45)[0].label, /£45\.00 is 55% below the typical £100/);
});
test("normal price, pre-owned and too few prices are not flagged", () => {
  assert.deepEqual(priceSignals(priceContext({ cardText: "£106.89 Runners Need", pagePrices: page })), []);
  assert.equal(priceContext({ cardText: "£51.00 Pre-owned eBay", pagePrices: page }), null);
  assert.equal(priceContext({ cardText: "£40", pagePrices: ["£100", "£110"] }), null);
});

import { buildReport } from "../lib/score.js";
test("price alone => caution, price + new domain => risky", () => {
  const price = { id: "price", label: "p", status: "bad", points: -25 };
  const https = { id: "https", label: "h", status: "good", points: 5 };
  const alone = buildReport({ url: "https://a.example", domain: "a.example", signals: [price, https], links: [] });
  assert.equal(alone.verdict, "caution");
  const young = { id: "age", label: "a", status: "bad", points: -30 };
  const both = buildReport({ url: "https://a.example", domain: "a.example", signals: [price, https, young], links: [] });
  assert.equal(both.verdict, "risky");
});
