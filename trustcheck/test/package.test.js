// The extension must always be in a shippable state: the validator passes on the repo and catches real mistakes.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateExtension, ROOT } from "../tools/validate_extension.mjs";

test("the shipped extension validates cleanly", () => {
  const { errors, warnings, files } = validateExtension(ROOT);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.ok(files.includes("manifest.json") && files.includes("background.js") && files.includes("icons/icon128.png"));
  assert.ok(files.every((f) => fs.existsSync(path.join(ROOT, f))), "every packaged file exists");
  // The package must never pick up the server, tests or tooling.
  assert.ok(files.every((f) => !/^(server|test|eval|tools|dist)\//.test(f)), "only extension files are packaged");
});

test("the validator catches a store-blocking manifest", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-val-"));
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
    manifest_version: 2, version: "1.0", description: "x".repeat(200),
    permissions: ["history"], host_permissions: ["http://api.example.com/*"],
    background: { service_worker: "missing.js" }
  }));
  const { errors } = validateExtension(dir);
  const text = errors.join("\n");
  for (const needle of ["manifest_version", "version", "name", "description", "icons.16", "icons.128", "missing.js",
    '"history"', "http://api.example.com/*"]) assert.match(text, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `catches ${needle}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the validator catches a wrong-size or fake icon", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-val-"));
  fs.mkdirSync(path.join(dir, "icons"));
  fs.copyFileSync(path.join(ROOT, "icons/icon16.png"), path.join(dir, "icons/icon128.png"));   // wrong size
  fs.writeFileSync(path.join(dir, "icons/icon16.png"), "not a png");
  fs.copyFileSync(path.join(ROOT, "icons/icon32.png"), path.join(dir, "icons/icon32.png"));
  fs.copyFileSync(path.join(ROOT, "icons/icon48.png"), path.join(dir, "icons/icon48.png"));
  for (const f of ["background.js", "popup.html", "options.html"]) fs.writeFileSync(path.join(dir, f), "");
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
    manifest_version: 3, version: "1.0.0", name: "T", description: "d",
    icons: { 16: "icons/icon16.png", 32: "icons/icon32.png", 48: "icons/icon48.png", 128: "icons/icon128.png" },
    action: { default_popup: "popup.html", default_icon: { 16: "icons/icon16.png", 32: "icons/icon32.png", 48: "icons/icon48.png", 128: "icons/icon128.png" } },
    options_page: "options.html", background: { service_worker: "background.js" }
  }));
  const { errors } = validateExtension(dir);
  assert.ok(errors.some((e) => e.includes("icon128.png") && e.includes("16x16")), "wrong size caught: " + errors.join("; "));
  assert.ok(errors.some((e) => e.includes("icon16.png") && e.includes("not a PNG")), "fake PNG caught");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the validator refuses eval and remote-code patterns in packaged files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-val-"));
  fs.cpSync(path.join(ROOT, "icons"), path.join(dir, "icons"), { recursive: true });
  fs.writeFileSync(path.join(dir, "background.js"), "eval('x')");
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
    manifest_version: 3, version: "1.0.0", name: "T", description: "d",
    icons: { 16: "icons/icon16.png", 32: "icons/icon32.png", 48: "icons/icon48.png", 128: "icons/icon128.png" },
    action: { default_icon: { 16: "icons/icon16.png", 32: "icons/icon32.png", 48: "icons/icon48.png", 128: "icons/icon128.png" } },
    background: { service_worker: "background.js" }
  }));
  const { errors } = validateExtension(dir);
  assert.ok(errors.some((e) => e.includes("eval")), errors.join("; "));
  fs.rmSync(dir, { recursive: true, force: true });
});
