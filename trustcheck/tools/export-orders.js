// Exports anonymized order delivery outcomes for payment processors.
// Usage: node tools/export-orders.js [serverUrl] [output.csv]
import fs from "node:fs";

const [serverUrl = "http://localhost:8787", outFile = "orders-export.csv"] = process.argv.slice(2);

console.log(`Fetching order log feed from ${serverUrl}...`);
try {
  const res = await fetch(`${serverUrl.replace(/\/$/, "")}/v1/export/orders?format=csv`);
  if (!res.ok) throw new Error("HTTP " + res.status);
  const csv = await res.text();
  fs.writeFileSync(outFile, csv, "utf8");
  console.log(`✓ Exported orders to ${outFile} (${(csv.match(/\n/g) || []).length} rows)`);
} catch (e) {
  console.error("Export failed:", e.message);
  process.exit(1);
}
