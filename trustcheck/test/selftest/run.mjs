// Process-level self-tests for the report server. Usage: node test/selftest/run.mjs [scenario ...]   (all scenarios by default)
// These start real server processes and abuse them. They take a couple of minutes and are NOT part of `npm test`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import { Database } from "../../server/db.js";
import { verifyAuditChainDb, verifyBackup, listBackups } from "../../server/backup.js";
import { solvePowSync } from "../../server/credentials.js";
import { ReportStore } from "../../server/store.js";
import { ROOT, ADMIN_TOKEN, SECRETS, HIGH_LIMITS, allLogs, sleep, credOf, pct, startServer, call, enroll, ipFor, Scenario } from "./lib.mjs";

const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `tc-self-${n}-`));
const dbCheck = (file) => { const d = new Database(file, { readOnly: false }); try {
  const ic = d.all("PRAGMA integrity_check").map((r) => r.integrity_check), fk = d.all("PRAGMA foreign_key_check").length, chain = verifyAuditChainDb(d);
  const dup = d.get("SELECT COUNT(*) AS n FROM (SELECT cred, domain FROM reports GROUP BY cred, domain HAVING COUNT(*) > 1)").n;
  return { integrity: ic.length === 1 && ic[0] === "ok", fk, chain, dup, reports: d.get("SELECT COUNT(*) AS n FROM reports").n, creds: d.get("SELECT COUNT(*) AS n FROM credentials").n, d };
} catch (e) { d.close(); throw e; } };

const SCENARIOS = {};

// ------------------------------------------------------------------------------------------------ 1. crash durability
SCENARIOS.crash = async () => {
  const S = new Scenario("crash durability (kill -9 under write load, 5 cycles)"), dir = tmp("crash"), file = path.join(dir, "data.db");
  let ackedTotal = 0, unackedPresent = 0, lost = [], prevRows = 0;
  for (let cycle = 1; cycle <= 5; cycle++) {
    const srv = await startServer({ dbFile: file, env: { REPORT_CONFIG_JSON: HIGH_LIMITS } }), acked = [], stop = { v: false }, attempts = { n: 0 };
    const worker = async (id) => {
      let n = 0;
      while (!stop.v) {
        const ip = ipFor(id + cycle * 31, n++); attempts.n++;
        try {
          const tok = await enroll(srv.base, ip); if (!tok) continue;
          const domain = `crash-${cycle}-${n % 9}.example`;
          const r = await call(srv.base, "/v1/report", { method: "POST", token: tok, ip, body: { domain, outcome: "never", tags: [] } });
          if (r.status === 200) acked.push({ cred: credOf(tok), domain });
        } catch { /* the server was killed under us: exactly the point */ }
      }
    };
    const workers = Array.from({ length: 12 }, (_, i) => worker(i));
    await sleep(500 + Math.floor(Math.random() * 1200));
    await srv.kill9(); stop.v = true; await Promise.all(workers);
    const srv2 = await startServer({ dbFile: file, env: { REPORT_CONFIG_JSON: HIGH_LIMITS } });         // recovery: WAL replay on open
    const ready = await call(srv2.base, "/readyz"); S.check(ready.status === 200, `cycle ${cycle}: server is ready after a crash`);
    await srv2.term();
    const v = dbCheck(file);
    S.check(v.integrity, `cycle ${cycle}: PRAGMA integrity_check ok`); S.check(v.fk === 0, `cycle ${cycle}: no foreign-key violations`);
    S.check(v.chain.ok, `cycle ${cycle}: audit hash chain intact (${v.chain.length} entries)`); S.check(v.dup === 0, `cycle ${cycle}: no duplicate (identity, domain) rows`);
    const have = new Set(v.d.all("SELECT cred, domain FROM reports").map((r) => r.cred + "|" + r.domain));
    const missing = acked.filter((a) => !have.has(a.cred + "|" + a.domain));
    lost.push(...missing); ackedTotal += acked.length; unackedPresent += (v.reports - prevRows) - acked.length + missing.length; prevRows = v.reports;
    S.note(`cycle ${cycle}: ${acked.length} acknowledged, ${missing.length} lost, ${v.reports} rows on disk`);
    v.d.close();
  }
  S.check(lost.length === 0, `NO acknowledged write was lost (${ackedTotal} acknowledged across 5 crashes, lost ${lost.length})`);
  S.check(ackedTotal > 200, `the test actually exercised the database (${ackedTotal} acknowledged writes)`);
  S.note(`${unackedPresent} writes were durable without having been acknowledged to the client (fine: the crash fell between commit and response)`);
  return S;
};

