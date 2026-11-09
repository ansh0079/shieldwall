import test from "node:test";
import assert from "node:assert/strict";
import { summarizeThemes } from "../lib/themes.js";

test("counts themes across reviews", () => {
  const t = summarizeThemes([
    "Never arrived, still waiting after 3 weeks", "Total scam, fake shoes", "Tracking never updates",
    "Counterfeit. No reply from support", "Great shoes, fast", "Package never received, no refund"
  ]);
  const by = Object.fromEntries(t.themes.map((x) => [x.id, x.count]));
  assert.equal(t.sample, 6);
  assert.equal(by.non_delivery, 2); assert.ok(by.fake >= 2);
  assert.ok(t.themes[0].count >= t.themes[t.themes.length - 1].count);
});
test("no reviews, no themes", () => assert.deepEqual(summarizeThemes([]), { sample: 0, themes: [] }));
test("one stray mention in many reviews is ignored", () => {
  const texts = Array(20).fill("lovely product"); texts[0] = "a bit cheap";
  assert.equal(summarizeThemes(texts).themes.length, 0);
});
