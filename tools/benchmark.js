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
  const easylistCount = countRules("easylist_rules.json");
  const privacyCount = countRules("privacy_rules.json");
  const cosmeticGenerics = fileBytes("cosmetic_filters.js");
  const cosmeticSites = fileBytes("cosmetic_sites.json");
  let optionalSummary = [];
  try {
    const index = readJSON("ruleset_index.json");
    optionalSummary = Object.entries(index).map(([id, info]) => ({
      id, total: info.total, parts: info.files.length
    }));
  } catch {}

  console.log("Rule counts:");
  console.log(`- easylist_rules.json: ${easylistCount}`);
  console.log(`- privacy_rules.json:  ${privacyCount}`);
  for (const o of optionalSummary) {
    console.log(`- opt ${o.id}: ${o.total} (${o.parts} part${o.parts === 1 ? "" : "s"})`);
  }
  console.log("");
  console.log("Cosmetic payload:");
  console.log(`- cosmetic_filters.js: ${human(cosmeticGenerics)} (generics + bundled procedural)`);
  console.log(`- cosmetic_sites.json: ${human(cosmeticSites)} (per-site hide/unhide index)`);

  console.log("");
  console.log("Simple URL probe (string matches in HTML):");
  const probe = await simpleProbe();
  for (const row of probe) {
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
