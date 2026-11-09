// TrustCheck report server. `node server/server.js`
// Env: PORT(8787) HOST(0.0.0.0) DATA_FILE(data.json) MIN_REPORTS(3) RATE_LIMIT(20 reports/h/IP)
//      TRUST_PROXY(false: set true behind a reverse proxy) CORS_ORIGIN(*) REPORT_SALT(required in production)
import http from "node:http";
import { Store } from "./store.js";

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

export function createServer(store, { rateLimit = 20, readLimit = 300, trustProxy = false, corsOrigin = "*", keepAlive = true } = {}) {
  const hits = new Map(); // `${kind}|${ip}` -> timestamps (1h window)
  const limited = (kind, ip, max) => {
    const t = Date.now(), k = kind + "|" + ip, arr = (hits.get(k) || []).filter((x) => t - x < 3600000);
    arr.push(t); hits.set(k, arr); return arr.length > max;
  };
  const sweep = setInterval(() => { // keep the map from growing forever
    const t = Date.now();
    for (const [k, arr] of hits) if (!arr.some((x) => t - x < 3600000)) hits.delete(k);
  }, 600000);
  sweep.unref();

  const srv = http.createServer((req, res) => {
    const send = (code, obj, extra = {}) => {
      res.writeHead(code, { "content-type": "application/json", "x-content-type-options": "nosniff", ...(keepAlive ? {} : { connection: "close" }),
        "access-control-allow-origin": corsOrigin, "access-control-allow-headers": "content-type",
        "access-control-allow-methods": "GET,POST,OPTIONS", ...extra });
      res.end(JSON.stringify(obj));
    };
    if (req.method === "OPTIONS") return send(204, {});
    const url = new URL(req.url, "http://x");
    const ip = clientIp(req, trustProxy);
    try {
      if (req.method === "GET" && url.pathname === "/healthz") return send(200, { ok: true });
      if (req.method === "GET" && url.pathname === "/v1/summary") {
        if (limited("read", ip, readLimit)) return send(429, { error: "rate limited" });
        return send(200, store.summary(url.searchParams.get("domain")), { "cache-control": "public, max-age=60" });
      }
      if (req.method === "POST" && url.pathname === "/v1/report") {
        if (limited("write", ip, rateLimit)) return send(429, { error: "rate limited" });
        if (Number(req.headers["content-length"] || 0) > 4096) return send(413, { error: "payload too large" });
        let body = "", tooBig = false;
        req.on("data", (c) => { body += c; if (body.length > 4096) { tooBig = true; req.destroy(); } });
        req.on("end", () => {
          if (tooBig) return;
          try { store.add(JSON.parse(body)); send(200, { ok: true }); }
          catch (e) { send(400, { error: e.message }); }
        });
        return;
      }
      send(404, { error: "not found" });
    } catch (e) { send(400, { error: e.message }); }
  });
  srv.headersTimeout = 10000; srv.requestTimeout = 10000;
  srv.on("close", () => clearInterval(sweep));
  return srv;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = process.env;
  if (env.NODE_ENV === "production" && !env.REPORT_SALT) { console.error("REPORT_SALT is required in production"); process.exit(1); }
  const store = new Store({ file: env.DATA_FILE || "data.json", minReports: Number(env.MIN_REPORTS || 3), salt: env.REPORT_SALT || "dev-salt" });
  const srv = createServer(store, { rateLimit: Number(env.RATE_LIMIT || 20), trustProxy: env.TRUST_PROXY === "true", corsOrigin: env.CORS_ORIGIN || "*" });
  const timer = setInterval(() => store.flush(), 5000); // batch disk writes
  const stop = () => { clearInterval(timer); store.flush(); shutdown(srv).then(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
  srv.listen(Number(env.PORT || 8787), env.HOST || "0.0.0.0", () => console.log(`TrustCheck report server on :${env.PORT || 8787}`));
}
