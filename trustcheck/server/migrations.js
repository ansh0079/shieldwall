// Ordered, append-only schema migrations. NEVER edit a migration that has shipped: add a new one. Each migration's checksum is
// recorded when applied, and the server refuses to start if an applied migration no longer matches its recorded checksum.
import crypto from "node:crypto";

export const checksum = (sql) => crypto.createHash("sha256").update(sql).digest("hex");

export const MIGRATIONS = [
  { version: 1, name: "initial schema", sql: `
    CREATE TABLE credentials (
      id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, net TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1))
    );
    CREATE INDEX credentials_net_created ON credentials (net, created_at);
    CREATE TABLE reports (
      id TEXT PRIMARY KEY,
      domain TEXT NOT NULL,
      cred TEXT NOT NULL REFERENCES credentials (id) ON DELETE CASCADE,
      net TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'problem', 'never')),
      tags TEXT NOT NULL DEFAULT '[]',
      at INTEGER NOT NULL,
      id_age_ms INTEGER NOT NULL,
      evidence TEXT NOT NULL DEFAULT 'reported' CHECK (evidence IN ('reported', 'verified')),
      fixed TEXT NOT NULL DEFAULT '[]',
      edits INTEGER NOT NULL DEFAULT 0,
      mod TEXT CHECK (mod IN ('approved', 'rejected')),
      UNIQUE (cred, domain)
    );
    CREATE INDEX reports_domain_at ON reports (domain, at);
    CREATE INDEX reports_at ON reports (at);
    CREATE TABLE disputes (
      id TEXT PRIMARY KEY, domain TEXT NOT NULL, message TEXT NOT NULL, contact TEXT NOT NULL DEFAULT '',
      token_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'appealed', 'closed')),
      merchant_verified INTEGER NOT NULL DEFAULT 0 CHECK (merchant_verified IN (0, 1)),
      resolution TEXT NOT NULL DEFAULT '', appeals INTEGER NOT NULL DEFAULT 0, appeal_message TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX disputes_domain ON disputes (domain, status);
    CREATE TABLE audit (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
      target TEXT NOT NULL, detail TEXT NOT NULL, prev TEXT NOT NULL, hash TEXT NOT NULL
    );
    -- The audit log is append-only at the database level too: rows can be neither changed nor removed.
    CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
    CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
    CREATE TABLE rate_events (key TEXT NOT NULL, ts INTEGER NOT NULL);
    CREATE INDEX rate_events_key_ts ON rate_events (key, ts);
    CREATE TABLE used_challenges (challenge TEXT PRIMARY KEY, expires INTEGER NOT NULL);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  ` }
];
export const latestVersion = (m = MIGRATIONS) => m[m.length - 1].version;
