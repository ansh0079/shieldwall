// Report store on SQLite (see db.js). The abuse heuristics live in abuse.js and are unchanged; this file adds transactions,
// persistent rate limits and replay protection, retention, and disputes/appeals. Reports are anonymous, UNVERIFIED context.
import crypto from "node:crypto";
import { Database, migrate, schemaStatus } from "./db.js";
import { latestVersion } from "./migrations.js";
import { DAY, HOUR, mergeConfig, netRange, netHash, weigh, detect, smooth } from "./abuse.js";
import { signToken, verifyToken, makeChallenge, verifyPow, timingSafeEqualStr } from "./credentials.js";
import { chainEntry, verifyAuditFrom, AUDIT_GENESIS } from "./audit.js";
import { OUTCOMES, TAGS, ApiError, cleanDomain } from "./vocab.js";

export { OUTCOMES, TAGS, ApiError, cleanDomain };
const rid = () => crypto.randomBytes(8).toString("hex");
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const short = (id) => sha(id).slice(0, 12);

export class ReportStore {
  constructor({ file = ":memory:", db = null, now = () => Date.now(), salt = "dev-salt", secret = "dev-secret", config = {}, fetchText = null, verifyPurchase = null, metrics = null } = {}) {
    Object.assign(this, { now, salt, secret, cfg: mergeConfig(config), fetchText, verifyPurchase, metrics });
    this.sumCache = new Map();                                // domain -> { at, value, w }
    this.flagCache = new Map();                               // domain -> ids held back at the last submit (so a submit evaluates once, not twice)
    this.db = db || new Database(file);
    migrate(this.db, { now });
  }
  close() { this.db.close(); }
  flush() { /* every operation is already durable (synchronous=FULL); kept for API compatibility */ }
  count(name, n = 1) { this.metrics?.inc?.(name, n); }

  // ---------- internals ----------
  _audit(actor, action, target, detail) {
    const last = this.db.get("SELECT hash FROM audit ORDER BY seq DESC LIMIT 1"), e = chainEntry(last ? last.hash : AUDIT_GENESIS, { ts: this.now(), actor, action, target, detail });
    this.db.run("INSERT INTO audit (ts, actor, action, target, detail, prev, hash) VALUES (?, ?, ?, ?, ?, ?, ?)", e.ts, e.actor, e.action, e.target, e.detail, e.prev, e.hash);
  }
  // Sliding-window limiter persisted in the database (survives restarts). Returns false when over the limit.
  _allow(key, windowMs, max) {
    const t = this.now(), since = t - windowMs;
    this.db.run("DELETE FROM rate_events WHERE key = ? AND ts <= ?", key, since);
    if (this.db.get("SELECT COUNT(*) AS n FROM rate_events WHERE key = ? AND ts > ?", key, since).n >= max) return false;
    this.db.run("INSERT INTO rate_events (key, ts) VALUES (?, ?)", key, t);
    return true;
  }
  _net(ip) { return netHash(netRange(ip), this.salt); }
  _row(r) { return { id: r.id, domain: r.domain, cred: r.cred, net: r.net, outcome: r.outcome, tags: JSON.parse(r.tags), at: r.at, idAgeMs: r.id_age_ms, evidence: r.evidence, fixed: JSON.parse(r.fixed), edits: r.edits, mod: r.mod, credRevoked: !!r.cred_revoked }; }

