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
      "if (typeof getBaseDomain !== 'undefined') globalThis.getBaseDomain = getBaseDomain;" +
      "if (typeof getSiteContentException !== 'undefined') globalThis.getSiteContentException = getSiteContentException;",
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
  test("enrich reports protection off without a site score", () => {
    const base = PhishScore.analyze("example.com", "https:", false);
    const enriched = PhishScore.enrich(base, {
      enabled: false,
      siteMode: "off",
      blockedCount: 3,
      trackerCount: 1
    });
    assert(enriched.level === "off", "expected off, got " + enriched.level);
    assert(enriched.trustScore == null, "score hidden when protection is off");
    assert(enriched.activityNote === "Protection is off", "activity note");
  });
  test("enrich keeps the site score when many trackers are blocked", () => {
    const base = PhishScore.analyze("example.com", "https:", false);
    const enriched = PhishScore.enrich(base, {
      enabled: true,
      siteMode: "full",
      blockedCount: 40,
      trackerCount: 12
    });
    assert(enriched.trustScore === base.trustScore, "blocker stats must not change the score");
    assert(enriched.level === base.level, "blocker stats must not change the level");
    assert(!enriched.reasons.some((r) => /blocked|paused|Ads allowed/.test(r)), "reasons stay site-only");
    assert(enriched.blockedCount === 40 && enriched.trackerCount === 12, "counts returned beside the score");
    assert(enriched.activityNote.includes("40") && enriched.activityNote.includes("12"), "activity note");
  });

  const corpus = [
    { name: "known brand", host: "www.google.com", protocol: "https:", password: false, level: "excellent", minScore: 90 },
    { name: "brand country domain", host: "paypal.co.uk", protocol: "https:", password: false, level: "good", absent: "Brand name" },
    { name: "brand inside a longer label", host: "login-paypal-secure.example", protocol: "https:", password: false, level: "danger", reason: "paypal" },
    { name: "brand glued to a lure word", host: "loginpaypal.com", protocol: "https:", password: false, level: "danger", reason: "paypal" },
    { name: "typosquat", host: "paypa1.com", protocol: "https:", password: false, level: "danger", reason: "misspelling" },
    { name: "raw ip login", host: "1.2.3.4", protocol: "http:", password: true, level: "danger", reason: "IP address" },
    { name: "risky tld", host: "shop.example.tk", protocol: "https:", password: false, level: "caution", reason: ".tk" },
    { name: "external login on a real brand", host: "accounts.google.com", protocol: "https:", password: true, signals: { externalFormAction: true }, level: "caution", reason: "different site" },
    { name: "user content host", host: "lh3.googleusercontent.com", protocol: "https:", password: false, notLevel: "excellent" },
    { name: "amazonaws host", host: "login-paypal.amazonaws.com", protocol: "https:", password: false, notLevel: "excellent" },
    { name: "azure host", host: "paypal.azurewebsites.net", protocol: "https:", password: false, notLevel: "excellent" }
  ];
  for (const row of corpus) {
    test("corpus: " + row.name, () => {
      const r = PhishScore.analyze(row.host, row.protocol, row.password, row.signals);
      if (row.level) assert(r.level === row.level, row.host + " expected " + row.level + ", got " + r.level + " (" + r.reasons.join("; ") + ")");
      if (row.notLevel) assert(r.level !== row.notLevel, row.host + " should not be " + row.notLevel);
      if (row.minScore != null) assert(r.trustScore >= row.minScore, row.host + " score " + r.trustScore);
      if (row.reason) assert(r.reasons.some((reason) => reason.includes(row.reason)), row.host + " missing reason " + row.reason + " in " + r.reasons.join("; "));
      if (row.absent) assert(!r.reasons.some((reason) => reason.includes(row.absent)), row.host + " unexpected " + row.absent);
    });
  }
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
  test("page fixes expire and use the most specific domain", () => {
    const now = 1000;
    const exceptions = {
      "example.com": { stage: "cosmetics", expiresAt: 2000 },
      "shop.example.com": { stage: "page", expiresAt: 2000 },
      "expired.test": { stage: "page", expiresAt: 999 }
    };
    assert(ctx.getSiteContentException("www.shop.example.com", exceptions, now).stage === "page", "specific stage");
    assert(ctx.getSiteContentException("expired.test", exceptions, now) === null, "expired fix");
  });
}

