import test from "node:test";
import assert from "node:assert/strict";
import { historyLines, historySignals, yearsText } from "../lib/history.js";
import { firstArchived } from "../lib/providers.js";

const now = Date.parse("2026-11-09");
test("history lines show both dates and ages", () => {
  const l = historyLines({ registered: "2019-03-14T00:00:00Z", archived: "2019-06-01T00:00:00Z" }, now);
  assert.match(l[0], /First seen online: Jun 2019 \(7\.4 years\)/);
  assert.match(l[1], /Domain registered: Mar 2019 \(7\.7 years\)/);
});
test("only what is known is shown", () => {
  assert.deepEqual(historyLines({}, now), []);
  assert.equal(historyLines({ registered: "2026-11-01T00:00:00Z" }, now).length, 1);
});
test("young shops are shown in months", () => assert.equal(yearsText(0.25), "3 months"));
test("old domain, new site => re-use warning", () => {
  const s = historySignals({ registered: "2015-01-01T00:00:00Z", archived: "2026-09-01T00:00:00Z" });
  assert.equal(s[0].id, "reuse"); assert.equal(s[0].status, "warn");
});
test("consistent history => no warning", () => {
  assert.deepEqual(historySignals({ registered: "2019-03-01T00:00:00Z", archived: "2019-08-01T00:00:00Z" }), []);
});
test("CDX parsing: earliest snapshot, or null when never archived", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => [["timestamp"], ["20190314123456"]] });
  assert.equal(await firstArchived("a.com"), "2019-03-14T00:00:00Z");
  globalThis.fetch = async () => ({ ok: true, json: async () => [] });
  assert.equal(await firstArchived("b.com"), null);
  globalThis.fetch = real;
});
