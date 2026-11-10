import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/store.js";
import { createServer } from "../server/server.js";
import { buyerSignals, buyerFeedback } from "../lib/buyers.js";

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
});
test("http round trip + rate limit", async () => {
  const srv = createServer(new Store({ minReports: 1 }), { rateLimit: 3 });
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const post = (n) => fetch(base + "/v1/report", { method: "POST", body: JSON.stringify(rep(n, "never", ["fake_tracking"])) });
  for (let n = 1; n <= 3; n++) assert.equal((await post(n)).status, 200);
  assert.equal((await post(4)).status, 429);
  const sum = await (await fetch(base + "/v1/summary?domain=shop.example")).json();
  assert.equal(sum.outcomes.never, 3);
  srv.close();
});
test("buyer signals and feedback", () => {
  const sum = { total: 10, windowDays: 30, outcomes: { ok: 1, problem: 3, never: 6 }, tags: { fake_tracking: 5, delayed: 2 } };
  assert.equal(buyerSignals(sum)[0].status, "bad");
  assert.match(buyerSignals(sum)[0].label, /6 of 10 buyers say their order never arrived/);
  assert.equal(buyerFeedback(sum)[0].label, "order never arrived");
  assert.equal(buyerSignals({ total: 2, hidden: true })[0].status, "info");
  assert.equal(buyerSignals({ total: 8, outcomes: { ok: 7, problem: 1, never: 0 } })[0].status, "good");
});
