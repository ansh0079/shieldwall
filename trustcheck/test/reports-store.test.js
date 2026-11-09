// requires: node:sqlite
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ReportStore, ApiError } from "../server/store.js";
import { solvePowSync } from "../server/credentials.js";
import { DAY, HOUR, MIN } from "./helpers.js";
import { makeStore, enrollFrom, report, ipN, nCreds, nReports, credIds, credOf } from "./server-helpers.js";

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
  const q = store.queue().items;
  assert.equal(q.length, 1); assert.equal(q[0].domain, SH); assert.equal(q[0].reports.length, 40);
  assert.ok(q[0].reports.every((r) => r.reasons.length >= 1 && r.identityAgeDays < 1));
  assert.ok(store.auditLog().some((e) => e.action === "quarantine" && e.actor === "system"));
});
test("a botnet that waits for its identities to mature is caught by the timing burst", () => {
  const { store, c } = makeStore();
  const toks = Array.from({ length: 40 }, (_, i) => enrollFrom(store, ipN(i))); c.tick(8 * DAY);
  toks.forEach((t, i) => { report(store, t, ipN(i)); c.tick(5_000); });                // 40 reports in ~3 minutes
  assert.equal(store.summary(SH).hidden, true);
  const q = store.queue().items[0];
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
  const { store } = quarantined(), q = store.queue().items[0], ids = q.reports.map((r) => r.id);
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
  store.revokeCredential(credOf(toks[0]));
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
  const credId = credOf(t1);
  report(store, t1, ipN(1)); report(store, t1, ipN(1), { domain: "b.example" }); report(store, t2, ipN(2));
  store.deleteReport(t1, "b.example");
  assert.equal(nReports(store), 2);
  assert.equal(code(() => store.deleteReport(t1, "b.example")), 404);
  assert.equal(store.eraseCredential(t1).removed, 1);
  assert.equal(nReports(store), 1);
  assert.equal(code(() => report(store, t1, ipN(1))), 401);                                   // the identity is gone
  assert.ok(!JSON.stringify(store.auditLog()).includes(credId), "the audit log never contains a raw credential id");
  assert.ok(!credIds(store).includes(credId) && store.db.get("SELECT COUNT(*) AS n FROM reports WHERE cred = ?", credId).n === 0);
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
test("the audit log is append-only in the database, and tampering that bypasses it is still detected", () => {
  const { store } = quarantined();
  store.moderate(store.queue().items[0].reports.slice(0, 1).map((r) => r.id), "reject");
  assert.equal(store.verifyAudit().ok, true);
  assert.throws(() => store.db.run("UPDATE audit SET detail = 'edited' WHERE seq = 1"), /append-only/);
  assert.throws(() => store.db.run("DELETE FROM audit WHERE seq = 1"), /append-only/);
  store.db.exec("DROP TRIGGER audit_no_update");                                              // an attacker with file access removes the guard...
  store.db.run("UPDATE audit SET detail = 'edited' WHERE seq = 1");
  assert.equal(store.verifyAudit().ok, false); assert.equal(store.verifyAudit().brokenAt, 1);  // ...and the hash chain still exposes the edit
});
test("persistence: data survives close/reopen, credentials keep working, and no IP addresses, secrets or tokens are on disk", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-")), file = path.join(dir, "data.db");
  const a = makeStore({ file }), toks = Array.from({ length: 3 }, (_, i) => enrollFrom(a.store, "198.51.100." + i));
  toks.forEach((t, i) => report(a.store, t, "198.51.100." + i));
  a.store.moderate([a.store.db.get("SELECT id FROM reports LIMIT 1").id], "reject"); a.store.close();
  const raw = fs.readFileSync(file).toString("latin1") + (fs.existsSync(file + "-wal") ? fs.readFileSync(file + "-wal").toString("latin1") : "");
  assert.ok(!raw.includes("198.51.100") && !raw.includes("secret") && !toks.some((t) => raw.includes(t)), "no raw IPs, secrets or tokens");
  const b = new ReportStore({ file, now: a.c.now, salt: "salt", secret: "secret", config: { powBits: 6 } });
  assert.equal(nReports(b), 3); assert.equal(nCreds(b), 3); assert.equal(b.verifyAudit().ok, true);
  assert.equal(b.db.get("SELECT COUNT(*) AS n FROM reports WHERE mod = 'rejected'").n, 1);
  assert.ok(b.submit({ token: toks[1], ip: "198.51.100.1", domain: SH, outcome: "ok" }).ok);          // credentials survive a restart
  b.close();
});
test("rate limits and replay protection survive a restart (they live in the database)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-")), file = path.join(dir, "data.db");
  const a = makeStore({ file, config: { limits: { reportsPerCredPerDay: 2 } } }), tok = enrollFrom(a.store, ipN(1));
  const { challenge, bits } = a.store.challenge(), solution = solvePowSync(challenge, bits);
  a.store.enroll({ ip: ipN(2), challenge, solution });
  report(a.store, tok, ipN(1)); report(a.store, tok, ipN(1), { domain: "b.example" }); a.store.close();
  const b = new ReportStore({ file, now: a.c.now, salt: "salt", secret: "secret", config: { powBits: 6, limits: { reportsPerCredPerDay: 2 } } });
  assert.equal(code(() => report(b, tok, ipN(1), { domain: "c.example" })), 429);                 // the daily budget was remembered
  assert.equal(code(() => b.enroll({ ip: ipN(3), challenge, solution })), 400);                    // the used challenge was remembered
  b.close();
});
test("old reports are pruned by retention, with expired helper rows and idle credentials", () => {
  const { store, c } = makeStore(), t = enrollFrom(store, ipN(1));
  report(store, t, ipN(1)); enrollFrom(store, ipN(2));                                               // second identity never reports
  c.tick(91 * DAY); const out = store.purge();
  assert.equal(nReports(store), 0); assert.ok(out.reports === 1 && out.credentials >= 1 && out.challenges >= 2);
  assert.ok(store.auditLog().some((e) => e.action === "retention_purge" && e.actor === "system"));
});
test("appeals: one review of a resolved dispute, by the merchant only, and the second decision is final", async () => {
  const { store } = makeStore(), d = store.openDispute({ domain: SH, message: "These reports concern another business." });
  assert.equal(code(() => store.appealDispute(d.id, d.token, "I want this reviewed again please.")), 409);   // not resolved yet
  store.resolveDispute(d.id, "Reports stand.", "alice");
  assert.equal(code(() => store.appealDispute(d.id, "wrong-token", "I want this reviewed again please.")), 403);
  assert.equal(code(() => store.appealDispute(d.id, d.token, "short")), 400);
  assert.equal(store.appealDispute(d.id, d.token, "The reports are about a competitor with a similar name.").ok, true);
  assert.equal(code(() => store.appealDispute(d.id, d.token, "Appealing a second time, please.")), 409);
  assert.equal(store.disputeStatus(d.id, d.token).status, "appealed");
  assert.equal(code(() => store.disputeStatus(d.id, "wrong")), 403);
  assert.equal(store.resolveDispute(d.id, "Reviewed by bob: upheld.", "bob").status, "closed");
  assert.equal(code(() => store.resolveDispute(d.id, "again")), 409); assert.equal(code(() => store.appealDispute(d.id, d.token, "Appealing a third time here.")), 409);
  assert.deepEqual(store.auditLog().filter((e) => e.action.startsWith("dispute")).map((e) => `${e.actor}:${e.action}`),
    ["merchant:dispute_opened", "alice:dispute_resolved", "merchant:dispute_appealed", "bob:dispute_closed"]);   // who decided what is on the record
});

