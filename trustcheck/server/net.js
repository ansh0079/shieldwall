// Network helpers: CIDR matching (IPv4 + IPv6), safe resolution of the client address behind a proxy, origin allowlists.
import { isIP } from "node:net";

// "::ffff:1.2.3.4" -> "1.2.3.4"; strips a zone id; lower-cases. Returns null for anything that is not an IP address.
export function normalizeIp(ip) {
  if (typeof ip !== "string") return null;
  let s = ip.trim().split("%")[0].toLowerCase();
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (m) s = m[1];
  return isIP(s) ? s : null;
}
function toBig(ip) {
  const v = isIP(ip);
  if (v === 4) return { v, n: ip.split(".").reduce((a, o) => (a << 8n) | BigInt(o), 0n) };
  let s = ip;
  if (s.includes(".")) { const i = s.lastIndexOf(":"), [a, b, c, d] = s.slice(i + 1).split(".").map(Number); s = `${s.slice(0, i + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`; }
  const [l, r] = s.split("::"), L = l ? l.split(":") : [], R = r !== undefined ? (r ? r.split(":") : []) : [];
  const groups = r === undefined ? L : [...L, ...Array(8 - L.length - R.length).fill("0"), ...R];
  return { v, n: groups.reduce((a, g) => (a << 16n) | BigInt(parseInt(g || "0", 16)), 0n) };
}
export function parseCidr(text) {
  const [addr, len, extra] = String(text).trim().split("/");
  const ip = normalizeIp(addr);
  if (!ip || extra !== undefined) throw new Error(`invalid address or network: "${text}"`);
  const { v, n } = toBig(ip), max = v === 4 ? 32 : 128, bits = len === undefined ? max : Number(len);
  if (!Number.isInteger(bits) || bits < 0 || bits > max || (len !== undefined && !/^\d+$/.test(len))) throw new Error(`invalid prefix length in "${text}"`);
  const shift = BigInt(max - bits);
  return { v, bits, base: (n >> shift) << shift, text: String(text).trim() };
}
export function inCidr(ip, cidr) {
  const a = normalizeIp(ip);
  if (!a) return false;
  const { v, n } = toBig(a);
  if (v !== cidr.v) return false;
  const shift = BigInt((v === 4 ? 32 : 128) - cidr.bits);
  return ((n >> shift) << shift) === cidr.base;
}
export const inAny = (ip, cidrs) => cidrs.some((c) => inCidr(ip, c));
// A trusted-proxy list that includes everyone (/0) would let any client forge its address: always refused.
export function parseCidrList(text) {
  const out = [];
  for (const part of String(text || "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const c = parseCidr(part);
    if (c.bits === 0) throw new Error(`"${part}" matches every address; refusing it`);
    out.push(c);
  }
  return out;
}

// The direct peer is only believed to be a proxy if it is in `trusted`. Then X-Forwarded-For is read RIGHT TO LEFT and the first
// address that is not itself a trusted proxy is the client. A malformed header is ignored (the peer address is used) and flagged.
export function resolveClientIp(req, trusted = []) {
  const peer = normalizeIp(req.socket?.remoteAddress) || "unknown";
  const xff = req.headers["x-forwarded-for"];
  if (!trusted.length || peer === "unknown" || !inAny(peer, trusted)) return { ip: peer, via: "peer", forwardedIgnored: !!xff };
  if (!xff) return { ip: peer, via: "peer" };
  const hops = String(xff).split(",").map((s) => s.trim());
  if (hops.length > 10 || hops.some((h) => !normalizeIp(h))) return { ip: peer, via: "peer", malformed: true };
  const addrs = hops.map(normalizeIp);
  for (let i = addrs.length - 1; i >= 0; i--) if (!inAny(addrs[i], trusted)) return { ip: addrs[i], via: "forwarded" };
  return { ip: addrs[0], via: "forwarded" };
}

// ---- origins ----
const ORIGIN_RE = /^(https?|chrome-extension|moz-extension):\/\/[a-z0-9.-]+(:\d{1,5})?$/;
export function parseOrigins(text, { production = false } = {}) {
  const t = String(text ?? "").trim();
  if (t === "*") { if (production) throw new Error('ALLOWED_ORIGINS="*" is not allowed in production'); return "*"; }
  if (t === "none") return new Set();
  const set = new Set();
  for (const o of t.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    if (!ORIGIN_RE.test(o)) throw new Error(`invalid origin "${o}" (expected scheme://host[:port], for example chrome-extension://<extension id>)`);
    set.add(o);
  }
  return set;
}
export const originAllowed = (origin, allowed) => allowed === "*" || (typeof origin === "string" && allowed.has(origin.toLowerCase()));
