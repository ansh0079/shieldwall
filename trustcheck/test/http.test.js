import test from "node:test";
import assert from "node:assert/strict";
import { fetchJson, ProviderError, describeFailure } from "../lib/http.js";
import { json, text } from "./helpers.js";

const kind = async (p) => { try { await p; return "none"; } catch (e) { assert.ok(e instanceof ProviderError, String(e)); return e.kind; } };
const ok = (impl, opts) => fetchJson("https://api.example.test/x?key=SECRETKEY123", { fetchImpl: impl, ...opts });

test("returns parsed JSON", async () => assert.deepEqual(await ok(async () => json({ a: 1 })), { a: 1 }));
test("timeout", async () => assert.equal(await kind(ok((u, o) => new Promise((_, rej) => o.signal.addEventListener("abort", () => rej(new Error("aborted")))), { timeoutMs: 30 })), "timeout"));
test("caller abort", async () => { const c = new AbortController(); const p = ok((u, o) => new Promise((_, rej) => o.signal.addEventListener("abort", () => rej(new Error("x")))), { signal: c.signal }); c.abort(); assert.equal(await kind(p), "aborted"); });
test("already aborted signal never fetches", async () => { const c = new AbortController(); c.abort(); let called = false; assert.equal(await kind(ok(async () => { called = true; return json({}); }, { signal: c.signal })), "aborted"); assert.equal(called, false); });
test("rate limit and http status", async () => {
  assert.equal(await kind(ok(async () => json({}, { status: 429 }))), "rate_limited");
  assert.equal(await kind(ok(async () => json({}, { status: 500 }))), "http");
});
test("http errors keep the server's message", async () => {
  try { await ok(async () => json({ error: "invalid domain" }, { status: 400 })); assert.fail(); } catch (e) { assert.equal(e.status, 400); assert.equal(e.detail, "invalid domain"); }
});
test("wrong content type", async () => assert.equal(await kind(ok(async () => text("<html>", { type: "text/html" }))), "content_type"));
test("oversized responses (header and streamed)", async () => {
  assert.equal(await kind(ok(async () => json({}, { headers: { "content-length": "999999" } }), { maxBytes: 1000 })), "too_large");
  assert.equal(await kind(ok(async () => json({ pad: "x".repeat(5000) }), { maxBytes: 1000 })), "too_large");
});
test("invalid JSON", async () => assert.equal(await kind(ok(async () => new Response("{nope", { headers: { "content-type": "application/json" } }))), "parse"));
test("network error", async () => assert.equal(await kind(ok(async () => { throw new TypeError("Failed to fetch"); })), "network"));
test("error messages never contain the URL, path or API key", async () => {
  for (const impl of [async () => { throw new TypeError("boom https://api.example.test/x?key=SECRETKEY123"); }, async () => json({}, { status: 403 })]) {
    try { await ok(impl); assert.fail(); } catch (e) { assert.ok(!e.message.includes("SECRETKEY123"), e.message); assert.ok(!describeFailure(new Error("fetch failed key=SECRETKEY123")).includes("SECRETKEY123")); assert.ok(!describeFailure(e).includes("?key=")); assert.match(e.message, /^api\.example\.test:/); }
  }
});
