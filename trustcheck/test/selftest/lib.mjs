// Helpers for process-level self-tests: real server processes, real sockets, no mocks.
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { solvePowSync } from "../../server/credentials.js";

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const ADMIN_TOKEN = "selftest-admin-token-0123456789abcdef";
export const SECRETS = { salt: "selftest-salt-" + "s".repeat(30), secret: "selftest-secret-" + "k".repeat(30) };
export const allLogs = [];                                      // every line from every server we start (scanned for leaks at the end)
export const HIGH_LIMITS = JSON.stringify({ limits: { enrollPerNetPerDay: 1e9, enrollPerHour: 1e9, reportsPerCredPerDay: 1e9, reportsPerNetPerHour: 1e9, newIdentityReportsPerDomainPerDay: 1e9, correctionsPerCredPerDomain: 1e9 } });

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
export const credOf = (t) => JSON.parse(Buffer.from(t.split(".")[0], "base64url").toString()).c;
export const pct = (arr, p) => { const a = [...arr].sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] : 0; };

export async function startServer({ dbFile, env = {}, tag = "srv" } = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server/index.js"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, PORT: String(port), HOST: "127.0.0.1", DATABASE_FILE: dbFile, POW_BITS: "8", RATE_LIMIT: "100000000", READ_LIMIT: "100000000", MAX_CONCURRENT_PER_IP: "5000",
      TRUSTED_PROXIES: "127.0.0.1/32", ADMIN_TOKENS: `ops:${ADMIN_TOKEN}`, REPORT_SALT: SECRETS.salt, CREDENTIAL_SECRET: SECRETS.secret, LOG_LEVEL: "info", ...env } });
  const s = { port, base: `http://127.0.0.1:${port}`, child, pid: child.pid, logs: [], errs: [], exit: null, tag };
  const onData = (arr) => { let buf = ""; return (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l) { arr.push(l); allLogs.push(l); } } }; };
  child.stdout.on("data", onData(s.logs)); child.stderr.on("data", onData(s.errs));
  s.exited = new Promise((res) => child.on("exit", (code, sig) => { s.exit = { code, sig }; res(s.exit); }));
  const t0 = Date.now();
  while (!s.logs.some((l) => l.includes('"event":"server_start"'))) {
    if (s.exit) throw new Error(`server exited early (${JSON.stringify(s.exit)}): ${s.logs.concat(s.errs).slice(-3).join(" | ")}`);
    if (Date.now() - t0 > 15000) { child.kill("SIGKILL"); throw new Error("server did not start"); }
    await sleep(25);
  }
  s.kill9 = () => { child.kill("SIGKILL"); return s.exited; };
  s.term = () => { child.kill("SIGTERM"); return s.exited; };
  s.rss = () => { try { return Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${s.pid}/status`, "utf8"))[1]) * 1024; } catch { return 0; } };
  s.fds = () => { try { return fs.readdirSync(`/proc/${s.pid}/fd`).length; } catch { return 0; } };
  return s;
}

export async function call(base, p, { method = "GET", body, token, ip, headers = {}, raw } = {}) {
  const h = { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(ip ? { "x-forwarded-for": ip } : {}), ...headers };
  const res = await fetch(base + p, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, headers: res.headers };
}
export async function enroll(base, ip) {
  const ch = (await call(base, "/v1/challenge", { ip })).json;
  const r = await call(base, "/v1/enroll", { method: "POST", ip, body: { challenge: ch.challenge, solution: solvePowSync(ch.challenge, ch.bits) } });
  return r.status === 200 ? r.json.token : null;
}
export const ipFor = (a, b) => `10.${a % 250}.${b % 250}.${(a * 7 + b) % 250 + 1}`;

// Tiny reporter: each scenario collects checks; a scenario passes only if every check passes.
export class Scenario {
  constructor(name) { this.name = name; this.checks = []; this.notes = []; this.t0 = Date.now(); }
  check(ok, msg) { this.checks.push({ ok: !!ok, msg }); if (!ok) console.log(`      FAIL: ${msg}`); return !!ok; }
  note(msg) { this.notes.push(msg); }
  get passed() { return this.checks.every((c) => c.ok); }
}
