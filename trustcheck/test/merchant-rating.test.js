import test from "node:test";
import assert from "node:assert/strict";
import "../lib/merchant-rating.js";

const { parseMerchantRating } = globalThis.TrustCheckMerchantRating;

test("reads seller-level merchant-published aggregate ratings", () => {
  const json = JSON.stringify({ "@context": "https://schema.org", "@type": "OnlineStore", aggregateRating: {
    "@type": "AggregateRating", ratingValue: "4.3", reviewCount: "127", bestRating: "5"
  } });
  assert.deepEqual(parseMerchantRating([json]), { value: 4.3, best: 5, worst: 1, count: 127, source: "Merchant website", claimed: true });
});

test("does not mistake product ratings for seller reputation", () => {
  const product = JSON.stringify({ "@type": "Product", name: "Shoe", aggregateRating: { ratingValue: 5, reviewCount: 999 } });
  assert.equal(parseMerchantRating([product]), null);
});

test("rejects malformed and impossible ratings", () => {
  assert.equal(parseMerchantRating(["not json"]), null);
  assert.equal(parseMerchantRating([JSON.stringify({ "@type": "Organization", aggregateRating: { ratingValue: 7, bestRating: 5, reviewCount: 3 } })]), null);
});
