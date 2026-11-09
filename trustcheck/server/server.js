// TrustCheck report server. `node server/server.js`
// Env: PORT(8787) HOST(0.0.0.0) DATA_FILE(data.json) TRUST_PROXY(false: true behind a reverse proxy) CORS_ORIGIN(*)
//      REPORT_SALT, CREDENTIAL_SECRET (both required in production) ADMIN_TOKEN (enables /admin/*) POW_BITS(16) RATE_LIMIT(20 writes/h/IP)
//      REPORT_CONFIG_JSON (optional overrides of the limits/thresholds in abuse.js DEFAULTS, e.g. {"display":{"minEffective":8}})
import http from "node:http";
import { ReportStore, ApiError } from "./store.js";
import { timingSafeEqualStr } from "./credentials.js";

export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const xff = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (xff) return xff;
  }
  return req.socket.remoteAddress || "unknown";
}

// Close a server completely (idle keep-alive sockets included) and resolve when it is down.
export function shutdown(srv) {
  return new Promise((resolve) => {
    srv.close(() => resolve());
    srv.closeIdleConnections?.(); srv.closeAllConnections?.();
  });
}

export function createServer(store, { rateLimit = 20, readLimit = 300, trustProxy = false, corsOrigin = "*", keepAlive = true, adminToken = "" } = {}) {
  const hits = new Map(); // `${kind}|${ip}` -> timestamps (1h window)
  const limited = (kind, ip, max) => {
    const t = Date.now(), k = kind + "|" + ip, arr = (hits.get(k) || []).filter((x) => t - x < 3600000);
    arr.push(t); hits.set(k, arr); return arr.length > max;
  };
  const sweep = setInterval(() => { const t = Date.now(); for (const [k, arr] of hits) if (!arr.some((x) => t - x < 3600000)) hits.delete(k); }, 600000);
  sweep.unref();

  const bearer = (req) => /^Bearer (\S{1,600})$/.exec(String(req.headers.authorization || ""))?.[1] || "";
  const readBody = (req, max = 8192) => new Promise((resolve, reject) => {
    if (Number(req.headers["content-length"] || 0) > max) return reject(new ApiError(413, "payload too large"));
    let body = "", dead = false;
    req.on("data", (c) => { body += c; if (body.length > max && !dead) { dead = true; reject(new ApiError(413, "payload too large")); req.destroy(); } });
    req.on("end", () => { if (dead) return; if (!body) return resolve({}); try { resolve(JSON.parse(body)); } catch { reject(new ApiError(400, "invalid JSON")); } });
    req.on("error", () => reject(new ApiError(400, "read error")));
  });

  const srv = http.createServer(async (req, res) => {
    const send = (code, obj, extra = {}) => {
      res.writeHead(code, { "content-type": "application/json", "x-content-type-options": "nosniff", ...(keepAlive ? {} : { connection: "close" }),
        "access-control-allow-origin": corsOrigin, "access-control-allow-headers": "content-type, authorization",
        "access-control-allow-methods": "GET,POST,DELETE,OPTIONS", "cache-control": "no-store", ...extra });
      res.end(JSON.stringify(obj));
    };
    if (req.method === "OPTIONS") return send(204, {});
    const url = new URL(req.url, "http://x"), p = url.pathname, ip = clientIp(req, trustProxy), m = req.method;
    try {
      if (m === "GET" && p === "/healthz") return send(200, { ok: true });
      if (m === "GET" && p === "/v1/summary") {
        if (limited("read", ip, readLimit)) return send(429, { error: "rate limited" });
        return send(200, store.summary(url.searchParams.get("domain")), { "cache-control": "public, max-age=60" });
      }
      if (m === "GET" && p === "/v1/challenge") {
        if (limited("read", ip, readLimit)) return send(429, { error: "rate limited" });
        return send(200, store.challenge());
      }
      // ---- admin (separate secret; disabled when no ADMIN_TOKEN is configured) ----
      if (p.startsWith("/admin/")) {
        if (!adminToken) return send(404, { error: "not found" });
        if (limited("admin", ip, 120)) return send(429, { error: "rate limited" });
        const fails = (hits.get("adminfail|" + ip) || []).filter((x) => Date.now() - x < 3600000).length;
        if (fails >= 10) return send(429, { error: "too many failed attempts" });                  // brute-force lockout (1h)
        if (!timingSafeEqualStr(bearer(req), adminToken)) { limited("adminfail", ip, Infinity); return send(401, { error: "unauthorized" }); }
        if (m === "GET" && p === "/admin/queue") return send(200, store.queue());
        if (m === "GET" && p === "/admin/disputes") return send(200, store.listDisputes());
        if (m === "GET" && p === "/admin/audit") return send(200, store.auditLog());
        if (m === "GET" && p === "/admin/audit/verify") return send(200, store.verifyAudit());
        if (m === "POST" && p === "/admin/reports/moderate") { const b = await readBody(req); return send(200, store.moderate(Array.isArray(b.ids) ? b.ids.slice(0, 200) : [], b.action)); }
        let mm;
        if (m === "POST" && (mm = /^\/admin\/credentials\/([a-f0-9]{24})\/revoke$/.exec(p))) return send(200, store.revokeCredential(mm[1]));
        if (m === "POST" && (mm = /^\/admin\/disputes\/([a-f0-9]{16})\/resolve$/.exec(p))) { const b = await readBody(req); return send(200, store.resolveDispute(mm[1], b.resolution)); }
        return send(404, { error: "not found" });
      }
      // ---- public writes ----
      const write = () => { if (limited("write", ip, rateLimit)) throw new ApiError(429, "rate limited"); };
      if (m === "POST" && p === "/v1/enroll") { write(); const b = await readBody(req); return send(200, store.enroll({ ip, challenge: b.challenge, solution: b.solution })); }
      if (m === "POST" && p === "/v1/report") { write(); const b = await readBody(req); return send(200, store.submit({ token: bearer(req), ip, domain: b.domain, outcome: b.outcome, tags: b.tags, proof: b.proof })); }
      if (m === "DELETE" && p === "/v1/report") { write(); return send(200, store.deleteReport(bearer(req), url.searchParams.get("domain"))); }
      if (m === "DELETE" && p === "/v1/credential") { write(); return send(200, store.eraseCredential(bearer(req))); }
      if (m === "POST" && p === "/v1/disputes") { write(); const b = await readBody(req); return send(200, store.openDispute({ domain: b.domain, message: b.message, contact: b.contact })); }
      let dm;
      if (m === "POST" && (dm = /^\/v1\/disputes\/([a-f0-9]{16})\/verify$/.exec(p))) { write(); return send(200, await store.verifyDispute(dm[1])); }
      send(404, { error: "not found" });
    } catch (e) {
      if (e instanceof ApiError) return send(e.status, { error: e.message });
      send(500, { error: "internal error" });          // never echo internals
    }
  });
  srv.headersTimeout = 10000; srv.requestTimeout = 10000;
  srv.on("close", () => clearInterval(sweep));
  return srv;
}