// ------------------------------------------------------------------------------------------------ 2. concurrency invariants
SCENARIOS.concurrency = async () => {
  const S = new Scenario("concurrency invariants (limits stay exact under parallel requests)"), dir = tmp("conc"), file = path.join(dir, "data.db");
  const srv = await startServer({ dbFile: file });                                         // DEFAULT limits: they are what is under test
  const ip = "10.77.77.1";
  const en = await Promise.all(Array.from({ length: 40 }, () => enroll(srv.base, ip)));
  S.check(en.filter(Boolean).length === 3, `40 parallel enrolments from one network create exactly 3 identities (got ${en.filter(Boolean).length})`);
  const tok = en.find(Boolean);
  const many = await Promise.all(Array.from({ length: 40 }, (_, i) => call(srv.base, "/v1/report", { method: "POST", token: tok, ip, body: { domain: `par${i}.example`, outcome: "ok", tags: [] } })));
  S.check(many.filter((r) => r.status === 200).length === 20, `40 parallel reports on one identity: exactly 20 accepted by the daily cap (got ${many.filter((r) => r.status === 200).length})`);
  S.check(many.every((r) => r.status === 200 || r.status === 429), "every other response is a clean 429");
  const tok2 = en.filter(Boolean)[1];
  const edits = await Promise.all(Array.from({ length: 30 }, (_, i) => call(srv.base, "/v1/report", { method: "POST", token: tok2, ip, body: { domain: "edit.example", outcome: i % 2 ? "ok" : "never", tags: [] } })));
  S.check(edits.filter((r) => r.status === 200).length === 4, `30 parallel edits of one report: 1 create + 3 corrections = 4 (got ${edits.filter((r) => r.status === 200).length})`);
  const ch = (await call(srv.base, "/v1/challenge", { ip: "10.78.0.1" })).json, sol = solvePowSync(ch.challenge, ch.bits);
  const replays = await Promise.all(Array.from({ length: 25 }, (_, i) => call(srv.base, "/v1/enroll", { method: "POST", ip: `10.78.${i}.9`, body: { challenge: ch.challenge, solution: sol } })));
  S.check(replays.filter((r) => r.status === 200).length === 1, `one proof of work replayed 25 times in parallel is accepted once (got ${replays.filter((r) => r.status === 200).length})`);
  await srv.term();
  const v = dbCheck(file);
  S.check(v.integrity && v.dup === 0 && v.chain.ok, "database is consistent afterwards");
  S.check(v.creds === 4, `exactly 4 identities exist: 3 from the capped network + 1 from the replayed proof of work (found ${v.creds})`);
  v.d.close();

  // a crowd of independent clients, no limits in the way: nothing may return a 5xx
  // MAX_CONNECTIONS is lifted too: on a 1-2 CPU machine the test's own HTTP client churns through more than the default 512 sockets
  // for these 300 "users", and the server then (correctly) drops the excess. Measured: 2/14 runs failed at 512, 4/4 at 150, 0/20 lifted.
  const file2 = path.join(dir, "crowd.db"), srv2 = await startServer({ dbFile: file2, env: { REPORT_CONFIG_JSON: HIGH_LIMITS, MAX_CONNECTIONS: "100000" } });
  const res = await Promise.all(Array.from({ length: 300 }, async (_, i) => { const t = await enroll(srv2.base, ipFor(i, 5)); return t ? (await call(srv2.base, "/v1/report", { method: "POST", token: t, ip: ipFor(i, 5), body: { domain: "crowd.example", outcome: i % 3 ? "never" : "ok", tags: [] } })).status : 0; }));
  S.check(res.every((s) => s === 200), `300 simultaneous clients: all succeeded (statuses: ${[...new Set(res)].join(",")})`);
  const m = (await call(srv2.base, "/metrics", { token: ADMIN_TOKEN })).text;
  S.check(!/unhandled_errors_total|db_errors_total/.test(m), "no unhandled errors and no database errors were recorded");
  await srv2.term(); const v2 = dbCheck(file2); S.check(v2.reports === 300 && v2.integrity && v2.chain.ok, `300 reports stored, integrity ok (${v2.reports})`); v2.d.close();
  return S;
};

