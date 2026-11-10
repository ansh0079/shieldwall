// requires: node:sqlite
import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { createServer, shutdown } from "../server/server.js";
import { safeFetchText } from "../server/fetch-safe.js";
import { createLogger, Metrics } from "../server/log.js";
import { parseCidrList } from "../server/net.js";
import { makeStore, enrollFrom, ipN, credOf } from "./server-helpers.js";
import { solvePowSync } from "../server/credentials.js";

const ADMIN = "alice-token-0123456789abcdef", BOB = "bob-token-0123456789abcdefgh";
const api = (base, token) => async (path, { method = "GET", body, headers = {} } = {}) => {
  const res = await fetch(base + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* plain text */ }
  return { status: res.status, headers: res.headers, json, text };
};
async function boot(opts = {}, storeOpts = {}) {
  const logs = [], logger = createLogger({ write: (l) => logs.push(l) }), metrics = new Metrics();
  const { store, c } = makeStore(storeOpts);
  const srv = createServer(store, { keepAlive: false, rateLimit: 1000, logger, metrics, adminTokens: [{ name: "alice", token: ADMIN }, { name: "bob", token: BOB }], ...opts });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port, base = `http://127.0.0.1:${port}`;
  return { store, c, srv, base, port, logs, metrics, call: api(base), admin: api(base, ADMIN), close: async () => { await shutdown(srv); store.close(); } };
}
const withServer = async (opts, fn, storeOpts) => { const s = await boot(opts, storeOpts); try { await fn(s); } finally { await s.close(); } };

