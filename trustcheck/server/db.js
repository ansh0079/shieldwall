// SQLite via Node's built-in node:sqlite (Node >= 22.13): transactional, WAL, no dependencies.
// Single-writer by design: run ONE server process per database file (see DEPLOY.md for when to move to PostgreSQL).
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, checksum, latestVersion } from "./migrations.js";

export class Database {
  constructor(file = ":memory:", { readOnly = false, busyTimeoutMs = 5000, synchronous = "FULL" } = {}) {
    this.file = file; this.readOnly = readOnly; this.depth = 0; this.stmts = new Map();
    this.writes = 0;                    // bumps on every change; lets caches stay correct by construction (no per-call-site invalidation)
    this.db = new DatabaseSync(file, { readOnly });
    this.db.exec(`PRAGMA busy_timeout = ${Number(busyTimeoutMs) | 0}`);
    this.db.exec("PRAGMA foreign_keys = ON");
    if (!readOnly) {
      this.db.exec("PRAGMA secure_delete = ON");               // deleted (erased) data is overwritten, not just unlinked
      this.db.exec(`PRAGMA synchronous = ${synchronous === "NORMAL" ? "NORMAL" : "FULL"}`);
      if (file !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL");
    }
  }
  prepare(sql) { let s = this.stmts.get(sql); if (!s) { s = this.db.prepare(sql); this.stmts.set(sql, s); } return s; }
  run(sql, ...p) { const r = this.prepare(sql).run(...p); if (r.changes) this.writes++; return r; }
  get(sql, ...p) { return this.prepare(sql).get(...p); }
  all(sql, ...p) { return this.prepare(sql).all(...p); }
  exec(sql) { this.writes++; this.db.exec(sql); }
  // Atomic unit of work. Nested calls join the outer transaction. Any throw rolls back everything inside.
  tx(fn) {
    if (this.depth > 0) return fn();
    this.db.exec("BEGIN IMMEDIATE"); this.depth = 1;
    try { const r = fn(); this.db.exec("COMMIT"); return r; }
    catch (e) { try { this.db.exec("ROLLBACK"); } catch { /* already rolled back */ } throw e; }
    finally { this.depth = 0; }
  }
  close() {
    if (!this.db.isOpen) return;
    try { if (!this.readOnly && this.file !== ":memory:") this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* best effort */ }
    this.stmts.clear(); this.db.close();
  }
}

export function schemaStatus(database, migrations = MIGRATIONS) {
  const has = database.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'");
  const applied = has ? database.all("SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version") : [];
  const latest = latestVersion(migrations), current = applied.length ? applied[applied.length - 1].version : 0;
  return { current, latest, pending: migrations.filter((m) => m.version > current).map((m) => m.version), applied };
}

// Applies pending migrations, each in its own transaction. Refuses a database that is newer than this code, and one whose
// applied migrations were edited after the fact.
export function migrate(database, { now = Date.now, migrations = MIGRATIONS, dryRun = false } = {}) {
  database.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL)");
  const st = schemaStatus(database, migrations), byVersion = new Map(migrations.map((m) => [m.version, m]));
  for (const a of st.applied) {
    const m = byVersion.get(a.version);
    if (!m) throw new Error(`database has migration ${a.version} ("${a.name}") that this server does not know: it was written by a newer version`);
    if (m.checksum !== undefined ? m.checksum !== a.checksum : checksum(m.sql) !== a.checksum) throw new Error(`migration ${a.version} ("${a.name}") was modified after it was applied`);
  }
  const done = [];
  for (const m of migrations.filter((x) => x.version > st.current)) {
    if (dryRun) { done.push(m.version); continue; }
    database.tx(() => {
      database.exec(m.sql);
      database.run("INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)", m.version, m.name, checksum(m.sql), now());
      database.exec(`PRAGMA user_version = ${m.version | 0}`);
    });
    done.push(m.version);
  }
  return { applied: done, current: dryRun ? st.current : latestVersion(migrations) };
}
