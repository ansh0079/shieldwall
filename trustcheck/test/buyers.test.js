// requires: node:sqlite
import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { buyerSignals, buyerFeedback, enroll, submitReport } from "../lib/buyers.js";
import { buildReport } from "../lib/score.js";
import { validateBuyerSummary } from "../lib/validate.js";
import { createServer, shutdown } from "../server/server.js";
import { withFetch, json } from "./helpers.js";
import { makeStore } from "./server-helpers.js";

test("buyer reports are unverified context with zero score impact", () => {
  const sum = { total: 10, windowDays: 30, outcomes: { ok: 1, problem: 3, never: 6 }, tags: { fake_tracking: 5, delayed: 2 } };
  const sig = buyerSignals(sum)[0];
  assert.equal(sig.points, 0); assert.equal(sig.status, "info"); assert.equal(sig.verification, "unverified");
  assert.match(sig.label, /6 of 10 unverified reports say the order never arrived/);
  assert.match(sig.detail, /do not change the score/);
  assert.equal(buyerFeedback(sum)[0].label, "order never arrived");
  assert.equal(buyerSignals({ total: 2, hidden: true })[0].points, 0);
  const great = buyerSignals({ total: 8, windowDays: 30, outcomes: { ok: 7, problem: 1, never: 0 } })[0];
  assert.equal(great.points, 0); assert.match(great.label, /unverified/);
});
test("a burst of fabricated reports cannot move the score or the verdict", () => {
  const sums = [{ total: 3, hidden: false, windowDays: 30, outcomes: { ok: 0, problem: 0, never: 3 }, tags: {} }, { total: 3, hidden: false, windowDays: 30, outcomes: { ok: 3, problem: 0, never: 0 }, tags: {} }];
  const base = [{ id: "https", label: "h", status: "good", points: 5 }, { id: "age", label: "a", status: "good", points: 20 }];
  const plain = buildReport({ url: "https://s.example", domain: "s.example", signals: base, links: [] });
  for (const sum of sums) {
    const r = buildReport({ url: "https://s.example", domain: "s.example", signals: [...base, ...buyerSignals(sum)], links: [] });
    assert.equal(r.score, plain.score); assert.equal(r.verdict, plain.verdict);
  }
});
test("summary details: separate networks, smoothed rate and merchant dispute are shown, still unverified", () => {
  const sum = validateBuyerSummary({ domain: "a.com", total: 12, windowDays: 30, outcomes: { ok: 2, problem: 3, never: 7 }, tags: {}, effectiveN: 8.4, clusters: 7,
    reported: 12, verified: 0, disputed: true, problemRate: { mean: 0.5, low: 0.3, high: 0.7 } });
  const s = buyerSignals(sum)[0];
  assert.match(s.detail, /from 7 separate networks/); assert.match(s.detail, /smoothed problem rate 50% \(range 30-70%\)/); assert.match(s.detail, /merchant has disputed/);
  assert.equal(s.points, 0);
});
test("summary validation rejects inconsistent server payloads", () => {
  const ok = { domain: "a.com", total: 5, outcomes: { ok: 1, problem: 1, never: 3 }, tags: {} };
  for (const bad of [{ problemRate: { mean: 0.9, low: 0.1, high: 0.5 } }, { problemRate: { mean: 2, low: 0, high: 3 } }, { effectiveN: -1 }, { clusters: 1.5 }, { reported: "x" }])
    assert.throws(() => validateBuyerSummary({ ...ok, ...bad }), /unexpected/);
});
test("client enrolment solves the server's challenge and refuses a hostile difficulty", async () => {
  const { store } = makeStore(), srv = createServer(store, { keepAlive: false, rateLimit: 1000 });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${srv.address().port}`;
    const token = await enroll(base);
    assert.equal((await submitReport(base, token, "shop.example", "never", ["fake_tracking"])).ok, true);
    await assert.rejects(submitReport(base, "forged", "shop.example", "ok", []), (e) => e.status === 401);
  } finally { await shutdown(srv); store.close(); }
  await withFetch(async () => json({ challenge: "x.y.99.z", bits: 99 }), async () => await assert.rejects(enroll("https://reports.example"), /unreasonable/));
  await withFetch(async () => json({ nonsense: true }), async () => await assert.rejects(enroll("https://reports.example"), /unexpected challenge/));
});
