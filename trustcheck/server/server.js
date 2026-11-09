// TrustCheck report server. `node server/server.js` (PORT, DATA_FILE, MIN_REPORTS env vars).
import http from "node:http";
import { Store } from "./store.js";

export function createServer(store, { rateLimit = 20 } = {}) {
  const hits = new Map(); // ip -> timestamps (1h window)
  const limited = (ip) => {
    const t = Date.now(), arr = (hits.get(ip) || []).filter((x) => t - x < 3600000);
    arr.push(t); hits.set(ip, arr); return arr.length > rateLimit;
  };
  return http.createServer((req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*",
        "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST,OPTIONS" });
      res.end(JSON.stringify(obj));
    };
    if (req.method === "OPTIONS") return send(204, {});
    const url = new URL(req.url, "http://x");
    try {
      if (req.method === "GET" && url.pathname === "/v1/summary") return send(200, store.summary(url.searchParams.get("domain")));
      if (req.method === "POST" && url.pathname === "/v1/report") {
        if (limited(req.socket.remoteAddress)) return send(429, { error: "rate limited" });
        let body = "";
        req.on("data", (c) => { body += c; if (body.length > 4096) req.destroy(); });
        req.on("end", () => {
          try { store.add(JSON.parse(body)); send(200, { ok: true }); }
          catch (e) { send(400, { error: e.message }); }
        });
        return;
      }
      send(404, { error: "not found" });
    } catch (e) { send(400, { error: e.message }); }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const store = new Store({ file: process.env.DATA_FILE || "data.json", minReports: Number(process.env.MIN_REPORTS || 3) });
  const port = Number(process.env.PORT || 8787);
  createServer(store, { rateLimit: Number(process.env.RATE_LIMIT || 20) }).listen(port, () => console.log(`TrustCheck report server on :${port}`));
}
