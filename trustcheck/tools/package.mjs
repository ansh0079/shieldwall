// Builds a store-ready zip containing exactly the files the extension references (validated first).
// Usage: node tools/package.mjs  ->  dist/trustcheck-<version>.zip
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { validateExtension, ROOT } from "./validate_extension.mjs";

const { errors, files } = validateExtension(ROOT);
if (errors.length) { errors.forEach((e) => console.error("ERROR:", e)); process.exit(1); }

const version = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")).version;
const dist = path.join(ROOT, "dist");
fs.mkdirSync(dist, { recursive: true });
const out = path.join(dist, `trustcheck-${version}.zip`);
fs.rmSync(out, { force: true });
execFileSync("zip", ["-X", "-q", out, ...files], { cwd: ROOT });   // -X: no platform extras, reproducible-ish
const kb = (fs.statSync(out).size / 1024).toFixed(0);
console.log(`${out} (${files.length} files, ${kb} KB)`);
if (fs.statSync(out).size > 10 * 1024 * 1024) { console.error("ERROR: package over 10 MB"); process.exit(1); }
