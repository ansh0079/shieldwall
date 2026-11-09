#!/usr/bin/env node
// QuietBrowse - re-split committed static rulesets by file-size cap without
// re-downloading filter lists. Updates ruleset_index.json and both manifests.
//
// Usage: node tools/resplit_rulesets.js
//
// Strategy:
// - Read ruleset_index.json to discover per-list files and metadata
// - Concatenate existing rules in order p1..pN
// - Split into chunks satisfying both:
//      - <= 25,000 rules per file
//      - < 4 MiB JSON size per file
// - Write back files as rules_opt_<id>_p1.json, p2.json, ...
// - Update ruleset_index.json counts/totals and manifests' rule_resources
//
// This keeps each file well below AMO's 5 MB hard limit to avoid FILE_TOO_LARGE.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const MAX_COUNT = 25000;
const MAX_BYTES = 4 * 1024 * 1024; // 4 MiB target

function chunkRulesByLimits(rules, maxCount = MAX_COUNT, maxBytes = MAX_BYTES) {
  const chunks = [];
  let current = [];
  // Track approximate JSON byte size incrementally for speed:
  // totalSize ≈ 2 ([]) + sum(len(JSON.stringify(rule))) + commas (N-1)
  let currentSize = 2; // for "[]"
  let currentCount = 0;
  for (const rule of rules) {
    const ruleBytes = Buffer.byteLength(JSON.stringify(rule));
    const commaBytes = currentCount > 0 ? 1 : 0; // comma between items
    const nextCount = currentCount + 1;
    const nextSize = currentSize + ruleBytes + commaBytes;
    // Enforce rule-count limit first
    if (nextCount > maxCount || nextSize >= maxBytes) {
      if (currentCount === 0) {
        // Single very large rule; emit alone to make progress.
        chunks.push([rule]);
        current = [];
        currentSize = 2;
        currentCount = 0;
      } else {
        chunks.push(current);
        current = [rule];
        currentSize = 2 + ruleBytes; // "[]" + first item (no comma)
        currentCount = 1;
      }
    } else {
      current.push(rule);
      currentSize = nextSize;
      currentCount = nextCount;
    }
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));
}

function writeJson(rel, data) {
  fs.writeFileSync(path.join(ROOT, rel), JSON.stringify(data));
}

function updateManifests(rulesetIndex) {
  const manifests = ["manifest.json", "manifest.firefox.json"];
  for (const m of manifests) {
    const full = path.join(ROOT, m);
    if (!fs.existsSync(full)) continue;
    const man = readJson(m);
    const base = man.declarative_net_request?.rule_resources || [];
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
    man.declarative_net_request = { ...(man.declarative_net_request || {}), rule_resources: filtered };
    fs.writeFileSync(full, JSON.stringify(man, null, 2));
    console.log(`Updated ${m} rule_resources with optional rulesets`);
  }
}

function main() {
  const indexPath = path.join(ROOT, "ruleset_index.json");
  if (!fs.existsSync(indexPath)) {
    console.error("ruleset_index.json not found — run the filters build first.");
    process.exit(1);
  }
  const index = readJson("ruleset_index.json");
  let totalFilesBefore = 0;
  let totalFilesAfter = 0;
  for (const [listId, info] of Object.entries(index)) {
    totalFilesBefore += info.files.length;
    // Merge existing files into one ordered rules array
    const allRules = [];
    for (const f of info.files) {
      allRules.push(...readJson(f));
    }
    // Safety: keep the same total
    if (allRules.length !== info.total) {
      console.warn(`  Warning: ${listId} total mismatch: index ${info.total}, files ${allRules.length} — using file count`);
      info.total = allRules.length;
    }
    // Chunk by size and count limits
    const chunks = chunkRulesByLimits(allRules);
    // Write back files p1..pN
    const newFiles = [];
    const newIds = [];
    const newCounts = [];
    chunks.forEach((chunk, idx) => {
      const fname = `rules_opt_${listId}_p${idx + 1}.json`;
      writeJson(fname, chunk);
      newFiles.push(fname);
      newIds.push(`quiet_opt_${listId}_p${idx + 1}`);
      newCounts.push(chunk.length);
    });
    // Remove any stale extra files if we reduced the count
    if (newFiles.length < info.files.length) {
      for (let i = newFiles.length; i < info.files.length; i++) {
        const stale = info.files[i];
        try {
          fs.unlinkSync(path.join(ROOT, stale));
          console.log(`  Removed stale ${stale}`);
        } catch {}
      }
    }
    // Update index entry
    info.files = newFiles;
    info.ids = newIds;
    info.counts = newCounts;
    info.total = newCounts.reduce((a, b) => a + b, 0);
    totalFilesAfter += newFiles.length;
    // Log sizes for visibility
    const sizes = newFiles.map((f) => fs.statSync(path.join(ROOT, f)).size);
    const maxMiB = Math.max(...sizes) / (1024 * 1024);
    console.log(`  ${listId}: ${info.total} rules → ${newFiles.length} file(s), max ${(maxMiB).toFixed(2)} MB`);
  }
  writeJson("ruleset_index.json", index);
  updateManifests(index);
  console.log(`Re-split complete: files ${totalFilesBefore} → ${totalFilesAfter}`);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error("Re-split failed:", e && e.message ? e.message : e);
    process.exit(1);
  }
}

