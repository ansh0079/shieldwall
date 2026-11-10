// Report store: validation, one-report-per-install-per-domain, aggregation. No dependencies.
import fs from "node:fs";
import crypto from "node:crypto";

export const OUTCOMES = ["ok", "problem", "never"];
export const TAGS = ["delayed", "wrong_item", "fake_tracking", "missing_items", "not_as_described", "poor_quality",
  "counterfeit", "damaged", "refund_refused", "unresponsive", "hidden_fees", "charged_no_confirmation", "card_misuse"];
const DAY = 86400000;

export class Store {
  constructor({ file = null, minReports = 3, windowDays = 30, retentionDays = 90, salt = "dev-salt",
    maxPerInstallPerDay = 20, maxReports = 500000, now = () => Date.now() } = {}) {
    Object.assign(this, { file, minReports, windowDays, retentionDays, salt, maxPerInstallPerDay, maxReports, now });
    this.reports = new Map(); // `${domain}|${installHash}` -> report
    this.dirty = false;
    if (file && fs.existsSync(file)) {
      for (const r of JSON.parse(fs.readFileSync(file, "utf8"))) this.reports.set(`${r.domain}|${r.install}`, r);
    }
    this.prune();
  }
  static cleanDomain(d) {
    d = String(d || "").toLowerCase().trim();
    return /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(d) ? d : null;
  }
  // Raw install IDs are never stored: only a salted HMAC.
  hashInstall(id) { return crypto.createHmac("sha256", this.salt).update(id).digest("hex").slice(0, 32); }

  add({ installId, domain, outcome, tags = [], purchaseId = null }) {
    domain = Store.cleanDomain(domain);
    if (!domain) throw new Error("invalid domain");
    if (!OUTCOMES.includes(outcome)) throw new Error("invalid outcome");
    if (typeof installId !== "string" || installId.length < 8 || installId.length > 64) throw new Error("invalid installId");
    if (purchaseId !== null && (typeof purchaseId !== "string" || !/^[a-f0-9-]{16,64}$/i.test(purchaseId))) throw new Error("invalid purchaseId");
    if (!Array.isArray(tags) || tags.length > TAGS.length || tags.some((t) => !TAGS.includes(t))) throw new Error("invalid tags");
    const install = this.hashInstall(installId), key = `${domain}|${install}`, t = this.now();
    const recent = [...this.reports.values()].filter((r) => r.install === install && t - r.at < DAY && `${r.domain}|${r.install}` !== key).length;
    if (recent >= this.maxPerInstallPerDay) throw new Error("daily report limit reached");
    if (!this.reports.has(key) && this.reports.size >= this.maxReports) throw new Error("server full");
    // one report per install per domain: a newer one replaces the older
    this.reports.set(key, { domain, install, outcome, tags: outcome === "ok" ? [] : [...new Set(tags)],
      proof: purchaseId ? "purchase_observed" : "self_reported", purchase: purchaseId ? this.hashInstall(purchaseId) : null, at: t });
    this.dirty = true;
  }
  summary(domain) {
    domain = Store.cleanDomain(domain);
    if (!domain) throw new Error("invalid domain");
    const since = this.now() - this.windowDays * DAY;
    const rows = [...this.reports.values()].filter((r) => r.domain === domain && r.at >= since);
    if (rows.length < this.minReports) return { domain, total: rows.length, hidden: rows.length > 0, windowDays: this.windowDays };
    const outcomes = { ok: 0, problem: 0, never: 0 }, tags = {}; let purchaseObserved = 0;
    for (const r of rows) { outcomes[r.outcome]++; if (r.proof === "purchase_observed") purchaseObserved++; for (const t of r.tags) tags[t] = (tags[t] || 0) + 1; }
    return { domain, total: rows.length, purchaseObserved, windowDays: this.windowDays, outcomes, tags };
  }
  prune() {
    const cutoff = this.now() - this.retentionDays * DAY;
    for (const [k, r] of this.reports) if (r.at < cutoff) { this.reports.delete(k); this.dirty = true; }
  }
  // Atomic: write a temp file then rename, so a crash never leaves a half-written data file.
  flush() {
    if (!this.file || !this.dirty) return;
    this.prune();
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify([...this.reports.values()]));
    fs.renameSync(tmp, this.file);
    this.dirty = false;
  }
}
