// QuietBrowse Edge packager — builds a clean zip for Microsoft Edge Add-ons.
// Edge accepts the same Chrome MV3 package. This wrapper writes quietbrowse-edge.zip.
// Usage: node tools/pack.edge.js [output.zip]
//
// Internally reuses the Chrome packer with a different default output filename.

const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DEFAULT_OUT = path.join(ROOT, "quietbrowse-edge.zip");
const outPath = path.resolve(process.argv[2] || DEFAULT_OUT);

const r = spawnSync(process.execPath, [path.join(ROOT, "tools", "pack.js"), outPath], {
  stdio: "inherit"
});
process.exit(r.status || 0);