  // ---------- credentials ----------
  challenge() { return { challenge: makeChallenge(this.secret, { bits: this.cfg.powBits, now: this.now() }), bits: this.cfg.powBits }; }
  enroll({ ip, challenge, solution }) {
    const v = verifyPow(challenge, solution, this.secret, { now: this.now(), minBits: this.cfg.powBits });
    if (!v.ok) throw new ApiError(400, "proof of work rejected: " + v.reason);
    const net = this._net(ip), L = this.cfg.limits, t = this.now(), id = crypto.randomBytes(12).toString("hex");
    return this.db.tx(() => {
      if (this.db.get("SELECT 1 AS x FROM used_challenges WHERE challenge = ?", challenge)) throw new ApiError(400, "proof of work rejected: already used");
      if (this.db.get("SELECT COUNT(*) AS n FROM credentials WHERE net = ? AND created_at > ?", net, t - DAY).n >= L.enrollPerNetPerDay) throw new ApiError(429, "too many new identities from this network");
      if (!this._allow("enroll:all", HOUR, L.enrollPerHour)) throw new ApiError(429, "enrolment is busy, try again later");
      if (this.db.get("SELECT COUNT(*) AS n FROM credentials").n >= L.maxCredentials) throw new ApiError(503, "server full");
      this.db.run("INSERT INTO used_challenges (challenge, expires) VALUES (?, ?)", challenge, t + 10 * 60_000);
      this.db.run("INSERT INTO credentials (id, created_at, net, revoked) VALUES (?, ?, ?, 0)", id, t, net);
      this.count("enrolments_total");
      return { token: signToken({ c: id, i: t }, this.secret), credentialId: id };
    });
  }
  _cred(token) {
    const p = verifyToken(token, this.secret), c = p && typeof p.c === "string" ? this.db.get("SELECT id, created_at, net, revoked FROM credentials WHERE id = ?", p.c) : null;
    if (!c || c.revoked) throw new ApiError(401, "invalid or revoked credential");
    return { id: c.id, createdAt: c.created_at, net: c.net };
  }

  // ---------- reports ----------
  submit({ token, ip, domain, outcome, tags = [], proof }) {
    const c = this._cred(token);
    domain = cleanDomain(domain);
    if (!domain) throw new ApiError(400, "invalid domain");
    if (!OUTCOMES.includes(outcome)) throw new ApiError(400, "invalid outcome");
    if (!Array.isArray(tags) || tags.length > TAGS.length || tags.some((x) => !TAGS.includes(x))) throw new ApiError(400, "invalid tags");
    if (proof !== undefined && (typeof proof !== "string" || proof.length > 4096)) throw new ApiError(400, "invalid proof");
    const L = this.cfg.limits, t = this.now(), net = this._net(ip), youngMs = this.cfg.detect.youngDays * DAY;
    const idAgeMs = t - c.createdAt, tags2 = JSON.stringify(outcome === "ok" ? [] : [...new Set(tags)]);
    const verified = !!(proof && this.verifyPurchase && this.verifyPurchase(proof, domain));          // no verifier is configured by default
    return this.db.tx(() => {
      const existing = this.db.get("SELECT id, edits FROM reports WHERE cred = ? AND domain = ?", c.id, domain);
      if (!this._allow("cred:" + c.id, DAY, L.reportsPerCredPerDay)) throw new ApiError(429, "daily report limit reached");
      if (!this._allow("net:" + net, HOUR, L.reportsPerNetPerHour)) throw new ApiError(429, "too many reports from this network");
      if (existing && existing.edits >= L.correctionsPerCredPerDomain) throw new ApiError(429, "too many corrections to this report");
      if (!existing && this.db.get("SELECT COUNT(*) AS n FROM reports").n >= L.maxReports) throw new ApiError(503, "server full");
      const fixed = [];
      if (idAgeMs < youngMs) {
        const n = this.db.get("SELECT COUNT(*) AS n FROM reports WHERE domain = ? AND at > ? AND id_age_ms < ? AND cred != ?", domain, t - DAY, youngMs, c.id).n;
        if (n >= L.newIdentityReportsPerDomainPerDay) fixed.push("velocity");
      }
      const before = this.flagCache.get(domain) ?? this._flaggedIds(domain), ev = verified ? "verified" : "reported";   // a stale "before" only affects an informational audit line
      if (existing) this.db.run("UPDATE reports SET outcome = ?, tags = ?, at = ?, net = ?, id_age_ms = ?, evidence = ?, fixed = ?, edits = edits + 1, mod = NULL WHERE id = ?", outcome, tags2, t, net, idAgeMs, ev, JSON.stringify(fixed), existing.id);
      else this.db.run("INSERT INTO reports (id, domain, cred, net, outcome, tags, at, id_age_ms, evidence, fixed, edits, mod) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)", rid(), domain, c.id, net, outcome, tags2, t, idAgeMs, ev, JSON.stringify(fixed));
      const after = this._flaggedIds(domain);
      if (this.flagCache.size > 5000) this.flagCache.clear();
      this.flagCache.set(domain, after);
      const fresh = [...after].filter((id) => !before.has(id));
      if (fresh.length) { this._audit("system", "quarantine", domain, `${fresh.length} report(s) held back from scoring`); this.count("reports_quarantined_total", fresh.length); }
      this.count("reports_submitted_total");
      return { ok: true };                                    // the caller is never told whether a report was held back
    });
  }
  deleteReport(token, domain) {
    const c = this._cred(token); domain = cleanDomain(domain);
    return this.db.tx(() => {
      if (!this.db.run("DELETE FROM reports WHERE cred = ? AND domain = ?", c.id, domain).changes) throw new ApiError(404, "no such report");
      this._audit("reporter", "delete_report", domain, "own report removed");
      return { ok: true };
    });
  }
  eraseCredential(token) {                                    // right to erasure: the identity and everything it reported
    const c = this._cred(token);
    return this.db.tx(() => {
      const n = this.db.get("SELECT COUNT(*) AS n FROM reports WHERE cred = ?", c.id).n;
      this.db.run("DELETE FROM credentials WHERE id = ?", c.id);                     // reports go with it (ON DELETE CASCADE)
      this._audit("reporter", "erase_credential", short(c.id), `${n} report(s) removed`);
      return { ok: true, removed: n };
    });
  }

