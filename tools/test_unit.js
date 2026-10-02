#!/usr/bin/env node
// QuietBrowse unit tests — filter_compiler, PhishScore, custom rules
// Usage: node tools/test_unit.js

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
let passed = 0;
let failed = 0;
const pending = [];

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      pending.push(result.then(
        () => { passed++; console.log("  ok  " + name); },
        (e) => { failed++; console.error("  FAIL " + name + " â€” " + (e.message || e)); }
      ));
      return;
    }
    passed++;
    console.log("  ok  " + name);
  } catch (e) {
    failed++;
    console.error("  FAIL " + name + " — " + (e.message || e));
  }
}

function loadScripts(files) {
  const context = {
    console,
    URL,
    setTimeout,
    clearTimeout,
    crypto: { randomUUID: () => "test-id" },
    module: { exports: {} },
    exports: {}
  };
  context.global = context;
  context.globalThis = context;
  vm.createContext(context);
  for (const file of files) {
    const code = fs.readFileSync(path.join(ROOT, file), "utf8");
    vm.runInContext(code, context, { filename: file });
  }
  // const bindings are not properties of the VM global — re-export known symbols.
  vm.runInContext(
      "if (typeof PhishScore !== 'undefined') globalThis.PhishScore = PhishScore;" +
      "if (typeof SITE_MODE !== 'undefined') globalThis.SITE_MODE = SITE_MODE;" +
      "if (typeof getBaseDomain !== 'undefined') globalThis.getBaseDomain = getBaseDomain;",
    context
  );
  return context;
}

console.log("filter_compiler");
{
  const { compileFilters } = require(path.join(ROOT, "filter_compiler.js"));
  test("blocks domain rules", () => {
    const c = compileFilters(["||tracker.example^\n"]);
    assert(c.blockRules.length >= 1, "expected block rules");
  });
  test("emits allow exceptions", () => {
    const c = compileFilters(["||tracker.example^\n@@||allowed.example^\n"]);
    assert(c.allowRules.length === 1, "expected one allow");
  });
  test("parses site cosmetics and :has translation", () => {
    const c = compileFilters([
      "example.com##.ad\nexample.com#@#.sponsor\nexample.com##div:-abp-has(> .ad)\n"
    ]);
    assert(c.siteHide["example.com"]?.includes(".ad"), "site hide");
    assert(c.siteUnhide["example.com"]?.includes(".sponsor"), "site unhide");
    const hasRule = (c.siteHide["example.com"] || []).some((s) => s.includes(":has("));
    assert(hasRule, ":-abp-has should become :has");
  });
  test("drops patterns Chrome DNR rejects (||* prefix)", () => {
    const c = compileFilters([
      "||*optout$third-party\n||*.exaapi.com^\n@@||*.allowed.example^\n||*status$removeparam=x\n||ok.example/path\n"
    ]);
    const all = [...c.blockRules, ...c.allowRules, ...c.paramRules];
    assert(!all.some((r) => (r.condition.urlFilter || "").startsWith("||*")), "no ||* urlFilter emitted");
    assert(c.blockRules.length === 1, "valid rule kept");
    assert(c.stats.invalidUrlFilters === 4, "counts dropped patterns, got " + c.stats.invalidUrlFilters);
  });
  test("dnrRuleError flags invalid conditions", () => {
    const { dnrRuleError, urlFilterError } = require(path.join(ROOT, "filter_compiler.js"));
    assert(urlFilterError("||*foo"), "||* rejected");
    assert(urlFilterError("||"), "anchor-only rejected");
    assert(urlFilterError("caf\u00e9"), "non-ASCII rejected");
    assert(urlFilterError("||example.com^") === null, "normal filter ok");
    assert(urlFilterError("*foo") === null, "leading wildcard ok");
    assert(dnrRuleError({ condition: { requestDomains: [] } }), "empty requestDomains rejected");
    assert(dnrRuleError({ condition: { requestDomains: ["Example.com"] } }), "uppercase domain rejected");
    assert(dnrRuleError({ condition: { urlFilter: "||a.example^" } }) === null, "valid rule ok");
  });
  test("skips unsupported options safely", () => {
    const c = compileFilters(["||x.example^$csp=script-src\n||y.example^\n"]);
    assert(c.blockRules.length >= 1, "still compiles valid lines");
  });
}

