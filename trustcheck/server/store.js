// Report store: validation, one-report-per-install-per-domain, aggregation, and abuse mitigations.
// Supports both in-memory/JSON-file and native SQLite (node:sqlite) storage.
import fs from "node:fs";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const OUTCOMES = ["ok", "problem", "never"];
export const TAGS = ["delayed", "wrong_item", "fake_tracking", "missing_items", "not_as_described", "poor_quality",
  "counterfeit", "damaged", "refund_refused", "unresponsive", "hidden_fees", "charged_no_confirmation", "card_misuse"];
const DAY = 86400000;
const HOUR = 3600000;

export class Store {
  constructor({ file = null, minReports = 3, windowDays = 30, retentionDays = 90, salt = "dev-salt",
    maxPerInstallPerDay = 20, maxPerDomainPerHour = 25, maxReports = 500000, now = () => Date.now() } = {}) {
    Object.assign(this, { file, minReports, windowDays, retentionDays, salt, maxPerInstallPerDay, maxPerDomainPerHour, maxReports, now });
    this.reports = new Map(); // `${domain}|${installHash}` -> report
    this.domainBursts = new Map(); // domain -> timestamps
    this.merchantVerifications = new Map(); // domain -> {token, method, verifiedAt}
    this.orderLogs = []; // in-memory order logs
    this.dirty = false;

    // Check if SQLite file requested
    this.useSqlite = file && (file.endsWith(".sqlite") || file.endsWith(".db"));
    if (this.useSqlite) {
      try {
        const { DatabaseSync } = require("node:sqlite");
        this.db = new DatabaseSync(file);
        this.db.exec("PRAGMA journal_mode = WAL;");
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS reports (
            domain TEXT NOT NULL,
            install TEXT NOT NULL,
            outcome TEXT NOT NULL,
            tags TEXT NOT NULL,
            proof TEXT NOT NULL,
            purchase TEXT,
            at INTEGER NOT NULL,
            PRIMARY KEY (domain, install)
          );
          CREATE INDEX IF NOT EXISTS idx_reports_domain_at ON reports (domain, at);
          CREATE TABLE IF NOT EXISTS merchant_verifications (
            domain TEXT PRIMARY KEY,
            token TEXT NOT NULL,
            method TEXT NOT NULL,
            verified_at INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS order_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            domain TEXT NOT NULL,
            storefront_name TEXT,
            receiver_name TEXT,
            trustpilot_score REAL,
            trustpilot_count INTEGER,
            trustpilot_url TEXT,
            outcome TEXT NOT NULL,
            order_date TEXT,
            answer_date TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_order_logs_domain ON order_logs (domain);
        `);
      } catch {
        this.useSqlite = false;
      }
    }

    if (!this.useSqlite && file && fs.existsSync(file)) {
      try {
        for (const r of JSON.parse(fs.readFileSync(file, "utf8"))) {
          this.reports.set(`${r.domain}|${r.install}`, r);
        }
      } catch {
        /* invalid or empty file */
      }
    }
    this.prune();
  }

  static cleanDomain(d) {
    d = String(d || "").toLowerCase().trim().replace(/\.+$/, "");
    return /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(d) ? d : null;
  }

  // Raw install IDs are never stored: only a salted HMAC.
  hashInstall(id) {
    return crypto.createHmac("sha256", this.salt).update(id).digest("hex").slice(0, 32);
  }

  // Issue a server-signed client credential token
  issueCredential(id = null) {
    const installId = id || crypto.randomUUID();
    const sig = crypto.createHmac("sha256", this.salt).update(`cred:${installId}`).digest("hex").slice(0, 32);
    return { installId, token: sig, issuedAt: this.now() };
  }

  // Verify server-issued client token
  verifyCredential(installId, token) {
    if (!installId || !token) return false;
    const expected = crypto.createHmac("sha256", this.salt).update(`cred:${installId}`).digest("hex").slice(0, 32);
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  }

  // Register verified merchant domain
  addMerchantVerification(domain, token, method = "well-known") {
    domain = Store.cleanDomain(domain);
    if (!domain) throw new Error("invalid domain");
    const record = { domain, token, method, verifiedAt: this.now() };
    if (this.useSqlite && this.db) {
      const stmt = this.db.prepare("INSERT OR REPLACE INTO merchant_verifications (domain, token, method, verified_at) VALUES (?, ?, ?, ?)");
      stmt.run(domain, token, method, record.verifiedAt);
    } else {
      this.merchantVerifications.set(domain, record);
    }
    return record;
  }

  getMerchantVerification(domain) {
    domain = Store.cleanDomain(domain);
    if (!domain) return null;
    if (this.useSqlite && this.db) {
      const row = this.db.prepare("SELECT * FROM merchant_verifications WHERE domain = ?").get(domain);
      return row ? { domain: row.domain, token: row.token, method: row.method, verifiedAt: row.verified_at } : null;
    }
    return this.merchantVerifications.get(domain) || null;
  }

  // Step 4: Record verified outcome in order log for payment processors
  addOrderLog({
    domain,
    storefrontName = "",
    receiverName = "",
    trustpilotScore = null,
    trustpilotCount = null,
    trustpilotUrl = "",
    outcome,
    orderDate = "",
    answerDate = null
  }) {
    domain = Store.cleanDomain(domain);
    if (!domain) throw new Error("invalid domain");
    const ans = answerDate || new Date(this.now()).toISOString();
    const row = {
      domain,
      storefrontName: storefrontName || null,
      receiverName: receiverName || null,
      trustpilotScore: trustpilotScore !== null ? Number(trustpilotScore) : null,
      trustpilotCount: trustpilotCount !== null ? Number(trustpilotCount) : null,
      trustpilotUrl: trustpilotUrl || `https://www.trustpilot.com/review/${domain}`,
      outcome,
      orderDate: orderDate || null,
      answerDate: ans
    };
    if (this.useSqlite && this.db) {
      const stmt = this.db.prepare(`
        INSERT INTO order_logs (domain, storefront_name, receiver_name, trustpilot_score, trustpilot_count, trustpilot_url, outcome, order_date, answer_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        row.domain,
        row.storefrontName,
        row.receiverName,
        row.trustpilotScore,
        row.trustpilotCount,
        row.trustpilotUrl,
        row.outcome,
        row.orderDate,
        row.answerDate
      );
    } else {
      this.orderLogs.push(row);
      this.dirty = true;
    }
    return row;
  }

  getOrderLogs(domain = null) {
    if (this.useSqlite && this.db) {
      if (domain) {
        return this.db.prepare("SELECT domain, storefront_name AS storefrontName, receiver_name AS receiverName, trustpilot_score AS trustpilotScore, trustpilot_count AS trustpilotCount, trustpilot_url AS trustpilotUrl, outcome, order_date AS orderDate, answer_date AS answerDate FROM order_logs WHERE domain = ? ORDER BY id DESC").all(domain);
      }
      return this.db.prepare("SELECT domain, storefront_name AS storefrontName, receiver_name AS receiverName, trustpilot_score AS trustpilotScore, trustpilot_count AS trustpilotCount, trustpilot_url AS trustpilotUrl, outcome, order_date AS orderDate, answer_date AS answerDate FROM order_logs ORDER BY id DESC").all();
    }
    if (domain) return this.orderLogs.filter((x) => x.domain === domain);
    return [...this.orderLogs];
  }

  add({ installId, domain, outcome, tags = [], purchaseId = null }) {
    domain = Store.cleanDomain(domain);
    if (!domain) throw new Error("invalid domain");
    if (!OUTCOMES.includes(outcome)) throw new Error("invalid outcome");
    if (typeof installId !== "string" || installId.length < 8 || installId.length > 64) throw new Error("invalid installId");
    if (purchaseId !== null && (typeof purchaseId !== "string" || !/^[a-f0-9-]{16,64}$/i.test(purchaseId))) throw new Error("invalid purchaseId");
    if (!Array.isArray(tags) || tags.length > TAGS.length || tags.some((t) => !TAGS.includes(t))) throw new Error("invalid tags");

    const t = this.now();
    const install = this.hashInstall(installId);
    const key = `${domain}|${install}`;

    // Velocity / Burst mitigation
    const burstWindow = (this.domainBursts.get(domain) || []).filter((x) => t - x < HOUR);
    if (!this.reports.has(key) && burstWindow.length >= this.maxPerDomainPerHour) {
      throw new Error("burst limit reached for this domain");
    }
    burstWindow.push(t);
    this.domainBursts.set(domain, burstWindow);

    if (this.useSqlite && this.db) {
      const dayAgo = t - DAY;
      const countStmt = this.db.prepare("SELECT COUNT(*) AS c FROM reports WHERE install = ? AND at >= ? AND domain != ?");
      const c = countStmt.get(install, dayAgo, domain)?.c || 0;
      if (c >= this.maxPerInstallPerDay) throw new Error("daily report limit reached");

      const insertStmt = this.db.prepare(`
        INSERT INTO reports (domain, install, outcome, tags, proof, purchase, at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(domain, install) DO UPDATE SET
          outcome = excluded.outcome,
          tags = excluded.tags,
          proof = excluded.proof,
          purchase = excluded.purchase,
          at = excluded.at
      `);
      insertStmt.run(
        domain,
        install,
        outcome,
        JSON.stringify(outcome === "ok" ? [] : [...new Set(tags)]),
        purchaseId ? "purchase_observed" : "self_reported",
        purchaseId ? this.hashInstall(purchaseId) : null,
        t
      );
      return;
    }

    const recent = [...this.reports.values()].filter((r) => r.install === install && t - r.at < DAY && `${r.domain}|${r.install}` !== key).length;
    if (recent >= this.maxPerInstallPerDay) throw new Error("daily report limit reached");
    if (!this.reports.has(key) && this.reports.size >= this.maxReports) throw new Error("server full");

    this.reports.set(key, {
      domain,
      install,
      outcome,
      tags: outcome === "ok" ? [] : [...new Set(tags)],
      proof: purchaseId ? "purchase_observed" : "self_reported",
      purchase: purchaseId ? this.hashInstall(purchaseId) : null,
      at: t
    });
    this.dirty = true;
  }

  summary(domain) {
    domain = Store.cleanDomain(domain);
    if (!domain) throw new Error("invalid domain");
    const since = this.now() - this.windowDays * DAY;

    let rows = [];
    if (this.useSqlite && this.db) {
      const q = this.db.prepare("SELECT * FROM reports WHERE domain = ? AND at >= ?");
      rows = q.all(domain, since).map((r) => ({
        domain: r.domain,
        install: r.install,
        outcome: r.outcome,
        tags: JSON.parse(r.tags || "[]"),
        proof: r.proof,
        purchase: r.purchase,
        at: r.at
      }));
    } else {
      rows = [...this.reports.values()].filter((r) => r.domain === domain && r.at >= since);
    }

    const isVerifiedMerchant = !!this.getMerchantVerification(domain);

    // 6-month window (180 days) for verified purchase-observed delivery reports (Step 3)
    const sixMonthsAgo = this.now() - 180 * DAY;
    let sixMonthRows = [];
    if (this.useSqlite && this.db) {
      const q6 = this.db.prepare("SELECT * FROM reports WHERE domain = ? AND at >= ? AND proof = 'purchase_observed'");
      sixMonthRows = q6.all(domain, sixMonthsAgo).map((r) => ({
        outcome: r.outcome,
        tags: JSON.parse(r.tags || "[]")
      }));
    } else {
      sixMonthRows = [...this.reports.values()].filter((r) => r.domain === domain && r.at >= sixMonthsAgo && r.proof === "purchase_observed");
    }

    let sixMonthNonDelivery = 0;
    let sixMonthNotMatched = 0;
    let sixMonthDelivered = 0;
    for (const r of sixMonthRows) {
      if (r.outcome === "never") sixMonthNonDelivery++;
      else if (r.outcome === "ok") sixMonthDelivered++;
      else if (r.outcome === "problem" && (r.tags.includes("not_as_described") || r.tags.includes("wrong_item") || r.tags.includes("counterfeit"))) {
        sixMonthNotMatched++;
      }
    }
    const activeNonDelivery = sixMonthNonDelivery >= this.minReports ? sixMonthNonDelivery : 0;
    const activeNotMatched = sixMonthNotMatched >= this.minReports ? sixMonthNotMatched : 0;

    if (rows.length < this.minReports) {
      return {
        domain,
        total: rows.length,
        hidden: rows.length > 0,
        windowDays: this.windowDays,
        verifiedMerchant: isVerifiedMerchant,
        sixMonthNonDelivery: activeNonDelivery,
        sixMonthNotMatched: activeNotMatched,
        sixMonthDelivered,
        minReports: this.minReports
      };
    }

    const outcomes = { ok: 0, problem: 0, never: 0 };
    const tags = {};
    let purchaseObserved = 0;

    for (const r of rows) {
      outcomes[r.outcome]++;
      if (r.proof === "purchase_observed") purchaseObserved++;
      for (const t of r.tags) tags[t] = (tags[t] || 0) + 1;
    }

    // Bayesian smoothing: prevents 1 or 2 malicious reports from creating extreme ratios
    const priorTotal = 4;
    const priorNever = 0.5;
    const priorProblem = 0.5;
    const smoothedNeverRate = (outcomes.never + priorNever) / (rows.length + priorTotal);
    const smoothedProblemRate = (outcomes.problem + outcomes.never + priorProblem + priorNever) / (rows.length + priorTotal);

    return {
      domain,
      total: rows.length,
      purchaseObserved,
      windowDays: this.windowDays,
      outcomes,
      tags,
      verifiedMerchant: isVerifiedMerchant,
      sixMonthNonDelivery: activeNonDelivery,
      sixMonthNotMatched: activeNotMatched,
      sixMonthDelivered,
      minReports: this.minReports,
      smoothed: {
        neverRate: Number(smoothedNeverRate.toFixed(3)),
        problemRate: Number(smoothedProblemRate.toFixed(3)),
        confidence: rows.length >= 15 ? "high" : rows.length >= 5 ? "medium" : "low"
      }
    };
  }

  prune() {
    const cutoff = this.now() - this.retentionDays * DAY;
    if (this.useSqlite && this.db) {
      this.db.prepare("DELETE FROM reports WHERE at < ?").run(cutoff);
      return;
    }
    for (const [k, r] of this.reports) {
      if (r.at < cutoff) {
        this.reports.delete(k);
        this.dirty = true;
      }
    }
  }

  flush() {
    if (this.useSqlite || !this.file || !this.dirty) return;
    this.prune();
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify([...this.reports.values()]));
    fs.renameSync(tmp, this.file);
    this.dirty = false;
  }
}
