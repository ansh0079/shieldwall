// QuietBrowse vs uBlock Origin vs Privacy Badger — automated comparison
// Usage:
//   npm install puppeteer-core   (once, in the defender/ directory)
//   node tools/compare.js
//
// Output: compare_report.html in the project root

const fs   = require("fs");
const path = require("path");
const https = require("https");
const { execSync } = require("child_process");
const os   = require("os");

// ── Config ────────────────────────────────────────────────────────────────────

const ROOT   = path.join(__dirname, "..");
const CACHE  = path.join(__dirname, "ext_cache");
const REPORT = path.join(ROOT, "compare_report.html");

const TEST_SITES = [
  "https://www.cnn.com",
  "https://www.theguardian.com",
  "https://www.reddit.com",
  "https://www.weather.com",
  "https://www.huffpost.com",
  "https://www.forbes.com",
  "https://www.msn.com",
  "https://www.espn.com",
];

const ADBLOCK_TESTER_URL = "https://adblock-tester.com";

const CHROME_PATHS = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA + "\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  process.env.LOCALAPPDATA + "\\Microsoft\\Edge\\Application\\msedge.exe",
  process.env.CHROME_PATH,
].filter(Boolean);

const PAGE_TIMEOUT = 25000; // ms per site
const TEMP_PREFIX  = "qb-compare-";

// ── Temp-file cleanup ─────────────────────────────────────────────────────────

// Tracks the temp dir currently in use so signal handlers can remove it.
let activeTmpDir = null;

function cleanupActiveTmp() {
  if (activeTmpDir) {
    try { fs.rmSync(activeTmpDir, { recursive: true, force: true }); } catch {}
    activeTmpDir = null;
  }
}

// Remove leftover qb-compare-* dirs from previous crashed runs.
function cleanupStaleTempDirs() {
  const tmpBase = os.tmpdir();
  let removed = 0;
  try {
    for (const entry of fs.readdirSync(tmpBase)) {
      if (!entry.startsWith(TEMP_PREFIX)) continue;
      const full = path.join(tmpBase, entry);
      try {
        fs.rmSync(full, { recursive: true, force: true });
        removed++;
      } catch {}
    }
  } catch {}
  if (removed > 0) log(`Cleaned up ${removed} stale temp dir(s) from a previous run.`);
}

// Ensure cleanup on Ctrl+C or unhandled crash.
process.on("SIGINT",  () => { cleanupActiveTmp(); process.exit(130); });
process.on("SIGTERM", () => { cleanupActiveTmp(); process.exit(143); });
process.on("uncaughtException", (err) => {
  cleanupActiveTmp();
  console.error("Unexpected error:", err.message || err);
  process.exit(1);
});

// ── Utilities ─────────────────────────────────────────────────────────────────

function log(msg) { process.stdout.write(msg + "\n"); }

function findChrome() {
  for (const p of CHROME_PATHS) {
    if (p && fs.existsSync(p)) return p;
  }
  throw new Error(
    "Chrome not found. Set the CHROME_PATH environment variable to your chrome.exe path."
  );
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const get = (u) =>
      https.get(u, { headers: { "User-Agent": "quietbrowse-compare/1.0" } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) { get(res.headers.location); return; }
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
        res.on("error", reject);
      }).on("error", reject);
    get(url);
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const get = (u) =>
      https.get(u, { headers: { "User-Agent": "quietbrowse-compare/1.0" } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) { get(res.headers.location); return; }
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
        file.on("error", reject);
      }).on("error", reject);
    get(url);
  });
}

function unzip(zipFile, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  execSync(
    `powershell -Command "Expand-Archive -Path '${zipFile}' -DestinationPath '${destDir}' -Force"`,
    { stdio: "ignore" }
  );
}

function firstSubdir(dir, predicate) {
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory() && (!predicate || predicate(entry))) return full;
  }
  return dir;
}

// ── Extension setup ───────────────────────────────────────────────────────────