test("liveness vs readiness, request ids, security headers, no-store", () => withServer({}, async (s) => {
  assert.equal((await s.call("/healthz")).status, 200);
  const r = await s.call("/readyz"); assert.equal(r.status, 200); assert.deepEqual(Object.keys(r.json.checks).sort(), ["database", "schema", "writable"]);
  const h = (await s.call("/v1/challenge")).headers;
  assert.match(h.get("x-request-id"), /^[0-9a-f]{8,}$/); assert.equal(h.get("x-content-type-options"), "nosniff"); assert.equal(h.get("cache-control"), "no-store");
  assert.match(h.get("content-security-policy"), /default-src 'none'/); assert.equal(h.get("referrer-policy"), "no-referrer");
  assert.equal((await s.call("/v1/summary?domain=shop.example")).headers.get("cache-control"), "public, max-age=60");
}));
test("readiness turns 503 when the database is unusable, and again 200 when it recovers", () => withServer({}, async (s) => {
  s.store.db.exec("PRAGMA query_only = ON");                                                  // simulates a read-only / failing disk
  const bad = await s.call("/readyz"); assert.equal(bad.status, 503); assert.equal(bad.json.checks.writable, "read-only or locked");
  assert.equal((await s.call("/healthz")).status, 200, "liveness must stay green so the process is not killed for a dependency problem");
  s.store.db.exec("PRAGMA query_only = OFF");
  assert.equal((await s.call("/readyz")).status, 200);
}));
test("database faults surface as 503 + Retry-After and are counted, never as a 500 or a crash", () => withServer({}, async (s) => {
  const real = s.store.summary.bind(s.store);
  s.store.summary = () => { const e = new Error("database or disk is full"); e.code = "ERR_SQLITE_ERROR"; e.errcode = 13; throw e; };
  const r = await s.call("/v1/summary?domain=shop.example");
  assert.equal(r.status, 503); assert.equal(r.headers.get("retry-after"), "5"); assert.equal(r.json.error, "temporarily unavailable");
  assert.equal(s.metrics.get("db_errors_total", { kind: "disk full" }), 1);
  assert.ok(s.logs.some((l) => JSON.parse(l).event === "db_fault"));
  s.store.summary = () => { throw new Error("secret stack detail /etc/passwd"); };
  const e = await s.call("/v1/summary?domain=shop.example"); assert.equal(e.status, 500); assert.equal(e.json.error, "internal error");
  assert.ok(!e.text.includes("passwd")); s.store.summary = real;
  assert.equal((await s.call("/v1/summary?domain=shop.example")).status, 200);
}));
test("request limits: body, headers, URL length, content type, malformed JSON", () => withServer({ bodyLimit: 1024, maxHeaderBytes: 2048 }, async (s) => {
  assert.equal((await fetch(s.base + "/v1/enroll", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ x: "y".repeat(5000) }) })).status, 413);
  assert.equal((await fetch(s.base + "/v1/enroll", { method: "POST", headers: { "content-type": "application/json" }, body: "{bad json" })).status, 400);
  assert.equal((await fetch(s.base + "/v1/enroll", { method: "POST", headers: { "content-type": "text/plain" }, body: '{"a":1}' })).status, 415);   // blocks cross-site "simple" form posts
  const longUrl = await fetch(s.base + "/v1/summary?domain=" + "a".repeat(3000)).then((r) => r.status, () => "closed");
  assert.ok([400, 414, 431, "closed"].includes(longUrl), "an over-long URL is refused, got " + longUrl);               // this server's tiny header cap stops it in the parser
  const big = await fetch(s.base + "/healthz", { headers: { "x-pad": "z".repeat(6000) } }).then((r) => r.status, () => "closed");
  assert.ok(big === 431 || big === 400 || big === "closed", "oversized headers must be refused, got " + big);
  assert.equal((await s.call("/healthz")).status, 200);                                          // and the server is still fine
}));
test("over-long URLs get an explicit 414 at the default header size", () => withServer({}, async (s) => {
  assert.equal((await fetch(s.base + "/v1/summary?domain=" + "a".repeat(3000))).status, 414);
}));
test("responses larger than the cap are refused rather than sent", () => withServer({ maxResponseBytes: 200 }, async (s) => {
  s.store.summary = () => ({ blob: "x".repeat(5000) });
  const r = await s.call("/v1/summary?domain=a.example"); assert.equal(r.status, 500); assert.equal(r.json.error, "internal error");
  assert.equal(s.metrics.get("response_too_large_total"), 1);
}));
test("CORS: only allowlisted origins; others are refused outright; no Origin (non-browser) is allowed", () => withServer({ allowedOrigins: new Set(["chrome-extension://abcdefabcdefabcdefabcdefabcdefab"]) }, async (s) => {
  const ok = await s.call("/v1/challenge", { headers: { origin: "chrome-extension://abcdefabcdefabcdefabcdefabcdefab" } });
  assert.equal(ok.status, 200); assert.equal(ok.headers.get("access-control-allow-origin"), "chrome-extension://abcdefabcdefabcdefabcdefabcdefab"); assert.equal(ok.headers.get("vary"), "Origin");
  const bad = await s.call("/v1/challenge", { headers: { origin: "https://evil.example" } });
  assert.equal(bad.status, 403); assert.equal(bad.headers.get("access-control-allow-origin"), null);
  assert.equal((await s.call("/v1/report", { method: "POST", body: {}, headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await fetch(s.base + "/v1/report", { method: "OPTIONS", headers: { origin: "https://evil.example" } })).status, 403);
  const pre = await fetch(s.base + "/v1/report", { method: "OPTIONS", headers: { origin: "chrome-extension://abcdefabcdefabcdefabcdefabcdefab" } });
  assert.match(pre.headers.get("access-control-allow-headers"), /authorization/); assert.match(pre.headers.get("access-control-allow-methods"), /DELETE/);
  assert.equal((await s.call("/v1/challenge")).status, 200);
}));
test("CORS 'none' refuses every browser origin; '*' (development) allows all", async () => {
  await withServer({ allowedOrigins: new Set() }, async (s) => { assert.equal((await s.call("/healthz", { headers: { origin: "https://a.example" } })).status, 403); assert.equal((await s.call("/healthz")).status, 200); });
  await withServer({ allowedOrigins: "*" }, async (s) => assert.equal((await s.call("/healthz", { headers: { origin: "https://a.example" } })).headers.get("access-control-allow-origin"), "*"));
});
test("forwarded addresses are believed only from a trusted proxy, read right to left, and never from anyone else", async () => {
  // Behind a trusted proxy (127.0.0.1): two different real clients get separate write budgets...
  await withServer({ rateLimit: 1, trustedProxies: parseCidrList("127.0.0.1/32") }, async (s) => {
    const t = (xff) => s.call("/v1/disputes", { method: "POST", headers: { "x-forwarded-for": xff }, body: { domain: "a.example", message: "a long enough dispute message" } });
    assert.equal((await t("203.0.113.1")).status, 200); assert.equal((await t("203.0.113.1")).status, 429); assert.equal((await t("203.0.113.2")).status, 200);
    assert.equal((await t("203.0.113.9, 127.0.0.1")).status, 200);                           // rightmost untrusted hop is the client
    assert.equal((await t("198.51.100.77, 203.0.113.1")).status, 429);                       // a spoofed left entry cannot hide the real client
    assert.equal((await t("junk")).status, 200); assert.equal((await t("junk")).status, 429);   // malformed header: falls back to the proxy's own address (one shared bucket)
    assert.ok(s.metrics.get("malformed_forwarded_for_total") >= 2);
  });
  // ...but from an UNtrusted peer the header is ignored, so it cannot be used to dodge limits.
  await withServer({ rateLimit: 1, trustedProxies: parseCidrList("10.0.0.0/8") }, async (s) => {
    const t = (xff) => s.call("/v1/disputes", { method: "POST", headers: { "x-forwarded-for": xff }, body: { domain: "a.example", message: "a long enough dispute message" } });
    assert.equal((await t("203.0.113.1")).status, 200); assert.equal((await t("203.0.113.2")).status, 429);
  });
});
test("per-address concurrency cap protects against one client holding many requests open", () => withServer({ maxConcurrentPerIp: 3, bodyLimit: 4096 }, async (s) => {
  const socks = await Promise.all(Array.from({ length: 8 }, () => new Promise((res) => { const c = net.connect(s.port, "127.0.0.1", () => { c.write("POST /v1/enroll HTTP/1.1\r\nhost: x\r\ncontent-type: application/json\r\ncontent-length: 50\r\n\r\n{"); res(c); }); })));
  await new Promise((r) => setTimeout(r, 150));                                              // 8 requests stalled mid-body
  const r = await s.call("/healthz").then((x) => x.status, () => "err"); const r2 = await s.call("/v1/challenge");
  assert.ok(r2.status === 429 || r2.status === 200);
  assert.ok(s.metrics.get("rate_limited_total", { kind: "concurrency" }) >= 1, "the cap engaged");
  socks.forEach((c) => c.destroy()); void r;
}));
test("connection cap and slowloris timeout: excess and stalled connections are dropped promptly, the server stays responsive", () => withServer({ maxConnections: 5, headersTimeoutMs: 400, requestTimeoutMs: 600 }, async (s) => {
  const closed = []; const idle = Array.from({ length: 12 }, () => { const c = net.connect(s.port, "127.0.0.1"); c.on("close", () => closed.push(1)); c.on("error", () => {}); c.resume(); return c; });
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(closed.length >= 7, `connections beyond the cap are refused immediately (closed ${closed.length}/12)`);
  await new Promise((r) => setTimeout(r, 1500));                                              // the rest never send headers: cut by the (frequent) timeout check
  assert.equal(closed.length, 12, `every stalled connection must be closed (closed ${closed.length}/12)`);
  assert.equal((await s.call("/healthz")).status, 200);
}));
test("draining: readiness fails, new work is refused, in-flight work completes", () => withServer({}, async (s) => {
  const slow = new Promise((res) => { const c = net.connect(s.port, "127.0.0.1", () => c.write("GET /healthz HTTP/1.1\r\nhost: x\r\n\r\n")); let b = ""; c.on("data", (d) => { b += d; if (b.includes("\r\n\r\n")) { res(b.split("\r\n")[0]); c.destroy(); } }); });
  assert.match(await slow, /200/);
  const d = s.srv.drain(2000);
  const r = await s.call("/readyz"); assert.equal(r.status, 503); assert.equal(r.json.checks.draining, "shutting down");
  const w = await s.call("/v1/challenge"); assert.equal(w.status, 503); assert.equal(w.headers.get("retry-after"), "5");
  assert.equal((await s.call("/healthz")).status, 200);
  assert.equal((await d).inflightLeft, 0);
}));
test("full flow over HTTP: challenge -> proof of work -> enrol -> signed report -> summary -> delete -> erase", () => withServer({}, async (s) => {
  const ch = (await s.call("/v1/challenge")).json;
  const en = await s.call("/v1/enroll", { method: "POST", body: { challenge: ch.challenge, solution: solvePowSync(ch.challenge, ch.bits) } });
  assert.equal(en.status, 200); const authed = api(s.base, en.json.token);
  assert.equal((await authed("/v1/report", { method: "POST", body: { domain: "shop.example", outcome: "never", tags: ["fake_tracking"] } })).status, 200);
  const sum = (await s.call("/v1/summary?domain=shop.example")).json;
  assert.equal(sum.hidden, true); assert.equal(sum.total, 1); assert.equal(sum.verification, "unverified");
  assert.equal((await authed("/v1/report?domain=shop.example", { method: "DELETE" })).status, 200);
  assert.equal((await authed("/v1/report?domain=shop.example", { method: "DELETE" })).status, 404);
  assert.equal((await authed("/v1/credential", { method: "DELETE" })).json.ok, true);
  assert.equal((await authed("/v1/report", { method: "POST", body: { domain: "shop.example", outcome: "ok" } })).status, 401);
}));
test("writes need a valid credential; forged tokens and bad enrolment are refused and counted", () => withServer({}, async (s) => {
  assert.equal((await s.call("/v1/report", { method: "POST", body: { domain: "a.example", outcome: "ok" } })).status, 401);
  assert.equal((await api(s.base, "forged.token")("/v1/report", { method: "POST", body: { domain: "a.example", outcome: "ok" } })).status, 401);
  assert.equal((await s.call("/v1/enroll", { method: "POST", body: { challenge: "x", solution: "y" } })).status, 400);
  assert.ok(s.metrics.get("auth_failures_total", { kind: "credential" }) >= 2);
}));
test("admin: off without tokens; 401 for bad tokens; lockout after repeated failures; hidden from other networks", async () => {
  await withServer({ adminTokens: [] }, async (s) => assert.equal((await s.call("/admin/queue")).status, 404));
  await withServer({}, async (s) => {
    assert.equal((await s.call("/admin/queue")).status, 401); assert.equal((await api(s.base, "wrong")("/admin/queue")).status, 401);
    assert.equal((await s.admin("/admin/queue")).status, 200);
    for (let i = 0; i < 12; i++) await api(s.base, "guess" + i)("/admin/queue");
    assert.equal((await s.admin("/admin/queue")).status, 429);                                // even the right token is locked out for the hour
  });
  await withServer({ adminCidrs: parseCidrList("10.0.0.0/8") }, async (s) => assert.equal((await s.admin("/admin/queue")).status, 404));   // 127.0.0.1 is outside
});
test("moderators are named: the audit log records WHO acted (queue, reject, revoke, disputes, appeals)", () => withServer({}, async (s) => {
  const bob = api(s.base, BOB), toks = Array.from({ length: 6 }, (_, i) => enrollFrom(s.store, ipN(i)));
  toks.forEach((t, i) => s.store.submit({ token: t, ip: ipN(i), domain: "shop.example", outcome: "never", tags: [] }));
  const q = (await s.admin("/admin/queue")).json; assert.equal(q.items.length, 1);
  const ids = q.items[0].reports.map((r) => r.id);
  assert.equal((await s.admin("/admin/reports/moderate", { method: "POST", body: { ids: ids.slice(0, 2), action: "reject" } })).json.changed, 2);
  assert.equal((await bob("/admin/reports/moderate", { method: "POST", body: { ids, action: "explode" } })).status, 400);
  assert.equal((await bob(`/admin/credentials/${credOf(toks[0])}/revoke`, { method: "POST", body: {} })).json.ok, true);
  const d = s.store.openDispute({ domain: "shop.example", message: "A long enough dispute message." });
  assert.equal((await s.admin("/admin/disputes")).json[0].token_hash, undefined);
  assert.equal((await s.admin(`/admin/disputes/${d.id}/resolve`, { method: "POST", body: { resolution: "ok" } })).json.status, "resolved");
  const m = await s.call(`/v1/disputes/${d.id}/appeal`, { method: "POST", headers: { authorization: `Bearer ${d.token}` }, body: { message: "Please look at this again, it is a different company." } });
  assert.equal(m.status, 200);
  assert.equal((await bob(`/admin/disputes/${d.id}/resolve`, { method: "POST", body: { resolution: "final" } })).json.status, "closed");
  assert.equal((await s.call(`/v1/disputes/${d.id}`, { headers: { authorization: `Bearer ${d.token}` } })).json.status, "closed");
  assert.equal((await s.call(`/v1/disputes/${d.id}`)).status, 403);
  const log = (await s.admin("/admin/audit?limit=100")).json;
  assert.ok(log.some((e) => e.actor === "alice" && e.action === "reject") && log.some((e) => e.actor === "bob" && e.action === "revoke_credential") && log.some((e) => e.actor === "bob" && e.action === "dispute_closed"));
  assert.equal((await s.admin("/admin/audit/verify")).json.ok, true);
  assert.equal((await s.admin("/admin/audit?after=2&limit=2")).json.length, 2);
  assert.equal((await s.admin("/admin/queue?limit=1&after=zzz")).json.items.length, 0);
}));
test("metrics are admin-only and contain counters, histograms and no personal data", () => withServer({}, async (s) => {
  await s.call("/v1/summary?domain=shop.example"); await s.call("/nope");
  assert.equal((await s.call("/metrics")).status, 401);
  const m = await s.admin("/metrics");
  assert.equal(m.status, 200); assert.match(m.headers.get("content-type"), /text\/plain/);
  assert.match(m.text, /trustcheck_http_requests_total\{route="GET \/v1\/summary",status="200"\} 1/);
  assert.match(m.text, /trustcheck_http_request_duration_seconds_bucket\{route="GET \/v1\/summary",le="0\.1"\}/); assert.match(m.text, /route="unmatched",status="404"/);
  assert.ok(!/127\.0\.0\.1|shop\.example/.test(m.text), "no addresses or domains in metrics");
}));
test("logs are structured and contain no addresses, tokens, bodies or query strings", () => withServer({}, async (s) => {
  const ch = (await s.call("/v1/challenge")).json;
  const en = (await s.call("/v1/enroll", { method: "POST", body: { challenge: ch.challenge, solution: solvePowSync(ch.challenge, ch.bits) } })).json;
  await api(s.base, en.token)("/v1/report", { method: "POST", body: { domain: "secret-shop.example", outcome: "never", tags: [] } });
  await s.call("/v1/summary?domain=secret-shop.example&utm=trackingvalue"); await s.admin("/admin/queue");
  const all = s.logs.join("\n"), parsed = s.logs.map((l) => JSON.parse(l));
  assert.ok(parsed.length >= 4 && parsed.every((l) => l.ts && l.level && l.event));
  // (the proof-of-work solution is a short number that appears inside timestamps, so it cannot be searched for meaningfully)
  for (const needle of ["127.0.0.1", en.token, en.token.split(".")[0], ch.challenge, ADMIN, "secret-shop", "trackingvalue", "authorization"]) {
    assert.ok(needle.length >= 8, "needle too short to be meaningful: " + needle);
    assert.ok(!all.includes(needle), `log leaks: ${needle}`);
  }
  assert.ok(parsed.some((l) => l.event === "request" && l.route === "POST /v1/report" && l.status === 200 && typeof l.ms === "number"));
}));
test("IP-level write limits and the safe ownership fetch", async () => {
  await withServer({ rateLimit: 2 }, async (s) => {
    const t = () => s.call("/v1/disputes", { method: "POST", body: { domain: "a.example", message: "a long enough dispute message" } });
    assert.equal((await t()).status, 200); assert.equal((await t()).status, 200); assert.equal((await t()).status, 429);
  });
  for (const u of ["http://shop.example/x", "https://localhost/x", "https://127.0.0.1/x", "https://intranet.internal/x"]) await assert.rejects(safeFetchText(u), /not allowed/);
});
