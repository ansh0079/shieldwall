import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { netRange, netHash, identityWeight, recencyWeight, weigh, detect, smooth, mergeConfig, DAY, MIN } from "../server/abuse.js";
import { signToken, verifyToken, makeChallenge, verifyPow, solvePowSync, leadingZeroBits, powHash, timingSafeEqualStr } from "../server/credentials.js";
import { appendAudit, verifyAudit } from "../server/audit.js";
import { solvePow } from "../lib/pow.js";
import { TAGS as SERVER_TAGS } from "../server/vocab.js";
import { TAGS as CLIENT_TAGS } from "../lib/vocab.js";

const cfg = mergeConfig();

test("network ranges: /24 for IPv4, /48 for IPv6, IPv4-mapped and junk", () => {
  assert.equal(netRange("203.0.113.77"), "v4:203.0.113");
  assert.equal(netRange("203.0.113.5"), netRange("203.0.113.250"));
  assert.notEqual(netRange("203.0.113.5"), netRange("203.0.114.5"));
  assert.equal(netRange("::ffff:198.51.100.9"), "v4:198.51.100");
  assert.equal(netRange("2001:db8:abcd:1::5"), "v6:2001:db8:abcd");
  assert.equal(netRange("2001:DB8:ABCD:99:1:2:3:4"), "v6:2001:db8:abcd");
  assert.equal(netRange("nope"), "unknown"); assert.equal(netRange(undefined), "unknown");
  assert.notEqual(netHash("v4:1.2.3", "a"), netHash("v4:1.2.3", "b"));              // salted: ranges are not reversible
});
test("identity and recency weights", () => {
  const m = cfg.maturity;
  assert.equal(identityWeight(0, m), 0); assert.equal(identityWeight(23 * 3600e3, m), 0);
  assert.equal(identityWeight(2 * DAY, m), 0.3); assert.equal(identityWeight(8 * DAY, m), 1);
  assert.equal(recencyWeight(0, 30), 1); assert.ok(Math.abs(recencyWeight(30 * DAY, 30) - 0.5) < 1e-9);
  assert.ok(recencyWeight(60 * DAY, 30) < recencyWeight(10 * DAY, 30));
});
const R = (id, net, o = {}) => ({ id, cred: "c" + id, net, outcome: "never", tags: ["fake_tracking"], at: 1e12, idAgeMs: 10 * DAY, evidence: "reported", ...o });
test("one network contributes at most 1.0 in total, however many reports it has", () => {
  const w = weigh([R(1, "n1"), R(2, "n1"), R(3, "n1"), R(4, "n2")], 1e12, cfg);
  assert.ok(Math.abs([1, 2, 3].reduce((n, i) => n + w.get(i), 0) - 1) < 1e-9);
  assert.equal(w.get(4), 1);
});
test("verified purchases weigh more than reported experiences", () => {
  const w = weigh([R(1, "n1", { evidence: "verified" }), R(2, "n2")], 1e12, cfg);
  assert.equal(w.get(1), 2); assert.equal(w.get(2), 1);
});
test("detection: same-network burst, timing burst, repeated payload from new identities, young-identity skew", () => {
  const nets = (n) => Array.from({ length: n }, (_, i) => R(i, "n" + i));
  // every flagged report must carry the reason AND all of them must be flagged ("every" on an empty set would pass vacuously)
  const allFlagged = (rs, why) => { const f = detect(rs, 1e12, cfg); assert.equal(f.size, rs.length, `expected ${rs.length} flagged for ${why}, got ${f.size}`); assert.ok([...f.values()].every((x) => x.has(why)), why); };
  assert.equal(detect([R(1, "n"), R(2, "n"), R(3, "n")], 1e12, cfg).size, 0);                                  // 3 from a network: below the burst threshold
  assert.equal(detect([1, 2, 3, 4].map((i) => R(i, "n")), 1e12, cfg).size, 4);                                 // 4: flagged
  const burst = nets(6).map((r, i) => ({ ...r, at: 1e12 + i * MIN }));
  allFlagged(burst, "timing_burst");
  const spread = nets(6).map((r, i) => ({ ...r, at: 1e12 + i * 3 * 3600e3 }));
  assert.equal(detect(spread, 1e12, cfg).size, 0);                                                              // same reports, spread out: not a burst
  const youngSame = nets(6).map((r, i) => ({ ...r, idAgeMs: 2 * DAY, at: 1e12 + i * 5 * 3600e3 }));
  allFlagged(youngSame, "repeated_payload_new_identities");
  const skew = nets(9).map((r, i) => ({ ...r, idAgeMs: 10 * DAY, at: 1e12 + i * 5 * 3600e3 }));
  allFlagged(skew, "young_identity_skew");                                                                      // mostly <14-day-old identities, ~all 'never'
  const mature = skew.map((r) => ({ ...r, idAgeMs: 40 * DAY }));
  assert.equal(detect(mature, 1e12, cfg).size, 0);
});
test("natural consensus is not punished: many mature, separate, spread-out reports with the same outcome", () => {
  const rs = Array.from({ length: 30 }, (_, i) => R(i, "n" + i, { idAgeMs: 90 * DAY, at: 1e12 + i * 7 * 3600e3 }));
  assert.equal(detect(rs, 1e12, cfg).size, 0);
});
test("Bayesian smoothing shrinks small samples towards the prior and tightens with evidence", () => {
  const p = cfg.prior, none = smooth(0, 0, p), few = smooth(5, 5, p), many = smooth(50, 50, p);
  assert.ok(Math.abs(none.mean - p.mean) < 1e-9);
  assert.ok(few.mean < 0.6, "five problem reports must not read as ~100%");
  assert.ok(many.mean > few.mean && many.mean < 1);
  assert.ok(many.high - many.low < few.high - few.low);
  assert.ok(few.low >= 0 && many.high <= 1);
});
test("credentials: signed, tamper-evident, constant-time compare", () => {
  const t = signToken({ c: "abc", i: 1 }, "sec");
  assert.deepEqual(verifyToken(t, "sec"), { c: "abc", i: 1 });
  assert.equal(verifyToken(t, "other"), null);
  const [b, s] = t.split(".");
  assert.equal(verifyToken(`${Buffer.from(JSON.stringify({ c: "evil", i: 1 })).toString("base64url")}.${s}`, "sec"), null);
  assert.equal(verifyToken(t + ".x", "sec"), null); assert.equal(verifyToken("junk", "sec"), null); assert.equal(verifyToken(undefined, "sec"), null);
  assert.equal(timingSafeEqualStr("abc", "abc"), true); assert.equal(timingSafeEqualStr("abc", "abd"), false); assert.equal(timingSafeEqualStr("abc", "abcd"), false);
});
test("proof of work: valid, insufficient, expired, tampered, too easy", () => {
  const now = 1e12, ch = makeChallenge("sec", { bits: 8, now }), sol = solvePowSync(ch, 8);
  assert.equal(verifyPow(ch, sol, "sec", { now: now + 1000, minBits: 8 }).ok, true);
  let bad = 0; while (leadingZeroBits(powHash(ch, String(bad))) >= 8) bad++;
  assert.equal(verifyPow(ch, String(bad), "sec", { now, minBits: 8 }).reason, "insufficient work");
  assert.equal(verifyPow(ch, sol, "sec", { now: now + 6 * MIN, minBits: 8 }).reason, "expired");
  const [ts, nonce, b, sig] = ch.split("."), forged = [ts, (nonce[0] === "a" ? "b" : "a") + nonce.slice(1), b, sig].join(".");
  assert.equal(verifyPow(forged, sol, "sec", { now, minBits: 8 }).reason, "bad signature");
  assert.equal(verifyPow(ch, sol, "sec", { now, minBits: 12 }).reason, "too easy");
  assert.equal(verifyPow(makeChallenge("sec", { bits: 1, now }), "0", "sec", { now, minBits: 8 }).reason, "too easy");   // cannot lower the difficulty
});
test("the extension's async solver produces solutions the server accepts", async () => {
  const now = Date.now(), ch = makeChallenge("sec", { bits: 8, now });
  assert.equal(verifyPow(ch, await solvePow(ch, 8), "sec", { now, minBits: 8 }).ok, true);
  await assert.rejects(solvePow(ch, 40), /unreasonable/);                                                       // a hostile server cannot hang the client
});
test("audit log is hash-chained and tamper-evident", () => {
  const log = [];
  for (let i = 0; i < 5; i++) appendAudit(log, { ts: i, actor: "moderator", action: "reject", target: "shop.example", detail: `n=${i}` });
  assert.deepEqual(verifyAudit(log), { ok: true, length: 5 });
  const edited = log.map((e) => ({ ...e })); edited[2].detail = "n=999";
  assert.equal(verifyAudit(edited).ok, false); assert.equal(verifyAudit(edited).brokenAt, 2);
  assert.equal(verifyAudit(log.filter((_, i) => i !== 1)).ok, false);                                           // deletion
  assert.equal(verifyAudit([log[1], log[0], ...log.slice(2)]).ok, false);                                       // reordering
});
test("server and client share one tag vocabulary", () => assert.deepEqual([...SERVER_TAGS].sort(), Object.keys(CLIENT_TAGS).sort()));

