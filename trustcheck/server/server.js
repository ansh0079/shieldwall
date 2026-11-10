// TrustCheck report server. `node server/server.js`
// Env: PORT(8787) HOST(0.0.0.0) DATA_FILE(data.json / reports.sqlite) MIN_REPORTS(3) RATE_LIMIT(20 reports/h/IP)
//      TRUST_PROXY(false: set true behind a reverse proxy) CORS_ORIGIN(*) REPORT_SALT(required in production)
import http from "node:http";
import { Store } from "./store.js";
import { safeBrowsing } from "../lib/providers.js";
import { fetchCompany } from "../lib/companies.js";
import { fetchTrustpilotSummary } from "./trustpilot.js";

export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const xff = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (xff) return xff;
  }
  return req.socket.remoteAddress || "unknown";
}

export function clientSubnet(ip) {
  if (!ip || typeof ip !== "string") return "unknown";
  if (ip.includes(":")) {
    const parts = ip.split(":");
    return parts.slice(0, 3).join(":") + "::/48";
  }
  const parts = ip.split(".");
  if (parts.length === 4) {
    return parts.slice(0, 3).join(".") + ".0/24";
  }
  return ip;
}

export function createServer(store, { rateLimit = 20, readLimit = 300, trustProxy = false, corsOrigin = "*", sbKey = "", chKey = "", tpKey = "" } = {}) {
  const hits = new Map(); // `${kind}|${key}` -> timestamps (1h window)
  const serverCache = new Map(); // key -> { at, data }

  const limited = (kind, key, max) => {
    const t = Date.now(), k = kind + "|" + key, arr = (hits.get(k) || []).filter((x) => t - x < 3600000);
    arr.push(t);
    hits.set(k, arr);
    return arr.length > max;
  };

  const sweep = setInterval(() => {
    const t = Date.now();
    for (const [k, arr] of hits) if (!arr.some((x) => t - x < 3600000)) hits.delete(k);
  }, 600000);
  sweep.unref();

  const srv = http.createServer(async (req, res) => {
    const send = (code, obj, extra = {}) => {
      res.writeHead(code, {
        "content-type": "application/json",
        "x-content-type-options": "nosniff",
        "access-control-allow-origin": corsOrigin,
        "access-control-allow-headers": "content-type, authorization",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        ...extra
      });
      res.end(JSON.stringify(obj));
    };

    if (req.method === "OPTIONS") return send(204, {});
    const url = new URL(req.url, "http://x");
    const ip = clientIp(req, trustProxy);
    const subnet = clientSubnet(ip);

    try {
      if (req.method === "GET" && url.pathname === "/healthz") {
        return send(200, { ok: true, sqlite: !!store.useSqlite });
      }

      // Endpoint to issue a cryptographically signed client installation credential
      if (req.method === "POST" && url.pathname === "/v1/register") {
        if (limited("reg", ip, 15)) return send(429, { error: "rate limited" });
        return send(200, store.issueCredential());
      }

      // Merchant verification endpoints
      if (req.method === "GET" && url.pathname === "/v1/merchant/status") {
        const domain = url.searchParams.get("domain");
        if (!domain) return send(400, { error: "missing domain parameter" });
        const ver = store.getMerchantVerification(domain);
        return send(200, { domain, verified: !!ver, verifiedAt: ver?.verifiedAt || null });
      }

      if (req.method === "POST" && url.pathname === "/v1/merchant/verify") {
        if (limited("merchant-ver", ip, 5)) return send(429, { error: "rate limited" });
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", async () => {
          try {
            const { domain, token } = JSON.parse(body);
            if (!domain || !token) return send(400, { error: "domain and token required" });
            const clean = Store.cleanDomain(domain);
            if (!clean) return send(400, { error: "invalid domain" });

            // In production, fetch https://${clean}/.well-known/trustcheck.json to verify ownership
            let verified = false;
            try {
              const res = await fetch(`https://${clean}/.well-known/trustcheck.json`, {
                headers: { "user-agent": "TrustCheck-Verification/1.0" },
                signal: AbortSignal.timeout(5000)
              });
              if (res.ok) {
                const doc = await res.json();
                if (doc.token === token && (doc.domain === clean || !doc.domain)) {
                  verified = true;
                }
              }
            } catch {
              // Direct network fetch failure
            }

            // Also support local dev token verification
            if (token === `dev-verify-${clean}`) verified = true;

            if (verified) {
              const record = store.addMerchantVerification(clean, token, "well-known");
              return send(200, { ok: true, domain: clean, verifiedAt: record.verifiedAt });
            }
            return send(400, { error: "verification token not found at /.well-known/trustcheck.json" });
          } catch (e) {
            return send(400, { error: e.message });
          }
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/check") {
        if (limited("read", ip, readLimit)) return send(429, { error: "rate limited" });
        const rawDomain = url.searchParams.get("domain");
        const clean = Store.cleanDomain(rawDomain);
        if (!clean) return send(400, { error: "invalid domain" });

        const summary = store.summary(clean);
        const ver = store.getMerchantVerification(clean);
        const targetUrl = url.searchParams.get("url") || `https://${clean}/`;
        const companyNumber = url.searchParams.get("companyNumber");

        // Safe browsing lookup (server-cached)
        let sbResult = null;
        if (sbKey) {
          const sbCacheKey = "sb:" + clean;
          const cachedSb = serverCache.get(sbCacheKey);
          if (cachedSb && Date.now() - cachedSb.at < 6 * 3600 * 1000) {
            sbResult = cachedSb.data;
          } else {
            try {
              sbResult = await safeBrowsing(targetUrl, sbKey);
              serverCache.set(sbCacheKey, { at: Date.now(), data: sbResult });
            } catch {
              sbResult = null;
            }
          }
        }

        // Company profile lookup (server-cached)
        let companyResult = null;
        if (chKey && companyNumber) {
          const coCacheKey = "co:" + companyNumber;
          const cachedCo = serverCache.get(coCacheKey);
          if (cachedCo && Date.now() - cachedCo.at < 24 * 3600 * 1000) {
            companyResult = cachedCo.data;
          } else {
            try {
              const profile = await fetchCompany(companyNumber, chKey);
              companyResult = { profile };
              serverCache.set(coCacheKey, { at: Date.now(), data: companyResult });
            } catch {
              companyResult = null;
            }
          }
        }

        // Trustpilot summary lookup (server-cached)
        let tpResult = null;
        const tpCacheKey = "tp:" + clean;
        const cachedTp = serverCache.get(tpCacheKey);
        if (cachedTp && Date.now() - cachedTp.at < 6 * 3600 * 1000) {
          tpResult = cachedTp.data;
        } else {
          try {
            tpResult = await fetchTrustpilotSummary(clean, tpKey);
            serverCache.set(tpCacheKey, { at: Date.now(), data: tpResult });
          } catch {
            tpResult = { source: "Trustpilot", score: null, count: null, themes: [], url: `https://www.trustpilot.com/review/${clean}` };
          }
        }

        return send(200, {
          domain: clean,
          summary,
          verifiedMerchant: !!ver,
          safeBrowsing: sbResult,
          company: companyResult,
          reviews: tpResult
        }, { "cache-control": "public, max-age=60" });
      }

      if (req.method === "GET" && url.pathname === "/v1/export/orders") {
        const domain = url.searchParams.get("domain") || null;
        const format = url.searchParams.get("format") || "json";
        const rows = store.getOrderLogs(domain);
        if (format === "csv") {
          const header = "Shop domain,Storefront name,Receiver name,Trustpilot score,Trustpilot reviews,Trustpilot URL,Outcome,Order date,Answer date\n";
          const lines = rows.map((r) =>
            [r.domain, r.storefrontName || "", r.receiverName || "", r.trustpilotScore ?? "", r.trustpilotCount ?? "", r.trustpilotUrl || "", r.outcome, r.orderDate || "", r.answerDate].map((f) => `"${String(f).replace(/"/g, '""')}"`).join(",")
          ).join("\n");
          res.writeHead(200, { "content-type": "text/csv", "content-disposition": "attachment; filename=orders-export.csv" });
          return res.end(header + lines);
        }
        return send(200, { ok: true, total: rows.length, rows });
      }

      if (req.method === "GET" && url.pathname === "/v1/summary") {
        if (limited("read", ip, readLimit)) return send(429, { error: "rate limited" });
        return send(200, store.summary(url.searchParams.get("domain")), { "cache-control": "public, max-age=60" });
      }

      if (req.method === "POST" && url.pathname === "/v1/report") {
        if (limited("write", ip, rateLimit) || limited("write-sub", subnet, rateLimit * 3)) {
          return send(429, { error: "rate limited" });
        }
        if (Number(req.headers["content-length"] || 0) > 4096) return send(413, { error: "payload too large" });

        let body = "", tooBig = false;
        req.on("data", (c) => {
          body += c;
          if (body.length > 4096) { tooBig = true; req.destroy(); }
        });
        req.on("end", () => {
          if (tooBig) return;
          try {
            const data = JSON.parse(body);
            store.add(data);

            // Record in order log for payment processor export (Step 4)
            if (data.purchaseId && (data.storefrontName || data.receiverName || data.outcome)) {
              let tpScore = null, tpCount = null, tpUrl = "";
              const tpCacheKey = "tp:" + Store.cleanDomain(data.domain);
              const cached = serverCache.get(tpCacheKey);
              if (cached?.data) {
                tpScore = cached.data.score;
                tpCount = cached.data.count;
                tpUrl = cached.data.url;
              }
              const outcomeNormalized = data.outcome === "never" ? "did_not_arrive" : (data.tags && data.tags.includes("not_as_described")) ? "did_not_match" : "arrived";
              store.addOrderLog({
                domain: data.domain,
                storefrontName: data.storefrontName,
                receiverName: data.receiverName,
                trustpilotScore: tpScore,
                trustpilotCount: tpCount,
                trustpilotUrl: tpUrl,
                outcome: outcomeNormalized,
                orderDate: data.orderDate || "",
                answerDate: data.answerDate || new Date().toISOString()
              });
            }

            send(200, { ok: true });
          } catch (e) {
            const status = e.message.includes("limit") ? 429 : 400;
            send(status, { error: e.message });
          }
        });
        return;
      }
      send(404, { error: "not found" });
    } catch (e) {
      send(400, { error: e.message });
    }
  });

  srv.headersTimeout = 10000;
  srv.requestTimeout = 10000;
  return srv;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = process.env;
  if (env.NODE_ENV === "production" && !env.REPORT_SALT) {
    console.error("REPORT_SALT is required in production");
    process.exit(1);
  }
  const store = new Store({
    file: env.DATABASE_FILE || env.DATA_FILE || "data.json",
    minReports: Number(env.MIN_REPORTS || 3),
    salt: env.REPORT_SALT || "dev-salt"
  });
  const srv = createServer(store, {
    rateLimit: Number(env.RATE_LIMIT || 20),
    trustProxy: env.TRUST_PROXY === "true",
    corsOrigin: env.CORS_ORIGIN || "*",
    sbKey: env.GOOGLE_SAFE_BROWSING_KEY || env.SAFE_BROWSING_KEY || "",
    chKey: env.COMPANIES_HOUSE_KEY || "",
    tpKey: env.TRUSTPILOT_API_KEY || ""
  });
  const timer = setInterval(() => store.flush(), 5000);
  const stop = () => {
    clearInterval(timer);
    store.flush();
    srv.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  srv.listen(Number(env.PORT || 8787), env.HOST || "0.0.0.0", () => {
    console.log(`TrustCheck report server on :${env.PORT || 8787} (SQLite: ${store.useSqlite})`);
  });
}
