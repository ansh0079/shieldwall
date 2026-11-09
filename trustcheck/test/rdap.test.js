import test from "node:test";
import assert from "node:assert/strict";
import { domainAge, rdapLookup } from "../lib/providers.js";

const realFetch = globalThis.fetch;
const reg = (iso) => ({ ok: true, status: 200, json: async () => ({ events: [{ eventAction: "registration", eventDate: iso }] }) });
test.afterEach(() => { globalThis.fetch = realFetch; });

test("falls back to Verisign for .com when rdap.org fails", async () => {
  const urls = [];
  globalThis.fetch = async (u) => { urls.push(u); if (u.includes("rdap.org")) throw new TypeError("Failed to fetch"); return reg("2026-10-20T00:00:00Z"); };
  const sig = await domainAge("koadclo.com");
  assert.equal(urls.length, 2); assert.match(urls[1], /rdap\.verisign\.com\/com\/v1\/domain\/koadclo\.com/);
  assert.equal(sig[0].status, "bad"); assert.match(sig[0].label, /registered only \d+ days ago/);
});
test("no fallback for other TLDs; error names every host tried", async () => {
  globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
  await assert.rejects(rdapLookup("shop.co.uk"), /rdap\.org: Failed to fetch/);
});
test("established domain scores well", async () => {
  globalThis.fetch = async () => reg("2012-01-01T00:00:00Z");
  assert.equal((await domainAge("old.com"))[0].status, "good");
});
