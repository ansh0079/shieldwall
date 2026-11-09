import test from "node:test";
import assert from "node:assert/strict";
import { buildReport } from "../lib/score.js";

const base = (signals) => buildReport({ url: "https://x.example", domain: "x.example", signals, links: [] });
const sig = (id, status, points) => ({ id, label: id, status, points });

test("nothing known about the shop => unverified, not caution", () => {
  const r = base([sig("https", "good", 5), sig("policies", "good", 8), sig("age", "info", 0)]);
  assert.equal(r.score, 63);
  assert.equal(r.verdict, "unverified");
  assert.equal(r.evidence, 0);
});
test("real evidence keeps a caution verdict", () => {
  const r = base([sig("https", "good", 5), sig("age", "good", 12)]);
  assert.equal(r.verdict, "caution"); assert.equal(r.evidence, 1);
});
test("risky stays risky with no evidence", () => {
  assert.equal(base([sig("https", "bad", -25), sig("policies", "bad", -15)]).verdict, "risky");
});
