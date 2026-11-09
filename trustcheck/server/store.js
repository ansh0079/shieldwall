// Report store with abuse resistance. No dependencies. State is one JSON file (see DEPLOY.md: move to a database before scale).
// Reports are anonymous, UNVERIFIED context. See abuse.js for the heuristics and their limits.
import fs from "node:fs";
import crypto from "node:crypto";
import { DAY, HOUR, mergeConfig, netRange, netHash, weigh, detect, smooth, payloadKey } from "./abuse.js";
import { signToken, verifyToken, makeChallenge, verifyPow } from "./credentials.js";
import { appendAudit, verifyAudit } from "./audit.js";

export const OUTCOMES = ["ok", "problem", "never"];
export const TAGS = ["delayed", "wrong_item", "fake_tracking", "missing_items", "not_as_described", "poor_quality",
  "counterfeit", "damaged", "refund_refused", "unresponsive", "hidden_fees", "charged_no_confirmation", "card_misuse"];

export class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
const rid = () => crypto.randomBytes(8).toString("hex");

export function cleanDomain(d) {
  d = String(d || "").toLowerCase().trim();
  return /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(d) && !/^\d+(\.\d+){3}$/.test(d) ? d : null;
}

export class ReportStore {
  constructor({ file = null, now = () => Date.now(), salt = "dev-salt", secret = "dev-secret", config = {}, fetchText = null, verifyPurchase = null } = {}) {
    Object.assign(this, { file, now, salt, secret, cfg: mergeConfig(config), fetchText, verifyPurchase });
    this.credentials = new Map(); this.reports = []; this.disputes = []; this.audit = [];
    this.windows = new Map(); this.usedChallenges = new Map(); this.dirty = false;
    if (file && fs.existsSync(file)) this._load(JSON.parse(fs.readFileSync(file, "utf8")));
    this.prune();
  }

