import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ReportStore, ApiError } from "../server/store.js";
import { solvePowSync } from "../server/credentials.js";
import { makeStore, enrollFrom, report, ipN, DAY, HOUR, MIN } from "./helpers.js";

const code = (fn) => { try { fn(); return null; } catch (e) { assert.ok(e instanceof ApiError, String(e)); return e.status; } };
const SH = "shop.example";

// ---------------------------------------------------------------- enrolment
test("enrolment is rate-limited per network, and per hour overall", () => {
  const { store, c } = makeStore();
  for (let i = 0; i < 3; i++) enrollFrom(store, "203.0.113." + (10 + i));              // same /24
  assert.equal(code(() => enrollFrom(store, "203.0.113.99")), 429);
  assert.ok(enrollFrom(store, "203.0.114.1"));                                          // another network is fine
  c.tick(25 * HOUR); assert.ok(enrollFrom(store, "203.0.113.99"));                      // the window slides
  const busy = makeStore({ config: { limits: { enrollPerHour: 5 } } });
  for (let i = 0; i < 5; i++) enrollFrom(busy.store, ipN(i));
  assert.equal(code(() => enrollFrom(busy.store, ipN(99))), 429);
});
test("proof of work must be valid, fresh and single-use", () => {
  const { store, c } = makeStore(), { challenge, bits } = store.challenge(), solution = solvePowSync(challenge, bits);
  assert.equal(code(() => store.enroll({ ip: ipN(1), challenge, solution: "nope-" })), 400);
  assert.ok(store.enroll({ ip: ipN(1), challenge, solution }));
  assert.equal(code(() => store.enroll({ ip: ipN(2), challenge, solution })), 400);   // replay
  const old = store.challenge(); c.tick(6 * MIN);
  assert.equal(code(() => store.enroll({ ip: ipN(3), challenge: old.challenge, solution: solvePowSync(old.challenge, old.bits) })), 400);   // expired
  const cheap = { challenge: "1.2.0.xxxx", solution: "0" };
  assert.equal(code(() => store.enroll({ ip: ipN(4), ...cheap })), 400);
});
test("forged, tampered and unknown credentials are rejected", () => {
  const { store } = makeStore(), tok = enrollFrom(store, ipN(1));
  for (const bad of ["", "junk", tok + "x", tok.split(".")[0] + ".AAAA", undefined]) assert.equal(code(() => report(store, bad, ipN(1))), 401);
  const other = makeStore().store;                                                       // a token minted by a different secret
  assert.equal(code(() => report(store, enrollFrom(other, ipN(1)), ipN(1))), 401);
  assert.equal(report(store, tok, ipN(1)).ok, true);
});

// ------------------------------------------- acceptance 1: new client IDs cannot mint identities
test("ACCEPTANCE: generating new client IDs cannot create multiple accepted identities", () => {
  const { store, c } = makeStore();
  const got = [];
  for (let i = 0; i < 100; i++) { try { got.push(enrollFrom(store, "198.51.100." + (i % 250))); } catch { /* rejected */ } }   // an attacker looping from one network
  assert.equal(got.length, 3, "one network gets at most 3 identities per day");
  c.tick(8 * DAY);
  for (const t of got) report(store, t, "198.51.100.5");
  const s = store.summary(SH);
  assert.equal(s.hidden, true); assert.equal(s.effectiveN, undefined);                   // and they cannot move anything
  assert.equal(code(() => report(store, "fresh-random-id-12345", "198.51.100.5")), 401);   // inventing an ID is not an option any more
});

// --------------------------------------------- acceptance 2: one network cannot move a verdict
test("ACCEPTANCE: a single network cannot move a domain's summary with a report burst", () => {
  const { store, c } = makeStore();
  const toks = [0, 1, 2].map((i) => enrollFrom(store, "203.0.113." + i)); c.tick(8 * DAY);
  for (const t of toks) { report(store, t, "203.0.113.9"); c.tick(2 * HOUR); }
  assert.equal(store.summary(SH).hidden, true);
  const ev = store.evaluate(SH).filter((r) => r.status === "scored");
  assert.ok(ev.reduce((n, r) => n + r.w, 0) <= 1.0001, "one network contributes at most 1.0");
});
test("a larger shared network (corporate NAT) with a burst is quarantined, not scored", () => {
  const { store, c } = makeStore({ config: { limits: { enrollPerNetPerDay: 20 } } });
  const toks = Array.from({ length: 6 }, (_, i) => enrollFrom(store, "192.0.2." + i)); c.tick(8 * DAY);
  for (const t of toks) { report(store, t, "192.0.2.50"); c.tick(3 * HOUR); }
  assert.ok(store.evaluate(SH).filter((r) => r.status === "quarantined").length === 6);
  assert.equal(store.summary(SH).hidden, true);
});

