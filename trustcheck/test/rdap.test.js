import test from "node:test";
import assert from "node:assert/strict";
import { domainAge, rdapLookup } from "../lib/providers.js";
import { json, withFetch, regEvent } from "./helpers.js";

test("falls back to Verisign for .com when rdap.org fails", async () => {
  const urls = [];
  await withFetch(async (u) => { urls.push(String(u)); if (String(u).includes("rdap.org")) throw new TypeError("Failed to fetch"); return json(regEvent("2026-10-20T00:00:00Z")); }, async () => {
    const sig = await domainAge("koadclo.com");
    assert.equal(urls.length, 2); assert.match(urls[1], /rdap\.verisign\.com\/com\/v1\/domain\/koadclo\.com/);
    assert.equal(sig[0].status, "bad"); assert.match(sig[0].label, /registered only \d+ days ago/);
    assert.equal(sig[0].verification, "verified");
  });
});
test("no fallback for other TLDs; error names every host tried", async () => {
  await withFetch(async () => { throw new TypeError("Failed to fetch"); }, async () => {
    await assert.rejects(rdapLookup("shop.co.uk"), /rdap\.org: Failed to fetch/);
  });
});
test("established domain scores well", async () => {
  await withFetch(async () => json(regEvent("2012-01-01T00:00:00Z")), async () => assert.equal((await domainAge("old.com"))[0].status, "good"));
});
test("record without a registration date is an info line, not an error", async () => {
  await withFetch(async () => json({ events: [{ eventAction: "last changed", eventDate: "2024-01-01T00:00:00Z" }] }), async () => {
    const s = await domainAge("x.co.uk"); assert.equal(s[0].status, "info"); assert.equal(s[0].points, 0);
  });
});
test("malformed RDAP payloads are rejected, never scored", async () => {
  for (const bad of [{ events: "nope" }, { events: [{ eventAction: "registration", eventDate: "not-a-date" }] },
    { events: [{ eventAction: "registration", eventDate: "2999-01-01T00:00:00Z" }] }, [], "x"])
    await withFetch(async () => json(bad), async () => await assert.rejects(rdapLookup("a.net"), /unexpected/));
});
