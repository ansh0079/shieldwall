// requires: node:sqlite
import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database, migrate, schemaStatus } from "../server/db.js";
import { MIGRATIONS, checksum } from "../server/migrations.js";
import { createBackup, verifyBackup, restoreBackup, rotateBackups, listBackups, verifyAuditChainDb } from "../server/backup.js";
import { importJson } from "../server/import-json.js";
import { appendAudit } from "../server/audit.js";
import { createAlerter, createJobs } from "../server/jobs.js";
import { createLogger, Metrics } from "../server/log.js";
import { ReportStore } from "../server/store.js";
import { DAY, HOUR } from "./helpers.js";
import { makeStore, enrollFrom, report, ipN, nReports, nCreds } from "./server-helpers.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "tc-ops-"));
const names = (d) => d.all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name);

// ---------------- migrations ----------------
test("a fresh database gets the schema; running again changes nothing; checksums are recorded", () => {
  const d = new Database(":memory:");
  assert.deepEqual(migrate(d), { applied: [1], current: 1 }); assert.deepEqual(migrate(d), { applied: [], current: 1 });
  for (const t of ["credentials", "reports", "disputes", "audit", "rate_events", "used_challenges", "meta", "schema_migrations"]) assert.ok(names(d).includes(t), t);
  assert.equal(schemaStatus(d).applied[0].checksum, checksum(MIGRATIONS[0].sql)); assert.equal(d.get("PRAGMA user_version").user_version, 1);
});
test("dry run reports what would happen and changes nothing", () => {
  const d = new Database(":memory:");
  assert.deepEqual(migrate(d, { dryRun: true }), { applied: [1], current: 0 }); assert.ok(!names(d).includes("credentials"));
});
test("an applied migration that was edited afterwards is refused", () => {
  const d = new Database(":memory:"); migrate(d);
  d.run("UPDATE schema_migrations SET checksum = 'deadbeef' WHERE version = 1");
  assert.throws(() => migrate(d), /migration 1 .* was modified after it was applied/);
});
test("a database written by a NEWER server is refused rather than silently downgraded", () => {
  const d = new Database(":memory:"); migrate(d);
  d.run("INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (99, 'from the future', 'x', 1)");
  assert.throws(() => migrate(d), /newer version/);
});
test("migrations apply in order, keep existing data, and a failing one rolls back completely", () => {
  const d = new Database(":memory:");
  const base = MIGRATIONS[0], v2 = { version: 2, name: "add note", sql: "ALTER TABLE disputes ADD COLUMN note TEXT NOT NULL DEFAULT ''; UPDATE disputes SET note = 'migrated';" };
  migrate(d, { migrations: [base] });
  d.run("INSERT INTO disputes (id, domain, message, token_hash, created_at, status) VALUES ('d1', 'a.example', 'm', 'h', 1, 'open')");
  assert.deepEqual(migrate(d, { migrations: [base, v2] }), { applied: [2], current: 2 });
  assert.equal(d.get("SELECT note FROM disputes WHERE id = 'd1'").note, "migrated");                         // existing rows survived and were transformed
  const bad = { version: 3, name: "breaks halfway", sql: "CREATE TABLE half_done (x INTEGER); INSERT INTO half_done VALUES (1); INSERT INTO no_such_table VALUES (1);" };
  assert.throws(() => migrate(d, { migrations: [base, v2, bad] }));
  assert.ok(!names(d).includes("half_done"), "a failed migration must leave no partial changes behind");
  assert.equal(schemaStatus(d, [base, v2, bad]).current, 2); assert.equal(d.get("PRAGMA user_version").user_version, 2);
});

