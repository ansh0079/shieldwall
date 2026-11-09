// Report store: validation, one-report-per-install-per-domain, aggregation. No dependencies.
import fs from "node:fs";

export const OUTCOMES = ["ok", "problem", "never"];
export const TAGS = ["delayed", "wrong_item", "fake_tracking", "missing_items", "not_as_described", "poor_quality",
  "counterfeit", "damaged", "refund_refused", "unresponsive", "hidden_fees", "charged_no_confirmation", "card_misuse"];
const DAY = 86400000;

export class Store {
  constructor({ file = null, minReports = 3, windowDays = 30, now = () => Date.now() } = {}) {
    this.file = file; this.minReports = minReports; this.windowDays = windowDays; this.now = now;
    this.reports = new Map(); // `${domain}|${installHash}` -> report
    if (file && fs.existsSync(file)) {
      for (const r of JSON.parse(fs.readFileSync(file, "utf8"))) this.reports.set(`${r.domain}|${r.install}`, r);
    }
  }
  static cleanDomain(d) {
    d = String(d || "").toLowerCase().trim();
    return /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(d) ? d : null;
  }
  add({ installId, domain, outcome, tags = [] }) {
    domain = Store.cleanDomain(domain);
    if (!domain) throw new Error("invalid domain");
    if (!OUTCOMES.includes(outcome)) throw new Error("invalid outcome");
    if (typeof installId !== "string" || installId.length < 8 || installId.length > 64) throw new Error("invalid installId");
    if (!Array.isArray(tags) || tags.some((t) => !TAGS.includes(t))) throw new Error("invalid tags");
    const install = [...installId].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(36) + installId.length;
    // one report per install per domain: a newer one replaces the older
    this.reports.set(`${domain}|${install}`, { domain, install, outcome, tags: outcome === "ok" ? [] : [...new Set(tags)], at: this.now() });
    this.save();
  }
  summary(domain) {
    domain = Store.cleanDomain(domain);
    if (!domain) throw new Error("invalid domain");
    const since = this.now() - this.windowDays * DAY;
    const rows = [...this.reports.values()].filter((r) => r.domain === domain && r.at >= since);
    if (rows.length < this.minReports) return { domain, total: rows.length, hidden: rows.length > 0, windowDays: this.windowDays };
    const outcomes = { ok: 0, problem: 0, never: 0 }, tags = {};
    for (const r of rows) { outcomes[r.outcome]++; for (const t of r.tags) tags[t] = (tags[t] || 0) + 1; }
    return { domain, total: rows.length, windowDays: this.windowDays, outcomes, tags };
  }
  save() { if (this.file) fs.writeFileSync(this.file, JSON.stringify([...this.reports.values()])); }
}