  // ---------- evaluation ----------
  _rows(domain) {
    const cut = this.now() - this.cfg.windowDays * DAY;
    // Bounded work per request: only the newest maxEvaluateRows reports of a domain are considered, so one hot (or attacked) domain
    // cannot make every request slow.
    return this.db.all("SELECT * FROM (SELECT r.*, c.revoked AS cred_revoked FROM reports r LEFT JOIN credentials c ON c.id = r.cred WHERE r.domain = ? AND r.at >= ? ORDER BY r.at DESC, r.id DESC LIMIT ?) ORDER BY at, id",
      domain, cut, this.cfg.maxEvaluateRows).map((r) => this._row(r));
  }
  evaluate(domain) {
    const live = this._rows(domain);
    const out = live.filter((r) => r.mod === "rejected" || r.credRevoked).map((r) => ({ ...r, status: "rejected", reasons: [], w: 0 }));
    const rest = live.filter((r) => !(r.mod === "rejected" || r.credRevoked));
    const flags = detect(rest, this.now(), this.cfg);
    const status = rest.map((r) => {
      const reasons = r.mod === "approved" ? [] : [...r.fixed, ...(flags.get(r.id) || [])];
      return { ...r, status: reasons.length ? "quarantined" : "scored", reasons };
    });
    const weights = weigh(status.filter((r) => r.status === "scored"), this.now(), this.cfg);
    return [...status.map((r) => ({ ...r, w: r.status === "scored" ? weights.get(r.id) : 0 })), ...out];
  }
  _flaggedIds(domain) { return new Set(this.evaluate(domain).filter((r) => r.status === "quarantined").map((r) => r.id)); }