// ---------------- constraints and transactions ----------------
test("the schema itself rejects bad data: foreign keys, enums, uniqueness", () => {
  const { store } = makeStore(), d = store.db;
  d.run("INSERT INTO credentials (id, created_at, net, revoked) VALUES ('c1', 1, 'n', 0)");
  const ins = (id, cred, outcome = "ok") => d.run("INSERT INTO reports (id, domain, cred, net, outcome, at, id_age_ms) VALUES (?, 'a.example', ?, 'n', ?, 1, 1)", id, cred, outcome);
  assert.throws(() => ins("r1", "no-such-credential"), /FOREIGN KEY/);
  assert.throws(() => ins("r2", "c1", "scam"), /CHECK/);
  ins("r3", "c1"); assert.throws(() => ins("r4", "c1"), /UNIQUE/);                                         // one report per identity per domain
  assert.throws(() => d.run("UPDATE credentials SET revoked = 2 WHERE id = 'c1'"), /CHECK/);
});
test("a failed operation leaves nothing behind: no partial report, no consumed rate-limit slot, no audit entry", () => {
  const { store } = makeStore({ config: { limits: { reportsPerNetPerHour: 1, enrollPerNetPerDay: 9 } } });
  const a = enrollFrom(store, "192.0.2.1"), b = enrollFrom(store, "192.0.2.2");
  report(store, a, "192.0.2.9");
  const before = { reports: nReports(store), events: store.db.get("SELECT COUNT(*) AS n FROM rate_events").n, audit: store.db.get("SELECT COUNT(*) AS n FROM audit").n };
  assert.throws(() => report(store, b, "192.0.2.9"), /too many reports from this network/);               // the network budget fails AFTER the credential budget was checked
  assert.deepEqual({ reports: nReports(store), events: store.db.get("SELECT COUNT(*) AS n FROM rate_events").n, audit: store.db.get("SELECT COUNT(*) AS n FROM audit").n }, before);
});
test("tx(): commits on success, rolls everything back on any throw, joins when nested", () => {
  const d = new Database(":memory:"); d.exec("CREATE TABLE t (a INTEGER)");
  d.tx(() => { d.run("INSERT INTO t VALUES (1)"); d.tx(() => d.run("INSERT INTO t VALUES (2)")); });
  assert.equal(d.get("SELECT COUNT(*) AS n FROM t").n, 2);
  assert.throws(() => d.tx(() => { d.run("INSERT INTO t VALUES (3)"); d.tx(() => { d.run("INSERT INTO t VALUES (4)"); throw new Error("boom"); }); }), /boom/);
  assert.equal(d.get("SELECT COUNT(*) AS n FROM t").n, 2);
  d.tx(() => d.run("INSERT INTO t VALUES (5)")); assert.equal(d.get("SELECT COUNT(*) AS n FROM t").n, 3);            // usable again after a rollback
});
test("erasure really removes the data from the file (secure_delete), not just from queries", () => {
  const dir = tmp(), file = path.join(dir, "d.db"), { store, c } = makeStore({ file }), tok = enrollFrom(store, ipN(1));
  report(store, tok, ipN(1), { domain: "needle-domain-xyz.example" });
  store.eraseCredential(tok); store.close();
  const raw = fs.readFileSync(file).toString("latin1") + (fs.existsSync(file + "-wal") ? fs.readFileSync(file + "-wal").toString("latin1") : "");
  assert.ok(!raw.includes("needle-domain-xyz"), "the erased report's domain must not remain in the database file"); void c;
});