async function setupExtensions() {
  fs.mkdirSync(CACHE, { recursive: true });

  // ── uBlock Origin ──
  const uBlockDir = path.join(CACHE, "ublock");
  if (!fs.existsSync(uBlockDir)) {
    log("  Fetching uBlock Origin release info...");
    const release = await fetchJson(
      "https://api.github.com/repos/gorhill/uBlock/releases/latest"
    );
    const asset = release.assets?.find((a) => a.name.includes(".chromium.zip"));
    if (!asset) throw new Error("Could not find uBlock Chromium zip in latest release.");
    log(`  Downloading uBlock Origin ${release.tag_name}...`);
    const zipPath = path.join(CACHE, "ublock.zip");
    await downloadFile(asset.browser_download_url, zipPath);
    unzip(zipPath, uBlockDir);
    try { fs.unlinkSync(zipPath); } catch {}
    log("  uBlock Origin ready.");
  }

  // ── Privacy Badger ──
  const pbDir = path.join(CACHE, "privacybadger");
  if (!fs.existsSync(pbDir)) {
    log("  Downloading Privacy Badger source...");
    const zipPath = path.join(CACHE, "pb.zip");
    await downloadFile(
      "https://github.com/EFForg/privacybadger/archive/refs/heads/master.zip",
      zipPath
    );
    unzip(zipPath, pbDir);
    try { fs.unlinkSync(zipPath); } catch {}
    log("  Privacy Badger ready.");
  }

  // Resolve extension root directories
  const uBlockRoot = firstSubdir(uBlockDir, (n) => n.startsWith("uBlock0"));
  const pbRoot = path.join(pbDir, "privacybadger-master", "src");

  return {
    "QuietBrowse":     { path: ROOT,       color: "#3b82f6" },
    "uBlock Origin":   { path: uBlockRoot, color: "#f59e0b" },
    "Privacy Badger":  { path: pbRoot,     color: "#10b981" },
    "Baseline (none)": { path: null,       color: "#6b7280" },
  };
}

// ── Page measurement ──────────────────────────────────────────────────────────

async function measurePage(page, url) {
  let total = 0, blocked = 0, bytes = 0;
  const blockedHosts = new Set();
  const loadedHosts  = new Set(); // hosts whose requests actually succeeded

  page.on("request",     ()     => total++);
  page.on("requestfailed", (r)  => {
    if (r.failure()?.errorText === "net::ERR_BLOCKED_BY_CLIENT") {
      blocked++;
      try { blockedHosts.add(new URL(r.url()).hostname); } catch {}
    }
  });
  page.on("response", (res) => {
    const cl = parseInt(res.headers()["content-length"] || "0", 10);
    if (cl > 0) bytes += cl;
    try { loadedHosts.add(new URL(res.url()).hostname); } catch {}
  });

  const t0 = Date.now();
  try {
    await page.goto(url, { waitUntil: "networkidle2", timeout: PAGE_TIMEOUT });
  } catch {
    /* timeout is ok — still record partial data */
  }
  const loadMs = Date.now() - t0;

  return {
    total, blocked, bytes, loadMs,
    blockedHosts: [...blockedHosts],
    loadedHosts:  [...loadedHosts],
  };
}

async function measureAdblockTester(page) {
  try {
    await page.goto(ADBLOCK_TESTER_URL, { waitUntil: "networkidle0", timeout: PAGE_TIMEOUT });
    await page.waitForSelector(".score, #score, .result, .test-result", { timeout: 8000 }).catch(() => {});
    return await page.evaluate(() => {
      // adblock-tester.com shows "X points out of 100" in a score bar
      const bodyText = document.body?.innerText || "";
      // Total score line: "NNN points out of 100" (may appear multiple times — take last)
      const matches = [...bodyText.matchAll(/(\d+)\s+points?\s+out\s+of\s+(\d+)/gi)];
      if (matches.length) {
        const last = matches[matches.length - 1];
        return { blocked: parseInt(last[1]), total: parseInt(last[2]) };
      }
      // Fallback: "X / Y" or "X%"
      const frac = bodyText.match(/(\d+)\s*\/\s*(\d+)/);
      if (frac) return { blocked: parseInt(frac[1]), total: parseInt(frac[2]) };
      const pct = bodyText.match(/(\d+)\s*%/);
      if (pct) return { blocked: parseInt(pct[1]), total: 100 };
      return null;
    });
  } catch {
    return null;
  }
}

