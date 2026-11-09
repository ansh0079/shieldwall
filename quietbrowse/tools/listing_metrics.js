#!/usr/bin/env node
// Print store-listing metrics from the bundled snapshot.
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");

const rules = JSON.parse(fs.readFileSync(path.join(ROOT, "easylist_rules.json"), "utf8"));
const cos = JSON.parse(fs.readFileSync(path.join(ROOT, "cosmetic_sites.json"), "utf8"));
const cf = fs.readFileSync(path.join(ROOT, "cosmetic_filters.js"), "utf8");

let block = 0;
let allow = 0;
let domainBlock = 0;
let patternBlock = 0;
for (const r of rules) {
  if (r.action?.type === "allow") {
    allow++;
    continue;
  }
  if (r.action?.type !== "block") continue;
  block++;
  const u = r.condition?.urlFilter || "";
  if (r.condition?.requestDomains || /^\|\|[a-z0-9.-]+\^$/i.test(u)) domainBlock++;
  else patternBlock++;
}

let siteSels = 0;
for (const sels of Object.values(cos.hide || {})) siteSels += sels.length;
const siteDomains = Object.keys(cos.hide || {}).length;

const genMatch = cf.match(/const GENERIC_HIDE_SELECTORS = (\[[\s\S]*?\]);/);
let genericSels = 0;
if (genMatch) {
  // File uses JSON-ish double-quoted strings in an array literal.
  genericSels = JSON.parse(genMatch[1]).length;
}

const out = {
  blockRules: block,
  allowRules: allow,
  domainAnchoredBlocks: domainBlock,
  patternBlocks: patternBlock,
  siteCosmeticDomains: siteDomains,
  siteCosmeticSelectors: siteSels,
  genericHideSelectors: genericSels,
  totalCosmeticSelectors: siteSels + genericSels
};

console.log(JSON.stringify(out, null, 2));
console.log(
  `\nSuggested listing line:\n• ${block.toLocaleString()}+ network block rules` +
    ` (${domainBlock.toLocaleString()}+ domain-anchored, ${patternBlock.toLocaleString()}+ URL patterns)` +
    ` and ${out.totalCosmeticSelectors.toLocaleString()}+ cosmetic selectors` +
    ` across ${siteDomains.toLocaleString()}+ sites.`
);