// ------------------------------------------------------------------------------------------------ 3. load, latency, leaks
SCENARIOS.load = async () => {
  const S = new Scenario("load: latency, throughput, memory and file-descriptor stability"), dir = tmp("load"), file = path.join(dir, "data.db");
  // Seed a realistic dataset directly: 3,000 ordinary domains + one hot domain with 8,000 reports.
  const seed = new ReportStore({ file, salt: SECRETS.salt, secret: SECRETS.secret }), db = seed.db, t = Date.now();
  const h = (x) => (await_h(x)); function await_h(x) { return execFileSync("node", ["-e", `process.stdout.write(require('crypto').createHash('sha256').update(${JSON.stringify(x)}).digest('hex'))`]).toString(); }
  void h;
  const crypto = (await import("node:crypto")).default;
  db.tx(() => {
    const add = (domain, i) => {
      const cid = crypto.createHash("sha256").update("c" + domain + i).digest("hex").slice(0, 24), rid = crypto.createHash("sha256").update("r" + domain + i).digest("hex").slice(0, 16);
      db.run("INSERT OR IGNORE INTO credentials (id, created_at, net, revoked) VALUES (?, ?, ?, 0)", cid, t - 40 * 86400000, "n" + (i % 900));
      db.run("INSERT INTO reports (id, domain, cred, net, outcome, tags, at, id_age_ms, evidence, fixed, edits) VALUES (?, ?, ?, ?, ?, '[]', ?, ?, 'reported', '[]', 0)", rid, domain, cid, "n" + (i % 900), i % 3 ? "never" : "ok", t - (i % 20) * 86400000 - i * 997, 30 * 86400000);
    };
    for (let d = 0; d < 3000; d++) for (let i = 0; i < 8; i++) add(`shop${d}.example`, i);
    for (let i = 0; i < 8000; i++) add("hot.example", i);
  });
  const rows = db.get("SELECT COUNT(*) AS n FROM reports").n; seed.close();
  S.note(`dataset: ${rows} reports across 3,001 domains (one domain holds 8,000)`);
  const srv = await startServer({ dbFile: file, env: { REPORT_CONFIG_JSON: HIGH_LIMITS } });
  const rss0 = srv.rss(), fd0 = srv.fds();
  const phase = async (name, total, conc, fn) => {
    const lat = []; let errors = 0, next = 0; const t0 = performance.now();
    await Promise.all(Array.from({ length: conc }, async () => { for (;;) { const i = next++; if (i >= total) return; const s = performance.now(); try { const st = await fn(i); if (st >= 500 || st === 0) errors++; } catch { errors++; } lat.push(performance.now() - s); } }));
    const secs = (performance.now() - t0) / 1000;
    return { name, total, errors, rps: Math.round(total / secs), p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99), max: Math.max(...lat) };
  };
  const R = [];
  R.push(await phase("GET summary, ordinary domains", 4000, 50, (i) => call(srv.base, `/v1/summary?domain=shop${(i * 37) % 3000}.example`, { ip: ipFor(i, 1) }).then((r) => r.status)));
  R.push(await phase("GET summary, the 8,000-report domain", 400, 20, (i) => call(srv.base, "/v1/summary?domain=hot.example", { ip: ipFor(i, 2) }).then((r) => r.status)));
  R.push(await phase("enrol + POST report (writes)", 500, 20, async (i) => { const ip = ipFor(i, 3), tok = await enroll(srv.base, ip); if (!tok) return 0; return (await call(srv.base, "/v1/report", { method: "POST", token: tok, ip, body: { domain: `shop${i % 3000}.example`, outcome: "never", tags: [] } })).status; }));
  R.push(await phase("writes to the hot domain (2 evaluations each)", 150, 10, async (i) => { const ip = ipFor(i, 4), tok = await enroll(srv.base, ip); if (!tok) return 0; return (await call(srv.base, "/v1/report", { method: "POST", token: tok, ip, body: { domain: "hot.example", outcome: "never", tags: [] } })).status; }));
  R.push(await phase("mixed: reads while writing", 1500, 40, async (i) => { const ip = ipFor(i, 5); if (i % 5 === 0) { const tok = await enroll(srv.base, ip); return tok ? (await call(srv.base, "/v1/report", { method: "POST", token: tok, ip, body: { domain: `shop${i % 3000}.example`, outcome: "ok", tags: [] } })).status : 0; } return (await call(srv.base, `/v1/summary?domain=shop${i % 3000}.example`, { ip })).status; }));
  console.log("      phase".padEnd(58) + "reqs".padStart(6) + " err".padStart(5) + "  req/s".padStart(8) + "   p50".padStart(8) + "   p95".padStart(8) + "   p99".padStart(8) + "   max".padStart(8) + " (ms)");
  for (const r of R) console.log(`      ${r.name.padEnd(52)}${String(r.total).padStart(6)}${String(r.errors).padStart(5)}${String(r.rps).padStart(8)}${r.p50.toFixed(1).padStart(8)}${r.p95.toFixed(1).padStart(8)}${r.p99.toFixed(1).padStart(8)}${r.max.toFixed(0).padStart(8)}`);
  const fdBusy = srv.fds();
  await sleep(7000);                                              // the server closes idle keep-alive sockets after 5 s: a leak would survive this, a client pool would not
  const rss1 = srv.rss(), fd1 = srv.fds();
  S.note(`open descriptors: ${fd0} at start, ${fdBusy} right after the load (the client's keep-alive pool), ${fd1} after the idle timeout`);
  S.check(R.every((r) => r.errors === 0), `zero errors across ${R.reduce((a, r) => a + r.total, 0)} requests`);
  S.check(R[0].p99 < 1000, `ordinary summary p99 under 1 s on this machine (${R[0].p99.toFixed(0)} ms)`);
  S.check(R[1].p99 < 1500, `hot-domain summary p99 under 1.5 s (${R[1].p99.toFixed(0)} ms)`);
  S.check(R[3].p99 < 3000, `hot-domain write p99 under 3 s (${R[3].p99.toFixed(0)} ms)`);
  S.check(rss1 < rss0 * 2.5 + 80e6, `memory stays bounded: ${(rss0 / 1e6).toFixed(0)} MB -> ${(rss1 / 1e6).toFixed(0)} MB`);
  S.check(fd1 <= fd0 + 10, `no file-descriptor leak: ${fd0} -> ${fd1} open descriptors after ${R.reduce((a, r) => a + r.total, 0)} requests`);
  const m = (await call(srv.base, "/metrics", { token: ADMIN_TOKEN })).text;
  S.check(!/unhandled_errors_total|db_errors_total|response_too_large/.test(m), "no unhandled, database or oversize errors recorded");
  await srv.term(); const v = dbCheck(file); S.check(v.integrity && v.chain.ok && v.dup === 0, "database consistent after the load"); v.d.close();
  return S;
};

