// QuietBrowse packager — builds a clean zip for Chrome Web Store upload.
// Usage: node tools/pack.js [output.zip]
//
// Excludes everything the store rejects:
//   _metadata/  (Chrome-generated indexed rulesets — causes upload rejection)
//   tools/      (dev scripts)
//   docs/       (documentation directory)
//   *.md files
//   manifest.firefox.json
//   .git/  .gitignore  .gitattributes
//   *.log  *.DS_Store  Thumbs.db

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DEFAULT_OUT = path.join(ROOT, "quietbrowse.zip");
const outPath = path.resolve(process.argv[2] || DEFAULT_OUT);

// Patterns excluded from the zip (relative to ROOT, matched against each entry path)
const EXCLUDE_DIRS = new Set(["_metadata", "tools", "docs", ".git", "node_modules", "assets"]);
const EXCLUDE_FILES = new Set([
  "manifest.firefox.json",
  ".gitignore",
  ".gitattributes",
  "Thumbs.db",
  "quietbrowse.zip",
  "quietbrowse-firefox.xpi",
  "compare_report.html",
  "package.json",
  "package-lock.json",
]);
const EXCLUDE_EXTS = new Set([".md", ".log", ".DS_Store", ".zip", ".xpi"]);

function shouldExclude(relPath) {
  const parts = relPath.split(/[\\/]/);
  // Exclude if any path component is a blocked directory
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

// Try to use the `zip` CLI (available on macOS/Linux/Git Bash).
// Fall back to a pure-JS approach using Node's built-in zlib for deflate.
function packWithZipCli(files) {
  if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
  // Write a temp file list so the shell arg list doesn't overflow
  const listFile = path.join(ROOT, ".pack-filelist.tmp");
  fs.writeFileSync(listFile, files.map((f) => f.rel).join("\n"), "utf8");
  try {
    execSync(`zip -@ "${outPath}" < "${listFile}"`, { cwd: ROOT, stdio: "inherit" });
  } finally {
    fs.unlinkSync(listFile);
  }
}

function packWithNodeZlib(files) {
  // Pure Node implementation — no native `zip` required.
  // Uses the ZIP local-file format with DEFLATE compression via zlib.
  const zlib = require("zlib");

  const centralDir = [];
  const chunks = [];
  let offset = 0;

  const enc = new TextEncoder();

  function u16(n) {
    const b = Buffer.allocUnsafe(2);
    b.writeUInt16LE(n, 0);
    return b;
  }
  function u32(n) {
    const b = Buffer.allocUnsafe(4);
    b.writeUInt32LE(n >>> 0, 0);
    return b;
  }

  function crc32(buf) {
    const table = crc32.table || (crc32.table = buildCrcTable());
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      c = (c >>> 8) ^ table[(c ^ buf[i]) & 0xff];
    }
    return (c ^ 0xffffffff) >>> 0;
  }
  function buildCrcTable() {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c;
    }
    return t;
  }

  const dosDate = (() => {
    const d = new Date();
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
    return { date, time };
  })();

  for (const { full, rel } of files) {
    const data = fs.readFileSync(full);
    const compressed = zlib.deflateRawSync(data, { level: 6 });
    const crc = crc32(data);
    const nameBuf = Buffer.from(rel, "utf8");

    const localHeader = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]), // signature
      u16(20),          // version needed
      u16(0x800),       // flags (UTF-8)
      u16(8),           // compression: DEFLATE
      u16(dosDate.time),
      u16(dosDate.date),
      u32(crc),
      u32(compressed.length),
      u32(data.length),
      u16(nameBuf.length),
      u16(0),           // extra field length
      nameBuf,
    ]);

    centralDir.push({ rel, nameBuf, crc, compSize: compressed.length, uncompSize: data.length, offset });

    chunks.push(localHeader, compressed);
    offset += localHeader.length + compressed.length;
  }

  const cdOffset = offset;
  for (const e of centralDir) {
    const cdEntry = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x01, 0x02]), // signature
      u16(20),          // version made by
      u16(20),          // version needed
      u16(0x800),       // flags (UTF-8)
      u16(8),           // compression
      u16(dosDate.time),
      u16(dosDate.date),
      u32(e.crc),
      u32(e.compSize),
      u32(e.uncompSize),
      u16(e.nameBuf.length),
      u16(0),           // extra
      u16(0),           // comment
      u16(0),           // disk start
      u16(0),           // internal attrs
      u32(0),           // external attrs
      u32(e.offset),
      e.nameBuf,
    ]);
    chunks.push(cdEntry);
    offset += cdEntry.length;
  }

  const cdSize = offset - cdOffset;
  const eocd = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    u16(0), u16(0),
    u16(centralDir.length),
    u16(centralDir.length),
    u32(cdSize),
    u32(cdOffset),
    u16(0), // comment length
  ]);
  chunks.push(eocd);

  fs.writeFileSync(outPath, Buffer.concat(chunks));
}

const files = collectFiles(ROOT, "");
console.log(`Packing ${files.length} files → ${outPath}`);

let useZipCli = false;
try {
  execSync("zip --version", { stdio: "ignore" });
  useZipCli = true;
} catch {
  // zip not available — use Node implementation
}

if (useZipCli) {
  packWithZipCli(files);
} else {
  packWithNodeZlib(files);
}

const bytes = fs.statSync(outPath).size;
console.log(`Done. ${(bytes / 1024).toFixed(1)} KB`);
