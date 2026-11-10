// Scheduled housekeeping with operational alerts: retention purge, verified backups, and a monitor that checks readiness,
// the audit chain, backup freshness, disk space and the moderation backlog. Every job is a plain function so it can be tested
// without timers. Alerts are logged (event "alert") and optionally POSTed to a webhook; each code alerts at most once per hour.
import fs from "node:fs";
import { createBackup, listBackups } from "./backup.js";
import { redact } from "./log.js";

export function createAlerter({ logger, webhookUrl = "", fetchImpl = globalThis.fetch, now = Date.now, dedupeMs = 3_600_000, metrics = null }) {
  const active = new Map();
  return {
    raise(code, details = {}) {
      const last = active.get(code);
      if (last && now() - last < dedupeMs) return false;
      active.set(code, now());
      metrics?.inc("alerts_total", 1, { code });
      logger.error("alert", { code, ...details });
      if (webhookUrl) {                                              // best effort, short timeout, privacy-redacted payload
        const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 5000);
        Promise.resolve(fetchImpl(webhookUrl, { method: "POST", headers: { "content-type": "application/json" }, signal: ctl.signal,
          body: JSON.stringify({ service: "trustcheck-reports", severity: "error", code, at: new Date(now()).toISOString(), details: redact(details) }) }))
          .catch((e) => logger.warn("alert_webhook_failed", { error: String(e?.message || e) })).finally(() => clearTimeout(timer));
      }
      return true;
    },
    resolve(code) { if (active.delete(code)) logger.info("alert_resolved", { code }); },
    activeCodes: () => [...active.keys()]
  };
}

export function createJobs({ store, config, logger, metrics, alerter, now = Date.now, statfs = fs.statfsSync, backupFn = createBackup }) {
  const every = (config.backupEveryHours || 6) * 3_600_000, startedAt = now();
  const jobs = {
    runRetention() {
      const out = store.purge();
      logger.info("retention_purge", out); metrics?.set("last_retention_timestamp", Math.round(now() / 1000));
      return out;
    },
    runBackup() {
      if (!config.backupDir) return null;
      try {
        const b = backupFn(store.db, config.backupDir, { now, keep: config.backupKeep });
        logger.info("backup_ok", { name: b.file.split(/[\\/]/).pop(), bytes: b.bytes, rotated: b.rotated, ms: b.tookMs, rows: b.info });
        metrics?.set("last_backup_timestamp", Math.round(now() / 1000)); metrics?.set("last_backup_bytes", b.bytes);
        alerter.resolve("backup_failed");
        return b;
      } catch (e) { alerter.raise("backup_failed", { error: String(e.message).slice(0, 200) }); metrics?.inc("backup_failures_total"); return null; }
    },
    runMonitor() {
      const found = [];
      const check = (code, bad, details) => { if (bad) { alerter.raise(code, details); found.push(code); } else alerter.resolve(code); };
      const r = store.readiness();
      check("not_ready", !r.ok, { checks: r.checks });
      let chain = { ok: true }; try { chain = store.verifyAudit(); } catch (e) { chain = { ok: false, error: String(e.message).slice(0, 100) }; }
      metrics?.set("audit_chain_ok", chain.ok ? 1 : 0);
      check("audit_chain_broken", !chain.ok, { brokenAt: chain.brokenAt });
      if (config.backupDir) {
        const latest = listBackups(config.backupDir).pop(), age = latest ? now() - latest.mtime : now() - startedAt;   // no backup yet: judged from process start, so a fresh start is not an alert
        metrics?.set("backup_age_seconds", latest ? Math.round(age / 1000) : -1);
        check("backup_stale", age > 2 * every, { ageHours: Math.round(age / 360000) / 10, neverBackedUp: !latest, expectedEveryHours: config.backupEveryHours });
      }
      let q = 0; try { q = store.queueLength(); } catch { /* reported by not_ready */ }
      metrics?.set("moderation_queue_length", q);
      check("moderation_backlog", q >= (config.queueAlertThreshold || 50), { domains: q });
      try {
        const target = config.backupDir || ".", s = statfs(target), free = s.bavail * s.bsize, pct = s.bavail / s.blocks;
        metrics?.set("disk_free_bytes", free);
        check("disk_low", pct < 0.1 || free < 500 * 1024 * 1024, { freeMB: Math.round(free / 1048576), freePct: Math.round(pct * 100) });
      } catch { /* statfs unavailable on this platform */ }
      const sch = store.schema(); metrics?.set("schema_version", sch.current);
      return found;
    },
    start() {
      const timers = [setInterval(() => jobs.runRetention(), 3_600_000), setInterval(() => jobs.runMonitor(), 300_000)];
      if (config.backupDir) {
        timers.push(setInterval(() => jobs.runBackup(), every));
        const last = listBackups(config.backupDir).pop();
        if (!last || now() - last.mtime > every) setTimeout(() => jobs.runBackup(), 5000).unref();     // do not wait a full interval after a restart
      }
      setTimeout(() => { jobs.runRetention(); jobs.runMonitor(); }, 2000).unref();
      timers.forEach((t) => t.unref());
      return () => timers.forEach(clearInterval);
    }
  };
  return jobs;
}
