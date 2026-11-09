// requires: node:sqlite
import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { makeChrome } from "./chrome-mock.js";
import { createServer, shutdown } from "../server/server.js";
import { makeStore, nCreds, nReports, credIds } from "./server-helpers.js";

test("real background.js: enrols once, reuses its credential, re-enrols after revocation, and erases on request", async () => {
  const { store } = makeStore(), srv = createServer(store, { keepAlive: false, rateLimit: 1000 });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {                                                           // a failing assertion must never leave the server listening
    const base = `http://127.0.0.1:${srv.address().port}`;
    const chrome = makeChrome(); globalThis.chrome = chrome;
    globalThis.fetch = ((real) => (u, o) => String(u).startsWith(base) ? real(u, o) : Promise.reject(new Error("offline")))(globalThis.fetch);
    await import("../background.js");
    const send = (msg) => new Promise((res) => chrome.L.message(msg, {}, res));
    const token = async () => (await chrome.storage.local.get({ reportToken: "" })).reportToken;

    assert.match((await send({ type: "submitReport", domain: "shop.example", outcome: "never", tags: [] })).error, /No report server/);
    await chrome.storage.local.set({ backend: base });

    assert.equal((await send({ type: "submitReport", domain: "shop.example", outcome: "never", tags: ["fake_tracking"] })).ok, true);
    const t1 = await token(); assert.ok(t1);
    assert.equal(nCreds(store), 1); assert.equal(nReports(store), 1);

    assert.equal((await send({ type: "submitReport", domain: "other.example", outcome: "ok", tags: [] })).ok, true);
    assert.equal(nCreds(store), 1, "the same identity is reused"); assert.equal(await token(), t1); assert.equal(nReports(store), 2);

    store.revokeCredential(credIds(store)[0]);                                               // a moderator revokes it
    assert.equal((await send({ type: "submitReport", domain: "third.example", outcome: "problem", tags: ["delayed"] })).ok, true);
    assert.equal(nCreds(store), 2, "re-enrolled automatically, once"); assert.notEqual(await token(), t1);

    assert.equal((await send({ type: "eraseReports" })).ok, true);
    assert.equal(await token(), "");                                                           // local identity gone
    assert.equal(store.db.get("SELECT COUNT(*) AS n FROM reports WHERE domain = 'third.example'").n, 0);   // and its reports on the server
  } finally { await shutdown(srv); store.close(); }
});