test("burst detection is linear: 20,000 reports inside ten minutes are analysed in well under a second", () => {
  // The first implementation sliced a window per report (quadratic): this input took many seconds and froze the server.
  const rs = Array.from({ length: 20000 }, (_, i) => R(i, "n" + (i % 500), { cred: "c" + i, at: 1e12 + (i % 600) * 1000, idAgeMs: 20 * DAY }));
  const t0 = performance.now(), flags = detect(rs, 1e12, cfg), ms = performance.now() - t0;
  assert.ok(ms < 1500, `detect took ${Math.round(ms)} ms: it must not be quadratic`);
  assert.equal(flags.size, 20000); assert.ok([...flags.values()].every((x) => x.has("timing_burst")));
});
test("the linear burst detector flags exactly the same reports as a straightforward quadratic reference", () => {
  const ref = (reports, d) => {                                      // obviously-correct O(n^2) reference implementation
    const sorted = [...reports].sort((a, b) => a.at - b.at), out = new Set();
    for (let i = 0; i < sorted.length; i++) for (let j = 0; j <= i; j++) {
      if (sorted[i].at - sorted[j].at > d.timingWindowMs) continue;
      const win = sorted.slice(j, i + 1);
      if (win.length >= d.timingMin && new Set(win.map((r) => r.cred)).size >= d.timingMin && win.length / sorted.length >= d.timingShare) win.forEach((r) => out.add(r.id));
    }
    return out;
  };
  let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let trial = 0; trial < 60; trial++) {
    const n = 5 + Math.floor(rnd() * 60), spread = [60_000, 600_000, 3_600_000, 86_400_000][Math.floor(rnd() * 4)];
    const rs = Array.from({ length: n }, (_, i) => R(i, "n" + (i % 7), { cred: "c" + Math.floor(rnd() * (n / 2 + 1)), at: 1e12 + Math.floor(rnd() * spread), idAgeMs: 30 * DAY }));
    const mine = new Set([...detect(rs, 1e12, { ...cfg, detect: { ...cfg.detect, netBurstMin: 1e9, payloadMin: 1e9, skewMin: 1e9 } })].filter(([, v]) => v.has("timing_burst")).map(([k]) => k));
    assert.deepEqual([...mine].sort(), [...ref(rs, cfg.detect)].sort(), `trial ${trial} (n=${n}, spread=${spread})`);
  }
});
