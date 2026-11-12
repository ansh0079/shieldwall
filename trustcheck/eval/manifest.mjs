// Writes eval/corpus/<version>/MANIFEST.json (case counts + sha256 of each file). The held-out hash is checked by tests:
// if you change the held-out set, you are no longer measuring generalisation: bump the corpus version instead.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { CORPUS_VERSION } from "./harness.mjs";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "corpus", CORPUS_VERSION);
export function describe() {
  const files = {};
  for (const set of ["dev", "holdout"]) {
    const text = fs.readFileSync(path.join(dir, `${set}.jsonl`), "utf8");
    files[set] = { cases: text.split("\n").filter(Boolean).length, sha256: crypto.createHash("sha256").update(text).digest("hex") };
  }
  return files;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const manifest = { version: CORPUS_VERSION, synthetic: true, files: describe(),
    note: "All cases are synthetic evidence profiles with fixture or reserved names. No real site is labelled fraudulent. See eval/README.md." };
  fs.writeFileSync(path.join(dir, "MANIFEST.json"), JSON.stringify(manifest, null, 1) + "\n");
  console.log(JSON.stringify(manifest.files));
}