// ── Run one extension profile ─────────────────────────────────────────────────

async function runProfile(puppeteer, chromePath, label, extPath) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  activeTmpDir = tmpDir;
  const args = [
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-default-apps",
    "--window-size=1280,800",
  ];
  if (extPath) {
    args.push(
      `--disable-extensions-except=${extPath}`,
      `--load-extension=${extPath}`
    );
  }

  async function launch() {
    const b = await puppeteer.launch({
      executablePath: chromePath,
      headless: "new",
      args,
      userDataDir: tmpDir,
    });
    // Keep one blank tab open at all times so Edge doesn't close the session
    // when individual test pages are closed.
    await b.newPage();
    return b;
  }

  let browser = await launch();

  async function measureOnce(url) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    const m = await measurePage(page, url);
    try { await page.close(); } catch {}
    return m;
  }

  // Measure a site; if the browser session died, relaunch once and retry.
  async function measureResilient(url) {
    try {
      return await measureOnce(url);
    } catch {
      try { await browser.close(); } catch {}
      try {
        browser = await launch();
        return await measureOnce(url);
      } catch (e2) {
        console.warn(`(failed after relaunch: ${e2.message})`);
        return { total: 0, blocked: 0, bytes: 0, loadMs: 0, blockedHosts: [], failed: true };
      }
    }
  }

  const results = { sites: {}, adblockScore: null };

  for (const url of TEST_SITES) {
    process.stdout.write(`    ${label.padEnd(18)} → ${url} ... `);
    const m = await measureResilient(url);
    results.sites[url] = m;
    log(
      m.failed
        ? "failed"
        : `${m.blocked}/${m.total} blocked  (${(m.loadMs / 1000).toFixed(1)}s)`
    );
  }

  process.stdout.write(`    ${label.padEnd(18)} → adblock-tester.com ... `);
  try {
    const testPage = await browser.newPage();
    results.adblockScore = await measureAdblockTester(testPage);
    try { await testPage.close(); } catch {}
  } catch {
    // Session died — one relaunch attempt.
    try {
      try { await browser.close(); } catch {}
      browser = await launch();
      const testPage = await browser.newPage();
      results.adblockScore = await measureAdblockTester(testPage);
      try { await testPage.close(); } catch {}
    } catch {}
  }
  log(results.adblockScore
    ? `${results.adblockScore.blocked}/${results.adblockScore.total}`
    : "unavailable");

  try { await browser.close(); } catch {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  activeTmpDir = null;

  return results;
}

// ── HTML report ───────────────────────────────────────────────────────────────

