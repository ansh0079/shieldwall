// requires: node:sqlite
import test from "node:test";
import assert from "node:assert/strict";
import { buildReport } from "../lib/score.js";
import { signalsFromTrustpilotReviews } from "../lib/providers.js";
import { createReminder, handleReminderAnswer, DAY } from "../lib/reminders.js";
import { createServer } from "../server/server.js";
import { ReportStore } from "../server/store.js";

test("Step 1: poor Trustpilot rating becomes a bad signal and triggers the checkout warning condition", () => {
  const reviews = {
    source: "Trustpilot",
    score: 2.0,
    count: 78,
    sample: 78,
    themes: [
      { id: "non_delivery", label: "orders that never arrived", count: 42 },
      { id: "refund", label: "extra charge / refund refused", count: 18 }
    ],
    url: "https://www.trustpilot.com/review/koadclo.com"
  };
  const { signals } = signalsFromTrustpilotReviews(reviews);
  const report = buildReport({
    url: "https://koadclo.com/checkout",
    domain: "koadclo.com",
    signals,
    reviews,
    links: [{ name: "Trustpilot", url: reviews.url }]
  });
  const tpSig = report.signals.find((s) => s.id === "tp");
  assert.ok(tpSig, "Should contain tp signal");
  assert.equal(tpSig.status, "bad");
  assert.match(tpSig.label, /Trustpilot 2\.0\/5/);
  const hasPoorTrustpilot = report.reviews && report.reviews.score < 3.0 && report.reviews.count >= 5;
  assert.ok(hasPoorTrustpilot, "Must satisfy poor Trustpilot trigger condition");
  assert.equal(report.reviews.url, "https://www.trustpilot.com/review/koadclo.com");
});

test("Step 2: 14-day reminder 'no' answer produces a never-arrived report payload", async () => {
  const t0 = 1700000000000;
  const rem = await createReminder({ domain: "koadclo.com", amount: "£59.99", orderId: "ORD-001", storefrontName: "KOAD'CLO", now: t0 });
  assert.equal(rem.remindAt, t0 + 14 * DAY);
  const ans = handleReminderAnswer(rem, "no", { now: t0 + 14 * DAY });
  assert.equal(ans.updatedReminder.status, "answered");
  assert.equal(ans.report.outcome, "never");
  assert.deepEqual(ans.report.tags, ["delayed"]);
  assert.equal(ans.report.domain, "koadclo.com");
  assert.ok(ans.report.purchaseId);
});

test("Step 2: 'not yet' is asked once more, then dismissed, and never submits a report", async () => {
  const t0 = 1700000000000;
  const rem = await createReminder({ domain: "shop.example", now: t0 });
  const first = handleReminderAnswer(rem, "not_yet", { now: t0 + 14 * DAY });
  assert.equal(first.updatedReminder.status, "pending");
  assert.equal(first.updatedReminder.askCount, 1);
  assert.equal(first.report, null);
  const second = handleReminderAnswer(first.updatedReminder, "not_yet", { now: t0 + 21 * DAY });
  assert.equal(second.updatedReminder.status, "dismissed");
  assert.equal(second.report, null);
});

test("GET /v1/check returns a buyer summary and a Trustpilot link without outbound keys", async (t) => {
  const store = new ReportStore({ file: ":memory:", salt: "test-salt-for-check-endpoint-32", secret: "test-secret-for-check-endpoint-32" });
  const srv = createServer(store, { rateLimit: 50, readLimit: 300 });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => srv.close(r)));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const res = await fetch(`${base}/v1/check?domain=koadclo.com`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.domain, "koadclo.com");
  assert.ok(body.summary);
  assert.equal(body.summary.domain, "koadclo.com");
  assert.equal(body.reviews.source, "Trustpilot");
  assert.match(body.reviews.url, /koadclo\.com/);
  assert.equal(body.safeBrowsing, null);
  assert.equal(body.company, null);
  const bad = await fetch(`${base}/v1/check?domain=`);
  assert.equal(bad.status, 400);
});
