// Validates the extension before packaging: manifest consistency, referenced files, icon sizes,
// permission allow-list and store limits. Run `node tools/validate_extension.mjs`; exit 1 on any problem.
// Importable for tests: `validateExtension(dir)` returns { errors, warnings, files }.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// Every permission must be on this list: adding one is a conscious decision reviewed here, not a drive-by.
const ALLOWED_PERMISSIONS = new Set(["storage", "tabs"]);
const ALLOWED_HOST_PERMISSIONS = new Set([
  "https://rdap.org/*", "https://rdap.verisign.com/*", "https://web.archive.org/*",
  "https://safebrowsing.googleapis.com/*", "https://api.trustpilot.com/*",
  "https://api.company-information.service.gov.uk/*", "http://localhost:8787/*"
]);

const pngSize = (buf) => (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) ? { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) } : null;

export function validateExtension(dir = ROOT) {
  const errors = [], warnings = [], files = new Set(["manifest.json"]);
  const need = (f, why) => { files.add(f); if (!fs.existsSync(path.join(dir, f))) errors.push(`missing file ${f} (${why})`); };
  let m;
  try { m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")); }
  catch (e) { return { errors: ["manifest.json unreadable: " + e.message], warnings, files: [] }; }

  if (m.manifest_version !== 3) errors.push("manifest_version must be 3");
  if (!/^\d+\.\d+\.\d+$/.test(m.version || "")) errors.push(`version must be x.y.z (got ${m.version})`);
  if (!m.name || m.name.length > 75) errors.push("name is required and must be at most 75 characters (store limit)");
  if (!m.description || m.description.length > 132) errors.push("description is required and must be at most 132 characters (store limit)");

  // Icons: the store refuses a listing without a 128px icon; Chrome wants 16/32/48 for the UI.
  for (const size of ["16", "32", "48", "128"]) {
    const f = m.icons?.[size];
    if (!f) { errors.push(`manifest.icons.${size} is missing`); continue; }
    need(f, `icons.${size}`);
    const p = path.join(dir, f);
    if (fs.existsSync(p)) {
      const s = pngSize(fs.readFileSync(p));
      if (!s) errors.push(`${f} is not a PNG`);
      else if (s.w !== Number(size) || s.h !== Number(size)) errors.push(`${f} is ${s.w}x${s.h}, expected ${size}x${size}`);
    }
    if (!m.action?.default_icon?.[size]) warnings.push(`action.default_icon.${size} not set (toolbar falls back to icons)`);
    else need(m.action.default_icon[size], `action.default_icon.${size}`);
  }

  // Every file the manifest references must exist.
  if (m.background?.service_worker) need(m.background.service_worker, "background.service_worker"); else errors.push("background.service_worker missing");
  for (const cs of m.content_scripts || []) for (const f of [...(cs.js || []), ...(cs.css || [])]) need(f, "content script");
  if (m.action?.default_popup) need(m.action.default_popup, "action.default_popup");
  if (m.options_page) need(m.options_page, "options_page");

  // Follow local script/module references from HTML and JS so the package is complete.
  const seen = new Set(), queue = [...files].filter((f) => fs.existsSync(path.join(dir, f)));
  while (queue.length) {
    const f = queue.pop();
    if (seen.has(f) || !/\.(js|mjs|html)$/.test(f)) continue;
    seen.add(f);
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    const refs = [];
    if (f.endsWith(".html")) {
      for (const [, src] of text.matchAll(/<script[^>]+src="([^"]+)"/g)) refs.push(src);
      for (const [, href] of text.matchAll(/<link[^>]+href="([^"]+\.css)"/g)) refs.push(href);
    } else {
      for (const [, spec] of text.matchAll(/(?:^|\n)\s*(?:import|export)[^"'\n]*["']([^"']+)["']/g)) if (spec.startsWith(".")) refs.push(path.join(path.dirname(f), spec));
    }
    for (const r of refs.map((x) => path.normalize(x))) { need(r, `referenced by ${f}`); if (fs.existsSync(path.join(dir, r))) queue.push(r); }
  }

  // Permissions: fail on anything not consciously allowed; plain-http host access only for localhost development.
  for (const p of m.permissions || []) if (!ALLOWED_PERMISSIONS.has(p)) errors.push(`permission "${p}" is not on the allow-list in tools/validate_extension.mjs: justify it there`);
  for (const h of m.host_permissions || []) {
    if (!ALLOWED_HOST_PERMISSIONS.has(h)) errors.push(`host permission "${h}" is not on the allow-list in tools/validate_extension.mjs: justify it there`);
    if (h.startsWith("http://") && !/^http:\/\/localhost(:\d+)?\//.test(h)) errors.push(`plain-http host permission "${h}" (only localhost is acceptable)`);
  }
  if ((m.optional_host_permissions || []).some((h) => h.startsWith("http://"))) errors.push("optional_host_permissions must be https only");

  // Packaged code must not fetch or evaluate remote code (store policy and basic hygiene).
  for (const f of [...files].filter((x) => /\.(js|mjs)$/.test(x) && fs.existsSync(path.join(dir, x)))) {
    const t = fs.readFileSync(path.join(dir, f), "utf8");
    if (/\beval\s*\(|new Function\s*\(/.test(t)) errors.push(`${f} uses eval/new Function`);
  }
  return { errors, warnings, files: [...files].sort() };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { errors, warnings, files } = validateExtension();
  for (const w of warnings) console.log("warn:", w);
  for (const e of errors) console.error("ERROR:", e);
  console.log(errors.length ? `INVALID (${errors.length} problem${errors.length === 1 ? "" : "s"})` : `ok: ${files.length} files verified`);
  process.exit(errors.length ? 1 : 0);
}