// Server-side fetch used only to verify merchant ownership files. Public host names only, no redirects, tiny responses.
export async function safeFetchText(url) {
  const u = new URL(url);
  if (u.protocol !== "https:" || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname) || /(^|\.)(localhost|local|internal|lan)$/i.test(u.hostname)) throw new Error("host not allowed");
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 5000);
  try {
    const res = await fetch(url, { redirect: "error", signal: ctl.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const text = await res.text();
    if (text.length > 512) throw new Error("file too large");
    return text;
  } finally { clearTimeout(timer); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = process.env;
  if (env.NODE_ENV === "production" && (!env.REPORT_SALT || !env.CREDENTIAL_SECRET)) { console.error("REPORT_SALT and CREDENTIAL_SECRET are required in production"); process.exit(1); }
  let override = {};
  try { override = env.REPORT_CONFIG_JSON ? JSON.parse(env.REPORT_CONFIG_JSON) : {}; } catch { console.error("REPORT_CONFIG_JSON is not valid JSON"); process.exit(1); }
  const store = new ReportStore({ file: env.DATA_FILE || "data.json", salt: env.REPORT_SALT || "dev-salt", secret: env.CREDENTIAL_SECRET || "dev-secret",
    config: { powBits: Number(env.POW_BITS || 16), ...override }, fetchText: safeFetchText });
  const srv = createServer(store, { rateLimit: Number(env.RATE_LIMIT || 20), trustProxy: env.TRUST_PROXY === "true", corsOrigin: env.CORS_ORIGIN || "*", adminToken: env.ADMIN_TOKEN || "" });
  const timer = setInterval(() => store.flush(), 5000); // batch disk writes
  const stop = () => { clearInterval(timer); store.flush(); shutdown(srv).then(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
  srv.listen(Number(env.PORT || 8787), env.HOST || "0.0.0.0", () => console.log(`TrustCheck report server on :${env.PORT || 8787}${env.ADMIN_TOKEN ? " (admin enabled)" : ""}`));
}
