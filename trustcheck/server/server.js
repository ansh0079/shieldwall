// TrustCheck report server. See DEPLOY.md and RUNBOOK.md. Configuration comes from the environment (config.js validates it).
import http from "node:http";
import { ApiError, cleanDomain } from "./vocab.js";
import { timingSafeEqualStr } from "./credentials.js";
import { resolveClientIp, originAllowed, inAny } from "./net.js";
import { createLogger, Metrics } from "./log.js";

// Close a server completely (idle keep-alive sockets included) and resolve when it is down.
export function shutdown(srv) {
  return new Promise((resolve) => {
    srv.close(() => resolve());
    srv.closeIdleConnections?.(); srv.closeAllConnections?.();
  });
}

const SQLITE_FAULTS = { 5: "busy", 6: "locked", 8: "read-only", 10: "io error", 11: "corrupt", 13: "disk full", 14: "cannot open", 26: "not a database" };
const isSqlite = (e) => e?.code === "ERR_SQLITE_ERROR";

export function createServer(store, options = {}) {
  const o = { rateLimit: 20, readLimit: 300, trustedProxies: [], allowedOrigins: "*", keepAlive: true, adminTokens: [], adminCidrs: [],
    maxConnections: 512, maxConcurrentPerIp: 20, maxHeaderBytes: 8192, bodyLimit: 8192, maxResponseBytes: 256 * 1024,
    headersTimeoutMs: 10_000, requestTimeoutMs: 15_000, metricsPublic: false, ...options };
  const metrics = o.metrics || new Metrics(), logger = o.logger || createLogger({ write: () => {} });
  const state = { draining: false, inflight: 0 };
  const hits = new Map(), perIp = new Map();                      // `${kind}|${ip}` -> timestamps; ip -> concurrent requests
  const limited = (kind, ip, max) => {
    const t = Date.now(), k = kind + "|" + ip, arr = (hits.get(k) || []).filter((x) => t - x < 3_600_000);
    arr.push(t); hits.set(k, arr); return arr.length > max;
  };
  const sweep = setInterval(() => { const t = Date.now(); for (const [k, arr] of hits) if (!arr.some((x) => t - x < 3_600_000)) hits.delete(k); }, 600_000);
  sweep.unref();

  const bearer = (req) => /^Bearer (\S{1,600})$/.exec(String(req.headers.authorization || ""))?.[1] || "";
  const readBody = (req) => new Promise((resolve, reject) => {
    if (Number(req.headers["content-length"] || 0) > o.bodyLimit) return reject(new ApiError(413, "payload too large"));
    let body = "", dead = false;
    req.on("data", (c) => { body += c; if (body.length > o.bodyLimit && !dead) { dead = true; reject(new ApiError(413, "payload too large")); req.destroy(); } });
    req.on("end", () => {
      if (dead) return;
      if (!body) return resolve({});
      if (!/^application\/json\b/i.test(req.headers["content-type"] || "")) return reject(new ApiError(415, "content-type must be application/json"));
      try { const j = JSON.parse(body); resolve(j && typeof j === "object" && !Array.isArray(j) ? j : {}); } catch { reject(new ApiError(400, "invalid JSON")); }
    });
    req.on("error", () => reject(new ApiError(400, "read error")));
  });
  const int = (v, d, min, max) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };

  // Named admin tokens: the audit log records WHO acted. Optional network restriction; lockout after repeated failures.
  function adminActor(req, ip) {
    if (!o.adminTokens.length) return { status: 404 };
    if (o.adminCidrs.length && !inAny(ip, o.adminCidrs)) return { status: 404 };          // do not reveal the API to other networks
    if (limited("admin", ip, 600)) return { status: 429, error: "rate limited" };
    const fails = (hits.get("adminfail|" + ip) || []).filter((x) => Date.now() - x < 3_600_000).length;
    if (fails >= 10) return { status: 429, error: "too many failed attempts" };
    const t = bearer(req);
    let name = null;
    for (const a of o.adminTokens) if (timingSafeEqualStr(t, a.token)) name = a.name;     // checks every token: no early exit
    if (!name) { limited("adminfail", ip, Infinity); metrics.inc("auth_failures_total", 1, { kind: "admin" }); return { status: 401, error: "unauthorized" }; }
    return { name };
  }

  const handler = async (req, res) => {
    const started = process.hrtime.bigint(), id = Math.random().toString(16).slice(2, 10) + Date.now().toString(16).slice(-4);
    const m = req.method, client = resolveClientIp(req, o.trustedProxies), ip = client.ip;
    let url; try { url = new URL(req.url, "http://x"); } catch { url = new URL("http://x/"); }
    const p = url.pathname;
    let route = "unmatched", status = 0;
    const origin = req.headers.origin;
    const originOk = origin === undefined || originAllowed(origin, o.allowedOrigins);

    const send = (code, obj, extra = {}, raw = null) => {
      let body = raw ?? JSON.stringify(obj);
      if (body.length > o.maxResponseBytes) { logger.error("response_too_large", { route, bytes: body.length }); metrics.inc("response_too_large_total"); code = 500; body = JSON.stringify({ error: "internal error" }); raw = null; }
      status = code;
      res.writeHead(code, { "content-type": raw ? "text/plain; version=0.0.4" : "application/json", "x-content-type-options": "nosniff", "x-request-id": id,
        "cache-control": "no-store", "content-security-policy": "default-src 'none'; frame-ancestors 'none'", "referrer-policy": "no-referrer",
        ...(o.keepAlive && !state.draining ? {} : { connection: "close" }),
        ...(origin !== undefined && originOk ? { "access-control-allow-origin": o.allowedOrigins === "*" ? "*" : origin, vary: "Origin",
          "access-control-allow-headers": "content-type, authorization", "access-control-allow-methods": "GET,POST,DELETE,OPTIONS", "access-control-max-age": "600" } : {}),
        ...extra });
      res.end(body);
    };
    res.on("close", () => {
      state.inflight--; const n = (perIp.get(ip) || 1) - 1; n <= 0 ? perIp.delete(ip) : perIp.set(ip, n);
      const secs = Number(process.hrtime.bigint() - started) / 1e9;
      metrics.inc("http_requests_total", 1, { route, status: String(status || 0) });
      metrics.observe("http_request_duration_seconds", secs, { route });
      if (route !== "GET /healthz" && route !== "GET /readyz") logger.info("request", { id, method: m, route, status, ms: Math.round(secs * 1000) });
    });
    state.inflight++; perIp.set(ip, (perIp.get(ip) || 0) + 1);
    if (client.malformed) { metrics.inc("malformed_forwarded_for_total"); logger.warn("malformed_forwarded_for", { id }); }

    try {
      if (req.url.length > 2048) return send(414, { error: "uri too long" });
      if (!originOk) { route = "forbidden_origin"; return send(403, { error: "origin not allowed" }); }
      if ((perIp.get(ip) || 0) > o.maxConcurrentPerIp) { route = "too_many_concurrent"; metrics.inc("rate_limited_total", 1, { kind: "concurrency" }); return send(429, { error: "too many concurrent requests" }, { "retry-after": "1" }); }
      if (m === "OPTIONS") { route = "OPTIONS"; return send(204, {}); }

      if (m === "GET" && p === "/healthz") { route = "GET /healthz"; return send(200, { ok: true }); }       // liveness: the process is up
      if (m === "GET" && p === "/readyz") {                                                                  // readiness: able to serve traffic
        route = "GET /readyz";
        const r = store.readiness(); if (state.draining) { r.ok = false; r.checks.draining = "shutting down"; }
        return send(r.ok ? 200 : 503, r);
      }
      if (state.draining) { route = "draining"; return send(503, { error: "shutting down" }, { "retry-after": "5" }); }

      if (m === "GET" && p === "/v1/summary") {
        route = "GET /v1/summary";
        if (limited("read", ip, o.readLimit)) { metrics.inc("rate_limited_total", 1, { kind: "read" }); return send(429, { error: "rate limited" }); }
        return send(200, store.summary(url.searchParams.get("domain")), { "cache-control": "public, max-age=60" });
      }
      if (m === "GET" && p === "/v1/challenge") {
        route = "GET /v1/challenge";
        if (limited("read", ip, o.readLimit)) { metrics.inc("rate_limited_total", 1, { kind: "read" }); return send(429, { error: "rate limited" }); }
        return send(200, store.challenge());
      }
      // Unified lookup used by the extension so shoppers do not have to supply third-party API keys.
      // Outbound checks (Safe Browsing, Companies House, Trustpilot) run only when the operator passed handlers.
      if (m === "GET" && p === "/v1/check") {
        route = "GET /v1/check";
        if (limited("read", ip, o.readLimit)) { metrics.inc("rate_limited_total", 1, { kind: "read" }); return send(429, { error: "rate limited" }); }
        const summary = store.summary(url.searchParams.get("domain"));
        const clean = summary.domain;
        let targetUrl = `https://${clean}/`;
        const requestedUrl = url.searchParams.get("url") || "";
        if (requestedUrl) {
          try {
            const parsed = new URL(requestedUrl);
            if (cleanDomain(parsed.hostname) === clean && /^https?:$/.test(parsed.protocol)) targetUrl = parsed.href;
          } catch { /* keep canonical domain URL */ }
        }
        const companyNumber = (url.searchParams.get("companyNumber") || "").trim();
        let safeBrowsing = null, company = null, reviews = null;
        try { if (o.safeBrowsing) safeBrowsing = await o.safeBrowsing(targetUrl); } catch { safeBrowsing = null; }
        try { if (o.fetchCompany && /^[A-Za-z0-9]{6,10}$/.test(companyNumber)) company = { profile: await o.fetchCompany(companyNumber) }; } catch { company = null; }
        try {
          if (o.fetchTrustpilot) reviews = await o.fetchTrustpilot(clean);
          else reviews = { source: "Trustpilot", score: null, count: null, sample: 0, themes: [], url: `https://www.trustpilot.com/review/${clean}` };
        } catch { reviews = { source: "Trustpilot", score: null, count: null, sample: 0, themes: [], url: `https://www.trustpilot.com/review/${clean}` }; }
        const verifiedMerchant = typeof store.getMerchantVerification === "function" ? !!store.getMerchantVerification(clean) : false;
        return send(200, { domain: clean, summary, verifiedMerchant, safeBrowsing, company, reviews }, { "cache-control": "public, max-age=60" });
      }

      // ---- admin ----
      if (p.startsWith("/admin/") || p === "/metrics") {
        route = (p === "/metrics" ? "GET /metrics" : `${m} ${p.replace(/[a-f0-9]{16,24}/g, ":id")}`);
        if (p === "/metrics" && o.metricsPublic) return send(200, null, {}, metrics.render());
        const a = adminActor(req, ip);
        if (a.status) return send(a.status, { error: a.error || "not found" });
        const actor = a.name;
        if (m === "GET" && p === "/metrics") return send(200, null, {}, metrics.render());
        if (m === "GET" && p === "/admin/queue") return send(200, store.queue({ limit: int(url.searchParams.get("limit"), 50, 1, 200), after: url.searchParams.get("after") || "" }));
        if (m === "GET" && p === "/admin/disputes") return send(200, store.listDisputes({ status: url.searchParams.get("status") || null, limit: int(url.searchParams.get("limit"), 50, 1, 200), offset: int(url.searchParams.get("offset"), 0, 0, 1e9) }));
        if (m === "GET" && p === "/admin/audit") return send(200, store.auditLog({ after: int(url.searchParams.get("after"), 0, 0, 1e12), limit: int(url.searchParams.get("limit"), 50, 1, 200) }));
        if (m === "GET" && p === "/admin/audit/verify") return send(200, store.verifyAudit());
        if (m === "POST" && p === "/admin/reports/moderate") { const b = await readBody(req); return send(200, store.moderate(Array.isArray(b.ids) ? b.ids.slice(0, 200) : [], b.action, actor)); }
        let mm;
        if (m === "POST" && (mm = /^\/admin\/credentials\/([a-f0-9]{24})\/revoke$/.exec(p))) return send(200, store.revokeCredential(mm[1], actor));
        if (m === "POST" && (mm = /^\/admin\/disputes\/([a-f0-9]{16})\/resolve$/.exec(p))) { const b = await readBody(req); return send(200, store.resolveDispute(mm[1], b.resolution, actor)); }
        return send(404, { error: "not found" });
      }

      // ---- public writes ----
      const write = () => { if (limited("write", ip, o.rateLimit)) { metrics.inc("rate_limited_total", 1, { kind: "write" }); throw new ApiError(429, "rate limited"); } };
      let dm;
      if (m === "POST" && p === "/v1/enroll") { route = "POST /v1/enroll"; write(); const b = await readBody(req); return send(200, store.enroll({ ip, challenge: b.challenge, solution: b.solution })); }
      if (m === "POST" && p === "/v1/report") {
        route = "POST /v1/report"; write(); const b = await readBody(req);
        try { return send(200, store.submit({ token: bearer(req), ip, domain: b.domain, outcome: b.outcome, tags: b.tags, proof: b.proof })); }
        catch (e) { if (e.status === 401) metrics.inc("auth_failures_total", 1, { kind: "credential" }); throw e; }
      }
      if (m === "DELETE" && p === "/v1/report") { route = "DELETE /v1/report"; write(); return send(200, store.deleteReport(bearer(req), url.searchParams.get("domain"))); }
      if (m === "DELETE" && p === "/v1/credential") { route = "DELETE /v1/credential"; write(); return send(200, store.eraseCredential(bearer(req))); }
      if (m === "POST" && p === "/v1/disputes") { route = "POST /v1/disputes"; write(); const b = await readBody(req); return send(200, store.openDispute({ domain: b.domain, message: b.message, contact: b.contact })); }
      if ((dm = /^\/v1\/disputes\/([a-f0-9]{16})(\/verify|\/appeal)?$/.exec(p))) {
        route = `${m} /v1/disputes/:id${dm[2] || ""}`;
        if (m === "GET" && !dm[2]) { if (limited("read", ip, o.readLimit)) throw new ApiError(429, "rate limited"); return send(200, store.disputeStatus(dm[1], bearer(req))); }
        if (m === "POST" && dm[2] === "/verify") { write(); return send(200, await store.verifyDispute(dm[1])); }
        if (m === "POST" && dm[2] === "/appeal") { write(); const b = await readBody(req); return send(200, store.appealDispute(dm[1], bearer(req), b.message)); }
      }
      send(404, { error: "not found" });
    } catch (e) {
      if (e instanceof ApiError) return send(e.status, { error: e.message });
      if (isSqlite(e)) {                                         // a database fault is an operational problem, not the client's: 503, logged, counted
        metrics.inc("db_errors_total", 1, { kind: SQLITE_FAULTS[e.errcode] || "other" });
        logger.error("db_fault", { id, route, errcode: e.errcode, kind: SQLITE_FAULTS[e.errcode] || "other" });
        return send(503, { error: "temporarily unavailable" }, { "retry-after": "5" });
      }
      logger.error("unhandled_error", { id, route, error: String(e?.message || e).slice(0, 160) });
      metrics.inc("unhandled_errors_total");
      send(500, { error: "internal error" });                    // never echo internals
    }
  };

  // Node only enforces headersTimeout/requestTimeout when its connection check runs (default every 30 s), so a "10 s" limit would really
// be up to 40 s. Check often enough that the configured limits mean what they say.
const srv = http.createServer({ maxHeaderSize: o.maxHeaderBytes, keepAliveTimeout: 5000,
    connectionsCheckingInterval: o.connectionsCheckingInterval ?? Math.min(5000, Math.max(100, Math.floor(o.headersTimeoutMs / 2))) }, handler);
  srv.maxConnections = o.maxConnections; srv.maxRequestsPerSocket = 100;
  srv.headersTimeout = o.headersTimeoutMs; srv.requestTimeout = o.requestTimeoutMs;
  srv.on("clientError", (err, socket) => { metrics.inc("client_errors_total", 1, { code: err.code || "unknown" }); if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n"); else socket.destroy(); });
  srv.on("close", () => clearInterval(sweep));
  srv.state = state; srv.metrics = metrics;
  // Stop taking new work, let in-flight requests finish (bounded), then close.
  srv.drain = async (timeoutMs = 10_000) => {
    state.draining = true;
    const t0 = Date.now();
    while (state.inflight > 0 && Date.now() - t0 < timeoutMs) await new Promise((r) => setTimeout(r, 25));
    return { inflightLeft: state.inflight };
  };
  return srv;
}
