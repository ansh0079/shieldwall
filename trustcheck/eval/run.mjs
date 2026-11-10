#!/usr/bin/env node
// Usage: node eval/run.mjs [--set dev|holdout|all] [--verbose] [--check] [--record] [--update-baseline] [--json FILE]
//   dev      tunable set; per-case detail allowed.
//   holdout  held-out set: AGGREGATES ONLY (use --holdout-details to override; doing so means it is no longer held out).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { loadCorpus, runCases, computeMetrics, checkGates, SEVERITY, CORPUS_VERSION, EVAL_NOW } from "./harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2), flag = (f) => args.includes(f), opt = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);
const set = opt("--set") || "dev";
const pct = (x) => (x === null || x === undefined ? "n/a" : `${(x * 100).toFixed(0)}%`);
const ci = (c) => (c ? ` [95% CI ${pct(c[0])}-${pct(c[1])}]` : "");
const pkg = JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8"));
const thresholds = JSON.parse(fs.readFileSync(path.join(here, "thresholds.json"), "utf8"));

const sets = set === "all" ? ["dev", "holdout"] : [set];
let exitCode = 0;
const summary = {};
for (const name of sets) {
  const cases = loadCorpus(name), results = await runCases(cases), m = computeMetrics(results);
  summary[name] = m;
  const detail = name === "dev" || flag("--holdout-details");
  console.log(`\n=== ${name.toUpperCase()} set (corpus ${CORPUS_VERSION}, ${cases.length} cases, clock ${EVAL_NOW}) ===`);
  if (!detail) console.log("(held-out: aggregates only. Do not tune rules against this set.)");
  console.log(`Prevalence in corpus: ${pct(m.prevalence)} fraud (${m.fraud} fraud / ${m.legit} legit, ${m.gaps.total} known-gap cases excluded).`);
  console.log("These rates are relative to this corpus mix. They do not describe real-world accuracy.\n");
  console.log(`  Recall   (fraud flagged High risk / Dangerous): ${pct(m.recallAlarm)}${ci(m.ci.recallAlarm)}   (also Caution: ${pct(m.recallWarn)})`);
  console.log(`  False negatives (alarm level):                  ${pct(m.fnrAlarm)}`);
  console.log(`  False-positive rate (legit alarmed):            ${pct(m.fprAlarm)}${ci(m.ci.fprAlarm)}   (incl. Caution: ${pct(m.fprWarn)})`);
  console.log(`  Precision (alarms that were fraud):             ${pct(m.precisionAlarm)}`);
  console.log(`  False reassurance (fraud rated Lower risk):     ${m.falseReassurance}`);
  console.log(`  Legit rated Dangerous:                          ${m.legitDangerous}`);
  console.log(`  Known gaps: ${m.gaps.total} cases, ${m.gaps.missed} missed, ${m.gaps.falseReassurance} rated Lower risk although fraudulent\n`);
  console.log("  Calibration (observed fraud rate by verdict; n in brackets):");
  for (const v of SEVERITY) { const b = m.calibration.buckets[v]; console.log(`    ${v.padEnd(9)} observed ${pct(b.observed).padStart(4)} vs prior ${pct(b.prior)} (n=${b.n})`); }
  console.log(`    ECE ${m.calibration.ece.toFixed(3)}   Brier ${m.calibration.brier.toFixed(3)}   monotone: ${m.calibration.monotone} (buckets with n>=3: ${m.calibration.usableBuckets.join(", ") || "none"})`);
  console.log("  Accuracy of decided verdicts by confidence (Limited evidence abstains): " + ["low", "medium", "high"].map((c) => `${c} ${pct(m.byConfidence[c].accuracy)} (n=${m.byConfidence[c].decided})`).join("  |  "));
  console.log("\n  Category            n  fraud warned   legit warned   verdicts (dangerous/risky/caution/limited/lower)");
  for (const [cat, c] of Object.entries(m.categories))
    console.log(`  ${cat.padEnd(18)} ${String(c.n).padStart(2)}  ${`${c.fraudWarned}/${c.fraud}`.padStart(11)}   ${`${c.legitWarned}/${c.legit}`.padStart(11)}   ${SEVERITY.map((v) => c.verdicts[v]).join("/")}`);

  if (detail) {
    const line = (r) => `    ${r.id.padEnd(34)} ${r.verdict.padEnd(9)} ${String(r.score).padStart(3)}  ${r.confidence}`;
    const lists = [["False reassurance (fraud -> Lower risk)", (r) => r.label === "fraud" && r.verdict === "lower" && !r.gap],
      ["Missed fraud (not flagged High risk / Dangerous)", (r) => r.label === "fraud" && !["dangerous", "risky"].includes(r.verdict) && !r.gap],
      ["Legit cases given Caution or worse", (r) => r.label === "legit" && ["dangerous", "risky", "caution"].includes(r.verdict) && !r.gap],
      ["Known gaps (not counted above)", (r) => r.gap]];
    for (const [title, f] of lists) { const rs = results.filter(f); console.log(`\n  ${title}: ${rs.length}`); for (const r of rs) console.log(line(r) + (r.gap ? `  [gap: ${r.gap}]` : "")); }
    if (flag("--verbose")) { console.log("\n  All cases:"); for (const r of results) console.log(line(r) + `  (${r.label})`); }
    // snapshot drift: any verdict that changed since the committed baseline must be reviewed deliberately
    const snapFile = path.join(here, "results", `baseline.${name}.json`);
    const snap = Object.fromEntries(results.map((r) => [r.id, { verdict: r.verdict, confidence: r.confidence, score: r.score }]));
    if (flag("--update-baseline")) { fs.writeFileSync(snapFile, JSON.stringify(snap, null, 1) + "\n"); console.log(`\n  Baseline written: ${path.relative(process.cwd(), snapFile)}`); }
    else if (fs.existsSync(snapFile)) {
      const base = JSON.parse(fs.readFileSync(snapFile, "utf8")), changed = results.filter((r) => !base[r.id] || base[r.id].verdict !== r.verdict || base[r.id].confidence !== r.confidence);
      console.log(`\n  Changes vs committed baseline: ${changed.length}`);
      for (const r of changed) console.log(`    ${r.id.padEnd(34)} ${(base[r.id]?.verdict || "(new)")} -> ${r.verdict}`);
      if (changed.length && flag("--check")) { console.error("  Verdicts changed. Review them, then run with --update-baseline."); exitCode = 1; }
    }
  }
  if (flag("--check")) {
    const bad = checkGates(m, thresholds[name]);
    console.log(bad.length ? `\n  GATE FAILED (${name}):\n    - ${bad.join("\n    - ")}` : `\n  Gate passed (${name}).`);
    if (bad.length) exitCode = 1;
  }
}
if (flag("--record")) {
  const histFile = path.join(here, "results", "history.json");
  const hist = fs.existsSync(histFile) ? JSON.parse(fs.readFileSync(histFile, "utf8")) : [];
  let commit = "unknown"; try { commit = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { /* not a git checkout */ }
  const keep = (m) => ({ n: m.n, fraud: m.fraud, legit: m.legit, recallAlarm: m.recallAlarm, recallWarn: m.recallWarn, fprAlarm: m.fprAlarm, fprWarn: m.fprWarn,
    precisionAlarm: m.precisionAlarm, falseReassurance: m.falseReassurance, ece: m.calibration.ece, brier: m.calibration.brier, monotone: m.calibration.monotone, gapsMissed: m.gaps.missed });
  hist.push({ version: pkg.version, label: opt("--label") || "", date: new Date().toISOString().slice(0, 10), corpus: CORPUS_VERSION, commit, ...Object.fromEntries(Object.entries(summary).map(([k, m]) => [k, keep(m)])) });
  fs.writeFileSync(histFile, JSON.stringify(hist, null, 1) + "\n");
  console.log(`\nRecorded run for version ${pkg.version} (${commit}) in eval/results/history.json`);
}
if (opt("--json")) fs.writeFileSync(opt("--json"), JSON.stringify(summary, null, 1));
process.exit(exitCode);
