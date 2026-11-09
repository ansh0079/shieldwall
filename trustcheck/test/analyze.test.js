import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { analyze } from "../lib/analyze.js";
import { EvidenceCache, memoryStore } from "../lib/cache.js";
import { ProviderError } from "../lib/http.js";

const age = (d) => [{ id: "age", label: "Established domain", status: "good", points: 20, since: "2015-01-01T00:00:00Z", detail: d }];
const sbClean = (url) => ({ flagged: false, signals: [{ id: "sb", label: "This page is not on Google Safe Browsing lists", status: "good", points: 5, scope: "url", detail: url }] });
const sbBad = (url) => ({ flagged: true, signals: [{ id: "sb", label: "This page is flagged by Google Safe Browsing", status: "bad", points: -60, scope: "url", detail: url }] });

function setup({ settings = {}, providers = {}, now } = {}) {
  const calls = [], store = memoryStore();
  let t = 1e12;
  const cache = new EvidenceCache(store, { now: now || (() => t) });
  const P = {
    domainAge: async (d) => { calls.push(["age", d]); return age(d); },
    firstArchived: async (d) => { calls.push(["arch", d]); return "2015-06-01T00:00:00Z"; },
    safeBrowsing: async (url) => { calls.push(["sb", url]); return url.includes("/checkout") ? sbBad(url) : sbClean(url); },
    trustpilot: async () => ({ reviews: null, signals: [] }), fetchCompany: async () => null, fetchSummary: async () => null,
    ...providers
  };
  const deps = { cache, providers: P, settings: { sbKey: "", tpKey: "", backend: "", chKey: "", ...settings } };
  return { calls, store, cache, deps, tick: (ms) => { t += ms; } };
}
const keys = (store) => [...store._map.keys()];

