// DEMO ONLY: writes synthetic, naturally-spread reports straight into a data file so you can see the UI.
// Stop the server first. Use the SAME REPORT_SALT / CREDENTIAL_SECRET as the server. Never use against a real deployment.
// usage: DATABASE_FILE=demo.db node server/seed.js shop.example
import { ReportStore } from "./store.js";
import { solvePowSync } from "./credentials.js";

const domain = process.argv[2] || "shop.example";
const HOUR = 3_600_000, DAY = 24 * HOUR;
let t = Date.now() - 12 * DAY;
const store = new ReportStore({ file: process.env.DATABASE_FILE || "demo.db", now: () => t, salt: process.env.REPORT_SALT || "dev-salt",
  secret: process.env.CREDENTIAL_SECRET || "dev-secret", config: { powBits: 1, limits: { enrollPerHour: 1000 } } });
const plan = [["never", ["fake_tracking"], 14], ["problem", ["counterfeit", "not_as_described"], 6], ["problem", ["delayed"], 4], ["ok", [], 2]];
const toks = []; let i = 0;
for (const [, , n] of plan) for (let k = 0; k < n; k++, i++) {
  const { challenge, bits } = store.challenge();
  toks.push(store.enroll({ ip: `10.${i >> 8}.${i & 255}.9`, challenge, solution: solvePowSync(challenge, bits) }).token);
}
t += 8 * DAY;                                                    // let the identities mature, then report spread over time
i = 0;
for (const [outcome, tags, n] of plan) for (let k = 0; k < n; k++, i++) { store.submit({ token: toks[i], ip: `10.${i >> 8}.${i & 255}.9`, domain, outcome, tags }); t += 3 * HOUR; }
store.flush();
console.log("seeded", i, "DEMO reports for", domain, "-> hidden/shown depends on the thresholds; summary:", JSON.stringify(store.summary(domain)).slice(0, 160));
