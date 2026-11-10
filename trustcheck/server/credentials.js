// Server-issued installation credentials and proof-of-work challenges. Stateless where possible (HMAC), no dependencies.
import crypto from "node:crypto";

const b64u = (b) => Buffer.from(b).toString("base64url");
const hmac = (secret, data) => crypto.createHmac("sha256", secret).update(data).digest();

export function timingSafeEqualStr(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  const len = Math.max(x.length, y.length, 1);
  const px = Buffer.alloc(len), py = Buffer.alloc(len); x.copy(px); y.copy(py);
  return crypto.timingSafeEqual(px, py) && x.length === y.length;     // constant-time, also for different lengths
}

// Credential token = base64url(JSON payload) . base64url(HMAC). A client cannot invent or alter one.
export function signToken(payload, secret) {
  const body = b64u(JSON.stringify(payload));
  return `${body}.${b64u(hmac(secret, body))}`;
}
export function verifyToken(token, secret) {
  if (typeof token !== "string" || token.length > 512) return null;
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return null;
  if (!timingSafeEqualStr(sig, b64u(hmac(secret, body)))) return null;
  try { const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); return p && typeof p === "object" ? p : null; } catch { return null; }
}

// ---- proof of work (a speed bump on identity creation, not a defence by itself) ----
export function leadingZeroBits(buf) {
  let n = 0;
  for (const byte of buf) { if (byte === 0) { n += 8; continue; } n += Math.clz32(byte) - 24; break; }
  return n;
}
export const powHash = (challenge, solution) => crypto.createHash("sha256").update(`${challenge}:${solution}`).digest();

export function makeChallenge(secret, { bits, now = Date.now() }) {
  const payload = `${now}.${crypto.randomBytes(12).toString("hex")}.${bits}`;
  return `${payload}.${b64u(hmac(secret, payload)).slice(0, 22)}`;
}
export function verifyPow(challenge, solution, secret, { now = Date.now(), ttlMs = 5 * 60_000, minBits = 0 } = {}) {
  if (typeof challenge !== "string" || typeof solution !== "string" || solution.length > 64 || challenge.length > 200) return { ok: false, reason: "malformed" };
  const parts = challenge.split(".");
  if (parts.length !== 4) return { ok: false, reason: "malformed" };
  const [ts, nonce, bitsStr, sig] = parts, payload = `${ts}.${nonce}.${bitsStr}`, bits = Number(bitsStr);
  if (!timingSafeEqualStr(sig, b64u(hmac(secret, payload)).slice(0, 22))) return { ok: false, reason: "bad signature" };
  if (!(now - Number(ts) <= ttlMs && now >= Number(ts) - 5000)) return { ok: false, reason: "expired" };
  if (!Number.isInteger(bits) || bits < minBits) return { ok: false, reason: "too easy" };
  if (leadingZeroBits(powHash(challenge, solution)) < bits) return { ok: false, reason: "insufficient work" };
  return { ok: true };
}
// Reference solver (used by tests and the server-side tooling; the extension has an async equivalent in lib/pow.js).
export function solvePowSync(challenge, bits) {
  for (let i = 0; ; i++) if (leadingZeroBits(powHash(challenge, String(i))) >= bits) return String(i);
}
