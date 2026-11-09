// QuietBrowse - filter list build script
// Downloads EasyList + EasyPrivacy and compiles them (via ../filter_compiler.js) into:
//   easylist_rules.json  - declarativeNetRequest network rules (incl. $removeparam)
//   cosmetic_filters.js  - generic element-hiding selectors + bundled procedural rules
//   cosmetic_sites.json  - per-site hide/unhide selector maps
// Also builds static optional rulesets (Fanboy/EasyList regionals, uBO quick-fixes)
// as separate files and updates manifest.rule_resources.
//
// Usage:  node tools/build_filters.js [easylist.txt easyprivacy.txt]
// (Pass local files to skip the download.)

const https = require("https");
const fs = require("fs");
const path = require("path");
const { compileFilters } = require("../filter_compiler.js");

const LISTS = {
  easylist: "https://easylist.to/easylist/easylist.txt",
  easyprivacy: "https://easylist.to/easylist/easyprivacy.txt"
};

const OUT_DIR = path.join(__dirname, "..");

// Must match background.js: allow rules 1.., block rules 50000..
const BLOCK_ID_START = 50000;
const PARAM_ID_BASE = 200000; // keep unique within the file
const MAX_STATIC_RULES_PER_FILE = 25000;
// Keep each generated static rules file comfortably under AMO's 5 MB limit.
// Target ~4 MiB to leave headroom for JSON overhead and future growth.
const MAX_STATIC_RULES_BYTES = 4 * 1024 * 1024;
const STATIC_RULES_BUDGET = 30000; // Chrome guaranteed minimum
const STATIC_RULES_BUDGET_SAFETY = 29500; // leave some headroom

const OPTIONAL_LISTS = [
  {
    id: "adguard-base",
    title: "AdGuard Base",
    url: "https://filters.adtidy.org/extension/ublock/filters/2.txt"
  },
  {
    id: "adguard-tracking",
    title: "AdGuard Tracking Protection",
    url: "https://filters.adtidy.org/extension/ublock/filters/3.txt"
  },
  {
    id: "peterlowe",
    title: "Peter Lowe’s ad/tracking list",
    url: "https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=0&mimetype=plaintext"
  },
  {
    id: "ublock-filters",
    title: "uBlock Origin – Filters",
    url: "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt"
  },
  {
    id: "ublock-privacy",
    title: "uBlock Origin – Privacy",
    url: "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/privacy.txt"
  },
  {
    id: "ubo-quick-fixes",
    title: "Quick Fixes (uBlock Assets)",
    url: "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/quick-fixes.txt"
  },
  {
    id: "fanboy-annoyance",
    title: "Fanboy's Annoyance List",
    url: "https://easylist.to/easylist/fanboy-annoyance.txt"
  },
  {
    id: "easylist-cookie",
    title: "EasyList Cookie List",
    url: "https://secure.fanboy.co.nz/fanboy-cookiemonster.txt"
  },
  {
    id: "fanboy-social",
    title: "Fanboy's Social Blocking List",
    url: "https://easylist.to/easylist/fanboy-social.txt"
  },
  {
    id: "easylist-germany",
    title: "EasyList Germany",
    url: "https://easylist.to/easylistgermany/easylistgermany.txt"
  },
  {
    id: "easylist-france",
    title: "EasyList France",
    url: "https://easylist.to/easylistfrance/easylistfrance.txt"
  }
];

function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(download(new URL(res.headers.location, url).href));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`${url}: HTTP ${res.statusCode}`));
      }
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(data));
    }).on("error", reject);
  });
}

