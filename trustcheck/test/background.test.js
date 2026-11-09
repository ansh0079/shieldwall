import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";

import { makeChrome } from "./chrome-mock.js";

const rdap = (iso) => new Response(JSON.stringify({ events: [{ eventAction: "registration", eventDate: iso }] }), { headers: { "content-type": "application/json" } });
const cdx = () => new Response(JSON.stringify([["timestamp"], ["20160101000000"]]), { headers: { "content-type": "application/json" } });

test("real background.js: a late, cancellation-ignoring response for site A is never shown on site B", async () => {
  const chrome = makeChrome(); globalThis.chrome = chrome;
  const gates = {};
  globalThis.fetch = async (u) => {                      // ignores the abort signal on purpose
    u = String(u);
    if (u.includes("web.archive.org")) return cdx();
    if (u.includes("rdap")) { if (u.includes("site-a.example")) await new Promise((r) => { gates.a = r; }); return rdap(u.includes("site-a") ? "2010-01-01T00:00:00Z" : "2012-01-01T00:00:00Z"); }
    throw new Error("unexpected fetch " + u);
  };
  await import("../background.js");
  const A = "https://site-a.example/", B = "https://site-b.example/";

  chrome.tabUrls.set(7, A); chrome.L.updated(7, { status: "complete" }, { url: A });      // A starts; its registry answer is held back
  await new Promise((r) => setTimeout(r, 30));
  chrome.tabUrls.set(7, B);                                                               // user navigates to B
  chrome.L.updated(7, { status: "loading", url: B }, { url: B });
  chrome.L.updated(7, { status: "complete" }, { url: B });
  await new Promise((r) => setTimeout(r, 80));                                            // B finishes and is published
  gates.a();                                                                              // A's answer finally arrives
  await new Promise((r) => setTimeout(r, 80));

  const reports = chrome.sent.filter(([, m]) => m.type === "report").map(([, m]) => m.report.url);
  assert.ok(reports.includes(B), "B's report was published");
  assert.ok(!reports.includes(A), "A's report must never be published");
  const stored = (await chrome.storage.session.get("report:7"))["report:7"];
  assert.equal(stored.url, B);
});

test("closing a tab clears its state", async () => {
  const chrome = globalThis.chrome;
  await chrome.storage.session.set({ "report:9": { url: "https://x.example/" } });
  chrome.L.removed(9);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal((await chrome.storage.session.get("report:9"))["report:9"], undefined);
});