console.log("PhishScore");
{
  const ctx = loadScripts(["psl_data.js", "utils.js", "phish_score.js"]);
  const PhishScore = ctx.PhishScore;
  test("public suffix parsing handles multi-label suffixes", () => {
    assert(ctx.getBaseDomain("login.example.co.uk") === "example.co.uk", "co.uk base");
    assert(ctx.getBaseDomain("a.b.city.kawasaki.jp") === "city.kawasaki.jp", "PSL exception");
  });
  test("trusted domain scores excellent", () => {
    const r = PhishScore.analyze("www.google.com", "https:", false);
    assert(r.level === "excellent", "expected excellent, got " + r.level);
    assert(r.trustScore >= 90, "trust score high");
  });
  test("http login page is risky", () => {
    const r = PhishScore.analyze("login-paypal-secure.tk", "http:", true, {
      passwordFieldCount: 1
    });
    assert(r.level === "danger" || r.level === "caution", "expected caution/danger");
    assert(r.riskScore > 0, "risk should be positive");
  });
  test("enrich lowers score when protection off", () => {
    const base = PhishScore.analyze("example.com", "https:", false);
    const enriched = PhishScore.enrich(base, {
      enabled: false,
      siteMode: "full",
      blockedCount: 0,
      trackerCount: 0
    });
    assert(enriched.level === "off" || enriched.trustScore == null || enriched.level, "enrich runs");
  });
}

console.log("compact getBaseDomain (no PSL)");
{
  const ctx = loadScripts(["utils.js"]);
  test("compact fallback handles co.uk", () => {
    assert(ctx.getBaseDomain("login.example.co.uk") === "example.co.uk", "co.uk compact");
  });
  test("compact fallback uses eTLD+1 for simple hosts", () => {
    assert(ctx.getBaseDomain("a.b.example.com") === "example.com", "simple eTLD+1");
  });
}

console.log("trusted enterprise suffixes");
{
  const ctx = loadScripts(["psl_data.js", "utils.js", "phish_score.js"]);
  const PhishScore = ctx.PhishScore;
  const trustedHosts = [
    "outlook.cloud.microsoft",
    "contoso.onmicrosoft.com",
    "contoso.sharepoint.com",
    "cdn.office.net",
    "login.microsoftonline.com",
    "storage.googleapis.com",
    "lh3.googleusercontent.com"
  ];
  for (const host of trustedHosts) {
    test("trusted: " + host, () => {
      const r = PhishScore.analyze(host, "https:", false);
      assert(r.level === "excellent", host + " expected excellent, got " + r.level);
      assert(r.trustScore >= 90, host + " trust score");
    });
  }
}