console.log("official service hosts and shared hosting");
{
  const ctx = loadScripts(["psl_data.js", "utils.js", "phish_score.js"]);
  const PhishScore = ctx.PhishScore;
  const trustedHosts = [
    "outlook.cloud.microsoft",
    "login.microsoftonline.com",
    "accounts.google.com",
    "appleid.apple.com"
  ];
  for (const host of trustedHosts) {
    test("trusted: " + host, () => {
      const r = PhishScore.analyze(host, "https:", false);
      assert(r.level === "excellent", host + " expected excellent, got " + r.level);
      assert(r.trustScore >= 90, host + " trust score");
    });
  }
  test("shared hosting receives no automatic trust", () => {
    for (const host of ["contoso.sharepoint.com", "login-paypal.amazonaws.com", "paypal.azurewebsites.net"]) {
      assert(PhishScore.analyze(host, "https:", true).level !== "excellent", host);
    }
  });
  test("official host still surfaces insecure forms", () => {
    const insecure = PhishScore.analyze("accounts.google.com", "http:", true);
    assert(insecure.level !== "excellent" && insecure.reasons.some(r => r.includes("http")), "insecure login");
    const external = PhishScore.analyze("accounts.google.com", "https:", true, { externalFormAction: true });
    assert(external.level === "caution", "cross-site form action");
  });
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
  const dnrUpdates = [];
  const rulesetUpdates = [];
  const ctx = {
    console, URL, TextDecoder, AbortController, crypto, setTimeout, clearTimeout,
    OPTIONAL_FILTER_LISTS: [], DEFAULT_FILTER_URLS: [],
    EASYLIST_RULESET_ID: "easylist", EASYPRIVACY_RULESET_ID: "privacy",
    UPDATE_ALLOW_ID_START: 100000, UPDATE_ID_END: 299999,
    chrome: {
      declarativeNetRequest: {
        MAX_NUMBER_OF_DYNAMIC_RULES: 30000,
        getDynamicRules: async () => dnrUpdates.at(-1)?.addRules || [],
        updateDynamicRules: async (update) => dnrUpdates.push(update),
        updateEnabledRulesets: async (update) => rulesetUpdates.push(update)
      },
      storage: { local: {
      get: async (defaults) => {
        if (Array.isArray(defaults)) {
          return Object.fromEntries(defaults.map((key) => [key, store[key]]));
        }
        return { ...defaults, ...store };
      },
      set: async (patch) => Object.assign(store, patch),
      remove: async (keys) => {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
        removed.push(...(Array.isArray(keys) ? keys : [keys]));
      }
    } } }
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "bg_filters.js"), "utf8"), ctx);
  vm.runInContext(
    "globalThis.seedSiteCosmetics = seedSiteCosmetics;" +
    "globalThis.seedProceduralRules = seedProceduralRules;" +
    "globalThis.readFilterResponse = readFilterResponse;" +
    "globalThis.applyFilterSnapshot = applyFilterSnapshot;" +
    "globalThis.reconcilePendingFilterUpdate = reconcilePendingFilterUpdate;",
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
  test("recovers an interrupted filter transaction", async () => {
    const candidate = {
      rules: [{ id: 150000, priority: 1, action: { type: "block" }, condition: { urlFilter: "||ads.example^" } }],
      useUpdatedLists: true,
      genericSelectors: [".ad"],
      proceduralRules: [],
      siteHide: { "example.com": [".ad"] },
      siteUnhide: {},
      lastFilterUpdate: 123
    };
    store.enabled = true;
    store.pendingFilterUpdate = { generation: "test-generation", candidate, previous: null };
    const result = await ctx.reconcilePendingFilterUpdate();
    assert(result.recovered === true, "transaction should recover");
    assert(store.pendingFilterUpdate === undefined, "pending transaction should clear");
    assert(store.lastFilterUpdate === 123 && store.updatedRules.length === 1, "candidate should commit");
    assert(store["cs_example.com"][0] === ".ad", "cosmetics should commit");
    assert(rulesetUpdates.some((u) => u.disableRulesetIds), "bundled lists should disable after install");
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
