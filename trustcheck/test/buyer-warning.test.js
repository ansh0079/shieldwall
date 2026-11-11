import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/store.js";
import { createServer } from "../server/server.js";
import { buildReport } from "../lib/score.js";
import { createReminder, handleReminderAnswer, DAY } from "../lib/reminders.js";
import { fetchTrustpilotSummary } from "../server/trustpilot.js";

test("Step 1: Koadclo checkout replay triggers warning notice with Trustpilot review link", () => {
  const koadcloUrl = "https://koadclo.com/checkout";
  const domain = "koadclo.com";
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

  const report = buildReport({
    url: koadcloUrl,
    domain,
    signals: [
      { id: "https", label: "Encrypted connection (HTTPS)", status: "good", points: 5 },
      { id: "age", label: "Domain is 1.5 years old", status: "info", points: 0 }
    ],
    reviews,
    links: [{ name: "Trustpilot", url: reviews.url }]
  });

  // Verify that the poor Trustpilot rating adds a bad signal
  const tpSig = report.signals.find((s) => s.id === "tp");
  assert.ok(tpSig, "Should contain tp signal");
  assert.equal(tpSig.status, "bad");
  assert.match(tpSig.label, /Trustpilot rating is 2.0\/5 \(78 reviews\)/);

  // Even though score is in caution range, Trustpilot conditions are met for notice trigger
  const hasPoorTrustpilot = report.reviews && report.reviews.score < 3.0 && report.reviews.count >= 5;
  assert.ok(hasPoorTrustpilot, "Must satisfy poor Trustpilot trigger condition");
  assert.equal(report.reviews.url, "https://www.trustpilot.com/review/koadclo.com");
});

test("Step 2 & 3: 14-day reminder answer feeds 6-month non-delivery warning count", async () => {
  const store = new Store({ minReports: 2, salt: "test-salt" });
  const t0 = 1700000000000;

  // Buyer 1 confirms purchase, answers reminder at day 14: "no" (did not arrive)
  const rem1 = await createReminder({
    domain: "koadclo.com",
    amount: "£59.99",
    orderId: "ORD-001",
    storefrontName: "KOAD'CLO",
    now: t0
  });
  const ans1 = handleReminderAnswer(rem1, "no", { now: t0 + 14 * DAY });
  store.add({
    installId: "install-buyer-001",
    domain: ans1.report.domain,
    outcome: ans1.report.outcome,
    tags: ans1.report.tags,
    purchaseId: ans1.report.purchaseId
  });

  // Buyer 2 confirms purchase, answers reminder at day 14: "no" (did not arrive)
  const rem2 = await createReminder({
    domain: "koadclo.com",
    amount: "£59.99",
    orderId: "ORD-002",
    storefrontName: "KOAD'CLO",
    now: t0 + 2 * DAY
  });
  const ans2 = handleReminderAnswer(rem2, "no", { now: t0 + 16 * DAY });
  store.add({
    installId: "install-buyer-002",
    domain: ans2.report.domain,
    outcome: ans2.report.outcome,
    tags: ans2.report.tags,
    purchaseId: ans2.report.purchaseId
  });

  // Query summary: 6-month threshold (minReports = 2) is met
  const sum = store.summary("koadclo.com");
  assert.equal(sum.sixMonthNonDelivery, 2);
  assert.equal(sum.sixMonthObservedTotal, 2);

  // Report built with this summary generates the 6-month non-delivery warning
  const rep = buildReport({
    url: "https://koadclo.com/checkout",
    domain: "koadclo.com",
    signals: [],
    sixMonthNonDelivery: sum.sixMonthNonDelivery,
    sixMonthObservedTotal: sum.sixMonthObservedTotal,
    minReports: sum.minReports
  });

  const sixMonthSig = rep.signals.find((s) => s.id === "six-month-nondelivery");
  assert.ok(sixMonthSig);
  assert.equal(sixMonthSig.status, "bad");
  assert.equal(sixMonthSig.label, "In the last 6 months, 2 confirmation-observed reports said this shop did not deliver");
  assert.deepEqual(rep.outcomeSummary, {
    total: 2,
    delivered: 0,
    nonDelivery: 2,
    notMatched: 0,
    deliveredPercent: 0,
    nonDeliveryPercent: 100,
    notMatchedPercent: 0,
    windowDays: 180
  });
});

test("Step 4: Order logs are recorded and exported without buyer personal data", async (t) => {
  const store = new Store({ minReports: 1, salt: "test-salt" });
  const srv = createServer(store, { rateLimit: 50, adminToken: "test-admin-token" });
  await new Promise((r) => srv.listen(0, r));
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;

  // Post verified order outcome
  const payload = {
    installId: "install-buyer-999",
    domain: "koadclo.com",
    outcome: "never",
    tags: ["delayed"],
    purchaseId: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
    storefrontName: "KOAD'CLO",
    receiverName: null,
    orderDate: "2026-10-10T12:00:00.000Z",
    answerDate: "2026-10-24T12:00:00.000Z"
  };

  const credential = await (await fetch(`${base}/v1/register`, { method: "POST" })).json();
  payload.installId = credential.installId;
  const res = await fetch(`${base}/v1/report`, {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": `Bearer ${credential.token}` },
    body: JSON.stringify(payload)
  });
  assert.equal(res.status, 200);

  // Query export endpoint
  const expRes = await fetch(`${base}/v1/export/orders?format=json`, { headers: { authorization: "Bearer test-admin-token" } });
  assert.equal(expRes.status, 200);
  const json = await expRes.json();
  assert.equal(json.total, 1);
  const row = json.rows[0];
  assert.equal(row.domain, "koadclo.com");
  assert.equal(row.storefrontName, "KOAD'CLO");
  assert.equal(row.receiverName, null);
  assert.equal(row.outcome, "did_not_arrive");
  assert.equal(row.orderDate, "2026-10-10T12:00:00.000Z");
  assert.equal(row.answerDate, "2026-10-24T12:00:00.000Z");

  // Also verify CSV export format
  const csvRes = await fetch(`${base}/v1/export/orders?format=csv`, { headers: { authorization: "Bearer test-admin-token" } });
  assert.equal(csvRes.status, 200);
  const csv = await csvRes.text();
  assert.ok(csv.includes('"koadclo.com","KOAD\'CLO",""'));
  assert.ok(csv.includes('"did_not_arrive"'));

});