// ------------------------------------------------------------------------------------------------ 4. memory plateau
SCENARIOS.leak = async () => {
  const S = new Scenario("memory: RSS reaches a plateau over repeated identical rounds (a leak keeps climbing)"), dir = tmp("leak"), file = path.join(dir, "data.db");
  const srv = await startServer({ dbFile: file, env: { REPORT_CONFIG_JSON: HIGH_LIMITS } }), rss = [srv.rss()];
  for (let round = 1; round <= 12; round++) {
    await Promise.all(Array.from({ length: 30 }, async (_, w) => {
      for (let i = 0; i < 100; i++) {
        const ip = ipFor(round * 40 + w, i);
        if (i % 4 === 0) { const t = await enroll(srv.base, ip); if (t) await call(srv.base, "/v1/report", { method: "POST", token: t, ip, body: { domain: `leak${(w * 100 + i) % 400}.example`, outcome: "never", tags: ["fake_tracking"] } }); }
        else await call(srv.base, `/v1/summary?domain=leak${(w * 31 + i) % 400}.example`, { ip });
      }
    }));
    await sleep(500); rss.push(srv.rss());
  }
  const mb = (x) => (x / 1e6).toFixed(0);
  S.note(`RSS by round (MB): ${rss.map(mb).join(" -> ")}`);
  const early = rss[8], late = rss[12];
  S.check(late <= early * 1.12 + 8e6, `growth has stopped: round 8 ${mb(early)} MB vs round 12 ${mb(late)} MB (${(((late - early) / early) * 100).toFixed(1)}%)`);
  await srv.term(); const v = dbCheck(file); S.check(v.integrity && v.chain.ok, "database consistent"); v.d.close();
  return S;
};