// -------------------------------------------- acceptance 3: suspicious clusters excluded + available for moderation
test("ACCEPTANCE: a botnet of brand-new identities is excluded from scoring and queued for moderation", () => {
  const { store } = makeStore();
  const toks = Array.from({ length: 40 }, (_, i) => enrollFrom(store, ipN(i)));       // 40 networks, immediate reports
  toks.forEach((t, i) => report(store, t, ipN(i)));
  const s = store.summary(SH);
  assert.equal(s.hidden, true); assert.equal(s.total, 40);                              // received, but not shown or scored
  assert.equal(s.problemRate, undefined);
  const q = store.queue();
  assert.equal(q.length, 1); assert.equal(q[0].domain, SH); assert.equal(q[0].reports.length, 40);
  assert.ok(q[0].reports.every((r) => r.reasons.length >= 1 && r.identityAgeDays < 1));
  assert.ok(store.auditLog().some((e) => e.action === "quarantine" && e.actor === "system"));
});
test("a botnet that waits for its identities to mature is caught by the timing burst", () => {
  const { store, c } = makeStore();
  const toks = Array.from({ length: 40 }, (_, i) => enrollFrom(store, ipN(i))); c.tick(8 * DAY);
  toks.forEach((t, i) => { report(store, t, ipN(i)); c.tick(5_000); });                // 40 reports in ~3 minutes
  assert.equal(store.summary(SH).hidden, true);
  const q = store.queue()[0];
  assert.ok(q.reports.every((r) => r.reasons.includes("timing_burst")));
});
test("five brand-new identities posting an identical report are quarantined (below the velocity cap)", () => {
  const { store, c } = makeStore(), toks = Array.from({ length: 5 }, (_, i) => enrollFrom(store, ipN(i)));
  toks.forEach((t, i) => { report(store, t, ipN(i)); c.tick(3 * HOUR); });                // spaced out, so only the payload rule applies
  const ev = store.evaluate(SH);
  assert.equal(ev.length, 5);
  assert.ok(ev.every((r) => r.reasons.length === 1 && r.reasons[0] === "repeated_payload_new_identities"), JSON.stringify(ev.map((r) => r.reasons)));
});
test("a new-identity flood is also throttled per domain (velocity), whatever the payload", () => {
  const { store } = makeStore(), outcomes = ["ok", "problem", "never"];
  const toks = Array.from({ length: 12 }, (_, i) => enrollFrom(store, ipN(i)));
  toks.forEach((t, i) => report(store, t, ipN(i), { outcome: outcomes[i % 3], tags: [] }));
  const ev = store.evaluate(SH);
  assert.equal(ev.filter((r) => r.reasons.includes("velocity")).length, 12 - 5);        // only the first 5 young reports per day pass
});
test("identity weight is fixed at REPORT time: waiting does not launder an early report", () => {
  const { store, c } = makeStore();
  const toks = Array.from({ length: 6 }, (_, i) => enrollFrom(store, ipN(i)));
  toks.forEach((t, i) => { report(store, t, ipN(i)); c.tick(3 * HOUR); });             // reported as brand-new identities
  c.tick(10 * DAY);                                                                      // identities are now "old"
  assert.equal(store.evaluate(SH).filter((r) => r.status === "scored").reduce((n, r) => n + r.w, 0), 0);
});
test("KNOWN LIMITATION: a patient, diverse attacker (many networks, 15+ days of aging, spread out) is not detected", () => {
  // Pinned on purpose: if a rule starts catching this, update this test AND DEPLOY.md. Cost to the attacker: 40 proofs of work,
  // 40 separate /24 networks, 15 days, and the result is still smoothed, labelled unverified, and has zero effect on the score.
  const { store, c } = makeStore();
  const toks = Array.from({ length: 40 }, (_, i) => enrollFrom(store, ipN(i))); c.tick(15 * DAY);
  toks.forEach((t, i) => { report(store, t, ipN(i)); c.tick(3 * HOUR); });
  const s = store.summary(SH);
  assert.equal(s.hidden, false); assert.ok(s.clusters >= 30);
  assert.ok(s.problemRate.mean < 0.95, "smoothing keeps even 40/40 below certainty");
  assert.equal(s.verification, "unverified");
});
test("natural consensus from mature, separate, spread-out reporters is displayed", () => {
  const { store, c } = makeStore();
  const toks = Array.from({ length: 8 }, (_, i) => enrollFrom(store, ipN(i))); c.tick(10 * DAY);
  toks.forEach((t, i) => { report(store, t, ipN(i), { outcome: i < 6 ? "never" : "ok", tags: i < 6 ? ["fake_tracking"] : [] }); c.tick(6 * HOUR); });
  const s = store.summary(SH);
  assert.equal(s.hidden, false); assert.ok(s.effectiveN >= 5); assert.ok(s.clusters >= 4);
  assert.equal(s.outcomes.never, 6); assert.equal(s.tags.fake_tracking, 6);
  assert.ok(s.problemRate.low <= s.problemRate.mean && s.problemRate.mean <= s.problemRate.high);
});
test("display needs both enough effective weight and enough separate networks", () => {
  const { store, c } = makeStore();
  const toks = Array.from({ length: 4 }, (_, i) => enrollFrom(store, ipN(i))); c.tick(10 * DAY);
  toks.forEach((t, i) => { report(store, t, ipN(i)); c.tick(6 * HOUR); });
  assert.equal(store.summary(SH).hidden, true);                                           // 4 networks, effective 4 < 5
});

