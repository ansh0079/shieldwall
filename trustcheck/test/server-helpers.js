// Report-server test helpers (need node:sqlite, so only files marked "// requires: node:sqlite" import this).
// ---- report-server helpers ----
import { ReportStore } from "../server/store.js";
import { solvePowSync } from "../server/credentials.js";
export function makeStore({ config = {}, ...opts } = {}) {
  let t = Date.parse("2026-11-09T12:00:00Z");
  const c = { now: () => t, tick: (ms) => { t += ms; } };
  const store = new ReportStore({ now: c.now, salt: "salt", secret: "secret", config: { powBits: 6, ...config }, ...opts });
  return { store, c };
}
export const nCreds = (store) => store.db.get("SELECT COUNT(*) AS n FROM credentials").n;
export const nReports = (store) => store.db.get("SELECT COUNT(*) AS n FROM reports").n;
export const credOf = (token) => JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString()).c;      // the credential id inside a token
export const credIds = (store) => store.db.all("SELECT id FROM credentials ORDER BY created_at, id").map((r) => r.id);
export const ipN = (n) => `10.${(n >> 8) & 255}.${n & 255}.7`;          // a distinct /24 per n
export function enrollFrom(store, ip) {
  const { challenge, bits } = store.challenge();
  return store.enroll({ ip, challenge, solution: solvePowSync(challenge, bits) }).token;
}
export const report = (store, token, ip, o = {}) => store.submit({ token, ip, domain: "shop.example", outcome: "never", tags: ["fake_tracking"], ...o });

export { DAY, HOUR, MIN } from "./helpers.js";