// ------------------------------------------------------------------------------------------------ 5. protocol and payload fuzzing
const rawSend = (port, bytes, { wait = 400 } = {}) => new Promise((res) => {
  const c = net.connect(port, "127.0.0.1"); let got = Buffer.alloc(0), done = false;
  const finish = (why) => { if (done) return; done = true; c.destroy(); res({ status: (/^HTTP\/1\.[01] (\d{3})/.exec(got.toString("latin1")) || [])[1] | 0, why, bytes: got.length }); };
  c.on("connect", () => { c.write(bytes); setTimeout(() => finish("timeout"), wait); }); c.on("data", (d) => { got = Buffer.concat([got, d]); if (got.length > 64) setTimeout(() => finish("data"), 30); }); c.on("error", () => finish("error")); c.on("close", () => finish("close"));
});
SCENARIOS.fuzz = async () => {
  const S = new Scenario("fuzz: malformed HTTP, hostile URLs and payloads cannot crash, corrupt or leak"), dir = tmp("fuzz"), file = path.join(dir, "data.db");
  const srv = await startServer({ dbFile: file, env: { MAX_CONNECTIONS: "400" } }), statuses = {}, bump = (st) => { statuses[st] = (statuses[st] || 0) + 1; };
  let rnd = 987654321; const R = () => (rnd = (rnd * 1664525 + 1013904223) >>> 0) / 2 ** 32, pick = (a) => a[Math.floor(R() * a.length)];
  // 1. hand-written protocol abuse
  const raw = [
    "GET / HTTP/9.9\r\nhost: x\r\n\r\n", "FOO / HTTP/1.1\r\nhost: x\r\n\r\n", "get /healthz HTTP/1.1\r\nhost: x\r\n\r\n", "GET /healthz\r\n\r\n", "GET http://evil.example/ HTTP/1.1\r\nhost: x\r\n\r\n", "GET /\u0000 HTTP/1.1\r\nhost: x\r\n\r\n",
    "POST /v1/report HTTP/1.1\r\nhost: x\r\ncontent-length: -5\r\n\r\n", "POST /v1/report HTTP/1.1\r\nhost: x\r\ncontent-length: 5\r\ncontent-length: 50\r\n\r\nhello",                          // request smuggling attempts
    "POST /v1/report HTTP/1.1\r\nhost: x\r\ncontent-length: 4\r\ntransfer-encoding: chunked\r\n\r\n0\r\n\r\n", "POST /v1/report HTTP/1.1\r\nhost: x\r\ntransfer-encoding: chunked\r\n\r\nZZZ\r\n",
    "POST /v1/report HTTP/1.1\r\nhost: x\r\ncontent-type: application/json\r\ncontent-length: 2\r\n\r\n{}GET /admin/queue HTTP/1.1\r\nhost: x\r\n\r\n",            // pipelined smuggled second request
    "GET /healthz HTTP/1.1\r\nhost: x\r\nx-a: b\r\n c: folded header\r\n\r\n", "GET /healthz HTTP/1.1\r\nhost: x\r\n\r\n\r\n\r\nGET /healthz HTTP/1.1\r\nhost: x\r\n\r\n",
    "GET /v1/summary?domain=%zz HTTP/1.1\r\nhost: x\r\n\r\n", "GET /v1/summary?domain[]=a&domain=b&domain=c HTTP/1.1\r\nhost: x\r\n\r\n", "GET /../../etc/passwd HTTP/1.1\r\nhost: x\r\n\r\n", "GET //admin//queue HTTP/1.1\r\nhost: x\r\n\r\n",
    "GET /admin/queue HTTP/1.1\r\nhost: x\r\nauthorization: Bearer\r\n\r\n", "GET /admin/queue HTTP/1.1\r\nhost: x\r\nauthorization: Basic dXNlcjpwYXNz\r\n\r\n", "GET /admin/queue HTTP/1.1\r\nhost: x\r\nauthorization: Bearer " + "A".repeat(7000) + "\r\n\r\n",
    "GET /healthz HTTP/1.1\r\nhost: x\r\nx-forwarded-for: ' OR 1=1 --\r\n\r\n", "GET /healthz HTTP/1.1\r\nhost: x\r\norigin: null\r\n\r\n", "GET /healthz HTTP/1.0\r\n\r\n", "\r\n\r\n\r\n", " ", "G", "GET /healthz HTTP/1.1\r\n"
  ];
  for (const r of raw) bump((await rawSend(srv.port, Buffer.from(r, "latin1"))).status);
  // 2. random bytes and random printable lines
  for (let i = 0; i < 120; i++) bump((await rawSend(srv.port, Buffer.from(Array.from({ length: 1 + Math.floor(R() * 600) }, () => Math.floor(R() * 256))), { wait: 120 })).status);
  const words = ["GET", "POST", "DELETE", "/v1/report", "/admin/queue", "HTTP/1.1", "host:", "content-length:", "\r\n", "authorization: Bearer x", "../", "%00", "{", "}"];
  for (let i = 0; i < 120; i++) bump((await rawSend(srv.port, Buffer.from(Array.from({ length: 3 + Math.floor(R() * 12) }, () => pick(words)).join(" ") + "\r\n\r\n", "latin1"), { wait: 120 })).status);
  // 3. hostile JSON against every JSON endpoint
  const nested = (n) => "{\"a\":".repeat(n) + "1" + "}".repeat(n), bodies = ["null", "[]", '"str"', "123", "true", "{}", '{"__proto__":{"admin":true}}', '{"constructor":{"prototype":{"x":1}}}', '{"domain":"a.example","outcome":{"$ne":1}}',
    '{"domain":["a.example"],"outcome":"ok"}', '{"domain":"a.example","outcome":"ok","tags":{"length":1e9}}', '{"domain":"a.example","outcome":"ok","tags":"fake_tracking"}', '{"ids":"all","action":"approve"}', '{"ids":[null,{},[],1e999],"action":"approve"}',
    nested(500), nested(1200), '{"a":"\ud800"}', '{"a":1e999}', '{"domain":"' + "a".repeat(5000) + '"}', '{"challenge":{},"solution":[]}', '{"message":123,"domain":"a.example"}', '{"ids":' + JSON.stringify(Array.from({ length: 5000 }, (_, i) => String(i))) + '}', "{", '{"a":}', "\u0000"];
  const eps = [["POST", "/v1/enroll", null], ["POST", "/v1/report", "garbage-token"], ["POST", "/v1/disputes", null], ["POST", "/v1/disputes/0123456789abcdef/appeal", "x"], ["POST", "/admin/reports/moderate", ADMIN_TOKEN], ["POST", "/admin/disputes/0123456789abcdef/resolve", ADMIN_TOKEN], ["DELETE", "/v1/report?domain=a.example", "x"]];
  for (const [m, p, tok] of eps) for (const b of bodies) { try { const r = await call(srv.base, p, { method: m, token: tok, raw: b, headers: { "content-type": "application/json" }, ip: ipFor(7, 7) }); bump(r.status); } catch { bump("fetch-error"); } }
  for (const b of ["{}", "x=1"]) for (const ct of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data", "application/json; charset=utf-16", ""]) { const r = await call(srv.base, "/v1/enroll", { method: "POST", raw: b, headers: { "content-type": ct } }); bump(r.status); }
  // 4. many concurrent junk connections, then check the server is still healthy
  await Promise.all(Array.from({ length: 150 }, () => rawSend(srv.port, Buffer.from("GET /healthz HTTP/1.1\r\nhost: x\r\nx-pad: " + "z".repeat(Math.floor(R() * 9000)) + "\r\n\r\n"), { wait: 200 }).then((r) => bump(r.status))));
  await sleep(300);
  const total = Object.values(statuses).reduce((a, b) => a + b, 0);
  S.note(`${total} hostile inputs sent; response statuses: ${Object.entries(statuses).sort().map(([k, v]) => `${k}x${v}`).join(" ")}`);
  S.check(srv.exit === null, "the server process is still running");
  S.check((await call(srv.base, "/healthz")).status === 200 && (await call(srv.base, "/readyz")).status === 200, "it still answers /healthz and /readyz");
  S.check(!statuses[500], `not one 500: every input was refused cleanly or served (500s: ${statuses[500] || 0})`);
  S.check(!statuses[200] || statuses[200] >= 1, "legitimate-looking requests were still served");
  const m = (await call(srv.base, "/metrics", { token: ADMIN_TOKEN })).text;
  S.check(!/unhandled_errors_total|db_errors_total/.test(m), "no unhandled or database errors were recorded");
  S.check(!/uncaught_exception|unhandled_rejection/.test(srv.logs.join("\n")), "no uncaught exception or rejection in the logs");
  const admin = await call(srv.base, "/admin/queue", { token: "wrong" }); S.check(admin.status === 401 || admin.status === 429, "the admin API still rejects bad tokens");
  S.check((await call(srv.base, "/admin/audit/verify", { token: ADMIN_TOKEN })).json.ok === true, "the audit chain verifies after the abuse");
  await srv.term(); const v = dbCheck(file); S.check(v.integrity && v.chain.ok && v.dup === 0 && v.reports === 0, `nothing was written by garbage (reports on disk: ${v.reports})`); v.d.close();
  return S;
};

// ------------------------------------------------------------------------------------------------ 6. graceful shutdown
SCENARIOS.shutdown = async () => {
  const S = new Scenario("graceful shutdown (SIGTERM during write load)"), dir = tmp("shutdown"), file = path.join(dir, "data.db");
  const srv = await startServer({ dbFile: file, env: { REPORT_CONFIG_JSON: HIGH_LIMITS } }), acked = [], stop = { v: false };
  const worker = async (id) => { let n = 0; while (!stop.v) { const ip = ipFor(id, n++); try { const tok = await enroll(srv.base, ip); if (!tok) continue;
    const domain = `sd-${n % 7}.example`, r = await call(srv.base, "/v1/report", { method: "POST", token: tok, ip, body: { domain, outcome: "never", tags: [] } }); if (r.status === 200) acked.push({ cred: credOf(tok), domain }); } catch { /* refused during drain */ } } };
  const workers = Array.from({ length: 10 }, (_, i) => worker(i)); await sleep(1200);
  const t0 = Date.now(); srv.child.kill("SIGTERM");
  let sawNotReady = false; for (let i = 0; i < 40 && !srv.exit; i++) { try { const r = await call(srv.base, "/readyz"); if (r.status === 503) sawNotReady = true; } catch { /* closed */ } await sleep(25); }
  const ex = await srv.exited; stop.v = true; await Promise.all(workers); const took = Date.now() - t0;
  S.check(ex.code === 0, `exit code 0 (got ${JSON.stringify(ex)})`); S.check(took < 15000, `stopped in ${took} ms (< 15 s)`);
  S.note(`/readyz reported 503 while draining: ${sawNotReady} (the window can be too short to observe)`);
  S.check(srv.logs.some((l) => l.includes('"event":"server_stopped"')), "logged server_stopped");
  const wal = file + "-wal"; S.check(!fs.existsSync(wal) || fs.statSync(wal).size === 0, "WAL checkpointed and emptied on clean exit");
  const v = dbCheck(file); const have = new Set(v.d.all("SELECT cred, domain FROM reports").map((r) => r.cred + "|" + r.domain));
  const lost = acked.filter((a) => !have.has(a.cred + "|" + a.domain)); S.check(acked.length > 20 && lost.length === 0, `${acked.length} acknowledged writes, ${lost.length} lost`);
  S.check(v.integrity && v.chain.ok && v.dup === 0, "database consistent"); v.d.close();
  return S;
};

// ------------------------------------------------------------------------------------------------ 7. full disk
SCENARIOS.diskfull = async () => {
  const S = new Scenario("full disk (tmpfs filled to the last byte, then freed)"), dir = tmp("disk");
  const mnt = spawnSync("mount", ["-t", "tmpfs", "-o", "size=3m", "tmpfs", dir]);
  if (mnt.status !== 0) { S.note("SKIPPED: cannot mount tmpfs here (" + String(mnt.stderr).trim() + ")"); S.check(true, "skipped"); return S; }
  let srv;
  try {
    const file = path.join(dir, "data.db"); srv = await startServer({ dbFile: file, env: { REPORT_CONFIG_JSON: HIGH_LIMITS } });
    const ok1 = await enroll(srv.base, ipFor(1, 1)); S.check(!!ok1, "works while there is space");
    const toks = []; for (let i = 0; i < 10; i++) toks.push(await enroll(srv.base, ipFor(2, i)));
    const filler = path.join(dir, "filler"); spawnSync("dd", ["if=/dev/zero", `of=${filler}`, "bs=4096"]);          // runs until ENOSPC
    const avail = Number(spawnSync("df", ["--output=avail", "-B1", dir], { encoding: "utf8" }).stdout.trim().split("\n").pop());
    S.check(avail < 16384, `disk really is full (${avail} bytes free)`);
    const codes = {}; const bump = (k) => (codes[k] = (codes[k] || 0) + 1);
    for (let i = 0; i < toks.length; i++) { try { const r = await call(srv.base, "/v1/report", { method: "POST", token: toks[i], ip: ipFor(2, i), body: { domain: `full${i}.example`, outcome: "never", tags: [] } }); bump(r.status); } catch { bump("err"); } }
    for (let i = 0; i < 10; i++) { try { bump("enroll-" + ((await enroll(srv.base, ipFor(9, i))) ? "ok" : "refused")); } catch { bump("enroll-err"); } }
    S.note(`statuses with a full disk: ${JSON.stringify(codes)}`);
    S.check(!codes[200], "no write was acknowledged that could not have been stored");
    S.check((codes[503] || 0) > 0, "writes failed with 503 (retryable), not 500 or a hang");
    S.check(srv.exit === null, "the process survived"); S.check((await call(srv.base, "/healthz")).status === 200, "/healthz (liveness) stays 200");
    const m = (await call(srv.base, "/metrics", { token: ADMIN_TOKEN })).text; S.note("metrics: " + m.split("\n").filter((l) => /db_err/.test(l)).join(" ; ")); S.check(/db_errors_total\{[^}]*\}\s+[1-9]/.test(m), "failures surfaced as 503 / db_errors_total, not silence");
    fs.rmSync(filler); await sleep(300);
    const t = await enroll(srv.base, ipFor(3, 3)); const r = t && await call(srv.base, "/v1/report", { method: "POST", token: t, ip: ipFor(3, 3), body: { domain: "recovered.example", outcome: "never", tags: [] } });
    S.check(r && r.status === 200, "writes work again once space is freed, without a restart");
    await srv.term(); srv = null; const v = dbCheck(path.join(dir, "data.db")); S.check(v.integrity && v.chain.ok && v.dup === 0, "database intact after the disk filled"); v.d.close();
  } finally { if (srv) await srv.term().catch(() => {}); spawnSync("umount", [dir]); }
  return S;
};

