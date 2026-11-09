import test from "node:test";
import assert from "node:assert/strict";
import { validateSafeBrowsing, validateTrustpilotDetail, validateTrustpilotUnit, validateCompany, validateBuyerSummary } from "../lib/validate.js";

const bad = (fn) => assert.throws(fn, /unexpected/);
test("safe browsing", () => {
  assert.deepEqual(validateSafeBrowsing({}), []);
  assert.deepEqual(validateSafeBrowsing({ matches: [{ threatType: "MALWARE" }] }), ["MALWARE"]);
  bad(() => validateSafeBrowsing({ matches: [{}] })); bad(() => validateSafeBrowsing("x")); bad(() => validateSafeBrowsing({ matches: "no" }));
});
test("trustpilot", () => {
  assert.equal(validateTrustpilotUnit({ id: "4b5c6d7e8f90a1b2c3d4e5f6" }), "4b5c6d7e8f90a1b2c3d4e5f6");
  bad(() => validateTrustpilotUnit({ id: "../../etc" }));
  assert.deepEqual(validateTrustpilotDetail({ score: { trustScore: 4.2 }, numberOfReviews: { total: 120 } }), { score: 4.2, total: 120 });
  bad(() => validateTrustpilotDetail({ score: { trustScore: 9 }, numberOfReviews: { total: 1 } }));
  bad(() => validateTrustpilotDetail({ score: { trustScore: "4" }, numberOfReviews: { total: 1 } }));
  bad(() => validateTrustpilotDetail({ score: { trustScore: 4 }, numberOfReviews: { total: -3 } }));
});
test("company profile", () => {
  assert.equal(validateCompany({ company_name: "A LTD", company_status: "active", date_of_creation: "2018-03-01" }).company_name, "A LTD");
  bad(() => validateCompany({ company_name: "" })); bad(() => validateCompany({ company_name: "A", date_of_creation: "yesterday" })); bad(() => validateCompany(null));
});
test("buyer summary", () => {
  const good = { domain: "a.com", total: 5, windowDays: 30, outcomes: { ok: 1, problem: 1, never: 3 }, tags: { fake_tracking: 3 } };
  assert.equal(validateBuyerSummary(good).tags.fake_tracking, 3);
  assert.equal(validateBuyerSummary({ domain: "a.com", total: 2, hidden: true, windowDays: 30 }).hidden, true);
  bad(() => validateBuyerSummary({ ...good, outcomes: { ok: 9, problem: 9, never: 9 } }));   // outcomes exceed total
  bad(() => validateBuyerSummary({ ...good, tags: { "<script>": 1 } }));
  bad(() => validateBuyerSummary({ ...good, total: "5" }));
});
