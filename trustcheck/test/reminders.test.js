import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createReminder, handleReminderAnswer, DAY } from "../lib/reminders.js";

test("reminder module is browser-compatible", () => {
  const source = fs.readFileSync(new URL("../lib/reminders.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:/);
});

test("creates reminder 14 days in the future without personal data", async () => {
  const t0 = 1700000000000;
  const rem = await createReminder({
    domain: "koadclo.com",
    amount: "£59.99",
    orderId: "ORD-998811",
    storefrontName: "KOAD'CLO",
    now: t0
  });

  assert.equal(rem.domain, "koadclo.com");
  assert.equal(rem.amount, "£59.99");
  assert.equal(rem.storefrontName, "KOAD'CLO");
  assert.equal(rem.receiverName, undefined);
  assert.equal(rem.createdAt, t0);
  assert.equal(rem.remindAt, t0 + 14 * DAY);
  assert.equal(rem.askCount, 0);
  assert.equal(rem.status, "pending");
  assert.ok(rem.orderIdHash);
  assert.notEqual(rem.orderIdHash, "ORD-998811"); // order ID is salted HMAC hash
});

test("not yet asks once more 7 days later, then dismisses on second not-yet", async () => {
  const t0 = 1700000000000;
  const rem = await createReminder({ domain: "shop.example", now: t0 });

  // First "not yet" at day 14
  const ans1 = handleReminderAnswer(rem, "not_yet", { now: t0 + 14 * DAY });
  assert.equal(ans1.report, null);
  assert.equal(ans1.updatedReminder.askCount, 1);
  assert.equal(ans1.updatedReminder.remindAt, t0 + 21 * DAY);
  assert.equal(ans1.updatedReminder.status, "pending");

  // Second "not yet" at day 21: dismisses without further asking
  const ans2 = handleReminderAnswer(ans1.updatedReminder, "not_yet", { now: t0 + 21 * DAY });
  assert.equal(ans2.report, null);
  assert.equal(ans2.updatedReminder.status, "dismissed");
});

test("no (did not arrive) emits report with outcome never", async () => {
  const t0 = 1700000000000;
  const rem = await createReminder({
    domain: "koadclo.com",
    orderId: "12345",
    storefrontName: "KOAD'CLO",
    now: t0
  });

  const { updatedReminder, report } = handleReminderAnswer(rem, "no", { now: t0 + 14 * DAY });
  assert.equal(updatedReminder.status, "answered");
  assert.equal(report.domain, "koadclo.com");
  assert.equal(report.outcome, "never");
  assert.equal(report.storefrontName, "KOAD'CLO");
  assert.equal(report.receiverName, undefined);
  assert.ok(report.orderDate);
  assert.ok(report.answerDate);
});

test("yes unmatched emits problem with tag not_as_described", async () => {
  const t0 = 1700000000000;
  const rem = await createReminder({ domain: "shoes.example", now: t0 });
  const { updatedReminder, report } = handleReminderAnswer(rem, "yes_unmatched", { now: t0 + 14 * DAY });
  assert.equal(updatedReminder.status, "answered");
  assert.equal(report.outcome, "problem");
  assert.deepEqual(report.tags, ["not_as_described"]);
});

test("yes matched emits ok", async () => {
  const t0 = 1700000000000;
  const rem = await createReminder({ domain: "shoes.example", now: t0 });
  const { updatedReminder, report } = handleReminderAnswer(rem, "yes_matched", { now: t0 + 14 * DAY });
  assert.equal(updatedReminder.status, "answered");
  assert.equal(report.outcome, "ok");
});