  summary(domain) {
    domain = cleanDomain(domain);
    if (!domain) throw new ApiError(400, "invalid domain");
    // Valid only while no write has happened since it was computed (db.writes) and it is still fresh (recency weights drift with time).
    const hit = this.sumCache.get(domain), w = this.db.writes;
    if (hit && hit.w === w && this.now() - hit.at < this.cfg.summaryCacheMs) return hit.value;
    const value = this._summary(domain);
    if (this.sumCache.size > 5000) this.sumCache.clear();
    this.sumCache.set(domain, { at: this.now(), value, w: this.db.writes });
    return value;
  }
  _summary(domain) {
    const ev = this.evaluate(domain), counted = ev.filter((r) => r.status !== "rejected"), scored = ev.filter((r) => r.status === "scored");
    const D = this.cfg.display, effectiveN = scored.reduce((n, r) => n + r.w, 0);
    const clusters = new Set(scored.filter((r) => r.w > 0).map((r) => r.net)).size;
    const disputed = !!this.db.get("SELECT 1 AS x FROM disputes WHERE domain = ? AND status IN ('open', 'appealed') AND merchant_verified = 1", domain);
    const base = { domain, total: counted.length, windowDays: this.cfg.windowDays, disputed, verification: "unverified" };
    if (effectiveN < D.minEffective || clusters < D.minClusters) return { ...base, hidden: counted.length > 0 };
    const problemW = scored.filter((r) => r.outcome !== "ok").reduce((n, r) => n + r.w, 0), outcomes = { ok: 0, problem: 0, never: 0 }, tags = {};
    for (const r of scored) { outcomes[r.outcome]++; for (const x of r.tags) tags[x] = (tags[x] || 0) + 1; }
    const verified = scored.filter((r) => r.evidence === "verified").length;
    return { ...base, hidden: false, outcomes, tags, effectiveN: Math.round(effectiveN * 10) / 10, clusters,
      reported: scored.length - verified, verified, problemRate: smooth(problemW, effectiveN, this.cfg.prior) };
  }

  // ---------- moderation ----------
  // Paginated: scans up to `scan` recent domains after `after`, returns those with held-back reports and a cursor for the next page.
  queue({ limit = 50, after = "", scan = 500, budgetMs = 250 } = {}) {
    limit = Math.max(1, Math.min(200, limit | 0 || 50));
    const t0 = Date.now();                                  // a time budget keeps this admin call from monopolising the (single) thread
    const cut = this.now() - this.cfg.windowDays * DAY, domains = this.db.all("SELECT DISTINCT domain FROM reports WHERE at >= ? AND domain > ? ORDER BY domain LIMIT ?", cut, String(after), scan).map((r) => r.domain);
    const items = []; let last = after;
    for (const d of domains) {
      last = d;
      const q = this.evaluate(d).filter((r) => r.status === "quarantined");
      if (q.length) items.push({ domain: d, reports: q.map((r) => ({ id: r.id, outcome: r.outcome, tags: r.tags, at: r.at, reasons: r.reasons, network: r.net.slice(0, 6), identityAgeDays: Math.round(r.idAgeMs / DAY * 10) / 10 })) });
      if (items.length >= limit || Date.now() - t0 > budgetMs) break;
    }
    // Finished only when every domain of this scan was processed AND the scan was not truncated by `scan`. An empty page is the end
    // (an earlier version returned a cursor for it, so a client following cursors could loop forever).
    const finished = last === (domains.length ? domains[domains.length - 1] : last) && domains.length < scan;
    return { items, next: finished ? null : last };
  }
  queueLength() { return this.queue({ limit: 200 }).items.length; }
  moderate(ids, action, actor = "moderator") {
    if (!["approve", "reject", "restore"].includes(action)) throw new ApiError(400, "invalid action");
    if (!Array.isArray(ids) || !ids.length || ids.some((i) => typeof i !== "string" || !/^[a-f0-9]{16}$/.test(i))) throw new ApiError(404, "no such reports");
    return this.db.tx(() => {
      const mod = action === "approve" ? "approved" : action === "reject" ? "rejected" : null;
      let changed = 0, domain = "";
      for (const id of ids) { const r = this.db.get("SELECT domain FROM reports WHERE id = ?", id); if (r) { this.db.run("UPDATE reports SET mod = ? WHERE id = ?", mod, id); changed++; domain ||= r.domain; } }
      if (!changed) throw new ApiError(404, "no such reports");
      this._audit(actor, action, domain, `${changed} report(s)`);
      return { ok: true, changed };
    });
  }
  revokeCredential(credentialId, actor = "moderator") {
    return this.db.tx(() => {
      if (!this.db.run("UPDATE credentials SET revoked = 1 WHERE id = ?", String(credentialId)).changes) throw new ApiError(404, "no such credential");
      this._audit(actor, "revoke_credential", short(credentialId), "credential revoked; its reports no longer count");
      return { ok: true };
    });
  }

