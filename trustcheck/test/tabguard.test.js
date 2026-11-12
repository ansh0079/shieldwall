import test from "node:test";
import assert from "node:assert/strict";
import { TabGuard } from "../lib/tabguard.js";
import { EvidenceCache, memoryStore } from "../lib/cache.js";
import { ProviderError } from "../lib/http.js";
import { normalizeUrl, sameDocument } from "../lib/url.js";

test("a newer analysis supersedes and aborts the older one", () => {
  const g = new TabGuard(), a = g.begin(1, "https://a.example/"), b = g.begin(1, "https://b.example/");
  assert.equal(a.signal.aborted, true); assert.equal(g.isCurrent(a), false); assert.equal(g.isCurrent(b), true);
});
test("navigation invalidates; URL must still match; closing forgets", () => {
  const g = new TabGuard(), t = g.begin(1, "https://a.example/p");
  assert.equal(g.isCurrent(t, "https://a.example/p#frag"), true);
  assert.equal(g.isCurrent(t, "https://b.example/"), false);
  g.invalidate(1); assert.equal(g.isCurrent(t), false);
  const t2 = g.begin(1, "https://a.example/"); g.forget(1); assert.equal(g.isCurrent(t2), false);
});
test("tabs are independent", () => {
  const g = new TabGuard(), a = g.begin(1, "https://a.example/"); g.begin(2, "https://b.example/"); g.invalidate(2);
  assert.equal(g.isCurrent(a), true);
});
test("rapid A -> B navigation with out-of-order responses never publishes A on B", async () => {
  const g = new TabGuard(), published = [];
  let currentUrl = "https://site-a.example/";
  const gates = {}; const wait = (k) => new Promise((r) => { gates[k] = r; });
  async function refresh(url) {                       // same shape as background.js refresh()
    const token = g.begin(1, url);
    await wait(url);                                  // provider response arrives whenever we release it
    if (!g.isCurrent(token, currentUrl)) return null;
    published.push(url); return url;
  }
  const a = refresh("https://site-a.example/");
  currentUrl = "https://site-b.example/"; g.invalidate(1);
  const b = refresh("https://site-b.example/");
  gates["https://site-b.example/"]();  await b;       // B answers first
  gates["https://site-a.example/"]();  await a;       // A answers late
  assert.deepEqual(published, ["https://site-b.example/"]);
});
test("URL normalisation", () => {
  assert.equal(normalizeUrl("HTTPS://Shop.Example:443/a/../b?x=1#f"), "https://shop.example/b?x=1");
  assert.equal(normalizeUrl("https://user:pw@shop.example/"), "https://shop.example/");
  assert.equal(normalizeUrl("https://shop.example/p?x=1", { dropQuery: true }), "https://shop.example/p");
  assert.equal(normalizeUrl("javascript:alert(1)"), null); assert.equal(normalizeUrl("nope"), null);
  assert.equal(sameDocument("https://a.example/x#1", "https://a.example/x#2"), true);
  assert.equal(sameDocument("https://a.example/x", "https://a.example/y"), false);
});
test("cache: success TTL, separate failure TTL, aborts not cached, pruning", async () => {
  let t = 1000; const store = memoryStore(), c = new EvidenceCache(store, { now: () => t, failTtlMs: 50 });
  let n = 0; const ok = () => c.cached("k", 100, async () => ++n);
  assert.equal(await ok(), 1); assert.equal(await ok(), 1); t += 101; assert.equal(await ok(), 2);
  const bad = () => c.cached("f", 100, async () => { n++; throw new ProviderError("http", "x: HTTP 500", { status: 500 }); });
  await assert.rejects(bad(), /500/); const before = n; await assert.rejects(bad(), /cached|500/); assert.equal(n, before);
  t += 51; await assert.rejects(bad(), /500/); assert.equal(n, before + 1);
  await assert.rejects(c.cached("ab", 100, async () => { throw new ProviderError("aborted", "x: cancelled"); }), /cancelled/);
  assert.ok(![...store._map.keys()].some((k) => k === "fail:ab"));
  await store.set("net:old.example", { at: t }); await store.set("ev:stale", { v: 1, at: 0 });
  const removed = await c.prune(500); assert.ok(removed >= 2); assert.ok(!store._map.has("net:old.example") && !store._map.has("ev:stale"));
});