  // ---------- persistence ----------
  _load(s) {
    if (Array.isArray(s)) { fs.renameSync(this.file, this.file + ".v1.bak"); return; }   // pre-credential format: incompatible, kept as a backup
    for (const c of s.credentials || []) this.credentials.set(c.id, c);
    this.reports = s.reports || []; this.disputes = s.disputes || []; this.audit = s.audit || [];
  }
  flush() {
    if (!this.file || !this.dirty) return;
    this.prune();
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ v: 2, credentials: [...this.credentials.values()], reports: this.reports, disputes: this.disputes, audit: this.audit }));
    fs.renameSync(tmp, this.file);
    this.dirty = false;
  }
  prune() {
    const cutoff = this.now() - this.cfg.retentionDays * DAY, before = this.reports.length;
    this.reports = this.reports.filter((r) => r.at >= cutoff);
    if (this.reports.length !== before) this.dirty = true;
    for (const [k, t] of this.usedChallenges) if (t < this.now()) this.usedChallenges.delete(k);
  }
  _audit(actor, action, target, detail) { appendAudit(this.audit, { ts: this.now(), actor, action, target, detail }); this.dirty = true; }
  _allow(key, windowMs, max) {
    const t = this.now(), arr = (this.windows.get(key) || []).filter((x) => t - x < windowMs);
    if (arr.length >= max) { this.windows.set(key, arr); return false; }
    arr.push(t); this.windows.set(key, arr); return true;
  }
  _net(ip) { return netHash(netRange(ip), this.salt); }

  // ---------- credentials ----------
  challenge() { return { challenge: makeChallenge(this.secret, { bits: this.cfg.powBits, now: this.now() }), bits: this.cfg.powBits }; }
  enroll({ ip, challenge, solution }) {
    const v = verifyPow(challenge, solution, this.secret, { now: this.now(), minBits: this.cfg.powBits });
    if (!v.ok) throw new ApiError(400, "proof of work rejected: " + v.reason);
    if (this.usedChallenges.has(challenge)) throw new ApiError(400, "proof of work rejected: already used");
    const net = this._net(ip), L = this.cfg.limits, t = this.now();
    const recent = [...this.credentials.values()].filter((c) => t - c.createdAt < DAY && c.net === net).length;
    if (recent >= L.enrollPerNetPerDay) throw new ApiError(429, "too many new identities from this network");
    if (!this._allow("enroll:all", HOUR, L.enrollPerHour)) throw new ApiError(429, "enrolment is busy, try again later");
    if (this.credentials.size >= L.maxCredentials) throw new ApiError(503, "server full");
    this.usedChallenges.set(challenge, t + 10 * 60_000);
    const id = crypto.randomBytes(12).toString("hex");
    this.credentials.set(id, { id, createdAt: t, net, revoked: false });
    this.dirty = true;
    return { token: signToken({ c: id, i: t }, this.secret), credentialId: id };
  }
  _cred(token) {
    const p = verifyToken(token, this.secret), c = p && this.credentials.get(p.c);
    if (!c || c.revoked) throw new ApiError(401, "invalid or revoked credential");
    return c;
  }

  // ---------- reports ----------
  submit({ token, ip, domain, outcome, tags = [], proof }) {
    const c = this._cred(token);
    domain = cleanDomain(domain);
    if (!domain) throw new ApiError(400, "invalid domain");
    if (!OUTCOMES.includes(outcome)) throw new ApiError(400, "invalid outcome");
    if (!Array.isArray(tags) || tags.length > TAGS.length || tags.some((x) => !TAGS.includes(x))) throw new ApiError(400, "invalid tags");
    if (proof !== undefined && (typeof proof !== "string" || proof.length > 4096)) throw new ApiError(400, "invalid proof");
    const L = this.cfg.limits, t = this.now(), net = this._net(ip);
    const existing = this.reports.find((r) => r.cred === c.id && r.domain === domain);
    if (!this._allow("cred:" + c.id, DAY, L.reportsPerCredPerDay)) throw new ApiError(429, "daily report limit reached");
    if (!this._allow("net:" + net, HOUR, L.reportsPerNetPerHour)) throw new ApiError(429, "too many reports from this network");
    if (existing && (existing.edits || 0) >= L.correctionsPerCredPerDomain) throw new ApiError(429, "too many corrections to this report");
    if (!existing && this.reports.length >= L.maxReports) throw new ApiError(503, "server full");

    const idAgeMs = t - c.createdAt, tags2 = outcome === "ok" ? [] : [...new Set(tags)];
    const verified = !!(proof && this.verifyPurchase && this.verifyPurchase(proof, domain));    // no verifier is configured by default
    const young = idAgeMs < this.cfg.detect.youngDays * DAY, fixed = [];
    if (young) {
      const n = this.reports.filter((r) => r.domain === domain && t - r.at < DAY && r.idAgeMs < this.cfg.detect.youngDays * DAY && r.cred !== c.id).length;
      if (n >= L.newIdentityReportsPerDomainPerDay) fixed.push("velocity");
    }
    const before = this._flaggedIds(domain);
    if (existing) Object.assign(existing, { outcome, tags: tags2, at: t, net, idAgeMs, evidence: verified ? "verified" : "reported", fixed, edits: (existing.edits || 0) + 1, mod: null });
    else this.reports.push({ id: rid(), domain, cred: c.id, net, outcome, tags: tags2, at: t, idAgeMs, evidence: verified ? "verified" : "reported", fixed, edits: 0, mod: null });
    this.dirty = true;
    const fresh = [...this._flaggedIds(domain)].filter((id) => !before.has(id));
    if (fresh.length) this._audit("system", "quarantine", domain, `${fresh.length} report(s) held back from scoring`);
    return { ok: true };             // the caller is never told whether a report was held back
  }
  deleteReport(token, domain) {
    const c = this._cred(token); domain = cleanDomain(domain);
    const i = this.reports.findIndex((r) => r.cred === c.id && r.domain === domain);
    if (i < 0) throw new ApiError(404, "no such report");
    this.reports.splice(i, 1); this.dirty = true;
    this._audit("reporter", "delete_report", domain, "own report removed");
    return { ok: true };
  }
  eraseCredential(token) {                           // right to erasure: the identity and everything it reported
    const c = this._cred(token), n = this.reports.filter((r) => r.cred === c.id).length;
    this.reports = this.reports.filter((r) => r.cred !== c.id);
    this.credentials.delete(c.id); this.dirty = true;
    this._audit("reporter", "erase_credential", crypto.createHash("sha256").update(c.id).digest("hex").slice(0, 12), `${n} report(s) removed`);
    return { ok: true, removed: n };
  }

  // ---------- evaluation ----------
  _live(domain) { const cut = this.now() - this.cfg.windowDays * DAY; return this.reports.filter((r) => r.domain === domain && r.at >= cut); }
  evaluate(domain) {
    const live = this._live(domain);
    const out = live.filter((r) => r.mod === "rejected" || this.credentials.get(r.cred)?.revoked).map((r) => ({ ...r, status: "rejected", reasons: [], w: 0 }));
    const rest = live.filter((r) => !out.some((o) => o.id === r.id));
    const flags = detect(rest, this.now(), this.cfg);
    const status = rest.map((r) => {
      const reasons = r.mod === "approved" ? [] : [...(r.fixed || []), ...(flags.get(r.id) || [])];
      return { ...r, status: reasons.length ? "quarantined" : "scored", reasons };
    });
    const weights = weigh(status.filter((r) => r.status === "scored"), this.now(), this.cfg);
    return [...status.map((r) => ({ ...r, w: r.status === "scored" ? weights.get(r.id) : 0 })), ...out];
  }
  _flaggedIds(domain) { return new Set(this.evaluate(domain).filter((r) => r.status === "quarantined").map((r) => r.id)); }

  summary(domain) {
    domain = cleanDomain(domain);
    if (!domain) throw new ApiError(400, "invalid domain");
    const ev = this.evaluate(domain), counted = ev.filter((r) => r.status !== "rejected"), scored = ev.filter((r) => r.status === "scored");
    const D = this.cfg.display, effectiveN = scored.reduce((n, r) => n + r.w, 0);
    const clusters = new Set(scored.filter((r) => r.w > 0).map((r) => r.net)).size;
    const disputed = this.disputes.some((d) => d.domain === domain && d.status === "open" && d.merchantVerified);
    const base = { domain, total: counted.length, windowDays: this.cfg.windowDays, disputed, verification: "unverified" };
    if (effectiveN < D.minEffective || clusters < D.minClusters) return { ...base, hidden: counted.length > 0 };
    const problemW = scored.filter((r) => r.outcome !== "ok").reduce((n, r) => n + r.w, 0), outcomes = { ok: 0, problem: 0, never: 0 }, tags = {};
    for (const r of scored) { outcomes[r.outcome]++; for (const x of r.tags) tags[x] = (tags[x] || 0) + 1; }
    const verified = scored.filter((r) => r.evidence === "verified").length;
    return { ...base, hidden: false, outcomes, tags, effectiveN: Math.round(effectiveN * 10) / 10, clusters,
      reported: scored.length - verified, verified, problemRate: smooth(problemW, effectiveN, this.cfg.prior) };
  }

  // ---------- moderation ----------
  queue() {
    const domains = [...new Set(this.reports.map((r) => r.domain))], out = [];
    for (const d of domains) {
      const q = this.evaluate(d).filter((r) => r.status === "quarantined");
      if (q.length) out.push({ domain: d, reports: q.map((r) => ({ id: r.id, outcome: r.outcome, tags: r.tags, at: r.at, reasons: r.reasons, network: r.net.slice(0, 6), identityAgeDays: Math.round(r.idAgeMs / DAY * 10) / 10 })) });
    }
    return out;
  }
  moderate(ids, action, actor = "moderator") {
    if (!["approve", "reject", "restore"].includes(action)) throw new ApiError(400, "invalid action");
    const hit = this.reports.filter((r) => ids.includes(r.id));
    if (!hit.length) throw new ApiError(404, "no such reports");
    for (const r of hit) r.mod = action === "approve" ? "approved" : action === "reject" ? "rejected" : null;
    this.dirty = true;
    this._audit(actor, action, hit[0].domain, `${hit.length} report(s)`);
    return { ok: true, changed: hit.length };
  }
  revokeCredential(credentialId, actor = "moderator") {
    const c = this.credentials.get(credentialId);
    if (!c) throw new ApiError(404, "no such credential");
    c.revoked = true; this.dirty = true;
    this._audit(actor, "revoke_credential", crypto.createHash("sha256").update(c.id).digest("hex").slice(0, 12), "credential revoked; its reports no longer count");
    return { ok: true };
  }

  // ---------- merchant disputes ----------
  openDispute({ domain, message, contact }) {
    domain = cleanDomain(domain);
    if (!domain) throw new ApiError(400, "invalid domain");
    if (typeof message !== "string" || message.trim().length < 10 || message.length > 2000) throw new ApiError(400, "describe the problem in 10-2000 characters");
    if (!this._allow("dispute:" + domain, DAY, 5)) throw new ApiError(429, "too many disputes for this domain today");
    const d = { id: rid(), domain, message: message.trim(), contact: typeof contact === "string" ? contact.slice(0, 200) : "", token: crypto.randomBytes(16).toString("hex"),
      createdAt: this.now(), status: "open", merchantVerified: false, resolution: "" };
    this.disputes.push(d); this.dirty = true;
    this._audit("merchant", "dispute_opened", domain, d.id);
    return { id: d.id, token: d.token, instructions: `Publish this exact token at https://${domain}/.well-known/trustcheck-dispute.txt then verify, so we know you control the site.` };
  }
  async verifyDispute(id) {
    const d = this.disputes.find((x) => x.id === id);
    if (!d) throw new ApiError(404, "no such dispute");
    if (!this.fetchText) throw new ApiError(501, "ownership verification is not configured");
    let text; try { text = await this.fetchText(`https://${d.domain}/.well-known/trustcheck-dispute.txt`); } catch { throw new ApiError(502, "could not fetch the verification file"); }
    if (String(text).trim() !== d.token) throw new ApiError(400, "verification file does not contain the token");
    d.merchantVerified = true; this.dirty = true;
    this._audit("merchant", "dispute_verified", d.domain, d.id);
    return { ok: true };
  }
  resolveDispute(id, resolution, actor = "moderator") {
    const d = this.disputes.find((x) => x.id === id);
    if (!d) throw new ApiError(404, "no such dispute");
    d.status = "resolved"; d.resolution = String(resolution || "").slice(0, 1000); this.dirty = true;
    this._audit(actor, "dispute_resolved", d.domain, d.id);
    return { ok: true };
  }
  listDisputes() { return this.disputes.map(({ token, ...d }) => d); }   // the proof token is never listed

  auditLog() { return this.audit.slice(); }
  verifyAudit() { return verifyAudit(this.audit); }
}
export { payloadKey };
