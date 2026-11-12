import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/store.js";
import { createServer } from "../server/server.js";
import { buyerSignals, buyerFeedback, fetchCheck } from "../lib/buyers.js";

const rep = (n, o, tags = []) => ({ installId: "install-" + String(n).padStart(6, "0"), domain: "shop.example", outcome: o, tags });

test("hidden until enough independent reports", () => {
  const s = new Store({ minReports: 3 });
  s.add(rep(1, "never")); s.add(rep(2, "never"));
  assert.equal(s.summary("shop.example").hidden, true);
  s.add(rep(3, "problem", ["counterfeit"]));
  const sum = s.summary("shop.example");
  assert.equal(sum.total, 3); assert.equal(sum.outcomes.never, 2); assert.equal(sum.tags.counterfeit, 1);
});
test("one report per install per domain (replace)", () => {
  const s = new Store({ minReports: 1 });
  s.add(rep(1, "never")); s.add(rep(1, "ok"));
  assert.equal(s.summary("shop.example").total, 1);
  assert.equal(s.summary("shop.example").outcomes.ok, 1);
});
test("purchase-observed reports expose provenance without storing the purchase token", () => {
  const s = new Store({ minReports: 1 });
  s.add({ ...rep(1, "ok"), purchaseId: "12345678-abcd-4321-abcd-123456789abc" });
  const sum = s.summary("shop.example");
  assert.equal(sum.purchaseObserved, 1);
  const stored = [...s.reports.values()][0];
  assert.equal(stored.proof, "purchase_observed");
  assert.notEqual(stored.purchase, "12345678-abcd-4321-abcd-123456789abc");
});
test("old reports fall out of the window", () => {
  let t = 1e12; const s = new Store({ minReports: 1, now: () => t });
  s.add(rep(1, "never")); t += 31 * 86400000;
  assert.equal(s.summary("shop.example").total, 0);
});
test("validation rejects bad input", () => {
  const s = new Store();
  assert.throws(() => s.add({ ...rep(1, "never"), outcome: "scam!" }));
  assert.throws(() => s.add({ ...rep(1, "never"), tags: ["<script>"] }));
  assert.throws(() => s.add({ ...rep(1, "never"), domain: "a b/c" }));
  assert.throws(() => s.add({ ...rep(1, "never"), installId: "x" }));
  assert.throws(() => s.add({ ...rep(1, "never"), purchaseId: "not valid" }));
  assert.throws(() => s.add({ ...rep(1, "never"), details: "x".repeat(301) }));
  assert.throws(() => s.add({ ...rep(1, "never"), details: { text: "bad" } }));
});
test("optional written details stay out of public summaries", () => {
  const s = new Store({ minReports: 1 });
  s.add({ ...rep(1, "problem"), details: "  Late delivery and poor support.  " });
  assert.equal(s.feedbackDetails("shop.example")[0].details, "Late delivery and poor support.");
  assert.equal(JSON.stringify(s.summary("shop.example")).includes("Late delivery"), false);
  s.add({ ...rep(1, "ok"), details: "" });
  assert.equal(s.feedbackDetails("shop.example").length, 0);
});
test("http round trip + rate limit", async () => {
  const srv = createServer(new Store({ minReports: 1 }), { rateLimit: 3 });
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const credentials = [];
  for (let n = 1; n <= 4; n++) credentials.push(await (await fetch(base + "/v1/register", { method: "POST" })).json());
  const post = (n) => fetch(base + "/v1/report", {
    method: "POST",
    headers: { authorization: `Bearer ${credentials[n - 1].token}` },
    body: JSON.stringify({ ...rep(n, "never", ["fake_tracking"]), installId: credentials[n - 1].installId })
  });
  for (let n = 1; n <= 3; n++) assert.equal((await post(n)).status, 200);
  assert.equal((await post(4)).status, 429);
  const sum = await (await fetch(base + "/v1/summary?domain=shop.example")).json();
  assert.equal(sum.outcomes.never, 3);

  // Test unified /v1/check endpoint
  const checkData = await fetchCheck(base, "shop.example");
  assert.equal(checkData.domain, "shop.example");
  assert.equal(checkData.summary.outcomes.never, 3);
  assert.equal(checkData.verifiedMerchant, false);

  srv.close();
});
test("report writes require a server credential and exports require the admin token", async (t) => {
  const srv = createServer(new Store({ minReports: 1 }), { rateLimit: 20, adminToken: "admin-secret" });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  const payload = rep(1, "never");
  assert.equal((await fetch(base + "/v1/report", { method: "POST", body: JSON.stringify(payload) })).status, 401);
  assert.equal((await fetch(base + "/v1/export/orders")).status, 401);
  assert.equal((await fetch(base + "/v1/export/orders", { headers: { authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await fetch(base + "/v1/export/orders", { headers: { authorization: "Bearer admin-secret" } })).status, 200);
  assert.equal((await fetch(base + "/v1/export/feedback")).status, 401);
  assert.equal((await fetch(base + "/v1/export/feedback", { headers: { authorization: "Bearer admin-secret" } })).status, 200);
});
test("written feedback reaches only the private export", async (t) => {
  const srv = createServer(new Store({ minReports: 1 }), { adminToken: "admin-secret" });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  const credential = await (await fetch(base + "/v1/register", { method: "POST" })).json();
  const details = "The parcel arrived late.";
  const submitted = await fetch(base + "/v1/report", {
    method: "POST",
    headers: { authorization: `Bearer ${credential.token}` },
    body: JSON.stringify({ ...rep(1, "problem"), installId: credential.installId, details })
  });
  assert.equal(submitted.status, 200);
  const publicSummary = await (await fetch(base + "/v1/summary?domain=shop.example")).text();
  assert.equal(publicSummary.includes(details), false);
  const privateExport = await (await fetch(base + "/v1/export/feedback", {
    headers: { authorization: "Bearer admin-secret" }
  })).json();
  assert.equal(privateExport.rows[0].details, details);
  assert.equal("install" in privateExport.rows[0], false);
});
test("buyer signals and feedback", () => {
  const sum = { total: 10, windowDays: 30, outcomes: { ok: 1, problem: 3, never: 6 }, tags: { fake_tracking: 5, delayed: 2 } };
  assert.equal(buyerSignals(sum)[0].status, "bad");
  assert.match(buyerSignals(sum)[0].label, /6 of 10 reports say the order never arrived/);
  assert.equal(buyerFeedback(sum)[0].label, "order never arrived");
  assert.equal(buyerSignals({ total: 2, hidden: true })[0].status, "info");
  assert.equal(buyerSignals({ total: 8, outcomes: { ok: 7, problem: 1, never: 0 } })[0].status, "good");
});

test("mobile share check returns domain-only evidence and rejects search engines", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    const url = String(input);
    if (url.startsWith("https://rdap.org/")) return new Response(JSON.stringify({ events: [{ eventAction: "registration", eventDate: "2020-01-01T00:00:00Z" }] }), { status: 200 });
    if (url.startsWith("https://web.archive.org/")) return new Response(JSON.stringify([["timestamp"], ["20200101000000"]]), { status: 200 });
    return originalFetch(input, options);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const srv = createServer(new Store(), { readLimit: 20 });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  const invalid = await originalFetch(`${base}/v1/mobile-check?url=${encodeURIComponent("https://www.google.com/search?q=shoes")}`);
  assert.equal(invalid.status, 400);
  const response = await originalFetch(`${base}/v1/mobile-check?url=${encodeURIComponent("https://shop.example.com/checkout?token=secret")}`);
  assert.equal(response.status, 200);
  const report = await response.json();
  assert.equal(report.domain, "example.com");
  assert.equal(report.url, "https://shop.example.com/");
  assert.ok(report.signals.some((signal) => signal.id === "age"));
  assert.match(report.analysisScope, /page content.*not scanned/);
  assert.ok(!JSON.stringify(report).includes("secret"));
});
