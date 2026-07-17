// QuietBrowse Firefox packager — builds a .xpi for AMO upload.
// Swaps manifest.firefox.json in as manifest.json; everything else is identical
// to the Chrome pack. The .xpi format is a plain zip file.
// Usage: node tools/pack.firefox.js [output.xpi]

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DEFAULT_OUT = path.join(ROOT, "quietbrowse-firefox.xpi");
const outPath = path.resolve(process.argv[2] || DEFAULT_OUT);

const EXCLUDE_DIRS = new Set(["_metadata", "tools", "docs", ".git", "node_modules", "assets"]);
const EXCLUDE_FILES = new Set([
  "manifest.firefox.json",  // will be injected as manifest.json
  ".gitignore",
  ".gitattributes",
  "Thumbs.db",
  "quietbrowse.zip",
  "quietbrowse-firefox.xpi",
  "compare_report.html",
  "package.json",
  "package-lock.json"
]);
const EXCLUDE_EXTS = new Set([".md", ".log", ".DS_Store", ".zip", ".xpi"]);

function shouldExclude(relPath) {
  const parts = relPath.split(/[\\/]/);
  if (parts.some((p) => EXCLUDE_DIRS.has(p))) return true;
  const base = parts[parts.length - 1];
  if (EXCLUDE_FILES.has(base)) return true;
  const ext = path.extname(base).toLowerCase();
  if (EXCLUDE_EXTS.has(ext)) return true;
  return false;
}

function collectFiles(dir, base) {
  const results = [];
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    const rel = base ? `${base}/${entry}` : entry;
    if (shouldExclude(rel)) continue;
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      results.push(...collectFiles(full, rel));
    } else {
      results.push({ full, rel });
    }
  }
  return results;
}

function packWithNodeZlib(files) {
  const zlib = require("zlib");
  const centralDir = [];
  const chunks = [];
  let offset = 0;

  function u16(n) { const b = Buffer.allocUnsafe(2); b.writeUInt16LE(n, 0); return b; }
  function u32(n) { const b = Buffer.allocUnsafe(4); b.writeUInt32LE(n >>> 0, 0); return b; }

  function crc32(buf) {
    const table = crc32.table || (crc32.table = (() => {
      const t = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[i] = c;
      }
      return t;
    })());
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ table[(c ^ buf[i]) & 0xff];
    return (c ^ 0xffffffff) >>> 0;
  }

  const d = new Date();
  const dosDate = {
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)
  };

  function addEntry(rel, data) {
    const compressed = zlib.deflateRawSync(data, { level: 6 });
    const crc = crc32(data);
    const nameBuf = Buffer.from(rel, "utf8");
    const localHeader = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      u16(20), u16(0x800), u16(8),
      u16(dosDate.time), u16(dosDate.date),
      u32(crc), u32(compressed.length), u32(data.length),
      u16(nameBuf.length), u16(0),
      nameBuf
    ]);
    centralDir.push({ rel, nameBuf, crc, compSize: compressed.length, uncompSize: data.length, offset });
    chunks.push(localHeader, compressed);
    offset += localHeader.length + compressed.length;
  }

  // Inject Firefox manifest as manifest.json first
  addEntry("manifest.json", fs.readFileSync(path.join(ROOT, "manifest.firefox.json")));

  // All other extension files (manifest.json from root is excluded by name matching below)
  for (const { full, rel } of files) {
    if (rel === "manifest.json") continue; // skip Chrome manifest — Firefox one already added
    addEntry(rel, fs.readFileSync(full));
  }

  const cdOffset = offset;
  for (const e of centralDir) {
    const cdEntry = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x01, 0x02]),
      u16(20), u16(20), u16(0x800), u16(8),
      u16(dosDate.time), u16(dosDate.date),
      u32(e.crc), u32(e.compSize), u32(e.uncompSize),
      u16(e.nameBuf.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(e.offset),
      e.nameBuf
    ]);
    chunks.push(cdEntry);
    offset += cdEntry.length;
  }

  const cdSize = offset - cdOffset;
  const eocd = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    u16(0), u16(0),
    u16(centralDir.length), u16(centralDir.length),
    u32(cdSize), u32(cdOffset),
    u16(0)
  ]);
  chunks.push(eocd);
  fs.writeFileSync(outPath, Buffer.concat(chunks));
}

// Pre-flight check
const ffManifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.firefox.json"), "utf8"));
const geckoId = ffManifest?.browser_specific_settings?.gecko?.id;
if (!geckoId || geckoId === "quietbrowse@local") {
  console.error("Error: manifest.firefox.json gecko.id is still the placeholder.");
  console.error("Set a real AMO extension ID before packing.");
  process.exit(1);
}
console.log(`Gecko ID: ${geckoId}`);
console.log(`Version:  ${ffManifest.version}`);

const files = collectFiles(ROOT, "");
console.log(`Packing ${files.length + 1} files → ${outPath}`);  // +1 for Firefox manifest

if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
packWithNodeZlib(files);

const bytes = fs.statSync(outPath).size;
console.log(`Done. ${(bytes / 1024).toFixed(1)} KB`);
console.log(`\nNext steps:`);
console.log(`  1. Go to https://addons.mozilla.org/developers/`);
console.log(`  2. Submit new add-on → upload quietbrowse-firefox.xpi`);
console.log(`  3. AMO will validate — if it asks for source code, zip the project root`);
console.log(`  4. Set listing details, privacy policy URL, screenshots`);
