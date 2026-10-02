// QuietBrowse validation smoke tests.
// Usage: node tools/validate_extension.js

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function parseJson(rel) {
  return JSON.parse(read(rel));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function validateJsonFiles() {
  for (const file of [
    "manifest.json",
    "rules.json",
    "easylist_rules.json",
    "privacy_rules.json",
    "headers_rules.json",
    "cosmetic_sites.json"
  ]) {
    parseJson(file);
  }
  assert(fs.existsSync(path.join(ROOT, "psl_data.js")), "psl_data.js must exist");
  const pslBytes = fs.statSync(path.join(ROOT, "psl_data.js")).size;
  assert(pslBytes < 250000, `psl_data.js is unexpectedly large: ${pslBytes} bytes`);

  const manifest = parseJson("manifest.json");
  const contentJs = manifest.content_scripts?.[0]?.js || [];
  assert(
    !contentJs.includes("psl_data.js"),
    "content_scripts must not inject psl_data.js (keep it in the service worker only)"
  );
  assert(
    !contentJs.includes("cosmetic_filters.js"),
    "content_scripts must not inject cosmetic_filters.js (cosmetics come from storage per-site)"
  );
}

function validateManifest() {
  const manifest = parseJson("manifest.json");
  assert(manifest.manifest_version === 3, "manifest_version must be 3");
  assert(
    manifest.default_locale === "en",
    "manifest must declare default_locale when using __MSG_* references"
  );
  assert(
    manifest.permissions.includes("webNavigation"),
    "manifest must include webNavigation for SPA phishing rechecks"
  );
  assert(
    manifest.permissions.includes("declarativeNetRequest"),
    "manifest must include declarativeNetRequest"
  );
  assert(
    !manifest.permissions.includes("cookies") &&
      !manifest.permissions.includes("downloads"),
    "cookies/downloads should be optional permissions in Chrome"
  );
  assert(
    manifest.optional_permissions?.includes("cookies") &&
      manifest.optional_permissions?.includes("downloads"),
    "manifest must declare cookies/downloads as optional permissions"
  );
  assert(
    manifest.host_permissions.includes("<all_urls>"),
    "general blocker must declare <all_urls>"
  );
}

function validateRules() {
  const el = parseJson("easylist_rules.json");
  const ep = parseJson("privacy_rules.json");
  const rules = el;
  const ids = new Set();
  for (const rule of rules) {
    assert(Number.isInteger(rule.id), "DNR rule id must be an integer");
    assert(!ids.has(rule.id), `duplicate DNR rule id: ${rule.id}`);
    ids.add(rule.id);
    assert(rule.action && rule.condition, `rule ${rule.id} missing action/condition`);
  }
  // After splitting EasyPrivacy into its own static ruleset, assert on combined coverage.
  const elCount = el.length;
  const epCount = ep.length;
  assert(elCount >= 3500, `EasyList rule count unexpectedly low: ${elCount}`);
  assert(elCount + epCount >= 12000, `Combined EasyList/EasyPrivacy rule count too low: ${elCount + epCount}`);
}

function validateFirefoxManifest() {
  const ffPath = "manifest.firefox.json";
  if (!fs.existsSync(path.join(ROOT, ffPath))) return; // optional — Chrome-only build is fine
  const ff = parseJson(ffPath);
  const geckoId = ff?.browser_specific_settings?.gecko?.id;
  assert(
    typeof geckoId === "string" && geckoId.length > 0,
    "manifest.firefox.json must declare browser_specific_settings.gecko.id"
  );
  assert(
    geckoId !== "quietbrowse@local",
    "manifest.firefox.json gecko.id is still the placeholder — replace with your real AMO extension ID before release"
  );
}

function validatePrivacyClaims() {
  const popup = read("popup.js");
  assert(!popup.includes("google.com/s2/favicons"), "popup must not call Google favicons");
  assert(!popup.includes("_favicon/?pageUrl="), "popup must not resolve page favicons");

  const docs = read("README.md") + read("PERMISSIONS.md") + read("STORE_LISTING.md");
  assert(
    docs.includes("custom filter-list"),
    "privacy/docs must mention user-added custom filter-list URLs"
  );
}

function validateFilterCompiler() {
  const { compileFilters } = require(path.join(ROOT, "filter_compiler.js"));
  const compiled = compileFilters([
    "||tracker.example^\n@@||allowed.example^\nexample.com##.ad\n#@#.sponsor"
  ]);
  assert(compiled.blockRules.length === 1, "compiler should emit one block rule");
  assert(compiled.allowRules.length === 1, "compiler should emit one allow rule");
  assert(compiled.siteHide["example.com"]?.includes(".ad"), "compiler should emit site cosmetics");
}

function validateI18nCoverage() {
  const messages = parseJson("_locales/en/messages.json");
  const knownKeys = new Set(Object.keys(messages));
  const missing = [];

  // Check data-i18n / data-i18n-placeholder / data-i18n-title in HTML files
  for (const file of ["popup.html", "options.html", "onboarding.html"]) {
    const html = read(file);
    for (const attr of ["data-i18n", "data-i18n-placeholder", "data-i18n-title"]) {
      const re = new RegExp(`${attr}="([^"]+)"`, "g");
      let m;
      while ((m = re.exec(html)) !== null) {
        if (!knownKeys.has(m[1])) missing.push(`${file}: ${attr}="${m[1]}"`);
      }
    }
  }

  // Check i18n("key") calls in JS files
  const jsFiles = ["popup.js", "options.js", "utils.js", "background.js"];
  const i18nCallRe = /\bi18n\(\s*["']([^"']+)["']/g;
  for (const file of jsFiles) {
    if (!fs.existsSync(path.join(ROOT, file))) continue;
    const src = read(file);
    let m;
    while ((m = i18nCallRe.exec(src)) !== null) {
      if (!knownKeys.has(m[1])) missing.push(`${file}: i18n("${m[1]}")`);
    }
  }

  assert(
    missing.length === 0,
    `i18n key(s) missing from messages.json:\n  ${missing.join("\n  ")}`
  );
}

function validatePlaceholderSyntax() {
  const messages = parseJson("_locales/en/messages.json");
  const bad = [];
  const curlyRe = /\{[a-zA-Z_]\w*\}/;
  for (const [key, entry] of Object.entries(messages)) {
    if (typeof entry.message === "string" && curlyRe.test(entry.message)) {
      bad.push(`${key}: "${entry.message}" uses {name} — must be $name$`);
    }
  }
  assert(
    bad.length === 0,
    `messages.json contains invalid placeholder syntax:\n  ${bad.join("\n  ")}`
  );
}

async function validateServiceWorkerLoads() {
  const listeners = { addListener() {} };
  const backingStore = {};
  const storageArea = {
    get(defaults, cb) {
      let value;
      if (typeof defaults === "string") {
        value = { [defaults]: backingStore[defaults] };
      } else if (Array.isArray(defaults)) {
        value = {};
        for (const key of defaults) value[key] = backingStore[key];
      } else {
        value = { ...(defaults || {}), ...backingStore };
      }
      if (cb) cb(value);
      return Promise.resolve(value);
    },
    set(value, cb) {
      Object.assign(backingStore, value || {});
      if (cb) cb();
      return Promise.resolve();
    },
    remove(keys, cb) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete backingStore[key];
      }
      if (cb) cb();
      return Promise.resolve();
    }
  };
  const chrome = {
    runtime: {
      getManifest: () => ({ version: "test" }),
      getURL: (file) => `chrome-extension://test/${file}`,
      onMessage: listeners,
      onInstalled: listeners,
      sendMessage: () => Promise.resolve()
    },
    storage: {
      local: storageArea,
      session: storageArea,
      sync: storageArea,
      onChanged: listeners
    },
    declarativeNetRequest: {
      MAX_NUMBER_OF_DYNAMIC_RULES: 30000,
      setExtensionActionOptions: () => Promise.resolve(),
      updateDynamicRules: () => Promise.resolve(),
      getDynamicRules: () => Promise.resolve([]),
      updateEnabledRulesets: () => Promise.resolve()
    },
    tabs: {
      onUpdated: listeners,
      onRemoved: listeners,
      sendMessage: () => Promise.resolve(),
      create: () => {}
    },
    webNavigation: { onHistoryStateUpdated: listeners },
    webRequest: {
      onErrorOccurred: listeners,
      onCompleted: listeners
    },
    cookies: { getAll: () => Promise.resolve([]) },
    alarms: {
      onAlarm: listeners,
      get(_name, cb) {
        cb(null);
      },
      create() {}
    },
    scripting: {
      unregisterContentScripts: () => Promise.resolve(),
      registerContentScripts: () => Promise.resolve()
    },
    downloads: {
      onDeterminingFilename: listeners,
      cancel() {}
    },
    notifications: { create() {} },
    contextMenus: {
      onClicked: listeners,
      removeAll(cb) {
        cb();
      },
      create() {}
    },
    permissions: {
      contains: () => Promise.resolve(false),
      request: () => Promise.resolve(false)
    }
  };

  const context = vm.createContext({
    console,
    chrome,
    setTimeout,
    clearTimeout,
    URL,
    fetch: async () => ({
      ok: true,
      text: async () => "",
      json: async () => ({ hide: {}, unhide: {} })
    })
  });
  context.globalThis = context;
  context.self = context;
  context.importScripts = (...files) => {
    for (const file of files) {
      vm.runInContext(read(file), context, { filename: file });
    }
  };

  vm.runInContext(read("background.js"), context, { filename: "background.js" });
  await Promise.resolve();

  vm.runInContext(
    "globalThis.__qbTest = {" +
      "setCustomRules(v){ customRules = v; }," +
      "getCustomRules(){ return customRules; }," +
      "undoLastAction" +
    "};",
    context
  );
  context.__qbTest.setCustomRules([
    {
      id: "r1",
      name: "Block tracker",
      action: "block",
      type: "domain",
      value: "tracker.example",
      scope: "all",
      enabled: true
    }
  ]);
  await context.chrome.storage.local.set({
    rollbackActions: [{ type: "customRuleAdd", ruleId: "r1" }]
  });
  const undoResult = await context.__qbTest.undoLastAction();
  assert(undoResult.ok, "undoLastAction should undo customRuleAdd");
  assert(context.__qbTest.getCustomRules().length === 0, "undo should remove added custom rule");
}

async function main() {
  validateJsonFiles();
  validateManifest();
  validateRules();
  validatePrivacyClaims();
  validateFilterCompiler();
  validateI18nCoverage();
  validatePlaceholderSyntax();
  validateFirefoxManifest();
  await validateServiceWorkerLoads();
  console.log("QuietBrowse validation passed");
}

main().catch((err) => {
  console.error("Validation failed:", err.message || err);
  process.exit(1);
});
