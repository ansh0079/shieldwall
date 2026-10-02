#!/usr/bin/env node
// QuietBrowse benchmark — rule counts, cosmetic payload size, simple URL probe
// Usage: node tools/benchmark.js

const fs = require("fs");
const path = require("path");
const https = require("https");

const ROOT = path.join(__dirname, "..");

function readJSON(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));
}

function fileBytes(rel) {
  try {
    return fs.statSync(path.join(ROOT, rel)).size;
  } catch {
    return 0;
  }
}

function human(n) {
  if (n > 1e6) return (n / 1e6).toFixed(2) + " MB";
  if (n > 1e3) return (n / 1e3).toFixed(1) + " KB";
  return n + " B";
}

function countRules(rel) {
  try {
    const arr = readJSON(rel);
    return Array.isArray(arr) ? arr.length : 0;
  } catch {
    return 0;
  }
}

async function fetchText(url, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = setTimeout(() => {
      try { controller && controller.abort(); } catch {}
      resolve("");
    }, timeoutMs);
    https.get(url, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => { clearTimeout(timer); resolve(data); });
    }).on("error", () => { clearTimeout(timer); resolve(""); });
  });
}

async function simpleProbe() {
  const urls = [
    "https://www.cnn.com/",
    "https://www.theverge.com/",
    "https://www.nytimes.com/",
    "https://www.forbes.com/",
    "https://www.youtube.com/"
  ];
  const needles = [
    "googlesyndication.com",
    "doubleclick.net",
    "adslot",
    "adunit",
    "ad-placement"
  ];
  const out = [];
  for (const url of urls) {
    const html = await fetchText(url);
    const counts = {};
    for (const k of needles) {
      const re = new RegExp(k, "gi");
      counts[k] = (html.match(re) || []).length;
    }
    out.push({ url, ...counts });
  }
  return out;
}

async function main() {
  const BASE_SHA = process.env.BASE_SHA || "b296dcf";
  const easylistCount = countRules("easylist_rules.json");
  const privacyCount = countRules("privacy_rules.json");
  const headersCount = countRules("headers_rules.json");
  const rulesJsonCount = (() => { try { return readJSON("rules.json").length; } catch { return 0; } })();
  const cosmeticGenerics = fileBytes("cosmetic_filters.js");
  const cosmeticSites = fileBytes("cosmetic_sites.json");
  let optionalSummary = [];
  try {
    const index = readJSON("ruleset_index.json");
    const manifest = readJSON("manifest.json");
    const enabled = new Set(
      (manifest.declarative_net_request?.rule_resources || [])
        .filter(r => r.enabled)
        .map(r => r.id)
    );
    optionalSummary = Object.entries(index).map(([id, info]) => {
      const enabledByDefault = info.ids.every(rid => enabled.has(rid));
      return { id, total: info.total, parts: info.files.length, enabledByDefault };
    });
  } catch {}

  console.log("Rule counts:");
  console.log(`- easylist_rules.json: ${easylistCount}`);
  console.log(`- privacy_rules.json:  ${privacyCount}`);
  optionalSummary.forEach(o => {
    console.log(`- ${o.enabledByDefault ? "default" : "opt"} ${o.id}: ${o.total} (${o.parts} part${o.parts === 1 ? "" : "s"})`);
  });
  console.log(`- headers_rules.json: ${headersCount}`);
  console.log(`- rules.json:         ${rulesJsonCount}`);
  const defaultExtraTotal = optionalSummary.filter(o => o.enabledByDefault).reduce((n, o) => n + o.total, 0);
  const defaultTotal = easylistCount + privacyCount + headersCount + rulesJsonCount + defaultExtraTotal;
  console.log(`Total default-enabled static rules: ${defaultTotal}`);

  // Baseline totals from master at BASE_SHA
  try {
    const { execSync } = require("child_process");
    const baseManifestJson = execSync(`git show ${BASE_SHA}:manifest.json`, { encoding: "utf8" });
    const baseManifest = JSON.parse(baseManifestJson);
    const baseResources = baseManifest.declarative_net_request?.rule_resources || [];
    let baseTotal = 0;
    for (const r of baseResources) {
      if (!r.enabled) continue;
      try {
        const content = execSync(`git show ${BASE_SHA}:${r.path}`, { encoding: "utf8" });
        const parsed = JSON.parse(content);
        baseTotal += Array.isArray(parsed) ? parsed.length : 0;
      } catch {}
    }
    console.log(`Total default-enabled static rules (baseline ${BASE_SHA}): ${baseTotal}`);
  } catch {
    console.log(`Baseline ${BASE_SHA} not available; skipping base totals`);
  }

  console.log("");
  console.log("Cosmetic payload:");
  console.log(`- cosmetic_filters.js: ${human(cosmeticGenerics)} (generics + bundled procedural)`);
  console.log(`- cosmetic_sites.json: ${human(cosmeticSites)} (per-site hide/unhide index)`);

  console.log("");
  console.log("Simple URL probe (string matches in HTML) — AFTER:");
  const probe = await simpleProbe();
  for (const row of probe) {
    console.log(`- ${row.url}`);
    const { url, ...rest } = row;
    const parts = Object.entries(rest).map(([k, v]) => `${k}:${v}`).join("  ");
    console.log(`  ${parts}`);
  }
  console.log("");
  console.log("Simple URL probe — BEFORE (baseline fetch uses same HTTP so values are for reference):");
  const probeBefore = await simpleProbe();
  for (const row of probeBefore) {
    console.log(`- ${row.url}`);
    const { url, ...rest } = row;
    const parts = Object.entries(rest).map(([k, v]) => `${k}:${v}`).join("  ");
    console.log(`  ${parts}`);
  }
}

main().catch((e) => {
  console.error("Benchmark failed:", e.message || e);
  process.exit(1);
});
