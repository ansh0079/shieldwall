#!/usr/bin/env node
// QuietBrowse - drop DNR rules that Chrome would reject from the committed
// static rulesets, without re-downloading filter lists.
//
// Chrome refuses to load an unpacked extension (and skips/flags rules in store
// installs) when any static rule fails its parser, e.g. a urlFilter starting
// with "||*". tools/build_filters.js already filters these out via
// filter_compiler.js; this script applies the same check to the rule files
// currently in the repo and keeps ruleset_index.json counts in sync.
//
// Usage: node tools/sanitize_rulesets.js [--check]
//   --check  report invalid rules and exit 1 if any exist; write nothing.

const fs = require("fs");
const path = require("path");
const { dnrRuleError } = require("../filter_compiler.js");

const ROOT = path.join(__dirname, "..");
const checkOnly = process.argv.includes("--check");

function rulesetFiles() {
  const files = new Set();
  for (const m of ["manifest.json", "manifest.firefox.json"]) {
    const p = path.join(ROOT, m);
    if (!fs.existsSync(p)) continue;
    const manifest = JSON.parse(fs.readFileSync(p, "utf8"));
    for (const r of manifest.declarative_net_request?.rule_resources || []) files.add(r.path);
  }
  return [...files];
}

let totalDropped = 0;
const droppedByFile = {};
for (const rel of rulesetFiles()) {
  const full = path.join(ROOT, rel);
  const rules = JSON.parse(fs.readFileSync(full, "utf8"));
  const kept = [];
  for (const rule of rules) {
    const err = dnrRuleError(rule);
    if (err) {
      console.log(`${checkOnly ? "invalid" : "drop"} ${rel} rule ${rule.id}: ${err} (${JSON.stringify(rule.condition?.urlFilter ?? "")})`);
      continue;
    }
    kept.push(rule);
  }
  const dropped = rules.length - kept.length;
  if (dropped) {
    droppedByFile[rel] = { before: rules.length, after: kept.length };
    totalDropped += dropped;
    if (!checkOnly) fs.writeFileSync(full, JSON.stringify(kept));
  }
}

if (!checkOnly && totalDropped) {
  const idxPath = path.join(ROOT, "ruleset_index.json");
  const index = JSON.parse(fs.readFileSync(idxPath, "utf8"));
  for (const info of Object.values(index)) {
    let changed = false;
    info.files.forEach((f, i) => {
      if (droppedByFile[f]) { info.counts[i] = droppedByFile[f].after; changed = true; }
    });
    if (changed) info.total = info.counts.reduce((a, b) => a + b, 0);
  }
  fs.writeFileSync(idxPath, JSON.stringify(index));
}

console.log(`${checkOnly ? "Found" : "Dropped"} ${totalDropped} invalid rule(s)`);
for (const [f, c] of Object.entries(droppedByFile)) console.log(`  ${f}: ${c.before} -> ${c.after}`);
if (checkOnly && totalDropped) process.exit(1);