// ---------------------------------------------------------------- limits and corrections
test("per-credential and per-network report limits; corrections are capped", () => {
  const { store } = makeStore({ config: { limits: { reportsPerCredPerDay: 3, correctionsPerCredPerDomain: 2 } } });
  const tok = enrollFrom(store, ipN(1));
  for (let i = 0; i < 3; i++) report(store, tok, ipN(1), { domain: `s${i}.example` });
  assert.equal(code(() => report(store, tok, ipN(1), { domain: "s9.example" })), 429);
  const b = makeStore({ config: { limits: { correctionsPerCredPerDomain: 2 } } }).store, t2 = enrollFrom(b, ipN(1));
  report(b, t2, ipN(1)); report(b, t2, ipN(1), { outcome: "ok" }); report(b, t2, ipN(1), { outcome: "problem" });
  assert.equal(code(() => report(b, t2, ipN(1), { outcome: "never" })), 429);
  assert.equal(b.evaluate(SH).length, 1);                                                  // one report per identity per domain
  const n = makeStore({ config: { limits: { reportsPerNetPerHour: 2, enrollPerNetPerDay: 9 } } }).store;
  const toks = [1, 2, 3].map((i) => enrollFrom(n, "192.0.2." + i));
  report(n, toks[0], "192.0.2.9"); report(n, toks[1], "192.0.2.9");
  assert.equal(code(() => report(n, toks[2], "192.0.2.9")), 429);
});
test("input validation", () => {
  const { store } = makeStore(), t = enrollFrom(store, ipN(1));
  for (const bad of [{ domain: "a b" }, { domain: "1.2.3.4" }, { outcome: "scam" }, { tags: ["<script>"] }, { tags: "x" }, { proof: 5 }])
    assert.equal(code(() => report(store, t, ipN(1), bad)), 400, JSON.stringify(bad));
});

// ---------------------------------------------------------------- verified vs reported
test("reported experiences and verified purchases are kept apart; no verifier means nothing is verified", () => {
  const plain = makeStore().store, tp = enrollFrom(plain, ipN(1));
  report(plain, tp, ipN(1), { proof: "RECEIPT-OK" });
  assert.equal(plain.evaluate(SH)[0].evidence, "reported");                                // a proof is never trusted without a verifier
  const { store, c } = makeStore({ verifyPurchase: (proof) => proof === "RECEIPT-OK" });
  const toks = Array.from({ length: 6 }, (_, i) => enrollFrom(store, ipN(i))); c.tick(10 * DAY);
  toks.forEach((t, i) => { report(store, t, ipN(i), { proof: i === 0 ? "RECEIPT-OK" : undefined }); c.tick(6 * HOUR); });
  const s = store.summary(SH);
  assert.equal(s.verified, 1); assert.equal(s.reported, 5);
  assert.ok(s.effectiveN > 6);                                                              // the verified report carries extra weight
});