  // ---------- merchant disputes (with one appeal) ----------
  openDispute({ domain, message, contact }) {
    domain = cleanDomain(domain);
    if (!domain) throw new ApiError(400, "invalid domain");
    if (typeof message !== "string" || message.trim().length < 10 || message.length > 2000) throw new ApiError(400, "describe the problem in 10-2000 characters");
    const token = crypto.randomBytes(16).toString("hex"), id = rid();
    return this.db.tx(() => {
      if (!this._allow("dispute:" + domain, DAY, 5)) throw new ApiError(429, "too many disputes for this domain today");
      this.db.run("INSERT INTO disputes (id, domain, message, contact, token_hash, created_at, status) VALUES (?, ?, ?, ?, ?, ?, 'open')", id, domain, message.trim(), typeof contact === "string" ? contact.slice(0, 200) : "", sha(token), this.now());
      this._audit("merchant", "dispute_opened", domain, id);
      return { id, token, instructions: `Publish this exact token at https://${domain}/.well-known/trustcheck-dispute.txt then verify, so we know you control the site.` };
    });
  }
  _dispute(id) { const d = this.db.get("SELECT * FROM disputes WHERE id = ?", String(id)); if (!d) throw new ApiError(404, "no such dispute"); return d; }
  async verifyDispute(id) {
    const d = this._dispute(id);
    if (!this.fetchText) throw new ApiError(501, "ownership verification is not configured");
    let text; try { text = await this.fetchText(`https://${d.domain}/.well-known/trustcheck-dispute.txt`); } catch { throw new ApiError(502, "could not fetch the verification file"); }
    if (!timingSafeEqualStr(sha(String(text).trim()), d.token_hash)) throw new ApiError(400, "verification file does not contain the token");
    return this.db.tx(() => { this.db.run("UPDATE disputes SET merchant_verified = 1 WHERE id = ?", d.id); this._audit("merchant", "dispute_verified", d.domain, d.id); return { ok: true }; });
  }
  resolveDispute(id, resolution, actor = "moderator") {
    return this.db.tx(() => {
      const d = this._dispute(id);
      if (d.status !== "open" && d.status !== "appealed") throw new ApiError(409, "this dispute is already resolved");
      const status = d.status === "appealed" ? "closed" : "resolved";                    // a second resolution is final
      this.db.run("UPDATE disputes SET status = ?, resolution = ? WHERE id = ?", status, String(resolution || "").slice(0, 1000), d.id);
      this._audit(actor, status === "closed" ? "dispute_closed" : "dispute_resolved", d.domain, d.id);
      return { ok: true, status };
    });
  }
  // The merchant (holder of the dispute token) may ask for ONE review of a resolution, by a different pass of moderation.
  appealDispute(id, token, message) {
    return this.db.tx(() => {
      const d = this._dispute(id);
      if (!timingSafeEqualStr(sha(String(token || "")), d.token_hash)) throw new ApiError(403, "invalid dispute token");
      if (d.status !== "resolved") throw new ApiError(409, "only a resolved dispute can be appealed");
      if (d.appeals >= 1) throw new ApiError(409, "this dispute has already been appealed");
      if (typeof message !== "string" || message.trim().length < 10 || message.length > 2000) throw new ApiError(400, "explain the appeal in 10-2000 characters");
      this.db.run("UPDATE disputes SET status = 'appealed', appeals = 1, appeal_message = ? WHERE id = ?", message.trim(), d.id);
      this._audit("merchant", "dispute_appealed", d.domain, d.id);
      return { ok: true };
    });
  }
  disputeStatus(id, token) {                                   // what the merchant sees: status and decision, never other people's data
    const d = this._dispute(id);
    if (!timingSafeEqualStr(sha(String(token || "")), d.token_hash)) throw new ApiError(403, "invalid dispute token");
    return { id: d.id, domain: d.domain, status: d.status, merchantVerified: !!d.merchant_verified, resolution: d.resolution, appeals: d.appeals };
  }
  listDisputes({ status = null, limit = 50, offset = 0 } = {}) {
    limit = Math.max(1, Math.min(200, limit | 0 || 50));
    const rows = status ? this.db.all("SELECT * FROM disputes WHERE status = ? ORDER BY created_at LIMIT ? OFFSET ?", status, limit, offset | 0) : this.db.all("SELECT * FROM disputes ORDER BY created_at LIMIT ? OFFSET ?", limit, offset | 0);
    return rows.map(({ token_hash, ...d }) => ({ ...d, merchantVerified: !!d.merchant_verified, merchant_verified: undefined }));   // the proof is never listed
  }

