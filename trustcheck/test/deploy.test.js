import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, clientIp, shutdown, safeFetchText } from "../server/server.js";
import { makeStore, enrollFrom, ipN } from "./helpers.js";
import { solvePowSync } from "../server/credentials.js";

const listen = async (srv) => { await new Promise((r) => srv.listen(0, "127.0.0.1", r)); return `http://127.0.0.1:${srv.address().port}`; };
const api = (base, token) => async (path, { method = "GET", body, headers = {} } = {}) => {
  const res = await fetch(base + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, headers: res.headers, json: await res.json().catch(() => null) };
};
async function boot(opts = {}, storeOpts = {}) {
  const { store, c } = makeStore(storeOpts), srv = createServer(store, { keepAlive: false, rateLimit: 1000, ...opts }), base = await listen(srv);
  return { store, c, srv, base, call: api(base), close: () => shutdown(srv) };
}

test("client IP honours X-Forwarded-For only when trusted", () => {
  const req = { headers: { "x-forwarded-for": "9.9.9.9, 10.0.0.1" }, socket: { remoteAddress: "127.0.0.1" } };
  assert.equal(clientIp(req, true), "9.9.9.9"); assert.equal(clientIp(req, false), "127.0.0.1");
});
test("healthz, 404, 413, security headers, no-store on writes, internals never leak", async () => {
  const s = await boot();
  assert.equal((await s.call("/healthz")).status, 200);
  assert.equal((await s.call("/nope")).status, 404);
  const big = await fetch(s.base + "/v1/enroll", { method: "POST", body: "x".repeat(20000) });
  assert.equal(big.status, 413);
  const r = await s.call("/v1/summary?domain=shop.example");
  assert.match(r.headers.get("cache-control"), /max-age/); assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.match((await s.call("/v1/challenge")).headers.get("cache-control"), /no-store/);
  s.store.summary = () => { throw new Error("secret stack detail"); };
  const e = await s.call("/v1/summary?domain=shop.example");
  assert.equal(e.status, 500); assert.equal(e.json.error, "internal error");
  await s.close();
});
test("CORS allows the Authorization header and DELETE", async () => {
  const s = await boot(), r = await fetch(s.base + "/v1/report", { method: "OPTIONS" });
  assert.match(r.headers.get("access-control-allow-headers"), /authorization/); assert.match(r.headers.get("access-control-allow-methods"), /DELETE/);
  await s.close();
});
test("full flow over HTTP: challenge -> proof of work -> enrol -> signed report -> summary -> delete -> erase", async () => {
  const s = await boot();
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
  await s.close();
});
test("writes require a valid credential; bad enrolment is refused", async () => {
  const s = await boot();
  assert.equal((await s.call("/v1/report", { method: "POST", body: { domain: "a.example", outcome: "ok" } })).status, 401);
  assert.equal((await api(s.base, "forged.token")("/v1/report", { method: "POST", body: { domain: "a.example", outcome: "ok" } })).status, 401);
  assert.equal((await s.call("/v1/enroll", { method: "POST", body: { challenge: "x", solution: "y" } })).status, 400);
  assert.equal((await fetch(s.base + "/v1/enroll", { method: "POST", body: "{bad json" })).status, 400);
  await s.close();
});
test("IP-level write limit applies per forwarded client when the proxy is trusted", async () => {
  const s = await boot({ rateLimit: 1, trustProxy: true });
  const t = (n) => s.call("/v1/disputes", { method: "POST", headers: { "x-forwarded-for": n }, body: { domain: "a.example", message: "a long enough dispute message" } });
  assert.equal((await t("1.1.1.1")).status, 200); assert.equal((await t("1.1.1.1")).status, 429); assert.equal((await t("2.2.2.2")).status, 200);
  await s.close();
});

// ---------------- admin API
test("admin API is off without a token, rejects bad tokens, and locks out brute force", async () => {
  const off = await boot(); assert.equal((await off.call("/admin/queue")).status, 404); await off.close();
  const s = await boot({ adminToken: "correct-horse-battery" });
  assert.equal((await s.call("/admin/queue")).status, 401);
  assert.equal((await api(s.base, "wrong")("/admin/queue")).status, 401);
  assert.equal((await api(s.base, "correct-horse-battery")("/admin/queue")).status, 200);
  for (let i = 0; i < 12; i++) await api(s.base, "guess" + i)("/admin/queue");
  assert.equal((await api(s.base, "correct-horse-battery")("/admin/queue")).status, 429);       // locked out after repeated failures
  await s.close();
});
test("moderators work through the admin API: queue, reject, revoke, disputes, audit verification", async () => {
  const s = await boot({ adminToken: "tok-admin" }), admin = api(s.base, "tok-admin");
  const toks = Array.from({ length: 6 }, (_, i) => enrollFrom(s.store, ipN(i)));
  toks.forEach((t, i) => s.store.submit({ token: t, ip: ipN(i), domain: "shop.example", outcome: "never", tags: [] }));
  const q = (await admin("/admin/queue")).json; assert.equal(q.length, 1);
  const ids = q[0].reports.map((r) => r.id);
  assert.equal((await admin("/admin/reports/moderate", { method: "POST", body: { ids: ids.slice(0, 2), action: "reject" } })).json.changed, 2);
  assert.equal((await admin("/admin/reports/moderate", { method: "POST", body: { ids, action: "explode" } })).status, 400);
  const credId = [...s.store.credentials.keys()][0];
  assert.equal((await admin(`/admin/credentials/${credId}/revoke`, { method: "POST", body: {} })).json.ok, true);
  const d = s.store.openDispute({ domain: "shop.example", message: "A long enough dispute message." });
  assert.equal((await admin("/admin/disputes")).json[0].token, undefined);
  assert.equal((await admin(`/admin/disputes/${d.id}/resolve`, { method: "POST", body: { resolution: "ok" } })).json.ok, true);
  assert.equal((await admin("/admin/audit/verify")).json.ok, true);
  assert.ok((await admin("/admin/audit")).json.length >= 4);
  await s.close();
});
test("dispute ownership verification only fetches public https hosts", async () => {
  await assert.rejects(safeFetchText("http://shop.example/x"), /not allowed/);
  await assert.rejects(safeFetchText("https://localhost/x"), /not allowed/);
  await assert.rejects(safeFetchText("https://127.0.0.1/x"), /not allowed/);
  await assert.rejects(safeFetchText("https://intranet.internal/x"), /not allowed/);
});
