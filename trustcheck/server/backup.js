// Consistent online backups (VACUUM INTO), verification, rotation and verified restore. A backup that has never been
// verified or restored is not a backup: createBackup verifies what it wrote, and restore verifies before touching anything.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Database, schemaStatus } from "./db.js";
import { MIGRATIONS, checksum } from "./migrations.js";
import { AUDIT_GENESIS, verifyAuditFrom } from "./audit.js";

const sha256File = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const stamp = (t) => new Date(t).toISOString().replace(/[:.]/g, "-");
export const BACKUP_RE = /^trustcheck-\d{4}-\d{2}-\d{2}T[\d-]+Z\.db$/;

export function verifyAuditChainDb(db) {
  let after = 0, prev = AUDIT_GENESIS, n = 0;
  for (;;) {
    const page = db.all("SELECT seq, ts, actor, action, target, detail, prev, hash FROM audit WHERE seq > ? ORDER BY seq LIMIT 2000", after);
    if (!page.length) return { ok: true, length: n };
    const v = verifyAuditFrom(page, prev);
    if (!v.ok) return { ok: false, brokenAt: page[v.brokenAt].seq };
    prev = page[page.length - 1].hash; after = page[page.length - 1].seq; n += page.length;
  }
}

// Opens read-only and checks: sidecar checksum, SQLite integrity, foreign keys, schema versions/checksums, audit chain.
export function verifyBackup(file, { requireChecksum = true } = {}) {
  const problems = [], info = {};
  if (!fs.existsSync(file)) return { ok: false, problems: ["file does not exist"], info };
  const side = file + ".sha256";
  if (fs.existsSync(side)) { if (fs.readFileSync(side, "utf8").trim().split(/\s+/)[0] !== sha256File(file)) problems.push("checksum does not match (the file changed after it was written)"); }
  else if (requireChecksum) problems.push("checksum file is missing");
  let db;
  try {
    db = new Database(file, { readOnly: true });
    const ic = db.all("PRAGMA integrity_check").map((r) => r.integrity_check);
    if (ic.length !== 1 || ic[0] !== "ok") problems.push("integrity_check failed: " + ic.slice(0, 3).join("; "));
    if (db.all("PRAGMA foreign_key_check").length) problems.push("foreign key violations found");
    const st = schemaStatus(db);
    info.schemaVersion = st.current;
    if (st.current > MIGRATIONS[MIGRATIONS.length - 1].version) problems.push("backup is from a newer server version");
    for (const a of st.applied) { const m = MIGRATIONS.find((x) => x.version === a.version); if (!m || checksum(m.sql) !== a.checksum) problems.push(`migration ${a.version} does not match this server`); }
    for (const t of ["credentials", "reports", "disputes", "audit"]) info[t] = db.get(`SELECT COUNT(*) AS n FROM ${t}`).n;
    const chain = verifyAuditChainDb(db);
    info.auditChainOk = chain.ok;
    if (!chain.ok) problems.push(`audit chain broken at entry ${chain.brokenAt}`);
  } catch (e) { problems.push("cannot be read as a database: " + String(e.message).slice(0, 120)); }
  finally { try { db?.close(); } catch { /* ignore */ } }
  return { ok: problems.length === 0, problems, info };
}

export function listBackups(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => BACKUP_RE.test(f)).sort().map((f) => ({ file: path.join(dir, f), name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }));
}
export function rotateBackups(dir, keep) {
  const all = listBackups(dir), drop = all.slice(0, Math.max(0, all.length - keep));
  for (const b of drop) { fs.rmSync(b.file, { force: true }); fs.rmSync(b.file + ".sha256", { force: true }); }
  return drop.length;
}

// Writes a consistent snapshot while the server keeps running, verifies it, then rotates old ones.
export function createBackup(db, dir, { now = Date.now, keep = 28 } = {}) {
  const t0 = Date.now();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const final = path.join(dir, `trustcheck-${stamp(now())}.db`), tmp = final + ".partial";
  fs.rmSync(tmp, { force: true });
  db.run("VACUUM INTO ?", tmp);
  const sum = sha256File(tmp);
  fs.renameSync(tmp, final);
  fs.writeFileSync(final + ".sha256", `${sum}  ${path.basename(final)}\n`, { mode: 0o600 });
  fs.chmodSync(final, 0o600);
  const v = verifyBackup(final);
  if (!v.ok) { fs.rmSync(final, { force: true }); fs.rmSync(final + ".sha256", { force: true }); throw new Error("backup failed verification: " + v.problems.join("; ")); }
  const rotated = rotateBackups(dir, keep);
  return { file: final, bytes: fs.statSync(final).size, sha256: sum, rotated, info: v.info, tookMs: Date.now() - t0 };
}

// Verified restore. Refuses to overwrite an existing database unless force is set; then it is moved aside, never deleted.
export function restoreBackup(backupFile, target, { force = false, now = Date.now } = {}) {
  const v = verifyBackup(backupFile);
  if (!v.ok) throw new Error("refusing to restore an unverified backup: " + v.problems.join("; "));
  let movedAside = null;
  if (fs.existsSync(target)) {
    if (!force) throw new Error(`${target} already exists (use force to move it aside and restore)`);
    movedAside = `${target}.pre-restore-${stamp(now())}`;
    fs.renameSync(target, movedAside);
  }
  for (const ext of ["-wal", "-shm"]) if (fs.existsSync(target + ext)) fs.renameSync(target + ext, (movedAside || target) + ext);
  fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  const tmp = target + ".restoring";
  fs.copyFileSync(backupFile, tmp);
  fs.renameSync(tmp, target);
  const after = verifyBackup(target, { requireChecksum: false });
  if (!after.ok) throw new Error("restored database failed verification: " + after.problems.join("; "));
  return { restored: target, movedAside, info: after.info };
}
