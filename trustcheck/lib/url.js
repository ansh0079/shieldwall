// URL normalisation for URL-scoped checks (Safe Browsing) and navigation identity.
export function normalizeUrl(input, { dropQuery = false } = {}) {
  let u; try { u = new URL(input); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = ""; u.username = ""; u.password = "";            // fragments never reach servers; credentials must never be sent
  if (dropQuery) u.search = "";
  return u.href;                                             // URL() already lowercases scheme/host and drops default ports
}
export function sameDocument(a, b) { const x = normalizeUrl(a), y = normalizeUrl(b); return !!x && x === y; }
export async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