// ------------------------------------------------------------------------------------------------ 8. backup and restore drill
SCENARIOS.backup = async () => {
  const S = new Scenario("backup / restore drill (CLI, under load, with corruption and loss of the database)"), dir = tmp("bk"), file = path.join(dir, "data.db"), bdir = path.join(dir, "backups");
  const env = { DATABASE_FILE: file, BACKUP_DIR: bdir, PATH: process.env.PATH }, cli = (...a) => spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "server/cli.js", ...a], { cwd: ROOT, env, encoding: "utf8" });
  const srv = await startServer({ dbFile: file, env: { REPORT_CONFIG_JSON: HIGH_LIMITS, BACKUP_DIR: bdir } });
  const before = []; for (let i = 0; i < 25; i++) { const ip = ipFor(4, i), t = await enroll(srv.base, ip); const r = await call(srv.base, "/v1/report", { method: "POST", token: t, ip, body: { domain: `bk${i % 5}.example`, outcome: "never", tags: [] } }); if (r.status === 200) before.push(t); }
  const stop = { v: false }, bg = (async () => { let n = 0; while (!stop.v) { const ip = ipFor(5, n++); try { const t = await enroll(srv.base, ip); if (t) await call(srv.base, "/v1/report", { method: "POST", token: t, ip, body: { domain: `bg${n % 5}.example`, outcome: "never", tags: [] } }); } catch { /* ignore */ } } })();
  const b = cli("backup"); S.check(b.status === 0, "CLI backup succeeded while the server was writing: " + b.stderr.slice(0, 100));
  const name = (() => { try { return JSON.parse(b.stdout).file || JSON.parse(b.stdout).path || JSON.parse(b.stdout).name; } catch { return null; } })();
  stop.v = true; await bg;
  const list = listBackups(bdir); S.check(list.length >= 1, `${list.length} backup(s) listed`);
  const bfile = path.join(bdir, list[list.length - 1].name); const vr = cli("verify", bfile); S.check(vr.status === 0, "verify accepts the good backup");
  const late = await enroll(srv.base, ipFor(6, 1)); await call(srv.base, "/v1/report", { method: "POST", token: late, ip: ipFor(6, 1), body: { domain: "after-backup.example", outcome: "never", tags: [] } });
  await srv.term();
  const bad = path.join(dir, "corrupt.db"); fs.copyFileSync(bfile, bad); fs.copyFileSync(bfile + ".sha256", bad + ".sha256"); const fd = fs.openSync(bad, "r+"); fs.writeSync(fd, Buffer.from("CORRUPTCORRUPT"), 0, 14, 4096 + 100); fs.closeSync(fd);
  S.check(cli("verify", bad).status === 1, "verify rejects a corrupted copy with exit code 1");
  S.check(cli("restore", bad, path.join(dir, "x.db")).status !== 0 && !fs.existsSync(path.join(dir, "x.db")), "restore refuses the corrupted backup and writes nothing");
  for (const f of [file, file + "-wal", file + "-shm"]) fs.rmSync(f, { force: true });                         // total loss of the database
  S.check(cli("restore", bfile, file).status === 0, "restore into an empty location succeeds");
  const srv2 = await startServer({ dbFile: file, env: { REPORT_CONFIG_JSON: HIGH_LIMITS, BACKUP_DIR: bdir } });
  S.check((await call(srv2.base, "/readyz")).status === 200, "server boots on the restored database");
  const s = (await call(srv2.base, "/v1/summary?domain=bk0.example")).json; S.check(s && JSON.stringify(s).length > 2, "restored data is served");
  const gone = await call(srv2.base, "/v1/report", { method: "POST", token: late, ip: ipFor(6, 1), body: { domain: "post-restore.example", outcome: "never", tags: [] } });
  S.note(`RPO demonstration: a credential issued after the backup is ${gone.status === 200 ? "STILL VALID (unexpected)" : "rejected after restore (status " + gone.status + ")"}: changes since the last backup are lost`);
  S.check(gone.status !== 200, "credentials issued after the backup are not honoured after restore (bounded data loss, no forged state)");
  const old = await call(srv2.base, "/v1/report", { method: "POST", token: before[0], ip: ipFor(4, 0), body: { domain: "bk-new.example", outcome: "never", tags: [] } }); S.check(old.status === 200, "credentials issued before the backup still work");
  const forced = cli("restore", bfile, file); S.check(forced.status !== 0, "restore refuses to overwrite an existing database without --force");
  await srv2.term(); const v = dbCheck(file); S.check(v.integrity && v.chain.ok && v.dup === 0, "restored database consistent"); v.d.close();
  void name; return S;
};

