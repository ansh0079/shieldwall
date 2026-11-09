import test from "node:test";
import assert from "node:assert/strict";
import { isSearchEngine } from "../lib/domain.js";

test("search engines are neutral", () => {
  for (const h of ["www.google.com", "google.co.uk", "shopping.google.com", "www.bing.com", "duckduckgo.com", "search.brave.com"])
    assert.equal(isSearchEngine(h), true, h);
});
test("shops are not search engines", () => {
  for (const h of ["www.amazon.com", "googlefake-shop.com", "shop.example", "localhost", "bing-deals.shop"])
    assert.equal(isSearchEngine(h), false, h);
});