test("tenants on shared hosting never share evidence or inherit the platform's age", async () => {
  const { deps, calls, store } = setup({ providers: { firstArchived: async (d) => { calls.push(["arch", d]); return d.startsWith("safe") ? "2016-01-01T00:00:00Z" : "2026-10-01T00:00:00Z"; } } });
  const safe = await analyze("https://safe.github.io/", deps), evil = await analyze("https://evil.github.io/shop", deps);
  assert.equal(safe.tenant, "github.io"); assert.equal(evil.tenant, "github.io");
  assert.ok(!calls.some((c) => c[0] === "age"), "no registration lookup for tenants (github.io's age does not apply)");
  assert.deepEqual(calls.filter((c) => c[0] === "arch").map((c) => c[1]).sort(), ["evil.github.io", "safe.github.io"]);
  assert.ok(keys(store).includes("ev:arch:safe.github.io") && keys(store).includes("ev:arch:evil.github.io"));
  assert.notEqual(safe.archived, evil.archived);                     // each tenant keeps its own history
  assert.ok(!safe.signals.some((s) => s.id === "age"));
  assert.ok(safe.signals.some((s) => s.id === "tenant" && s.scope === "tenant"));
});
test("domain-level evidence is shared across paths of the same site", async () => {
  const { deps, calls } = setup();
  await analyze("https://shop.example.co.uk/a", deps); await analyze("https://shop.example.co.uk/b?x=1", deps);
  assert.equal(calls.filter((c) => c[0] === "age").length, 1);
  assert.equal(calls[0][1], "example.co.uk");
});
test("Safe Browsing checks the complete URL and caches per URL", async () => {
  const { deps, calls } = setup({ settings: { sbKey: "K" } });
  const home = await analyze("https://shop.example/", deps);
  const pay = await analyze("https://shop.example/checkout?cart=1#step2", deps);
  assert.notEqual(home.verdict, "dangerous");
  assert.equal(pay.verdict, "dangerous"); assert.ok(pay.score <= 10);   // a clean homepage cannot mark a flagged checkout clean
  assert.deepEqual(calls.filter((c) => c[0] === "sb").map((c) => c[1]), ["https://shop.example/", "https://shop.example/checkout?cart=1"]);
  const again = await analyze("https://shop.example/", deps);          // re-checking one URL cannot disturb the other
  assert.equal(again.verdict, home.verdict);
  await analyze("https://shop.example:443/checkout?cart=1#other", deps);   // fragment + default port normalise to a cache hit
  assert.equal(calls.filter((c) => c[0] === "sb").length, 2);
});
test("a provider failure is 'unavailable', never a clean result, and is only cached briefly", async () => {
  let n = 0;
  const { deps, tick } = setup({ settings: { sbKey: "K" }, providers: { safeBrowsing: async () => { n++; throw new ProviderError("timeout", "safebrowsing.googleapis.com: timed out after 8s"); } } });
  const r = await analyze("https://shop.example/pay", deps);
  const sig = r.missingChecks.find((s) => s.id === "sb");
  assert.equal(sig.status, "info"); assert.equal(sig.availability, "unavailable"); assert.equal(sig.points, 0);
  assert.equal(sig.provenance, "unavailable");
  assert.match(sig.detail, /missing, not clean/);
  assert.ok(![...r.signals, ...r.missingChecks].some((s) => s.id === "sb" && s.status === "good"));
  await analyze("https://shop.example/pay", deps); assert.equal(n, 1);   // failure cached briefly: no request storm
  tick(61_000); await analyze("https://shop.example/pay", deps); assert.equal(n, 2);
});
test("one failing provider does not hide the others", async () => {
  const { deps } = setup({ providers: { domainAge: async () => { throw new ProviderError("network", "rdap.org: Failed to fetch"); } } });
  const r = await analyze("https://shop.example/", deps);
  assert.ok(r.missingChecks.some((s) => s.id === "age" && s.availability === "unavailable"));
  assert.equal(r.archived, "2015-06-01T00:00:00Z");
});
test("Safe Browsing TTL is configurable", async () => {
  const { deps, calls, tick } = setup({ settings: { sbKey: "K", sbTtlMin: 2 } });
  await analyze("https://shop.example/", deps); tick(90_000); await analyze("https://shop.example/", deps);
  assert.equal(calls.filter((c) => c[0] === "sb").length, 1);
  tick(60_000); await analyze("https://shop.example/", deps);
  assert.equal(calls.filter((c) => c[0] === "sb").length, 2);
});
test("hover lookups drop the query before any URL-level check", async () => {
  const { deps, calls } = setup({ settings: { sbKey: "K" } });
  await analyze("https://shop.example/p/1?utm_source=google&gclid=abc#x", deps, { hover: true });
  assert.deepEqual(calls.find((c) => c[0] === "sb"), ["sb", "https://shop.example/p/1"]);
});
test("cancelled analysis throws and caches nothing as a failure", async () => {
  const ctl = new AbortController();
  const { deps, store } = setup({ providers: { domainAge: async () => { ctl.abort(); throw new ProviderError("aborted", "rdap.org: cancelled"); } } });
  await assert.rejects(analyze("https://shop.example/", deps, { signal: ctl.signal }), (e) => e.kind === "aborted");
  assert.ok(!keys(store).some((k) => k.startsWith("fail:age")));
});
test("malformed URLs and hosts", async () => {
  const { deps } = setup();
  assert.equal(await analyze("not a url", deps), null); assert.equal(await analyze("ftp://x.com/", deps), null);
  assert.equal((await analyze("https://www.google.co.uk/search?q=x", deps)).neutral, true);
});

test("every signal carries provenance: source, scope, kind, checked and expiry times", async () => {
  const { deps, tick } = setup({ settings: { sbKey: "K", backend: "https://reports.example" },
    providers: { fetchSummary: async () => ({ domain: "shop.example", total: 6, windowDays: 30, outcomes: { ok: 1, problem: 1, never: 4 }, tags: {} }) } });
  const r = await analyze("https://shop.example/", deps);
  const by = (id) => [...r.signals, ...r.missingChecks].find((s) => s.id === id);
  for (const s of r.signals) for (const k of ["family", "source", "scope", "provenance", "effect", "checkedAt", "explanation"]) assert.ok(s[k] !== undefined, `${s.id}.${k}`);
  assert.equal(by("sb").provenance, "verified"); assert.equal(by("sb").scope, "url"); assert.equal(by("sb").source, "Google Safe Browsing");
  assert.equal(by("sb").expiresAt - by("sb").checkedAt, 30 * 60_000);
  assert.equal(by("age").source, "Domain registry (RDAP)"); assert.equal(by("age").expiresAt - by("age").checkedAt, 6 * 3600_000);
  assert.equal(by("https").provenance, "inferred"); assert.equal(by("https").expiresAt, null);        // local heuristic: never "expires"
  assert.equal(by("buyers").provenance, "user-reported");
  tick(5 * 60_000);
  const again = await analyze("https://shop.example/", deps);                                           // cached evidence keeps its ORIGINAL check time
  assert.equal([...again.signals].find((s) => s.id === "age").checkedAt, by("age").checkedAt);
});
