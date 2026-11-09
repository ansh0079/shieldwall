import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCorpus, runCases, computeMetrics, checkGates, buildFetch, wilson, CORPUS_VERSION } from "../eval/harness.mjs";
import { describe as describeCorpus } from "../eval/manifest.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const evalDir = path.join(here, "..", "eval");
const dev = loadCorpus("dev"), holdout = loadCorpus("holdout"), all = [...dev, ...holdout];
const CATS = ["known_legit", "confirmed_fraud", "compromised_legit", "new_legit", "marketplace", "multi_tenant", "international", "url_threat", "contradictory"];
const EV_KEYS = new Set(["age", "arch", "sb", "tp", "tpTexts", "co", "scan", "scanExtra", "price", "buyers"]);

test("corpus schema", () => {
  const ids = new Set();
  for (const c of all) {
    assert.ok(!ids.has(c.id), "duplicate id " + c.id); ids.add(c.id);
    assert.ok(CATS.includes(c.cat), `${c.id}: category`);
    assert.ok(["fraud", "legit"].includes(c.label), `${c.id}: label`);
    assert.doesNotThrow(() => new URL(c.url), `${c.id}: url`);
    assert.ok(c.desc && c.desc.length > 10, `${c.id}: description`);
    for (const k of Object.keys(c.ev)) assert.ok(EV_KEYS.has(k), `${c.id}: unknown evidence key ${k}`);
    if (c.gap) assert.ok(typeof c.gap === "string" && c.gap.length > 10, `${c.id}: gap needs a reason`);
  }
});
test("labelling policy: only synthetic fixtures may be labelled fraudulent", () => {
  for (const c of all.filter((x) => x.label === "fraud")) {
    const u = new URL(c.url), synthetic = /fixture/i.test(c.url) || /^203\.0\.113\./.test(u.hostname);   // documentation IP range
    assert.ok(synthetic, `${c.id}: a fraud label must apply to a fixture name, never to a real site (${c.url})`);
  }
});
test("every case category from the plan is covered in the development set, and most in the held-out set", () => {
  for (const cat of CATS) assert.ok(dev.filter((c) => c.cat === cat).length >= 2, `dev needs >=2 '${cat}' cases`);
  assert.ok(CATS.filter((cat) => holdout.some((c) => c.cat === cat)).length >= 8);
  assert.ok(dev.some((c) => c.gap) && dev.some((c) => c.hover));          // gaps and hover lookups are represented
});
test("corpus files match the manifest (the held-out set is frozen: bump the corpus version instead of editing it)", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(evalDir, "corpus", CORPUS_VERSION, "MANIFEST.json"), "utf8")), now = describeCorpus();
  assert.equal(manifest.synthetic, true);
  assert.equal(now.holdout.sha256, manifest.files.holdout.sha256, "held-out set changed: it no longer measures generalisation");
  assert.equal(now.dev.sha256, manifest.files.dev.sha256, "dev set changed: run `node eval/manifest.mjs`");
});
test("evaluation is deterministic and never touches the network", async () => {
  const a = await runCases(dev), b = await runCases(dev);
  assert.deepEqual(a, b);
  await assert.rejects(buildFetch(dev[0])("https://example.org/not-a-provider"), /unexpected provider call/);
});
test("development gate passes and no verdict has drifted from the committed baseline", async () => {
  const results = await runCases(dev), m = computeMetrics(results);
  const t = JSON.parse(fs.readFileSync(path.join(evalDir, "thresholds.json"), "utf8")).dev;
  assert.deepEqual(checkGates(m, t), []);
  const base = JSON.parse(fs.readFileSync(path.join(evalDir, "results", "baseline.dev.json"), "utf8"));
  const drift = results.filter((r) => !base[r.id] || base[r.id].verdict !== r.verdict || base[r.id].confidence !== r.confidence).map((r) => `${r.id}: ${base[r.id]?.verdict} -> ${r.verdict}`);
  assert.deepEqual(drift, [], "verdicts changed: review, then `node eval/run.mjs --update-baseline`");
});
test("invariants on the development set", async () => {
  const results = await runCases(dev);
  for (const r of results.filter((x) => x.label === "fraud")) assert.notEqual(r.verdict, "lower", `${r.id}: false reassurance`);
  for (const r of results.filter((x) => x.gap && x.label === "fraud")) assert.notEqual(r.verdict, "lower", `${r.id}: gap case reassured`);
  for (const r of results) if (r.verdict === "limited") assert.equal(r.confidence, "low", r.id);
  for (const r of results.filter((x) => x.cat === "multi_tenant")) assert.ok(!/Domain registered/.test(r.headline));
});

// ---- the metric maths, on hand-built results ----
const R = (label, verdict, extra = {}) => ({ id: Math.random().toString(36), cat: "x", label, verdict, confidence: "medium", score: 50, gap: null, ...extra });
test("metrics: recall, false positives, precision, false reassurance, gaps", () => {
  const m = computeMetrics([R("fraud", "dangerous"), R("fraud", "risky"), R("fraud", "caution"), R("fraud", "lower"), R("legit", "lower"), R("legit", "limited"), R("legit", "caution"), R("legit", "risky"),
    R("fraud", "lower", { gap: "out of scope" }), R("legit", "dangerous", { gap: "x" })]);
  assert.equal(m.fraud, 4); assert.equal(m.legit, 4); assert.equal(m.n, 8);
  assert.equal(m.recallAlarm, 0.5); assert.equal(m.recallWarn, 0.75); assert.equal(m.fnrAlarm, 0.5);
  assert.equal(m.fprAlarm, 0.25); assert.equal(m.fprWarn, 0.5); assert.equal(m.precisionAlarm, 2 / 3);
  assert.equal(m.falseReassurance, 1); assert.equal(m.legitDangerous, 0);
  assert.equal(m.gaps.total, 2); assert.equal(m.gaps.falseReassurance, 1); assert.equal(m.gaps.missed, 2);
});
test("metrics: calibration flags a verdict ordering that is not monotone", () => {
  const good = computeMetrics([...Array(3).fill(0).map(() => R("fraud", "risky")), ...Array(3).fill(0).map(() => R("legit", "lower"))]);
  assert.equal(good.calibration.monotone, true);
  const bad = computeMetrics([...Array(3).fill(0).map(() => R("legit", "risky")), ...Array(3).fill(0).map(() => R("fraud", "lower"))]);
  assert.equal(bad.calibration.monotone, false);
  assert.ok(good.calibration.ece < bad.calibration.ece);
});
test("gates fail when a regression is introduced", () => {
  const t = JSON.parse(fs.readFileSync(path.join(evalDir, "thresholds.json"), "utf8")).dev;
  const m = computeMetrics([R("fraud", "lower"), R("legit", "dangerous"), R("legit", "risky")]);
  const bad = checkGates(m, t);
  assert.ok(bad.some((b) => /false reassurance/.test(b)) && bad.some((b) => /Dangerous/.test(b)) && bad.some((b) => /FPR\(alarm\)/.test(b)));
});
test("Wilson interval", () => {
  const [lo, hi] = wilson(15, 20); assert.ok(lo > 0.5 && lo < 0.75 && hi > 0.75 && hi < 0.95);
  assert.deepEqual(wilson(0, 0), null);
  const [l2] = wilson(0, 10); assert.equal(l2, 0);
});
