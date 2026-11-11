import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../server/store.js";
import { createServer, clientIp } from "../server/server.js";

const rep = (n, o = "never", d = "shop.example") => ({ installId: "install-" + String(n).padStart(6, "0"), domain: d, outcome: o, tags: [] });
const listen = async (srv) => { await new Promise((r) => srv.listen(0, "127.0.0.1", r)); return `http://127.0.0.1:${srv.address().port}`; };

test("raw install IDs are never written to disk; data survives restart", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tc-")), "data.json");
  const s = new Store({ file, minReports: 1, salt: "s1" });
  s.add(rep(1)); s.flush();
  const raw = fs.readFileSync(file, "utf8");
  assert.ok(!raw.includes("install-000001"));
  assert.ok(!fs.existsSync(file + ".tmp"));                  // atomic write left no temp file
  assert.equal(new Store({ file, minReports: 1, salt: "s1" }).summary("shop.example").total, 1);
  s.add(rep(1, "ok")); // same install + same salt still dedups after restart
  s.flush();
  assert.equal(new Store({ file, minReports: 1, salt: "s1" }).summary("shop.example").total, 1);
});
test("per-install daily limit", () => {
  const s = new Store({ minReports: 1, maxPerInstallPerDay: 3 });
  for (let i = 0; i < 3; i++) s.add(rep(1, "never", `shop${i}.example`));
  assert.throws(() => s.add(rep(1, "never", "shop9.example")), /daily/);
  s.add(rep(1, "ok", "shop0.example")); // updating an existing report is still allowed
});
test("old reports are pruned by retention", () => {
  let t = 1e12; const s = new Store({ minReports: 1, retentionDays: 90, now: () => t });
  s.add(rep(1)); t += 91 * 86400000; s.prune();
  assert.equal(s.reports.size, 0);
});
test("client IP honours X-Forwarded-For only when trusted", () => {
  const req = { headers: { "x-forwarded-for": "9.9.9.9, 10.0.0.1" }, socket: { remoteAddress: "127.0.0.1" } };
  assert.equal(clientIp(req, true), "9.9.9.9");
  assert.equal(clientIp(req, false), "127.0.0.1");
});
test("browser manifests load helper scripts before their consumers and declare packaged icons", () => {
  for (const name of ["manifest.json", "manifest.firefox.json"]) {
    const manifest = JSON.parse(fs.readFileSync(new URL(`../${name}`, import.meta.url), "utf8"));
    assert.deepEqual(manifest.content_scripts[0].js, ["lib/merchant-rating.js", "content.js"]);
    assert.deepEqual(manifest.content_scripts[1].js, ["lib/search-seller.js", "search_hover.js"]);
    for (const size of [16, 32, 48, 128]) assert.ok(fs.existsSync(new URL(`../${manifest.icons[size]}`, import.meta.url)));
  }
});
test("healthz, 413 on big body, 404, cache header", async (t) => {
  const srv = createServer(new Store({ minReports: 1 })); const base = await listen(srv);
  t.after(() => srv.close());
  assert.equal((await fetch(base + "/healthz")).status, 200);
  assert.equal((await fetch(base + "/nope")).status, 404);
  assert.equal((await fetch(base + "/v1/report", { method: "POST", body: "x".repeat(5000) })).status, 413);
  const r = await fetch(base + "/v1/summary?domain=shop.example");
  assert.match(r.headers.get("cache-control"), /max-age/);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
});
test("rate limit uses forwarded IP when trusted", async (t) => {
  const srv = createServer(new Store({ minReports: 1 }), { rateLimit: 1, trustProxy: true }); const base = await listen(srv);
  t.after(() => srv.close());
  const credentials = [];
  for (let n = 0; n < 3; n++) credentials.push(await (await fetch(base + "/v1/register", { method: "POST", headers: { "x-forwarded-for": `${n + 10}.0.0.1` } })).json());
  const post = (n, ip) => fetch(base + "/v1/report", {
    method: "POST",
    headers: { "x-forwarded-for": ip, authorization: `Bearer ${credentials[n - 1].token}` },
    body: JSON.stringify({ ...rep(n), installId: credentials[n - 1].installId })
  });
  assert.equal((await post(1, "1.1.1.1")).status, 200);
  assert.equal((await post(2, "1.1.1.1")).status, 429);
  assert.equal((await post(3, "2.2.2.2")).status, 200);   // different client unaffected
});