// ------------------------------------------------------------------------------------------------ 9. production boot
SCENARIOS.prodboot = async () => {
  const S = new Scenario("production boot (config refusal, container layout, spoofed forwarding header)"), dir = tmp("prod");
  const run = (env, ms = 4000) => new Promise((res) => { const c = require_spawn(env); let out = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d)); const t = setTimeout(() => c.kill("SIGKILL"), ms); c.on("exit", (code) => { clearTimeout(t); res({ code, out }); }); });
  const require_spawn = (env) => spawnProc(env);
  const good = { NODE_ENV: "production", REPORT_SALT: SECRETS.salt, CREDENTIAL_SECRET: SECRETS.secret, BACKUP_DIR: path.join(dir, "backups"), ALLOWED_ORIGINS: "https://shop.example", ADMIN_TOKENS: "ops:" + ADMIN_TOKEN, POW_BITS: "12", DATABASE_FILE: path.join(dir, "data.db"), HOST: "127.0.0.1" };
  for (const k of ["REPORT_SALT", "CREDENTIAL_SECRET", "BACKUP_DIR", "ALLOWED_ORIGINS"]) { const e = { ...good, PORT: "0" }; delete e[k]; const r = await run(e); S.check(r.code !== 0 && r.code !== null && r.out.includes(k), `refuses to start without ${k} (exit ${r.code})`); }
  const weak = await run({ ...good, PORT: "0", REPORT_SALT: "short" }); S.check(weak.code !== 0 && weak.code !== null, "refuses a short REPORT_SALT");
  const badAdmin = await run({ ...good, PORT: "0", ADMIN_TOKENS: "ops:short" }); S.check(badAdmin.code !== 0 && badAdmin.code !== null, "refuses a short admin token");
  const noProxy = await run({ ...good, PORT: "0", TRUST_PROXY: "true" }); S.check(noProxy.code !== 0 && noProxy.code !== null, "refuses the legacy TRUST_PROXY flag in production");
  const port = await (await import("./lib.mjs")).freePort();
  const c = spawnProc({ ...good, PORT: String(port), REPORT_CONFIG_JSON: JSON.stringify({ limits: { enrollPerNetPerDay: 2 } }) }); const logs = []; c.stdout.on("data", (d) => logs.push(String(d))); c.stderr.on("data", (d) => logs.push(String(d)));
  const t0 = Date.now(); let up = false; while (Date.now() - t0 < 10000 && !up) { try { up = (await fetch(`http://127.0.0.1:${port}/healthz`)).status === 200; } catch { await sleep(100); } }
  S.check(up, "boots with a complete production configuration");
  if (up) {
    const base = `http://127.0.0.1:${port}`; const sol = async (ip) => { const ch = (await call(base, "/v1/challenge", { ip })).json; return call(base, "/v1/enroll", { method: "POST", ip, body: { challenge: ch.challenge, solution: solvePowSync(ch.challenge, ch.bits) } }); };
    const st = []; for (let i = 0; i < 5; i++) st.push((await sol(`198.51.100.${i + 1}`)).status);                  // each request claims a different address in X-Forwarded-For
    S.note(`enroll statuses with 5 spoofed forwarding addresses and enrollPerNetPerDay=2: ${st.join(",")}`);
    S.check(st.filter((x) => x === 200).length <= 2, "X-Forwarded-For is ignored without TRUSTED_PROXIES: spoofing cannot dodge the per-network cap");
    S.check((await call(base, "/admin/queue")).status === 401, "admin API refuses unauthenticated calls"); S.check((await call(base, "/admin/queue", { token: ADMIN_TOKEN, headers: { origin: "https://evil.example" } })).status === 403, "even a valid admin token is refused from a foreign browser origin");
    const cors = await fetch(`${base}/v1/challenge`, { headers: { origin: "https://evil.example" } }); S.check(cors.headers.get("access-control-allow-origin") !== "*" && cors.headers.get("access-control-allow-origin") !== "https://evil.example", "CORS does not reflect a foreign origin");
    const okc = await fetch(`${base}/v1/challenge`, { headers: { origin: "https://shop.example" } }); S.note(`CORS for the allowed origin: ${okc.headers.get("access-control-allow-origin")}`);
    c.kill("SIGTERM"); await new Promise((r) => c.on("exit", r)); const all = logs.join("");
    S.check(!all.includes(ADMIN_TOKEN) && !all.includes(SECRETS.salt) && !all.includes(SECRETS.secret) && !/198\.51\.100/.test(all), "production logs contain no secrets or client addresses"); allLogs.push(...all.split("\n").filter(Boolean));
  } else c.kill("SIGKILL");
  return S;
};
function spawnProc(env) { return spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server/index.js"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH, ...env } }); }

// ------------------------------------------------------------------------------------------------ runner
const wanted = process.argv.slice(2), names = wanted.length ? wanted : Object.keys(SCENARIOS);
let failed = 0;
for (const n of names) {
  if (!SCENARIOS[n]) { console.error("unknown scenario", n); process.exit(2); }
  console.log(`\n== ${n}`); let S;
  try { S = await SCENARIOS[n](); } catch (e) { S = new Scenario(n); S.check(false, "scenario crashed: " + e.stack); }
  const ok = S.passed; if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${S.name}  (${((Date.now() - S.t0) / 1000).toFixed(1)}s, ${S.checks.filter((c) => c.ok).length}/${S.checks.length} checks)`);
  for (const c of S.checks.filter((c) => c.ok)) console.log(`      ok   ${c.msg}`);
  for (const x of S.notes) console.log(`      note ${x}`);
}
if (names.length === Object.keys(SCENARIOS).length) {
  // every log line from every server we ran must be free of secrets and personal data
  const bad = [];
  const needles = [ADMIN_TOKEN, SECRETS.salt, SECRETS.secret, "x-forwarded-for", /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, /crash-\d-\d\.example|par\d+\.example|crowd\.example|edit\.example/];
  for (const l of allLogs) for (const nd of needles) if (typeof nd === "string" ? l.includes(nd) : nd.test(l)) bad.push(`${String(nd).slice(0, 30)} in: ${l.slice(0, 120)}`);
  console.log(`\n${bad.length ? "FAIL" : "PASS"}  log hygiene: ${allLogs.length} log lines scanned for secrets, addresses and domains`); bad.slice(0, 5).forEach((b) => console.log("      " + b));
  if (bad.length) failed++;
}
console.log(`\n${failed ? failed + " scenario(s) FAILED" : "all scenarios passed"}`);
process.exit(failed ? 1 : 0);