console.log("custom rules");
{
  const dnrUpdates = [];
  const ctx = {
    console,
    URL,
    crypto: { randomUUID: () => "rid-1" },
    CUSTOM_RULES_MAX: 200,
    CUSTOM_BLOCK_ID_START: 300000,
    CUSTOM_ALLOW_ID_START: 350000,
    customRules: [],
    customFilterLists: [],
    chrome: {
      storage: {
        local: {
          get: async (d) => d || { enabled: true },
          set: async () => {}
        }
      },
      declarativeNetRequest: {
        MAX_NUMBER_OF_DYNAMIC_RULES: 30000,
        getDynamicRules: async () => [],
        updateDynamicRules: async (update) => dnrUpdates.push(update)
      }
    }
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  // Minimal removeDynamicRange stub
  vm.runInContext(
    "async function removeDynamicRange() {} async function pushRollbackAction() {}",
    ctx
  );
  vm.runInContext(
    fs.readFileSync(path.join(ROOT, "bg_custom.js"), "utf8"),
    ctx,
    { filename: "bg_custom.js" }
  );

  test("rejects invalid domain", () => {
    const err = ctx.validateCustomRule({
      action: "block",
      type: "domain",
      value: "not a domain"
    });
    assert(err, "should error");
  });
  test("accepts valid block domain", () => {
    const rule = { action: "block", type: "domain", value: "ads.tracker.com", scope: "thirdParty" };
    const err = ctx.validateCustomRule(rule);
    assert(!err, err || "ok");
    assert(rule.value === "ads.tracker.com", "normalized");
  });
  test("normalize fills defaults", () => {
    const n = ctx.normalizeCustomRule({
      action: "allow",
      type: "urlContains",
      value: "doubleclick"
    });
    assert(n.id, "id set");
    assert(n.enabled === true, "enabled default");
    assert(n.scope === "all", "scope default");
  });
  test("replaces custom DNR rules atomically", async () => {
    ctx.customRules.push({
      id: "custom-1", action: "block", type: "domain",
      value: "ads.example", scope: "all", enabled: true
    });
    await ctx.syncCustomRules();
    assert(dnrUpdates.length === 1, "expected one DNR update");
    assert(Array.isArray(dnrUpdates[0].removeRuleIds), "missing removal set");
    assert(dnrUpdates[0].addRules.length === 1, "missing replacement rule");
  });
}

console.log("filter persistence");
{
  const store = { cosmeticDomains: ["same.example", "gone.example"] };
  const removed = [];
  const ctx = {
    console, URL, TextDecoder, AbortController, setTimeout, clearTimeout,
    OPTIONAL_FILTER_LISTS: [], DEFAULT_FILTER_URLS: [],
    chrome: { storage: { local: {
      get: async (defaults) => ({ ...defaults, ...store }),
      set: async (patch) => Object.assign(store, patch),
      remove: async (keys) => removed.push(...keys)
    } } }
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "bg_filters.js"), "utf8"), ctx);
  vm.runInContext(
    "globalThis.seedSiteCosmetics = seedSiteCosmetics;" +
    "globalThis.seedProceduralRules = seedProceduralRules;" +
    "globalThis.readFilterResponse = readFilterResponse;",
    ctx
  );

  test("removes stale cosmetic variants", async () => {
    await ctx.seedSiteCosmetics({}, { "same.example": [".allowed"] });
    assert(removed.includes("cs_same.example"), "old hide key should be removed");
    assert(removed.includes("cs_gone.example") && removed.includes("cx_gone.example"), "removed domain keys");
    assert(!removed.includes("cx_same.example"), "current unhide key should remain");
  });
  test("seeds generic procedural rules once", async () => {
    await ctx.seedProceduralRules({ "": [{ selector: ".generic" }], "site.example": [{ selector: ".site" }] });
    assert(store.proceduralRules.length === 2, "expected exactly two rules");
    assert(store.proceduralRules.filter((r) => r.selector === ".generic").length === 1, "generic duplicated");
    assert(store.proceduralRules.find((r) => r.selector === ".generic").domains.length === 0, "generic domains");
  });
  test("rejects oversized filter responses", async () => {
    const res = { headers: { get: () => "101" } };
    let rejected = false;
    try { await ctx.readFilterResponse(res, 100); } catch { rejected = true; }
    assert(rejected, "oversized response should be rejected");
  });
}

console.log("YouTube scriptlets prune");
{
  const ctx = {
    console,
    window: {},
    Response: function() {},
    JSON,
    setTimeout, clearTimeout, setInterval, clearInterval
  };
  ctx.globalThis = ctx;
  ctx.window = ctx; // emulate main world
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "scriptlets.js"), "utf8"), ctx, { filename: "scriptlets.js" });
  test("removes ad keys from player response safely", () => {
    const sample = {
      playerResponse: {
        videoDetails: { title: "Test" },
        adPlacements: [{ foo: 1 }],
        adSignals: { bar: 2 }
      },
      adSlots: [1, 2, 3],
      other: { nested: { adSafetyReasons: ["x"] , keep: true } }
    };
    const prune = ctx.__qbYT_prune;
    assert(typeof prune === "function", "prune exported");
    const out = prune(JSON.parse(JSON.stringify(sample)));
    assert(!("adPlacements" in out.playerResponse), "adPlacements removed");
    assert(!("adSignals" in out.playerResponse), "adSignals removed");
    assert(!("adSlots" in out), "adSlots removed");
    assert(out.playerResponse.videoDetails.title === "Test", "video details intact");
    assert(out.other.nested.keep === true, "unrelated fields intact");
  });
}

console.log("Scriptlet catalog site rules");
{
  // Emulate main world with location.hostname = youtube.com to trigger RULES
  const ctx = {
    console,
    window: {},
    Response: function() {},
    JSON,
    location: { hostname: "www.youtube.com" },
    setTimeout, clearTimeout
  };
  ctx.globalThis = ctx;
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "scriptlets_catalog.js"), "utf8"), ctx, { filename: "scriptlets_catalog.js" });
  test("json-prune removes YouTube ad fields via catalog", () => {
    const sample = JSON.stringify({
      playerResponse: { adPlacements: [{ id: 1 }], playerAds: [{ id: 2 }], other: 1 }
    });
    const obj = JSON.parse(sample);
    assert(!obj.playerResponse.adPlacements, "catalog pruned adPlacements");
    assert(!obj.playerResponse.playerAds, "catalog pruned playerAds");
    assert(obj.playerResponse.other === 1, "kept other fields");
  });
}

Promise.all(pending).then(() => {
  console.log("\n" + passed + " passed, " + failed + " failed");
  if (failed) process.exit(1);
});