  // ---------- audit ----------
  auditLog({ after = 0, limit = 50 } = {}) {
    limit = Math.max(1, Math.min(200, limit | 0 || 50));
    return this.db.all("SELECT seq, ts, actor, action, target, detail, prev, hash FROM audit WHERE seq > ? ORDER BY seq LIMIT ?", after | 0, limit);
  }
  verifyAudit() {                                              // streams the whole chain in pages: safe for a large log
    let after = 0, prev = AUDIT_GENESIS, n = 0;
    for (;;) {
      const page = this.db.all("SELECT seq, ts, actor, action, target, detail, prev, hash FROM audit WHERE seq > ? ORDER BY seq LIMIT 2000", after);
      if (!page.length) break;
      const v = verifyAuditFrom(page, prev);
      if (!v.ok) return { ok: false, brokenAt: page[v.brokenAt].seq };
      prev = page[page.length - 1].hash; after = page[page.length - 1].seq; n += page.length;
    }
    return { ok: true, length: n };
  }

  // ---------- retention and housekeeping ----------
  purge() {
    const t = this.now(), R = this.cfg.retentionDays * DAY;
    return this.db.tx(() => {
      const out = {
        reports: this.db.run("DELETE FROM reports WHERE at < ?", t - R).changes,
        credentials: this.db.run("DELETE FROM credentials WHERE created_at < ? AND NOT EXISTS (SELECT 1 FROM reports WHERE reports.cred = credentials.id)", t - 30 * DAY).changes,
        challenges: this.db.run("DELETE FROM used_challenges WHERE expires < ?", t).changes,
        rateEvents: this.db.run("DELETE FROM rate_events WHERE ts < ?", t - 25 * HOUR).changes,
        disputes: this.db.run("DELETE FROM disputes WHERE status IN ('resolved', 'closed') AND created_at < ?", t - 365 * DAY).changes
      };
      const total = Object.values(out).reduce((a, b) => a + b, 0);
      if (total) this._audit("system", "retention_purge", "", JSON.stringify(out));
     
      return out;
    });
  }
  prune() { return this.purge(); }

  // ---------- health ----------
  schema() { return schemaStatus(this.db); }
  readiness() {
    const checks = {};
    try { this.db.get("SELECT 1 AS ok"); checks.database = "ok"; } catch { checks.database = "unreachable"; }
    try { const s = this.schema(); checks.schema = s.current === latestVersion() && !s.pending.length ? "ok" : `at ${s.current}, expected ${latestVersion()}`; } catch { checks.schema = "unreadable"; }
    try { this.db.exec("BEGIN IMMEDIATE"); this.db.exec("ROLLBACK"); checks.writable = "ok"; } catch { checks.writable = "read-only or locked"; }
    return { ok: Object.values(checks).every((v) => v === "ok"), checks };
  }
}
