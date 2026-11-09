// Append-only, hash-chained audit log: each entry commits to the previous one, so edits or deletions are detectable.
// Entries never contain report content, IP addresses or raw credentials.
import crypto from "node:crypto";

const ZERO = "0".repeat(64);
const digest = (prev, e) => crypto.createHash("sha256").update(prev + JSON.stringify([e.ts, e.actor, e.action, e.target, e.detail])).digest("hex");

export const AUDIT_GENESIS = ZERO;
// Builds the next chain entry from the previous hash (used by the database-backed log).
export function chainEntry(prev, { ts, actor, action, target = "", detail = "" }) {
  const entry = { ts, actor: String(actor).slice(0, 64), action, target: String(target).slice(0, 120), detail: String(detail).slice(0, 240) };
  entry.prev = prev; entry.hash = digest(prev, entry);
  return entry;
}
export function appendAudit(log, fields) {
  const entry = chainEntry(log.length ? log[log.length - 1].hash : ZERO, fields);
  log.push(entry);
  return entry;
}
// Verifies a run of entries given the hash the run must start from (so a large log can be checked page by page).
export function verifyAuditFrom(log, startPrev = ZERO) {
  let prev = startPrev;
  for (let i = 0; i < log.length; i++) {
    const e = log[i];
    if (e.prev !== prev || e.hash !== digest(prev, e)) return { ok: false, brokenAt: i };
    prev = e.hash;
  }
  return { ok: true, length: log.length };
}
export const verifyAudit = (log) => verifyAuditFrom(log, ZERO);
