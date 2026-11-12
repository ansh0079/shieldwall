#!/usr/bin/env node
// Zero-dependency packaging tool for BeforeYouBuy (Chrome + Firefox MV3 distributions).
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist");

function crc32(buf) {
  let table = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c;
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF];
  return (crc ^ (-1)) >>> 0;
}

function createZip(files) {
  const localHeaders = [];
  const cdEntries = [];
  let offset = 0;

  for (const f of files) {
    const data = Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content);
    const compressed = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const nameBuf = Buffer.from(f.path.replace(/\\/g, "/"));

    const lh = Buffer.alloc(30 + nameBuf.length);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(compressed.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    nameBuf.copy(lh, 30);

    localHeaders.push(lh, compressed);

    const cd = Buffer.alloc(46 + nameBuf.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(compressed.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    nameBuf.copy(cd, 46);

    cdEntries.push(cd);
    offset += lh.length + compressed.length;
  }

  const cdTotalLen = cdEntries.reduce((acc, c) => acc + c.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdTotalLen, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localHeaders, ...cdEntries, eocd]);
}

function collectFiles(target = "chrome") {
  const manifestFile = target === "firefox" ? "manifest.firefox.json" : "manifest.json";
  const manifestRaw = fs.readFileSync(path.join(ROOT, manifestFile), "utf8");
  const manifest = JSON.parse(manifestRaw);
  const version = manifest.version || "0.3.0";

  const fileList = [
    { path: "manifest.json", content: manifestRaw },
    { path: "background.js", content: fs.readFileSync(path.join(ROOT, "background.js")) },
    { path: "content.js", content: fs.readFileSync(path.join(ROOT, "content.js")) },
    { path: "search_hover.js", content: fs.readFileSync(path.join(ROOT, "search_hover.js")) },
    { path: "popup.html", content: fs.readFileSync(path.join(ROOT, "popup.html")) },
    { path: "popup.css", content: fs.readFileSync(path.join(ROOT, "popup.css")) },
    { path: "popup.js", content: fs.readFileSync(path.join(ROOT, "popup.js")) },
    { path: "options.html", content: fs.readFileSync(path.join(ROOT, "options.html")) },
    { path: "options.js", content: fs.readFileSync(path.join(ROOT, "options.js")) },
    { path: "reminder.html", content: fs.readFileSync(path.join(ROOT, "reminder.html")) },
    { path: "reminder.js", content: fs.readFileSync(path.join(ROOT, "reminder.js")) }
  ];

  // Add all files from lib/
  const libDir = path.join(ROOT, "lib");
  for (const f of fs.readdirSync(libDir)) {
    if (f.endsWith(".js") || f.endsWith(".json")) {
      fileList.push({
        path: `lib/${f}`,
        content: fs.readFileSync(path.join(libDir, f))
      });
    }
  }

  const iconsDir = path.join(ROOT, "icons");
  if (fs.existsSync(iconsDir)) {
    for (const f of fs.readdirSync(iconsDir)) {
      fileList.push({ path: `icons/${f}`, content: fs.readFileSync(path.join(iconsDir, f)) });
    }
  }

  return { fileList, version };
}

function run() {
  if (!fs.existsSync(DIST)) fs.mkdirSync(DIST, { recursive: true });

  // 1. Chrome distribution
  const chromeData = collectFiles("chrome");
  const chromeZip = createZip(chromeData.fileList);
  const chromeOut = path.join(DIST, `beforeyoubuy-chrome-v${chromeData.version}.zip`);
  fs.writeFileSync(chromeOut, chromeZip);
  console.log(`✓ Packaged Chrome release (${chromeData.fileList.length} files): ${chromeOut} (${(chromeZip.length / 1024).toFixed(1)} KB)`);

  // 2. Firefox distribution
  const ffData = collectFiles("firefox");
  const ffZip = createZip(ffData.fileList);
  const ffOut = path.join(DIST, `beforeyoubuy-firefox-v${ffData.version}.zip`);
  const ffXpi = path.join(DIST, `beforeyoubuy-firefox-v${ffData.version}.xpi`);
  fs.writeFileSync(ffOut, ffZip);
  fs.writeFileSync(ffXpi, ffZip);
  console.log(`✓ Packaged Firefox release (${ffData.fileList.length} files): ${ffOut} (${(ffZip.length / 1024).toFixed(1)} KB)`);
}

run();