// ---------------------------------------------------------------- moderation + audit
function quarantined() {
  const ctx = makeStore(), toks = Array.from({ length: 8 }, (_, i) => enrollFrom(ctx.store, ipN(i)));
  toks.forEach((t, i) => report(ctx.store, t, ipN(i)));
  return { ...ctx, toks };
}
test("moderators can approve, reject, restore; every action is audited", () => {
  const { store } = quarantined(), q = store.queue()[0], ids = q.reports.map((r) => r.id);
  assert.equal(store.evaluate(SH).filter((r) => r.status === "scored").length, 0);
  store.moderate(ids.slice(0, 2), "approve");
  assert.equal(store.evaluate(SH).filter((r) => r.status === "scored").length, 2);         // approved reports bypass the auto rules
  store.moderate(ids.slice(0, 1), "reject");
  assert.equal(store.evaluate(SH).filter((r) => r.status === "rejected").length, 1);
  store.moderate(ids.slice(0, 1), "restore");
  assert.equal(store.evaluate(SH).filter((r) => r.status === "rejected").length, 0);
  assert.equal(code(() => store.moderate(ids, "delete-everything")), 400);
  assert.equal(code(() => store.moderate(["nope"], "approve")), 404);
  const log = store.auditLog().filter((e) => e.actor === "moderator");
  assert.deepEqual(log.map((e) => e.action), ["approve", "reject", "restore"]);
  assert.equal(store.verifyAudit().ok, true);
});
test("revoking a credential removes its influence and blocks further reports", () => {
  const { store, c } = makeStore();
  const toks = Array.from({ length: 7 }, (_, i) => enrollFrom(store, ipN(i))); c.tick(10 * DAY);
  toks.forEach((t, i) => { report(store, t, ipN(i)); c.tick(6 * HOUR); });
  const before = store.summary(SH);
  assert.equal(before.hidden, false);
  const id = [...store.credentials.keys()][0]; store.revokeCredential(id);
  assert.equal(store.evaluate(SH).filter((r) => r.status === "rejected").length, 1);
  const after = store.summary(SH);
  assert.ok(after.hidden || after.effectiveN < before.effectiveN);
  assert.equal(code(() => report(store, toks[0], ipN(0), { domain: "other.example" })), 401);   // the revoked identity can no longer report
  assert.ok(store.auditLog().some((e) => e.action === "revoke_credential"));
  assert.equal(code(() => store.revokeCredential("ffffffffffffffffffffffff")), 404);
});

// ---------------------------------------------------------------- deletion and erasure
test("a reporter can delete their own report, and erase their identity entirely", () => {
  const { store } = makeStore(), t1 = enrollFrom(store, ipN(1)), t2 = enrollFrom(store, ipN(2));
  const credId = JSON.parse(Buffer.from(t1.split(".")[0], "base64url").toString()).c;
  report(store, t1, ipN(1)); report(store, t1, ipN(1), { domain: "b.example" }); report(store, t2, ipN(2));
  store.deleteReport(t1, "b.example");
  assert.equal(store.reports.length, 2);
  assert.equal(code(() => store.deleteReport(t1, "b.example")), 404);
  assert.equal(store.eraseCredential(t1).removed, 1);
  assert.equal(store.reports.length, 1); assert.equal(store.reports[0].cred !== undefined, true);
  assert.equal(code(() => report(store, t1, ipN(1))), 401);                                   // the identity is gone
  assert.ok(!JSON.stringify(store.auditLog()).includes(credId), "the audit log never contains a raw credential id");
  assert.ok(!JSON.stringify(store.reports).includes(credId) && !store.credentials.has(credId));
  assert.ok(store.auditLog().some((e) => e.action === "erase_credential"));
  assert.equal(store.verifyAudit().ok, true);
});

