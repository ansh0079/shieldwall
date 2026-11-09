// Proof-of-work solver for credential enrolment (SHA-256 with N leading zero bits; same algorithm as server/credentials.js).
// A speed bump on identity creation, not a defence by itself. The client refuses absurd difficulties from a hostile server.
export const MAX_POW_BITS = 22;

export function leadingZeroBits(bytes) {
  let n = 0;
  for (const b of bytes) { if (b === 0) { n += 8; continue; } n += Math.clz32(b) - 24; break; }
  return n;
}
export async function solvePow(challenge, bits, { signal } = {}) {
  if (!Number.isInteger(bits) || bits < 1 || bits > MAX_POW_BITS) throw new Error("unreasonable proof-of-work difficulty");
  const enc = new TextEncoder();
  for (let i = 0; ; i++) {
    if (signal?.aborted) throw new Error("cancelled");
    const h = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(`${challenge}:${i}`)));
    if (leadingZeroBits(h) >= bits) return String(i);
    if (i % 1500 === 1499) await new Promise((r) => setTimeout(r, 0));     // let the service worker breathe
  }
}