// ---------------- performance guards found by self-testing ----------------
function bulk(store, domain, n, { burst = false, at0 } = {}) {
  store.db.tx(() => {
    for (let i = 0; i < n; i++) {
      const cid = `${domain}-${i}`.replace(/[^a-z0-9-]/g, "").padEnd(24, "0").slice(0, 24) + "", id = (i.toString(16).padStart(8, "0") + (domain.length.toString(16).padStart(8, "0"))).slice(0, 16);
      const unique = (Math.abs([...domain].reduce((a, c) => a * 31 + c.charCodeAt(0), 7)) % 100000).toString(16).padStart(5, "0") + i.toString(16).padStart(19, "0");
      store.db.run("INSERT OR IGNORE INTO credentials (id, created_at, net, revoked) VALUES (?, ?, ?, 0)", unique.slice(0, 24), at0 - 30 * DAY, "n" + (i % 3000));
      store.db.run("INSERT INTO reports (id, domain, cred, net, outcome, tags, at, id_age_ms, evidence, fixed, edits) VALUES (?, ?, ?, ?, 'never', '[]', ?, ?, 'reported', '[]', 0)",
        id + (Math.abs([...domain].reduce((a, c) => a * 17 + c.charCodeAt(0), 3)) % 256).toString(16).padStart(2, "0").slice(0, 0) + "", domain, unique.slice(0, 24), "n" + (i % 3000), burst ? at0 + (i % 600) * 1000 : at0 + i * 40_000, 20 * DAY);
      void cid;
    }
  });
}
test("a domain under a 5,000-report burst is still summarised quickly (it used to take over a second and freeze the server)", () => {
  const { store, c } = makeStore(), t0 = c.now(); bulk(store, "hot.example", 5000, { burst: true, at0: t0 - DAY });
  const s0 = performance.now(), sum = store.summary("hot.example"), ms = performance.now() - s0;
  assert.ok(ms < 800, `summary took ${Math.round(ms)} ms`); assert.equal(sum.hidden, true);
});
test("evaluation work per request is bounded by maxEvaluateRows, whatever the size of the domain", () => {
  const { store, c } = makeStore({ config: { maxEvaluateRows: 300 } }); bulk(store, "big.example", 2000, { at0: c.now() - 20 * DAY });
  assert.equal(store.evaluate("big.example").length, 300);
  const newest = store.db.get("SELECT MAX(at) AS m FROM reports").m; assert.equal(Math.max(...store.evaluate("big.example").map((r) => r.at)), newest, "the newest reports are the ones kept");
});
test("summaries are cached briefly and every kind of write invalidates the right entries", () => {
  const { store, c } = makeStore(), toks = Array.from({ length: 7 }, (_, i) => enrollFrom(store, ipN(i))); c.tick(10 * DAY);
  toks.slice(0, 6).forEach((t, i) => { report(store, t, ipN(i)); c.tick(6 * HOUR); });
  const a = store.summary(SH); assert.equal(store.summary(SH), a, "second call is served from the cache (same object)");
  report(store, toks[6], ipN(6)); assert.notEqual(store.summary(SH), a, "a new report invalidates it");
  const b = store.summary(SH), id = store.db.get("SELECT id FROM reports WHERE domain = ?", SH).id;
  store.moderate([id], "reject"); assert.notEqual(store.summary(SH), b, "moderation invalidates it"); const c2 = store.summary(SH);
  store.revokeCredential(credOf(toks[1])); assert.notEqual(store.summary(SH), c2, "revocation invalidates it");
  const d2 = store.summary(SH); c.tick(31_000); assert.notEqual(store.summary(SH), d2, "and it expires on its own after the TTL");
  assert.equal(store.summary("other.example").total, 0);
  const e1 = store.summary(SH); store.db.run("UPDATE reports SET outcome = 'ok' WHERE domain = ?", SH);
  assert.notEqual(store.summary(SH), e1, "even a direct write (a path nobody remembered to invalidate) cannot leave a stale summary");
  const e2 = store.summary(SH); store.openDispute({ domain: SH, message: "A long enough dispute message." }); assert.notEqual(store.summary(SH), e2);
});
test("the moderation queue pages through many domains and always makes progress, even with a tiny time budget", () => {
  const { store, c } = makeStore({ config: { detect: { netBurstMin: 2 }, limits: { reportsPerNetPerHour: 9999, reportsPerCredPerDay: 9999 } } });
  const toks = Array.from({ length: 6 }, (_, i) => enrollFrom(store, ipN(i))); c.tick(10 * DAY);
  for (let d = 0; d < 40; d++) { toks.slice(0, 2).forEach((t) => report(store, t, "192.0.2.50", { domain: `q${d}.example` })); }
  const seen = new Set(); let after = "", pages = 0;
  for (;;) {
    const page = store.queue({ limit: 7, after, budgetMs: 0 }); pages++;
    page.items.forEach((i) => seen.add(i.domain));
    if (!page.next) break; after = page.next; assert.ok(pages < 200, "no progress");
  }
  assert.ok(seen.size > 0 && seen.size <= 40, `saw ${seen.size} domains over ${pages} pages`);
  const direct = store.queue({ limit: 200, budgetMs: 10_000 }); assert.equal(direct.items.length, seen.size, "paging and a single big call agree");
});

