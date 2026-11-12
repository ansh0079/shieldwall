// Environment -> validated configuration. Production refuses to start on unsafe or missing settings (all problems are listed at once).
import { parseCidrList, parseOrigins } from "./net.js";
import { DEFAULTS, mergeConfig } from "./abuse.js";

const KNOWN = (obj, over, path, errors) => {
  for (const [k, v] of Object.entries(over)) {
    if (!(k in obj)) { errors.push(`REPORT_CONFIG_JSON: unknown setting "${path}${k}"`); continue; }
    if (obj[k] && typeof obj[k] === "object" && !Array.isArray(obj[k])) { if (!v || typeof v !== "object") errors.push(`REPORT_CONFIG_JSON: "${path}${k}" must be an object`); else KNOWN(obj[k], v, `${path}${k}.`, errors); }
    else if (typeof obj[k] === "number" && !(typeof v === "number" && Number.isFinite(v) && v >= 0)) errors.push(`REPORT_CONFIG_JSON: "${path}${k}" must be a non-negative number`);
  }
};
const num = (v, d, name, errors, { min = 0, max = Infinity } = {}) => {
  if (v === undefined || v === "") return d;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) { errors.push(`${name} must be a number between ${min} and ${max}`); return d; }
  return n;
};

export function loadConfig(env = process.env) {
  const errors = [], warnings = [], production = env.NODE_ENV === "production";
  const c = { production };
  c.port = num(env.PORT, 8787, "PORT", errors, { min: 1, max: 65535 });
  c.host = env.HOST || "0.0.0.0";
  c.dbFile = env.DATABASE_FILE || env.DATA_FILE || "data.db";
  c.backupDir = env.BACKUP_DIR || "";
  c.backupEveryHours = num(env.BACKUP_EVERY_HOURS, 6, "BACKUP_EVERY_HOURS", errors, { min: 0.01, max: 24 * 30 });
  c.backupKeep = num(env.BACKUP_KEEP, 28, "BACKUP_KEEP", errors, { min: 1, max: 1000 });
  c.salt = env.REPORT_SALT || (production ? "" : "dev-salt");
  c.secret = env.CREDENTIAL_SECRET || (production ? "" : "dev-secret");
  c.logLevel = ["debug", "info", "warn", "error"].includes(env.LOG_LEVEL) ? env.LOG_LEVEL : "info";
  c.rateLimit = num(env.RATE_LIMIT, 20, "RATE_LIMIT", errors, { min: 1 });
  c.readLimit = num(env.READ_LIMIT, 300, "READ_LIMIT", errors, { min: 1 });
  c.maxConnections = num(env.MAX_CONNECTIONS, 512, "MAX_CONNECTIONS", errors, { min: 1, max: 100000 });
  c.maxConcurrentPerIp = num(env.MAX_CONCURRENT_PER_IP, 20, "MAX_CONCURRENT_PER_IP", errors, { min: 1, max: 10000 });
  c.powBits = num(env.POW_BITS, 16, "POW_BITS", errors, { min: 8, max: 24 });
  if (production && c.powBits < 12) warnings.push("POW_BITS below 12 is a negligible speed bump");

  if (production) {
    for (const [name, v] of [["REPORT_SALT", c.salt], ["CREDENTIAL_SECRET", c.secret]]) {
      if (!v) errors.push(`${name} is required in production`);
      else if (v.length < 32) errors.push(`${name} must be at least 32 characters (use: openssl rand -hex 32)`);
    }
    if (c.salt && c.salt === c.secret) errors.push("REPORT_SALT and CREDENTIAL_SECRET must differ");
    if (!c.backupDir) errors.push("BACKUP_DIR is required in production (backups are not optional)");
  }

  try { c.trustedProxies = parseCidrList(env.TRUSTED_PROXIES || ""); } catch (e) { errors.push(`TRUSTED_PROXIES: ${e.message}`); c.trustedProxies = []; }
  if (env.TRUST_PROXY && env.TRUST_PROXY !== "false") (production ? errors : warnings).push("TRUST_PROXY is no longer supported: set TRUSTED_PROXIES to your proxy's address range, so forwarded addresses are only believed from it");
  if (production && !c.trustedProxies.length) warnings.push("TRUSTED_PROXIES is empty: X-Forwarded-For will be ignored and every client will appear as the proxy. Set it if you run behind a reverse proxy");

  try {
    if (production && env.ALLOWED_ORIGINS === undefined) errors.push('ALLOWED_ORIGINS is required in production (comma-separated, e.g. chrome-extension://<your extension id>; use "none" for no browser origins)');
    c.allowedOrigins = env.ALLOWED_ORIGINS === undefined && production ? new Set() : parseOrigins(env.ALLOWED_ORIGINS ?? "*", { production });   // (the "missing" case is already reported above)
  } catch (e) { errors.push(`ALLOWED_ORIGINS: ${e.message}`); c.allowedOrigins = new Set(); }

  // Admin tokens: "name:token,name2:token2" (named so the audit log records WHO acted) or a single ADMIN_TOKEN.
  c.adminTokens = [];
  const raw = env.ADMIN_TOKENS || (env.ADMIN_TOKEN ? `admin:${env.ADMIN_TOKEN}` : "");
  for (const part of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const i = part.indexOf(":"), name = part.slice(0, i), token = part.slice(i + 1);
    if (i < 1 || !/^[a-z0-9_-]{1,32}$/.test(name)) errors.push(`ADMIN_TOKENS: "${part.slice(0, 12)}..." must look like name:token (name = letters, digits, - _)`);
    else if (token.length < 24) errors.push(`ADMIN_TOKENS: the token for "${name}" is shorter than 24 characters`);
    else if (c.adminTokens.some((t) => t.name === name || t.token === token)) errors.push(`ADMIN_TOKENS: duplicate name or token for "${name}"`);
    else c.adminTokens.push({ name, token });
  }
  try { c.adminCidrs = parseCidrList(env.ADMIN_CIDRS || ""); } catch (e) { errors.push(`ADMIN_CIDRS: ${e.message}`); c.adminCidrs = []; }
  if (production && c.adminTokens.length && !c.adminCidrs.length) warnings.push("ADMIN_CIDRS is empty: the moderation API is reachable from any address (it still needs a token). Restrict it to your admin network");

  if (env.ALERT_WEBHOOK_URL) {
    try { const u = new URL(env.ALERT_WEBHOOK_URL); if (u.protocol !== "https:" || /^(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(u.hostname)) throw new Error("must be a public https URL"); c.alertWebhook = u.href; }
    catch (e) { errors.push(`ALERT_WEBHOOK_URL: ${e.message}`); }
  }
  let over = {};
  try { over = env.REPORT_CONFIG_JSON ? JSON.parse(env.REPORT_CONFIG_JSON) : {}; } catch { errors.push("REPORT_CONFIG_JSON is not valid JSON"); }
  KNOWN(DEFAULTS, over, "", errors);
  c.report = errors.length ? mergeConfig({ powBits: c.powBits }) : mergeConfig({ powBits: c.powBits, ...over });
  return { config: c, errors, warnings };
}