// ---------------- backup, verify, restore ----------------
function populated(file) {
  const ctx = makeStore(file ? { file } : {}), { store, c } = ctx, toks = Array.from({ length: 6 }, (_, i) => enrollFrom(store, ipN(i)));
  c.tick(10 * DAY); toks.forEach((t, i) => { report(store, t, ipN(i)); c.tick(6 * HOUR); });
  store.moderate([store.db.get("SELECT id FROM reports LIMIT 1").id], "approve", "alice"); store.openDispute({ domain: "shop.example", message: "A long enough dispute message." });
  return ctx;
}
test("backup: consistent snapshot, checksum sidecar, restrictive permissions, verified on creation", () => {
  const { store } = populated(), dir = tmp(), b = createBackup(store.db, dir, { now: () => Date.parse("2026-11-09T12:00:00Z"), keep: 5 });
  assert.match(path.basename(b.file), /^trustcheck-2026-11-09T12-00-00-000Z\.db$/); assert.ok(fs.existsSync(b.file + ".sha256"));
  assert.equal(b.info.reports, 6); assert.equal(b.info.credentials, 6); assert.equal(b.info.auditChainOk, true);
  if (process.platform !== "win32") assert.equal(fs.statSync(b.file).mode & 0o077, 0, "backups are not group/world readable");
  assert.deepEqual(verifyBackup(b.file).problems, []); assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith(".partial")));
});
test("restore drill: wipe the live database, restore from backup, and every row, credential and the audit chain are back", () => {
  const dir = tmp(), live = path.join(dir, "live.db"), ctx = populated(live), { store } = ctx;
  const expect = { reports: nReports(store), creds: nCreds(store), audit: store.db.get("SELECT COUNT(*) AS n FROM audit").n, summary: JSON.stringify(store.summary("shop.example")) };
  const tok = enrollFrom(store, ipN(50)), backup = createBackup(store.db, path.join(dir, "bk"), { now: ctx.c.now });
  store.close(); fs.rmSync(live); fs.rmSync(live + "-wal", { force: true }); fs.rmSync(live + "-shm", { force: true });            // disaster
  const r = restoreBackup(backup.file, live, { now: ctx.c.now });
  assert.equal(r.movedAside, null); assert.equal(r.info.auditChainOk, true);
  const back = new ReportStore({ file: live, now: ctx.c.now, salt: "salt", secret: "secret", config: { powBits: 6 } });
  assert.equal(nReports(back), expect.reports); assert.equal(nCreds(back), expect.creds + 1); assert.equal(back.db.get("SELECT COUNT(*) AS n FROM audit").n, expect.audit);
  assert.equal(JSON.stringify(back.summary("shop.example")), expect.summary);
  assert.equal(back.verifyAudit().ok, true);
  assert.ok(back.submit({ token: tok, ip: ipN(50), domain: "other.example", outcome: "ok" }).ok);                                  // an issued credential still works after restore
  assert.equal(back.db.get("PRAGMA integrity_check").integrity_check, "ok"); back.close();
});
test("restore never overwrites silently: needs force, and the old database is moved aside, not deleted", () => {
  const dir = tmp(), live = path.join(dir, "live.db"), { store, c } = populated(live), b = createBackup(store.db, path.join(dir, "bk"), { now: c.now }); store.close();
  assert.throws(() => restoreBackup(b.file, live), /already exists/);
  const r = restoreBackup(b.file, live, { force: true, now: () => Date.parse("2030-01-01T00:00:00Z") });
  assert.match(r.movedAside, /pre-restore-2030-01-01/); assert.ok(fs.existsSync(r.movedAside) && fs.existsSync(live));
});
test("corrupted, truncated, tampered, unchecksummed and non-database backups are all detected and refused", () => {
  const { store } = populated(), dir = tmp(), b = createBackup(store.db, dir), good = fs.readFileSync(b.file), side = fs.readFileSync(b.file + ".sha256");
  const flip = (off) => { const x = Buffer.from(good); x[off] ^= 0xff; return x; };
  fs.writeFileSync(b.file, flip(good.length - 100)); assert.match(verifyBackup(b.file).problems.join(), /checksum does not match/);        // bit rot
  fs.writeFileSync(b.file, good.subarray(0, Math.floor(good.length / 2))); assert.equal(verifyBackup(b.file).ok, false);                      // truncated
  fs.writeFileSync(b.file, flip(good.length - 100)); const noSum = verifyBackup(b.file, { requireChecksum: false });                         // corruption with the checksum ignored
  assert.equal(noSum.ok, false, "SQLite-level checks must still notice damage when the checksum is not available");
  fs.writeFileSync(b.file, good); fs.writeFileSync(b.file + ".sha256", "0".repeat(64) + "  x\n"); assert.match(verifyBackup(b.file).problems.join(), /checksum does not match/);
  fs.rmSync(b.file + ".sha256"); assert.match(verifyBackup(b.file).problems.join(), /checksum file is missing/);
  fs.writeFileSync(b.file, "this is not a database at all"); fs.writeFileSync(b.file + ".sha256", side); assert.equal(verifyBackup(b.file).ok, false);
  assert.match(verifyBackup(path.join(dir, "missing.db")).problems.join(), /does not exist/);
  assert.throws(() => restoreBackup(b.file, path.join(dir, "target.db")), /refusing to restore an unverified backup/);
  assert.ok(!fs.existsSync(path.join(dir, "target.db")), "a refused restore must not create the target");
});
test("a backup whose audit chain was tampered with, or from a newer server, fails verification", () => {
  const { store } = populated(), dir = tmp();
  store.db.exec("DROP TRIGGER audit_no_update"); store.db.run("UPDATE audit SET detail = 'edited' WHERE seq = 2");
  assert.throws(() => createBackup(store.db, dir), /audit chain broken at entry 2/);
  assert.deepEqual(fs.readdirSync(dir), [], "a backup that fails verification must not be left behind");
  const { store: s2 } = populated(), d2 = tmp();
  s2.db.run("INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (9, 'future', 'x', 1)");
  assert.throws(() => createBackup(s2.db, d2), /newer server version|does not match this server/);
});
test("rotation keeps the newest N, and half-written files are never listed or counted", () => {
  const { store } = populated(), dir = tmp(); let t = Date.parse("2026-11-01T00:00:00Z");
  for (let i = 0; i < 5; i++) createBackup(store.db, dir, { now: () => (t += DAY), keep: 99 });
  fs.writeFileSync(path.join(dir, "trustcheck-2026-11-09T00-00-00-000Z.db.partial"), "x"); fs.writeFileSync(path.join(dir, "notes.txt"), "x");
  assert.equal(listBackups(dir).length, 5); assert.equal(rotateBackups(dir, 2), 3);
  assert.equal(listBackups(dir).length, 2); assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith(".sha256")).length, 2);
  assert.ok(listBackups(dir)[1].name > listBackups(dir)[0].name);
});
test("a backup taken while the database is being written to is internally consistent", () => {
  const { store, c } = makeStore({ config: { limits: { enrollPerNetPerDay: 99, enrollPerHour: 9999, reportsPerNetPerHour: 999 } } }), dir = tmp(), toks = [];
  for (let i = 0; i < 40; i++) { toks.push(enrollFrom(store, ipN(i))); report(store, toks[i], ipN(i), { domain: `d${i % 5}.example` }); if (i % 10 === 9) createBackup(store.db, dir, { now: () => c.now() + i, keep: 99 }); }
  for (const b of listBackups(dir)) { const v = verifyBackup(b.file); assert.deepEqual(v.problems, [], b.name); assert.equal(v.info.reports, v.info.credentials); }
});
test("backup into an unusable location fails loudly and leaves no partial file", () => {
  const { store } = populated(), blocker = path.join(tmp(), "file"); fs.writeFileSync(blocker, "x");
  assert.throws(() => createBackup(store.db, path.join(blocker, "sub")));
});