test("queue pagination always terminates: an empty page is the end, and every cursor strictly advances", () => {
  const { store, c } = makeStore({ config: { detect: { netBurstMin: 2 }, limits: { reportsPerNetPerHour: 9999, reportsPerCredPerDay: 9999 } } });
  assert.deepEqual(store.queue(), { items: [], next: null });                                    // empty database
  const toks = Array.from({ length: 3 }, (_, i) => enrollFrom(store, ipN(i))); c.tick(10 * DAY);
  for (let d = 0; d < 5; d++) toks.slice(0, 2).forEach((t) => report(store, t, "192.0.2.50", { domain: `p${d}.example` }));
  assert.deepEqual(store.queue({ after: "zzzz" }), { items: [], next: null }, "past the last domain: finished, no cursor");
  for (const budgetMs of [0, 1, 250]) for (const limit of [1, 2, 3, 5, 6, 200]) {
    let after = "", pages = 0; const seen = [];
    for (;;) { const p = store.queue({ limit, after, budgetMs }); seen.push(...p.items.map((i) => i.domain)); if (!p.next) break; assert.ok(p.next > after, "cursor must advance"); after = p.next; assert.ok(++pages < 50, `no termination (budget ${budgetMs}, limit ${limit})`); }
    assert.deepEqual([...new Set(seen)].sort(), ["p0.example", "p1.example", "p2.example", "p3.example", "p4.example"], `budget ${budgetMs}, limit ${limit}`);
    assert.equal(seen.length, 5, "no domain is returned twice");
  }
});
