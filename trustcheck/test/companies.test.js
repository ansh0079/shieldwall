import test from "node:test";
import assert from "node:assert/strict";
import { extractCompanyNumber, companySignals, nameMatches } from "../lib/companies.js";

test("extracts company numbers from footers", () => {
  assert.equal(extractCompanyNumber("Registered in England and Wales. Company No. 12345678"), "12345678");
  assert.equal(extractCompanyNumber("Company number: SC123456 | VAT"), "SC123456");
  assert.equal(extractCompanyNumber("Registered number 09876543"), "09876543");
  assert.equal(extractCompanyNumber("Call us on 01234567890"), null);
  assert.equal(extractCompanyNumber(""), null);
});
const now = Date.parse("2026-11-09");
const prof = (o) => ({ company_name: "SHOE WORLD LTD", company_status: "active", date_of_creation: "2018-03-01", ...o });
test("unknown number is bad", () => assert.equal(companySignals({ number: "1", profile: null, now })[0].status, "bad"));
test("dissolved company is bad", () => assert.equal(companySignals({ number: "1", profile: prof({ company_status: "dissolved" }), now })[0].status, "bad"));
test("brand-new company warns", () => assert.equal(companySignals({ number: "1", profile: prof({ date_of_creation: "2026-10-20" }), haystack: "shoe world", now })[0].status, "warn"));
test("established matching company is good", () => {
  const s = companySignals({ number: "1", profile: prof(), haystack: "Shoe World | shoeworld.co.uk", now });
  assert.equal(s.length, 1); assert.equal(s[0].status, "good");
});
test("quoting someone else's company number is flagged", () => {
  const s = companySignals({ number: "1", profile: prof(), haystack: "fastkicks-outlet.shop Company No. 1", now });
  assert.ok(s.some((x) => /name not found/i.test(x.label)));
});
test("name matching ignores legal suffixes", () => {
  assert.equal(nameMatches("ACME TRADING LIMITED", "welcome to acme"), true);
  assert.equal(nameMatches("ACME TRADING LIMITED", "other site"), false);
});
