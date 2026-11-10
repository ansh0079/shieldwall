import test from "node:test";
import assert from "node:assert/strict";
import { isSearchEngine } from "../lib/domain.js";
import "../lib/search-seller.js";

const { explicitSellerUrl, sameProduct, visibleSellerName } = globalThis.TrustCheckSearch;

test("search engines are neutral", () => {
  for (const h of ["www.google.com", "google.co.uk", "shopping.google.com", "www.bing.com", "duckduckgo.com", "search.brave.com"])
    assert.equal(isSearchEngine(h), true, h);
});
test("shops are not search engines", () => {
  for (const h of ["www.amazon.com", "googlefake-shop.com", "shop.example", "localhost", "bing-deals.shop"])
    assert.equal(isSearchEngine(h), false, h);
});

test("explicit seller domains can be recovered from linkless shopping cards", () => {
  assert.equal(explicitSellerUrl("£99.00 & more prices\nFooty.com & more\n30-day returns"), "https://footy.com/");
  assert.equal(explicitSellerUrl("Seller: shoes.example.co.uk"), "https://shoes.example.co.uk/");
});

test("seller fallback never guesses a domain or rates the search engine", () => {
  assert.equal(explicitSellerUrl("ASICS Gel-Kayano 31\nSports Direct & more"), null);
  assert.equal(explicitSellerUrl("Sponsored by google.com"), null);
  assert.equal(explicitSellerUrl("Model gel-kayano.31"), null);
});

test("an open Google Shopping panel is associated only with its product card", () => {
  assert.equal(sameProduct("Asics Gel-Kayano 31 Paris Men\n£133.19\nDirect Sports", "Asics Gel Kayano 31 Paris Men"), true);
  assert.equal(sameProduct("Asics Gel-Kayano 31 Platinum Mens\n£144.99", "Asics Gel Kayano 31 Paris Men"), false);
  assert.equal(sameProduct("Shoe", "Shoe"), false);
});

test("seller names support Trustpilot search when Google omits the domain", () => {
  assert.equal(visibleSellerName("The North Face Men's Jacket\n£87.89 £175\nSnow+Rock\n30-day returns\n4.1 (30)"), "Snow+Rock");
  assert.equal(visibleSellerName("Product\n£99.00 & more prices\nFooty.com & more\n30-day returns"), "Footy.com");
  assert.equal(visibleSellerName("Product without a price\nSnow+Rock"), null);
});