function writeJson(relPath, data) {
  fs.writeFileSync(path.join(OUT_DIR, relPath), JSON.stringify(data));
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Split an array of rule objects into chunks which satisfy both:
 *  - rule count per file <= MAX_STATIC_RULES_PER_FILE
 *  - JSON byte size per file < MAX_STATIC_RULES_BYTES
 *
 * This prevents AMO FILE_TOO_LARGE errors (5 MB hard limit).
 */
function chunkRulesByLimits(rules, {
  maxCount = MAX_STATIC_RULES_PER_FILE,
  maxBytes = MAX_STATIC_RULES_BYTES
} = {}) {
  const chunks = [];
  let current = [];
  // Pre-calc overhead for empty array brackets/newlines to be conservative.
  const EMPTY_ARRAY_OVERHEAD = 2; // "[]"
  for (const rule of rules) {
    const candidate = current.length === 0 ? [rule] : [...current, rule];
    // Enforce rule-count limit first
    if (candidate.length > maxCount) {
      chunks.push(current);
      current = [rule];
      continue;
    }
    // Enforce byte-size limit using precise JSON length
    const bytes = Buffer.byteLength(JSON.stringify(candidate)) + EMPTY_ARRAY_OVERHEAD;
    if (bytes >= maxBytes) {
      if (current.length === 0) {
        // Single very large rule; still emit it to avoid infinite loop.
        chunks.push([rule]);
        current = [];
      } else {
        chunks.push(current);
        current = [rule];
      }
    } else {
      current = candidate;
    }
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function pruneTextBySeen(text, seen) {
  const out = [];
  for (let line of text.split("\n")) {
    line = line.trim();
    if (!line || line.startsWith("!") || line.startsWith("[")) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out.join("\n");
}

async function main() {
  const localFiles = process.argv.slice(2);
  let elText = "";
  let epText = "";
  if (localFiles.length > 0) {
    console.log("Reading local filter lists...");
    const [elPath, epPath] = localFiles;
    elText = fs.readFileSync(elPath || "", "utf8");
    epText = fs.readFileSync(epPath || "", "utf8");
    console.log(`  EasyList: ${(elText.length / 1e6).toFixed(1)} MB`);
    console.log(`  EasyPrivacy: ${(epText.length / 1e6).toFixed(1)} MB`);
  } else {
    console.log("Downloading filter lists...");
    elText = await download(LISTS.easylist);
    console.log(`  ${LISTS.easylist} (${(elText.length / 1e6).toFixed(1)} MB)`);
    epText = await download(LISTS.easyprivacy);
    console.log(`  ${LISTS.easyprivacy} (${(epText.length / 1e6).toFixed(1)} MB)`);
  }

  const cEL = compileFilters([elText]);
  const cEP = compileFilters([epText]);

  // EasyList ruleset (network + $removeparam)
  const elAllow = cEL.allowRules.map((r, i) => ({ ...r, id: i + 1 }));
  const elBlock = cEL.blockRules.map((r, i) => ({ ...r, id: BLOCK_ID_START + i }));
  const elParam = (cEL.paramRules || []).map((r, i) => ({ ...r, id: PARAM_ID_BASE + i }));
  writeJson("easylist_rules.json", [...elAllow, ...elBlock, ...elParam]);

  // EasyPrivacy ruleset (network + $removeparam)
  const epAllow = cEP.allowRules.map((r, i) => ({ ...r, id: i + 1 }));
  const epBlock = cEP.blockRules.map((r, i) => ({ ...r, id: BLOCK_ID_START + i }));
  const epParam = (cEP.paramRules || []).map((r, i) => ({ ...r, id: PARAM_ID_BASE + i }));
  writeJson("privacy_rules.json", [...epAllow, ...epBlock, ...epParam]);

  // Build bundled procedural rules: site-specific first (up to 2000 total)
  const MAX_PROC = 2000;
  const procFlat = [];
  for (const [domain, rules] of Object.entries(cEL.proceduralRules || {})) {
    if (!domain || procFlat.length >= MAX_PROC) break;
    for (const r of rules) {
      if (procFlat.length >= MAX_PROC) break;
      procFlat.push({ ...r, domains: [domain] });
    }
  }
  for (const r of (cEL.proceduralRules[""] || [])) {
    if (procFlat.length >= MAX_PROC) break;
    procFlat.push({ ...r, domains: [] });
  }

  fs.writeFileSync(
    path.join(OUT_DIR, "cosmetic_filters.js"),
    "// Generated by tools/build_filters.js - generic element-hiding selectors\n" +
      "// from EasyList. Do not edit by hand; re-run the build script instead.\n" +
      "const GENERIC_HIDE_SELECTORS = " +
      JSON.stringify(cEL.genericSelectors) +
      ";\n" +
      "const BUNDLED_PROCEDURAL_RULES = " +
      JSON.stringify(procFlat) +
      ";\n"
  );

  writeJson("cosmetic_sites.json", { hide: cEL.siteHide, unhide: cEL.siteUnhide });

  // Build additional static rulesets (optional or default-enabled based on budget)
  console.log("\nBuilding additional static rulesets...");
  const rulesetIndex = {};
  // Priority for default-enabled selection (highest first)
  const DEFAULT_PRIORITY = [
    "ubo-quick-fixes",
    "ublock-filters",
    "ublock-privacy",
    "adguard-tracking",
    "peterlowe",
    "adguard-base"
  ];
  const defaultCandidates = new Map(OPTIONAL_LISTS.map((l) => [l.id, l]));
  const seenLines = new Set();
  // Seed dedupe with EasyList/EasyPrivacy lines
  pruneTextBySeen(elText, seenLines);
  pruneTextBySeen(epText, seenLines);
  const perListRules = {};
  const defaultEnableIds = new Set();
  // Gather rules for each list with cross-list dedupe on default ordering
  for (const opt of OPTIONAL_LISTS) {
    try {
      const raw = await download(opt.url);
      const text = DEFAULT_PRIORITY.includes(opt.id)
        ? pruneTextBySeen(raw, seenLines)
        : raw;
      const ccRaw = compileFilters([raw], { maxBlockRules: 100000, maxAllowRules: 10000, domainsPerGroup: 1000 });
      const cc = compileFilters([text], { maxBlockRules: 100000, maxAllowRules: 10000, domainsPerGroup: 1000 });
      const rules = [
        ...cc.allowRules.map((r, i) => ({ ...r, id: i + 1 })),
        ...cc.blockRules.map((r, i) => ({ ...r, id: BLOCK_ID_START + i })),
        ...(cc.paramRules || []).map((r, i) => ({ ...r, id: PARAM_ID_BASE + i }))
      ];
      if (cc.stats?.invalidUrlFilters) {
        console.log(`  ${opt.id}: dropped ${cc.stats.invalidUrlFilters} pattern(s) Chrome DNR rejects`);
      }
      perListRules[opt.id] = {
        rules,
        count: rules.length,
        title: opt.title,
        domains: cc.stats?.domainCount || 0,
        domainsRaw: ccRaw.stats?.domainCount || 0
      };
    } catch (e) {
      console.warn(`  Skipped ${opt.id}: ${e.message}`);
    }
  }
  // Decide which lists are enabled by default within the static rules budget
  const coreEasy = JSON.parse(fs.readFileSync(path.join(OUT_DIR, "easylist_rules.json"), "utf8")).length;
  const corePrivacy = JSON.parse(fs.readFileSync(path.join(OUT_DIR, "privacy_rules.json"), "utf8")).length;
  const coreHeaders = JSON.parse(fs.readFileSync(path.join(OUT_DIR, "headers_rules.json"), "utf8")).length;
  const coreRules = JSON.parse(fs.readFileSync(path.join(OUT_DIR, "rules.json"), "utf8")).length;
  let used = coreEasy + corePrivacy + coreHeaders + coreRules;
  for (const id of DEFAULT_PRIORITY) {
    const entry = perListRules[id];
    if (!entry) continue;
    if (used + entry.count <= STATIC_RULES_BUDGET_SAFETY) {
      used += entry.count;
      defaultEnableIds.add(id);
    }
  }
  console.log(`Default static budget used: ${used}/${STATIC_RULES_BUDGET}`);
  // Write per-list chunked files and index
  for (const [id, entry] of Object.entries(perListRules)) {
    const chunks = chunkRulesByLimits(entry.rules);
    const fileIds = [];
    const fileNames = [];
    const counts = [];
    chunks.forEach((chunk, idx) => {
      const fname = `rules_opt_${id}_p${idx + 1}.json`;
      writeJson(fname, chunk);
      const rid = `quiet_opt_${id}_p${idx + 1}`;
      fileIds.push(rid);
      fileNames.push(fname);
      counts.push(chunk.length);
    });
    rulesetIndex[id] = {
      ids: fileIds,
      files: fileNames,
      counts,
      total: entry.count,
      domains: entry.domains || 0,
      domainsRaw: entry.domainsRaw || 0,
      title: entry.title,
      defaultEnabled: defaultEnableIds.has(id)
    };
    console.log(`  ${id}: ${entry.count} rules (${fileNames.join(", ")}) ${defaultEnableIds.has(id) ? "[default]" : ""}`);
  }
  for (const opt of OPTIONAL_LISTS) {
    if (!rulesetIndex[opt.id]) {
      console.warn(`  Skipped ${opt.id}: no data`);
    }
  }
  writeJson("ruleset_index.json", rulesetIndex);

  // Patch manifest.rule_resources to include optional rulesets (disabled by default)
  const manifestPath = path.join(OUT_DIR, "manifest.json");
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const base = manifest.declarative_net_request?.rule_resources || [];
    // Remove any previous quiet_opt_* entries
    const filtered = base.filter((r) => {
      if (typeof r.id !== "string") return true;
      if (r.id.startsWith("quiet_opt_")) return false;
      if (r.id === "quiet_privacy" || r.id === "quiet_headers" || r.id === "quiet_easylist") return false;
      return true;
    });
    // Ensure core lists present with correct mapping:
    filtered.push({ id: "quiet_easylist", enabled: true, path: "easylist_rules.json" });
    filtered.push({ id: "quiet_privacy", enabled: true, path: "privacy_rules.json" });
    // Add headers/params toggle ruleset
    filtered.push({ id: "quiet_headers", enabled: true, path: "headers_rules.json" });
    for (const [optId, info] of Object.entries(rulesetIndex)) {
      info.ids.forEach((rid, i) => {
        filtered.push({ id: rid, enabled: !!info.defaultEnabled, path: info.files[i] });
      });
    }
    manifest.declarative_net_request = { ...(manifest.declarative_net_request || {}), rule_resources: filtered };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log("Updated manifest.json rule_resources with optional rulesets");
  } catch (e) {
    console.warn("Could not update manifest.json:", e.message);
  }
  // Patch Firefox manifest if present
  const ffManifestPath = path.join(OUT_DIR, "manifest.firefox.json");
  try {
    if (fs.existsSync(ffManifestPath)) {
      const ff = JSON.parse(fs.readFileSync(ffManifestPath, "utf8"));
      const base = ff.declarative_net_request?.rule_resources || [];
      const filtered = base.filter((r) => {
        if (typeof r.id !== "string") return true;
        if (r.id.startsWith("quiet_opt_")) return false;
        if (r.id === "quiet_privacy" || r.id === "quiet_headers" || r.id === "quiet_easylist") return false;
        return true;
      });
      filtered.push({ id: "quiet_easylist", enabled: true, path: "easylist_rules.json" });
      filtered.push({ id: "quiet_privacy", enabled: true, path: "privacy_rules.json" });
      filtered.push({ id: "quiet_headers", enabled: true, path: "headers_rules.json" });
      for (const info of Object.values(rulesetIndex)) {
        info.ids.forEach((rid, i) => {
          filtered.push({ id: rid, enabled: !!info.defaultEnabled, path: info.files[i] });
        });
      }
      ff.declarative_net_request = { ...(ff.declarative_net_request || {}), rule_resources: filtered };
      fs.writeFileSync(ffManifestPath, JSON.stringify(ff, null, 2));
      console.log("Updated manifest.firefox.json rule_resources with optional rulesets");
    }
  } catch (e) {
    console.warn("Could not update manifest.firefox.json:", e.message);
  }

  // Build headers/params ruleset (GPC/DNT + small static param list)
  const headersRules = [
    {
      id: 1,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "DNT", operation: "set", value: "1" },
          { header: "Sec-GPC", operation: "set", value: "1" }
        ]
      },
      condition: {
        resourceTypes: [
          "main_frame","sub_frame","stylesheet","script","image","font",
          "object","xmlhttprequest","ping","media","websocket","other"
        ]
      }
    },
    {
      id: 2,
      priority: 1,
      action: {
        type: "redirect",
        redirect: {
          transform: {
            queryTransform: {
              removeParams: [
                "utm_source","utm_medium","utm_campaign","utm_term","utm_content","utm_id",
                "fbclid","gclid","gclsrc","dclid","wbraid","gbraid","msclkid","twclid","ttclid","yclid",
                "igshid","mc_cid","mc_eid","mkt_tok","_hsenc","_hsmi","vero_id","oly_enc_id","oly_anon_id","s_cid"
              ]
            }
          }
        }
      },
      condition: { resourceTypes: ["main_frame"] }
    }
  ];
  writeJson("headers_rules.json", headersRules);

  const sEL = cEL.stats;
  const sEP = cEP.stats;
  console.log(`\nCompiled:`);
  console.log(`EasyList:`);
  console.log(`  ${sEL.domainCount} blocked domains (merged into ${sEL.groupedRules} grouped rules)`);
  console.log(`  ${sEL.patternRules} pattern block rules`);
  console.log(`  ${sEL.allowRules} exception rules`);
  console.log(`  ${sEL.paramRules || 0} $removeparam rules`);
  console.log(`EasyPrivacy:`);
  console.log(`  ${sEP.domainCount} blocked domains (merged into ${sEP.groupedRules} grouped rules)`);
  console.log(`  ${sEP.patternRules} pattern block rules`);
  console.log(`  ${sEP.allowRules} exception rules`);
  console.log(`  ${sEP.paramRules || 0} $removeparam rules`);
  console.log(`Cosmetics:`);
  console.log(`  ${sEL.genericSelectors} generic cosmetic selectors`);
  console.log(`  ${sEL.siteHideDomains} domains with site-specific cosmetics`);
  console.log(`  ${sEL.siteUnhideDomains} domains with cosmetic exceptions`);
  console.log(`  ${sEL.proceduralRules} procedural rules (has-text/upward/remove) — ${procFlat.length} bundled`);
  console.log(`\nWrote easylist_rules.json, privacy_rules.json, headers_rules.json, cosmetic_filters.js, cosmetic_sites.json, ruleset_index.json + optional rulesets`);
  console.log("Reload the extension in chrome://extensions to apply.");
}

main().catch((err) => {
  console.error("Build failed:", err.message || err);
  process.exit(1);
});