// ---------------------------------------------------------------- disputes
test("merchant disputes: ownership must be proven before a dispute is shown publicly", async () => {
  const files = {};
  const { store, c } = makeStore({ fetchText: async (url) => { if (!(url in files)) throw new Error("404"); return files[url]; } });
  const toks = Array.from({ length: 7 }, (_, i) => enrollFrom(store, ipN(i))); c.tick(10 * DAY);
  toks.forEach((t, i) => { report(store, t, ipN(i)); c.tick(6 * HOUR); });
  assert.equal(store.summary(SH).disputed, false);
  assert.equal(code(() => store.openDispute({ domain: SH, message: "short" })), 400);
  const d = store.openDispute({ domain: SH, message: "These reports are about a different shop with a similar name." });
  assert.match(d.instructions, /\.well-known\/trustcheck-dispute\.txt/);
  assert.equal(store.summary(SH).disputed, false);                                             // an unverified claim changes nothing public
  await assert.rejects(store.verifyDispute(d.id), (e) => e.status === 502);                    // file missing
  files[`https://${SH}/.well-known/trustcheck-dispute.txt`] = "wrong-token";
  await assert.rejects(store.verifyDispute(d.id), (e) => e.status === 400);
  files[`https://${SH}/.well-known/trustcheck-dispute.txt`] = d.token + "\n";
  assert.equal((await store.verifyDispute(d.id)).ok, true);
  assert.equal(store.summary(SH).disputed, true);                                              // now visible, alongside the reports
  assert.ok(!JSON.stringify(store.listDisputes()).includes(d.token));                           // the proof token is never listed
  store.resolveDispute(d.id, "Reviewed: reports concern a different business; 3 rejected.");
  assert.equal(store.summary(SH).disputed, false);
  assert.deepEqual(store.auditLog().map((e) => e.action).filter((a) => a.startsWith("dispute")), ["dispute_opened", "dispute_verified", "dispute_resolved"]);
  await assert.rejects(makeStore().store.verifyDispute("nope"), (e) => e.status === 404);
  const noFetch = makeStore().store, nd = noFetch.openDispute({ domain: SH, message: "A long enough description." });
  await assert.rejects(noFetch.verifyDispute(nd.id), (e) => e.status === 501);
});
test("disputes are rate-limited per domain", () => {
  const { store } = makeStore();
  for (let i = 0; i < 5; i++) store.openDispute({ domain: SH, message: "A long enough description " + i });
  assert.equal(code(() => store.openDispute({ domain: SH, message: "Yet another dispute text" })), 429);
});

// ---------------------------------------------------------------- audit + persistence
test("tampering with the stored audit log is detected", () => {
  const { store } = quarantined();
  store.moderate(store.queue()[0].reports.slice(0, 1).map((r) => r.id), "reject");
  assert.equal(store.verifyAudit().ok, true);
  store.audit[0].detail = "edited"; assert.equal(store.verifyAudit().ok, false);
});
test("persistence: round trip, atomic file, and no IP addresses or secrets on disk", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tc-")), "data.json");
  const a = makeStore({ file }), toks = Array.from({ length: 3 }, (_, i) => enrollFrom(a.store, "198.51.100." + i));
  toks.forEach((t, i) => report(a.store, t, "198.51.100." + i));
  a.store.moderate([a.store.reports[0].id], "reject"); a.store.flush();
  const raw = fs.readFileSync(file, "utf8");
  assert.ok(!raw.includes("198.51.100") && !raw.includes("secret") && !toks.some((t) => raw.includes(t)), "no raw IPs, secrets or tokens");
  assert.ok(!fs.existsSync(file + ".tmp"));
  const b = new ReportStore({ file, now: a.c.now, salt: "salt", secret: "secret", config: { powBits: 6 } });
  assert.equal(b.reports.length, 3); assert.equal(b.credentials.size, 3); assert.equal(b.verifyAudit().ok, true);
  assert.equal(b.reports.find((r) => r.mod === "rejected") !== undefined, true);
  assert.ok(b.submit({ token: toks[1], ip: "198.51.100.1", domain: SH, outcome: "ok" }).ok);          // credentials survive a restart
});
test("a pre-credential data file is backed up, not misread", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tc-")), "data.json");
  fs.writeFileSync(file, JSON.stringify([{ domain: "x.example", install: "abc", outcome: "never", tags: [], at: 1 }]));
  const s = new ReportStore({ file, config: { powBits: 6 } });
  assert.equal(s.reports.length, 0); assert.ok(fs.existsSync(file + ".v1.bak"));
});
test("old reports are pruned by retention", () => {
  const { store, c } = makeStore(), t = enrollFrom(store, ipN(1));
  report(store, t, ipN(1)); c.tick(91 * DAY); store.prune();
  assert.equal(store.reports.length, 0);
});
