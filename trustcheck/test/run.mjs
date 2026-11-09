// Runs every test/*.test.js in its own process with a hard timeout, so one hung file is named and killed
// instead of hanging the whole suite. Works on Node 18+ (no glob/--test-timeout needed). `node test/run.mjs [file...]`
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const FILE_TIMEOUT_MS = Number(process.env.TEST_FILE_TIMEOUT_MS || 60_000);
const only = process.argv.slice(2);
const REQUIRE_ALL = process.env.TEST_REQUIRE_ALL === "1";                 // CI on the full Node version: skipping a file is a failure
let HAS_SQLITE = true; try { await import("node:sqlite"); } catch { HAS_SQLITE = false; }
const needsSqlite = (file) => /^\/\/ requires: node:sqlite/m.test(fs.readFileSync(file, "utf8").split("\n").slice(0, 3).join("\n"));
const files = (only.length ? only : fs.readdirSync(here).filter((f) => f.endsWith(".test.js")).sort()).map((f) => path.resolve(here, f.replace(/^test[\\/]/, "")));

function runOne(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", file], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", timedOut = false;
    child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { out += d; });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, FILE_TIMEOUT_MS);
    child.on("close", (code) => { clearTimeout(timer); resolve({ file, code, timedOut, out }); });
  });
}

const started = Date.now(); let failed = 0, passTests = 0, skipped = 0;
for (const f of files) {
  if (!HAS_SQLITE && needsSqlite(f)) {
    skipped++; console.log(`SKIP  ${path.basename(f).padEnd(26)} needs node:sqlite (Node >= 22.13); this is Node ${process.versions.node}`);
    if (REQUIRE_ALL) { failed++; console.error(`FAIL  ${path.basename(f)} was skipped but TEST_REQUIRE_ALL=1`); }
    continue;
  }
  const t0 = Date.now(), r = await runOne(f), secs = ((Date.now() - t0) / 1000).toFixed(1);
  const pass = Number((/^# pass (\d+)/m.exec(r.out) || [])[1] || 0); passTests += pass;
  const name = path.basename(f);
  if (r.timedOut) { failed++; console.error(`HANG  ${name} did not exit within ${FILE_TIMEOUT_MS / 1000}s. Likely an unclosed server, socket or timer.\n${r.out.split("\n").slice(-25).join("\n")}`); }
  else if (r.code !== 0) { failed++; console.error(`FAIL  ${name} (${secs}s)\n${r.out}`); }
  else console.log(`ok    ${name.padEnd(26)} ${String(pass).padStart(3)} tests  ${secs}s`);
}
console.log(`\n${files.length - failed - skipped}/${files.length} files passed${skipped ? `, ${skipped} skipped (need node:sqlite)` : ""}, ${passTests} tests, ${((Date.now() - started) / 1000).toFixed(1)}s`);
process.exit(failed ? 1 : 0);