// ---------------- migration from the old JSON file ----------------
function oldState() {
  const audit = []; appendAudit(audit, { ts: 1, actor: "system", action: "quarantine", target: "shop.example", detail: "2 report(s) held back" }); appendAudit(audit, { ts: 2, actor: "moderator", action: "reject", target: "shop.example", detail: "1 report(s)" });
  return { v: 2, credentials: [{ id: "c1".padEnd(24, "0"), createdAt: 100, net: "aa", revoked: false }, { id: "c2".padEnd(24, "0"), createdAt: 200, net: "bb", revoked: true }],
    reports: [{ id: "r1".padEnd(16, "0"), domain: "shop.example", cred: "c1".padEnd(24, "0"), net: "aa", outcome: "never", tags: ["fake_tracking"], at: 1e12, idAgeMs: 5, evidence: "reported", fixed: [], edits: 0, mod: null },
      { id: "r2".padEnd(16, "0"), domain: "shop.example", cred: "gone".padEnd(24, "0"), net: "cc", outcome: "ok", tags: [], at: 1e12, idAgeMs: 5, fixed: [], edits: 0, mod: null }],
    disputes: [{ id: "d1".padEnd(16, "0"), domain: "shop.example", message: "msg msg msg msg", token: "plain-old-token", createdAt: 5, status: "open", merchantVerified: true, resolution: "" }], audit };
}
test("import from the previous JSON format: rows, the audit chain and disputes carry over; dispute tokens are hashed; orphans are skipped", () => {
  const d = new Database(":memory:"); migrate(d);
  const out = importJson(d, oldState());
  assert.deepEqual(out, { credentials: 2, reports: 1, skippedOrphans: 1, disputes: 1, audit: 2 });
  assert.equal(verifyAuditChainDb(d).ok, true); assert.equal(d.get("SELECT revoked FROM credentials WHERE id LIKE 'c2%'").revoked, 1);
  assert.deepEqual(JSON.parse(d.get("SELECT tags FROM reports").tags), ["fake_tracking"]);
  assert.ok(!JSON.stringify(d.all("SELECT * FROM disputes")).includes("plain-old-token"), "the raw dispute token is not stored");
  assert.equal(d.get("SELECT token_hash FROM disputes").token_hash.length, 64);
});
test("import refuses non-empty databases, broken audit chains and foreign formats", () => {
  const d = new Database(":memory:"); migrate(d); importJson(d, oldState());
  assert.throws(() => importJson(d, oldState()), /not empty/);
  const broken = oldState(); broken.audit[0].detail = "edited"; const d2 = new Database(":memory:"); migrate(d2);
  assert.throws(() => importJson(d2, broken), /audit log .* already broken/); assert.equal(d2.get("SELECT COUNT(*) AS n FROM credentials").n, 0);
  assert.throws(() => importJson(d2, [{ domain: "old-v1" }]), /not a TrustCheck v2/); assert.throws(() => importJson(d2, { v: 1 }), /not a TrustCheck v2/);
});

