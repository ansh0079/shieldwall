import test from "node:test";
import assert from "node:assert/strict";
import "../lib/notice.js";

const { shouldAutoOpenNotice } = globalThis;

const report = (verdict, extra = {}) => ({ verdict, signals: [], ...extra });

test("lower-risk shops do not auto-open the on-page notice", () => {
  assert.equal(shouldAutoOpenNotice(report("lower")), false);
  assert.equal(shouldAutoOpenNotice(report("lower", { ui: { mode: "auto" } })), false);
});

test("high-risk and dangerous shops auto-open", () => {
  assert.equal(shouldAutoOpenNotice(report("risky")), true);
  assert.equal(shouldAutoOpenNotice(report("dangerous")), true);
});

test("caution (low-trust) auto-opens", () => {
  assert.equal(shouldAutoOpenNotice(report("caution")), true);
});

test("limited evidence auto-opens only with red flags", () => {
  assert.equal(shouldAutoOpenNotice(report("limited")), false);
  assert.equal(shouldAutoOpenNotice(report("limited", { signals: [{ status: "info", label: "new" }] })), false);
  assert.equal(shouldAutoOpenNotice(report("limited", { signals: [{ status: "bad", label: "flagged" }] })), true);
  assert.equal(shouldAutoOpenNotice(report("limited", { reviews: { score: 2.0, count: 78 } })), true);
  assert.equal(shouldAutoOpenNotice(report("limited", { reviews: { score: 2.0, count: 2 } })), false);
  assert.equal(shouldAutoOpenNotice(report("limited", { buyerOutcomes: { never: 3 } })), true);
});

test("quiet and off modes never auto-open, even on a dangerous verdict", () => {
  assert.equal(shouldAutoOpenNotice(report("dangerous", { ui: { mode: "quiet" } })), false);
  assert.equal(shouldAutoOpenNotice(report("risky", { ui: { mode: "off" } })), false);
  assert.equal(shouldAutoOpenNotice(null), false);
});
