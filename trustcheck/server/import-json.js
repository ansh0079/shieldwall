// One-off importer for the previous JSON data file ({ v: 2, credentials, reports, disputes, audit }) into the SQLite database.
// Safe to run once on an empty database; refuses a database that already holds data. The audit chain is carried over unchanged.
import crypto from "node:crypto";
import { verifyAudit } from "./audit.js";

export function importJson(db, state) {
  if (!state || state.v !== 2 || !Array.isArray(state.reports)) throw new Error("not a TrustCheck v2 data file");
  if (db.get("SELECT COUNT(*) AS n FROM credentials").n || db.get("SELECT COUNT(*) AS n FROM reports").n || db.get("SELECT COUNT(*) AS n FROM audit").n)
    throw new Error("the target database is not empty; refusing to import");
  const chain = verifyAudit(state.audit || []);
  if (!chain.ok) throw new Error(`the audit log in the file is already broken at entry ${chain.brokenAt}; refusing to import it`);
  return db.tx(() => {
    for (const c of state.credentials || []) db.run("INSERT INTO credentials (id, created_at, net, revoked) VALUES (?, ?, ?, ?)", c.id, c.createdAt, c.net, c.revoked ? 1 : 0);
    const creds = new Set((state.credentials || []).map((c) => c.id));
    let skipped = 0;
    for (const r of state.reports) {
      if (!creds.has(r.cred)) { skipped++; continue; }
      db.run("INSERT INTO reports (id, domain, cred, net, outcome, tags, at, id_age_ms, evidence, fixed, edits, mod) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        r.id, r.domain, r.cred, r.net, r.outcome, JSON.stringify(r.tags || []), r.at, r.idAgeMs, r.evidence || "reported", JSON.stringify(r.fixed || []), r.edits || 0, r.mod || null);
    }
    for (const d of state.disputes || []) db.run("INSERT INTO disputes (id, domain, message, contact, token_hash, created_at, status, merchant_verified, resolution) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      d.id, d.domain, d.message, d.contact || "", crypto.createHash("sha256").update(String(d.token || "")).digest("hex"), d.createdAt, d.status === "resolved" ? "resolved" : "open", d.merchantVerified ? 1 : 0, d.resolution || "");
    for (const e of state.audit || []) db.run("INSERT INTO audit (ts, actor, action, target, detail, prev, hash) VALUES (?, ?, ?, ?, ?, ?, ?)", e.ts, e.actor, e.action, e.target, e.detail, e.prev, e.hash);
    return { credentials: (state.credentials || []).length, reports: state.reports.length - skipped, skippedOrphans: skipped, disputes: (state.disputes || []).length, audit: (state.audit || []).length };
  });
}
