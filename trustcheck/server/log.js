// Structured, privacy-conscious logging and metrics. Logs are JSON lines. Request logs name the route template, never the raw
// URL, IP address, token, request body or query. Anything that looks like an address or a credential is redacted defensively.
import { isIPv6 } from "node:net";
const SENSITIVE_KEY = /token|secret|authorization|password|passwd|cookie|credential|solution|challenge|proof|contact|message|body|^ip$|addr|salt/i;
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g, V6_CANDIDATE = /[0-9a-f:]{2,}(?:%\w+)?/gi, TOKENISH = /[A-Za-z0-9_-]{22,}(?:\.[A-Za-z0-9_-]{8,})*/g;

// IPv6 is found by candidate + Node's own parser (a regex alone leaves partial addresses behind). Timestamps like 03:04:05 are not IPv6.
export function redactString(s) {
  return String(s).replace(IPV4, "[ip]").replace(V6_CANDIDATE, (m) => (m.includes(":") && isIPv6(m.split("%")[0]) ? "[ip]" : m)).replace(TOKENISH, "[redacted]");
}
export function redact(v, depth = 0) {
  if (v === null || v === undefined || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "string") return redactString(v).slice(0, 500);
  if (depth > 3) return "[deep]";
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => redact(x, depth + 1));
  // A sensitive-looking KEY hides its value, but a plain number/boolean (a count such as credentials: 3) is not a secret and stays useful.
  if (typeof v === "object") return Object.fromEntries(Object.entries(v).slice(0, 40).map(([k, x]) => [k, SENSITIVE_KEY.test(k) && typeof x !== "number" && typeof x !== "boolean" ? "[redacted]" : redact(x, depth + 1)]));
  return String(v);
}
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
export function createLogger({ write = (line) => process.stdout.write(line + "\n"), level = "info", now = () => Date.now(), base = {} } = {}) {
  const min = LEVELS[level] ?? 20;
  const log = (lvl, event, fields = {}) => {
    if (LEVELS[lvl] < min) return;
    write(JSON.stringify({ ts: new Date(now()).toISOString(), level: lvl, event, ...redact(base), ...redact(fields) }));
  };
  return { debug: (e, f) => log("debug", e, f), info: (e, f) => log("info", e, f), warn: (e, f) => log("warn", e, f), error: (e, f) => log("error", e, f) };
}

export class Metrics {
  constructor() { this.counters = new Map(); this.gauges = new Map(); this.hist = new Map(); this.start = Date.now(); }
  static key(name, labels) { const l = labels ? Object.entries(labels).sort().map(([k, v]) => `${k}="${String(v).replace(/["\\\n]/g, "")}"`).join(",") : ""; return l ? `${name}{${l}}` : name; }
  inc(name, n = 1, labels) { const k = Metrics.key(name, labels); this.counters.set(k, (this.counters.get(k) || 0) + n); }
  set(name, v, labels) { this.gauges.set(Metrics.key(name, labels), v); }
  observe(name, seconds, labels) {
    const k = Metrics.key(name, labels), h = this.hist.get(k) || { sum: 0, count: 0, b: new Array(BUCKETS.length).fill(0) };
    h.sum += seconds; h.count++; BUCKETS.forEach((b, i) => { if (seconds <= b) h.b[i]++; }); this.hist.set(k, h);
  }
  get(name, labels) { return this.counters.get(Metrics.key(name, labels)) ?? this.gauges.get(Metrics.key(name, labels)) ?? 0; }
  render() {
    const out = [`# TYPE trustcheck_uptime_seconds gauge`, `trustcheck_uptime_seconds ${Math.round((Date.now() - this.start) / 1000)}`];
    for (const [k, v] of this.counters) out.push(`trustcheck_${k} ${v}`);
    for (const [k, v] of this.gauges) out.push(`trustcheck_${k} ${v}`);
    for (const [k, h] of this.hist) {
      const [name, lab] = k.includes("{") ? [k.slice(0, k.indexOf("{")), k.slice(k.indexOf("{") + 1, -1)] : [k, ""];
      BUCKETS.forEach((b, i) => out.push(`trustcheck_${name}_bucket{${lab ? lab + "," : ""}le="${b}"} ${h.b[i]}`));
      out.push(`trustcheck_${name}_bucket{${lab ? lab + "," : ""}le="+Inf"} ${h.count}`, `trustcheck_${name}_sum${lab ? `{${lab}}` : ""} ${h.sum.toFixed(6)}`, `trustcheck_${name}_count${lab ? `{${lab}}` : ""} ${h.count}`);
    }
    return out.join("\n") + "\n";
  }
}
const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5];