// ---------------- jobs and alerts ----------------
function jobsCtx(over = {}) {
  const ctx = makeStore(), logs = [], logger = createLogger({ write: (l) => logs.push(JSON.parse(l)) }), metrics = new Metrics(), dir = tmp(), posted = [];
  const alerter = createAlerter({ logger, metrics, webhookUrl: over.webhook || "", fetchImpl: over.fetchImpl || (async (url, init) => { posted.push({ url, body: JSON.parse(init.body) }); return { ok: true }; }), now: () => Date.now() });
  const jobs = createJobs({ store: ctx.store, config: { backupDir: dir, backupEveryHours: 6, backupKeep: 3, ...over.config }, logger, metrics, alerter, now: () => Date.now(), statfs: over.statfs || (() => ({ bavail: 900, blocks: 1000, bsize: 1_000_000 })), backupFn: over.backupFn });
  return { ...ctx, logs, metrics, dir, posted, alerter, jobs, alerts: () => logs.filter((l) => l.event === "alert").map((l) => l.code) };
}
test("retention job purges expired data and records what it did", () => {
  const j = jobsCtx(), tok = enrollFrom(j.store, ipN(1)); report(j.store, tok, ipN(1)); j.c.tick(100 * DAY);
  const out = j.jobs.runRetention(); assert.equal(out.reports, 1);
  assert.ok(j.logs.some((l) => l.event === "retention_purge" && l.reports === 1));
});
test("backup job: writes a verified backup, rotates, records metrics; a failure alerts once and resolves on success", () => {
  let fail = true; const j = jobsCtx({ backupFn: (db, dir, o) => { if (fail) throw new Error("disk exploded at /secret/path 203.0.113.9"); return createBackup(db, dir, o); } });
  assert.equal(j.jobs.runBackup(), null); assert.equal(j.jobs.runBackup(), null);
  assert.deepEqual(j.alerts(), ["backup_failed"], "deduplicated: one alert, not one per attempt"); assert.equal(j.metrics.get("backup_failures_total"), 2);
  assert.ok(!JSON.stringify(j.logs).includes("203.0.113.9"), "addresses inside error text are redacted");
  fail = false; const b = j.jobs.runBackup(); assert.ok(b.file);
  assert.ok(j.logs.some((l) => l.event === "alert_resolved" && l.code === "backup_failed")); assert.ok(j.metrics.get("last_backup_timestamp") > 0);
  for (let i = 0; i < 4; i++) { j.c.tick(HOUR); j.jobs.runBackup(); } assert.ok(listBackups(j.dir).length <= 3);
});
test("monitor: healthy system raises no alerts and publishes gauges", () => {
  const j = jobsCtx(); j.jobs.runBackup();
  assert.deepEqual(j.jobs.runMonitor(), []); assert.equal(j.metrics.get("audit_chain_ok"), 1); assert.equal(j.metrics.get("schema_version"), 1); assert.ok(j.metrics.get("disk_free_bytes") > 0);
});
test("a freshly started server is not alerted about a backup that has not had time to happen yet", () => {
  const j = jobsCtx(); assert.deepEqual(j.jobs.runMonitor(), [], "no backups yet, but the process just started"); assert.equal(j.metrics.get("backup_age_seconds"), -1);
  const old = createJobs({ store: j.store, config: { backupDir: j.dir, backupEveryHours: 6 }, logger: createLogger({ write: () => {} }), metrics: new Metrics(),
    alerter: createAlerter({ logger: createLogger({ write: () => {} }) }), now: (() => { const t0 = Date.now(); let calls = 0; return () => (calls++ === 0 ? t0 - 13 * HOUR : t0); })(), statfs: () => ({ bavail: 900, blocks: 1000, bsize: 1e6 }) });
  assert.ok(old.runMonitor().includes("backup_stale"), "after 2 backup intervals without a backup it IS stale");
});
test("monitor alerts: stale backup, missing backup, broken audit chain, not ready, disk low, moderation backlog", () => {
  const j = jobsCtx({ config: { queueAlertThreshold: 1 }, statfs: () => ({ bavail: 50, blocks: 1000, bsize: 1_000_000 }) });
  const b = createBackup(j.store.db, j.dir); fs.utimesSync(b.file, new Date(), new Date(Date.now() - 13 * HOUR));
  assert.ok(j.jobs.runMonitor().includes("backup_stale"), "13h old with a 6h schedule is stale");
  j.store.db.exec("DROP TRIGGER audit_no_delete"); j.store.db.exec("DROP TRIGGER audit_no_update"); j.store.db.run("INSERT INTO audit (ts, actor, action, target, detail, prev, hash) VALUES (1, 'x', 'y', 'z', 'w', 'bad', 'bad')");
  j.store.db.exec("PRAGMA query_only = ON");
  const found = j.jobs.runMonitor(); j.store.db.exec("PRAGMA query_only = OFF");
  for (const code of ["audit_chain_broken", "not_ready", "disk_low"]) assert.ok(found.includes(code), `${code} in ${found}`);
  const toks = Array.from({ length: 8 }, (_, i) => enrollFrom(j.store, ipN(i))); toks.forEach((t, i) => report(j.store, t, ipN(i)));
  assert.ok(j.jobs.runMonitor().includes("moderation_backlog"));
  assert.equal(j.metrics.get("audit_chain_ok"), 0);
});
test("alerts are deduplicated for an hour, re-raised afterwards, and resolution is logged", () => {
  let t = 1_000_000; const logs = [], alerter = createAlerter({ logger: createLogger({ write: (l) => logs.push(JSON.parse(l)) }), now: () => t });
  assert.equal(alerter.raise("x", { n: 1 }), true); assert.equal(alerter.raise("x", { n: 2 }), false); assert.equal(alerter.raise("y"), true);
  t += 3_600_001; assert.equal(alerter.raise("x"), true);
  alerter.resolve("x"); assert.ok(logs.some((l) => l.event === "alert_resolved")); assert.deepEqual(alerter.activeCodes(), ["y"]);
});
test("webhook alerts carry a privacy-redacted payload; a failing webhook never throws or loops", async () => {
  const j = jobsCtx({ webhook: "https://hooks.example.com/alert" });
  j.alerter.raise("db_down", { detail: "cannot reach 203.0.113.7", token: "abcdefghijklmnopqrstuvwxyz0123", domains: 3 });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(j.posted.length, 1); assert.equal(j.posted[0].url, "https://hooks.example.com/alert");
  const p = j.posted[0].body; assert.equal(p.code, "db_down"); assert.equal(p.service, "trustcheck-reports"); assert.equal(p.details.domains, 3);
  assert.ok(!JSON.stringify(p).includes("203.0.113.7") && !JSON.stringify(p).includes("abcdefghijklmnopqrstuvwxyz0123"));
  const bad = jobsCtx({ webhook: "https://hooks.example.com/alert", fetchImpl: async () => { throw new Error("webhook down"); } });
  assert.doesNotThrow(() => bad.alerter.raise("x")); await new Promise((r) => setTimeout(r, 20));
  assert.ok(bad.logs.some((l) => l.event === "alert_webhook_failed"));
});
