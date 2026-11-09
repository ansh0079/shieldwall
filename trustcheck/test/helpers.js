// Test helpers: real Response objects so the streaming/size-limit paths are exercised.
export const json = (obj, { status = 200, headers = {} } = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...headers } });
export const text = (t, { status = 200, type = "text/plain" } = {}) => new Response(t, { status, headers: { "content-type": type } });
export const withFetch = async (impl, fn) => {
  const real = globalThis.fetch; globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = real; }
};
export const regEvent = (iso) => ({ events: [{ eventAction: "registration", eventDate: iso }] });

// ---- report-server helpers ----
import { ReportStore } from "../server/store.js";
import { solvePowSync } from "../server/credentials.js";
export const DAY = 86_400_000, HOUR = 3_600_000, MIN = 60_000;
export function makeStore({ config = {}, ...opts } = {}) {
  let t = Date.parse("2026-11-09T12:00:00Z");
  const c = { now: () => t, tick: (ms) => { t += ms; } };
  const store = new ReportStore({ now: c.now, salt: "salt", secret: "secret", config: { powBits: 6, ...config }, ...opts });
  return { store, c };
}
export const ipN = (n) => `10.${(n >> 8) & 255}.${n & 255}.7`;          // a distinct /24 per n
export function enrollFrom(store, ip) {
  const { challenge, bits } = store.challenge();
  return store.enroll({ ip, challenge, solution: solvePowSync(challenge, bits) }).token;
}
export const report = (store, token, ip, o = {}) => store.submit({ token, ip, domain: "shop.example", outcome: "never", tags: ["fake_tracking"], ...o });
