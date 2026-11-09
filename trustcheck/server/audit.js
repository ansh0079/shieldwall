// Append-only, hash-chained audit log: each entry commits to the previous one, so edits or deletions are detectable.
// Entries never contain report content, IP addresses or raw credentials.
import crypto from "node:crypto";

const ZERO = "0".repeat(64);
const digest = (prev, e) => crypto.createHash("sha256").update(prev + JSON.stringify([e.ts, e.actor, e.action, e.target, e.detail])).digest("hex");

export function appendAudit(log, { ts, actor, action, target = "", detail = "" }) {
  const entry = { ts, actor, action, target: String(target).slice(0, 120), detail: String(detail).slice(0, 240) };
  entry.prev = log.length ? log[log.length - 1].hash : ZERO;
  entry.hash = digest(entry.prev, entry);
  log.push(entry);
  return entry;
}
export function verifyAudit(log) {
  let prev = ZERO;
  for (let i = 0; i < log.length; i++) {
    const e = log[i];
    if (e.prev !== prev || e.hash !== digest(prev, e)) return { ok: false, brokenAt: i };
    prev = e.hash;
  }
  return { ok: true, length: log.length };
}
