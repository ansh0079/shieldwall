// QuietBrowse release gate — run after every source change, before any store upload.
// Usage: node tools/release_check.js
//
// Checks:
//   1. npm test passes (validation + unit tests)
//   2. Both packages rebuild cleanly
//   3. Packaged manifest version matches package.json
//   4. Entry counts are in the expected range (no node_modules drift)
//   5. No banned paths inside the zips (node_modules, _metadata, tools, assets)
//   6. Firefox manifest has a real gecko.id (not the placeholder)

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const zlib = require("zlib");

const ROOT = path.join(__dirname, "..");
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const EXPECTED_VERSION = PKG.version;

const CHROME_ZIP = path.join(ROOT, "quietbrowse.zip");
const FF_XPI = path.join(ROOT, "quietbrowse-firefox.xpi");

// Rough bounds — if the count drifts far outside these, something is wrong.
const MIN_ENTRIES = 35;
const MAX_ENTRIES = 60;

const BANNED_PATH_PREFIXES = ["node_modules/", "_metadata/", "tools/", "assets/"];

let pass = true;
function ok(label) { console.log(`  ✓  ${label}`); }
function fail(label) { console.error(`  ✗  ${label}`); pass = false; }

// ── 1. Tests ──────────────────────────────────────────────────────────────────
console.log("\n[1] Running test suite...");
try {
  execSync("npm test", { cwd: ROOT, stdio: "inherit" });
  ok("npm test passed");
} catch {
  fail("npm test failed");
}

// ── 2. Build packages ─────────────────────────────────────────────────────────
console.log("\n[2] Building packages...");
try {
  execSync("node tools/pack.js", { cwd: ROOT, stdio: "inherit" });
  ok("Chrome zip built");
} catch {
  fail("Chrome zip build failed");
}
try {
  execSync("node tools/pack.firefox.js", { cwd: ROOT, stdio: "inherit" });
  ok("Firefox xpi built");
} catch {
  fail("Firefox xpi build failed");
}

// ── 3-5. Inspect each artifact ───────────────────────────────────────────────
function inspectZip(zipPath, label, expectedManifestFn) {
  console.log(`\n[checking ${label}]`);
  if (!fs.existsSync(zipPath)) { fail(`${label} does not exist`); return; }

  // Parse zip central directory (pure Node — no unzip required)
  const buf = fs.readFileSync(zipPath);

  // Find end-of-central-directory record
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocdOffset = i; break; }
  }
  if (eocdOffset < 0) { fail(`${label}: not a valid zip`); return; }

  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  const cdCount  = buf.readUInt16LE(eocdOffset + 10);

  const entries = [];
  let pos = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) break;
    const method       = buf.readUInt16LE(pos + 10);
    const compSize     = buf.readUInt32LE(pos + 20);
    const uncompSize   = buf.readUInt32LE(pos + 24);
    const nameLen      = buf.readUInt16LE(pos + 28);
    const extraLen     = buf.readUInt16LE(pos + 30);
    const commentLen   = buf.readUInt16LE(pos + 32);
    const localOffset  = buf.readUInt32LE(pos + 42);
    const name         = buf.slice(pos + 46, pos + 46 + nameLen).toString("utf8");
    entries.push({ name, method, compSize, uncompSize, localOffset });
    pos += 46 + nameLen + extraLen + commentLen;
  }

  // Entry count
  if (entries.length < MIN_ENTRIES || entries.length > MAX_ENTRIES) {
    fail(`${label}: ${entries.length} entries — expected ${MIN_ENTRIES}–${MAX_ENTRIES}`);
  } else {
    ok(`${label}: ${entries.length} entries (in expected range)`);
  }

  // Banned paths
  const banned = entries.filter(e =>
    BANNED_PATH_PREFIXES.some(p => e.name.startsWith(p))
  );
  if (banned.length) {
    fail(`${label}: banned paths found: ${banned.map(e => e.name).join(", ")}`);
  } else {
    ok(`${label}: no banned paths`);
  }

  // Read and inflate manifest.json
  const mEntry = entries.find(e => e.name === "manifest.json");
  if (!mEntry) { fail(`${label}: manifest.json missing`); return; }

  const lhPos = mEntry.localOffset;
  const lNameLen  = buf.readUInt16LE(lhPos + 26);
  const lExtraLen = buf.readUInt16LE(lhPos + 28);
  const dataStart = lhPos + 30 + lNameLen + lExtraLen;
  const compData  = buf.slice(dataStart, dataStart + mEntry.compSize);

  let manifest;
  try {
    const raw = mEntry.method === 8
      ? zlib.inflateRawSync(compData)
      : compData;
    manifest = JSON.parse(raw.toString("utf8"));
  } catch (e) {
    fail(`${label}: could not read manifest.json — ${e.message}`);
    return;
  }

  // Version match
  if (manifest.version !== EXPECTED_VERSION) {
    fail(`${label}: manifest version ${manifest.version} ≠ package.json ${EXPECTED_VERSION}`);
  } else {
    ok(`${label}: version ${manifest.version} matches package.json`);
  }

  // Caller-supplied extra checks
  if (expectedManifestFn) expectedManifestFn(manifest, label);
}

inspectZip(CHROME_ZIP, "Chrome zip", (m, label) => {
  if (m.background?.service_worker) ok(`${label}: service_worker present`);
  else fail(`${label}: missing background.service_worker`);
});

inspectZip(FF_XPI, "Firefox xpi", (m, label) => {
  const geckoId = m.browser_specific_settings?.gecko?.id;
  if (!geckoId || geckoId === "quietbrowse@local") {
    fail(`${label}: gecko.id is missing or still a placeholder`);
  } else {
    ok(`${label}: gecko.id = ${geckoId}`);
  }
  if (Array.isArray(m.background?.scripts) && m.background.scripts.length > 0) {
    ok(`${label}: background.scripts present (${m.background.scripts.length} files)`);
  } else {
    fail(`${label}: background.scripts missing or empty`);
  }
});

// ── Result ────────────────────────────────────────────────────────────────────
console.log("");
if (pass) {
  console.log("Release check PASSED — safe to upload.");
} else {
  console.error("Release check FAILED — fix the errors above before uploading.");
  process.exit(1);
}