function buildReport(extensions, allResults) {
  const labels = Object.keys(extensions);
  const colors = labels.map((l) => extensions[l].color);

  // Aggregate totals
  const totals = {};
  for (const label of labels) {
    const r = allResults[label];
    let totalReqs = 0, totalBlocked = 0, totalBytes = 0, totalTime = 0, n = 0;
    for (const m of Object.values(r.sites)) {
      totalReqs    += m.total;
      totalBlocked += m.blocked;
      totalBytes   += m.bytes;
      totalTime    += m.loadMs;
      n++;
    }
    totals[label] = {
      requests: totalReqs,
      blocked:  totalBlocked,
      pct:      totalReqs > 0 ? ((totalBlocked / totalReqs) * 100).toFixed(1) : "0",
      bytes:    (totalBytes / 1024 / 1024).toFixed(1),
      avgLoad:  n > 0 ? (totalTime / n / 1000).toFixed(1) : "—",
      adblockScore: allResults[label].adblockScore,
    };
  }

  const maxBlocked = Math.max(...labels.map((l) => totals[l].blocked));

  function bar(value, max, color) {
    const pct = max > 0 ? Math.round((value / max) * 100) : 0;
    return `<div style="background:#e5e7eb;border-radius:4px;height:14px;width:120px;display:inline-block;vertical-align:middle">
      <div style="width:${pct}%;background:${color};height:100%;border-radius:4px"></div></div>`;
  }

  const summaryRows = labels.map((label, i) => {
    const t = totals[label];
    const s = t.adblockScore;
    return `<tr>
      <td><span style="color:${colors[i]};font-weight:700">${label}</span></td>
      <td>${t.requests.toLocaleString()}</td>
      <td>${t.blocked.toLocaleString()} ${bar(t.blocked, maxBlocked, colors[i])}</td>
      <td>${t.pct}%</td>
      <td>${t.bytes} MB</td>
      <td>${t.avgLoad}s</td>
      <td>${s ? `${s.blocked} / ${s.total}` : "—"}</td>
    </tr>`;
  }).join("\n");

  const perSiteRows = TEST_SITES.map((url) => {
    const host = new URL(url).hostname.replace(/^www\./, "");
    const cells = labels.map((label, i) => {
      const m = allResults[label].sites[url];
      if (!m || m.failed) {
        return `<td style="text-align:center;color:#9ca3af">✗<br><small>failed</small></td>`;
      }
      return `<td style="text-align:center">${m.blocked}<br><small style="color:#6b7280">${m.total} total</small></td>`;
    }).join("");
    return `<tr><td style="font-size:13px">${host}</td>${cells}</tr>`;
  }).join("\n");

  // Gap analysis: hosts other blockers caught that QuietBrowse missed, and vice versa.
  // A miss only counts as REAL if the host actually loaded successfully in our run —
  // otherwise the host never fired for us (often because we blocked its loader
  // earlier in the chain), and the "miss" is an artifact of comparing separate loads.
  const OURS = "QuietBrowse";
  function hostsFor(label, key) {
    const all = new Set();
    for (const m of Object.values(allResults[label].sites)) {
      for (const h of m[key] || []) all.add(h);
    }
    return all;
  }
  const ourHosts  = hostsFor(OURS, "blockedHosts");
  const ourLoaded = hostsFor(OURS, "loadedHosts");
  const missedBy = {};   // host -> which competitors caught it
  const uniqueToUs = []; // hosts only QuietBrowse caught
  const competitorHosts = new Set();
  for (const label of labels) {
    if (label === OURS || !extensions[label].path) continue;
    for (const h of hostsFor(label, "blockedHosts")) {
      competitorHosts.add(h);
      if (!ourHosts.has(h)) {
        (missedBy[h] = missedBy[h] || []).push(label);
      }
    }
  }
  for (const h of ourHosts) {
    if (!competitorHosts.has(h)) uniqueToUs.push(h);
  }

  const realMisses    = [];
  const phantomMisses = [];
  for (const [host, caughtBy] of Object.entries(missedBy)) {
    (ourLoaded.has(host) ? realMisses : phantomMisses).push([host, caughtBy]);
  }
  const byCaughtThenName = (a, b) =>
    b[1].length - a[1].length || a[0].localeCompare(b[0]);
  const missRow = ([host, caughtBy]) =>
    `<tr><td><code>${host}</code></td><td>${caughtBy.join(", ")}</td></tr>`;

  const realMissRows    = realMisses.sort(byCaughtThenName).map(missRow).join("\n");
  const phantomMissRows = phantomMisses.sort(byCaughtThenName).map(missRow).join("\n");

  const uniqueList = uniqueToUs.sort().map((h) => `<code>${h}</code>`).join(", ") || "—";

  const headerCells = labels.map((l, i) =>
    `<th style="color:${colors[i]}">${l}</th>`
  ).join("");

  const now = new Date().toLocaleString();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>QuietBrowse Comparison Report — ${now}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         max-width: 1000px; margin: 40px auto; padding: 0 20px; color: #111; background: #fafafa; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  .meta { color: #6b7280; font-size: 13px; margin-bottom: 32px; }
  h2 { font-size: 16px; margin: 32px 0 12px; border-bottom: 1px solid #e5e7eb; padding-bottom: 6px; }
  table { width: 100%; border-collapse: collapse; background: #fff;
          border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  th { background: #f3f4f6; padding: 10px 14px; text-align: left; font-size: 13px; font-weight: 600; }
  td { padding: 10px 14px; border-top: 1px solid #f3f4f6; font-size: 13px; }
  tr:hover td { background: #f9fafb; }
  .note { font-size: 12px; color: #6b7280; margin-top: 16px; }
</style>
</head>
<body>
<h1>🌊 QuietBrowse vs uBlock Origin vs Privacy Badger</h1>
<div class="meta">Generated ${now} · ${TEST_SITES.length} sites · ${PAGE_TIMEOUT / 1000}s timeout per page</div>

<h2>Summary — all sites combined</h2>
<table>
  <tr>
    <th>Extension</th><th>Total requests</th><th>Blocked</th><th>Block %</th>
    <th>Transferred</th><th>Avg load</th><th>adblock-tester score</th>
  </tr>
  ${summaryRows}
</table>
<p class="note">
  "Blocked" = requests that failed with <code>net::ERR_BLOCKED_BY_CLIENT</code> (i.e. the extension intercepted them).
  Transferred size is estimated from <code>Content-Length</code> headers only.
  Privacy Badger starts cold — it blocks very little until it has learned across many sites.
</p>

<h2>Blocked requests by site</h2>
<table>
  <tr><th>Site</th>${headerCells}</tr>
  ${perSiteRows}
</table>

<h2>Gap analysis — real misses (loaded successfully in QuietBrowse's run)</h2>
${realMissRows
  ? `<table><tr><th>Host</th><th>Caught by</th></tr>${realMissRows}</table>
<p class="note">These hosts loaded without being blocked while a competitor blocked them.
Genuine rule gaps — review each: tracker/ad hosts are candidates for the filter rules;
functional CDNs should be ignored (over-blocking causes breakage).</p>`
  : `<p class="note">None — every host a competitor blocked either was blocked by
QuietBrowse too, or never fired in QuietBrowse's page load. 🎉</p>`}

<h2>Inconclusive — never requested in QuietBrowse's run</h2>
${phantomMissRows
  ? `<table><tr><th>Host</th><th>Caught by</th></tr>${phantomMissRows}</table>
<p class="note">A competitor blocked these, but they never fired during QuietBrowse's
page load — usually because QuietBrowse blocked the script that would have triggered
them (blocking earlier in the chain), or plain ad-auction variance between loads.
Not evidence of a gap.</p>`
  : `<p class="note">None.</p>`}

<h2>Hosts only QuietBrowse blocked</h2>
<p>${uniqueList}</p>
<p class="note">Blocked by QuietBrowse but no competitor. Mostly a good sign (learning +
CNAME rules firing), but double-check none of these are functional resources.</p>

</body>
</html>`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  cleanupStaleTempDirs();

  // Check puppeteer-core is installed
  let puppeteer;
  try {
    puppeteer = require("puppeteer-core");
  } catch {
    log("puppeteer-core not found. Run:  npm install puppeteer-core");
    process.exit(1);
  }

  const chromePath = findChrome();
  log(`Chrome: ${chromePath}`);

  log("\nSetting up extensions...");
  const extensions = await setupExtensions();

  const allResults = {};

  for (const [label, ext] of Object.entries(extensions)) {
    log(`\nRunning: ${label}`);
    allResults[label] = await runProfile(puppeteer, chromePath, label, ext.path);
  }

  log("\nBuilding report...");
  fs.writeFileSync(REPORT, buildReport(extensions, allResults));
  log(`\nDone. Report: ${REPORT}`);
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
