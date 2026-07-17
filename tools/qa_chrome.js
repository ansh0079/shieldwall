#!/usr/bin/env node
// Dependency-free Chrome smoke test for the unpacked extension.
// Usage: node tools/qa_chrome.js

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge"
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p));
}

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function removeDirWithRetry(dir) {
  for (let i = 0; i < 8; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await wait(250);
    }
  }
}

async function readDevToolsPort(userDataDir) {
  const file = path.join(userDataDir, "DevToolsActivePort");
  for (let i = 0; i < 80; i++) {
    if (fs.existsSync(file)) {
      const [port] = fs.readFileSync(file, "utf8").trim().split(/\r?\n/);
      return Number(port);
    }
    await wait(250);
  }
  throw new Error("Chrome did not expose a DevTools port");
}

async function json(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

function startFixtureServer() {
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (req.url === "/login") {
      res.end(`<!doctype html><title>Login</title><form><input name="user"><input type="password"></form>`);
      return;
    }
    res.end(`<!doctype html><title>Ads</title><div class="adsbygoogle">ad</div><div id="app">ok</div>`);
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        origin: `http://127.0.0.1:${server.address().port}`
      });
    });
  });
}

async function cdpCommand(wsUrl, method, params = {}) {
  if (typeof WebSocket === "undefined") {
    throw new Error("Node WebSocket API is unavailable");
  }
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const id = 1;
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      reject(new Error(`CDP command timed out: ${method}`));
    }, 5000);
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ id, method, params }));
    });
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id !== id) return;
      clearTimeout(timer);
      ws.close();
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`CDP websocket failed: ${method}`));
    });
  });
}

async function createPageTarget(port, url) {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
    method: "PUT"
  });
  if (!res.ok) throw new Error(`create target failed: HTTP ${res.status}`);
  return res.json();
}

async function waitForExpression(wsUrl, expression, label) {
  for (let i = 0; i < 40; i++) {
    const result = await cdpCommand(wsUrl, "Runtime.evaluate", {
      expression,
      returnByValue: true
    });
    if (result.result?.value) return;
    await wait(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.log("Chrome smoke skipped: Chrome/Edge executable not found");
    return;
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quietbrowse-qa-"));
  const fixtures = await startFixtureServer();
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    `--disable-extensions-except=${ROOT}`,
    `--load-extension=${ROOT}`,
    "about:blank"
  ];

  const proc = spawn(chrome, args, { stdio: "ignore" });
  try {
    const port = await readDevToolsPort(userDataDir);
    const version = await json(`http://127.0.0.1:${port}/json/version`);
    let targets = [];
    for (let i = 0; i < 40; i++) {
      const result = await cdpCommand(version.webSocketDebuggerUrl, "Target.getTargets");
      targets = result.targetInfos || [];
      if (targets.some((t) => t.url?.startsWith("chrome-extension://"))) break;
      await wait(250);
    }

    const extensionTargets = targets.filter((t) =>
      t.url?.startsWith("chrome-extension://")
    );
    if (!extensionTargets.length) {
      throw new Error("No chrome-extension target appeared");
    }

    const background = extensionTargets.find((t) =>
      t.type === "service_worker" || /\/background(\.rollup)?\.js$/.test(t.url)
    );
    if (!background) {
      throw new Error("Extension loaded, but background service worker was not visible");
    }

    const adPage = await createPageTarget(port, fixtures.origin + "/ads");
    await waitForExpression(
      adPage.webSocketDebuggerUrl,
      "Boolean(document.getElementById('__qb_styles_base'))",
      "content script cosmetic styles"
    );

    const loginPage = await createPageTarget(port, fixtures.origin + "/login");
    await waitForExpression(
      loginPage.webSocketDebuggerUrl,
      "Boolean(document.getElementById('__qb_phish_overlay') || document.getElementById('__qb_phish_banner'))",
      "phishing/login warning UI"
    );

    console.log("Chrome smoke passed");
    console.log(`  ${background.type}: ${background.url}`);
  } finally {
    proc.kill();
    fixtures.server.close();
    await removeDirWithRetry(userDataDir);
  }
}

main().catch((err) => {
  console.error("Chrome smoke failed:", err.message || err);
  process.exit(1);
});
