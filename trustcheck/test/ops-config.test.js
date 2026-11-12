import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../server/config.js";
import { normalizeIp, parseCidr, inCidr, parseCidrList, resolveClientIp, parseOrigins, originAllowed } from "../server/net.js";
import { redact, redactString, createLogger, Metrics } from "../server/log.js";

const S32 = "a".repeat(32), T32 = "b".repeat(32), ADM = "adminToken0123456789abcdefghij";
const good = { NODE_ENV: "production", REPORT_SALT: S32, CREDENTIAL_SECRET: T32, BACKUP_DIR: "/data/backups", ALLOWED_ORIGINS: "chrome-extension://abcdefabcdefabcdefabcdefabcdefab",
  TRUSTED_PROXIES: "10.0.0.0/8", ADMIN_TOKENS: `alice:${ADM}`, ADMIN_CIDRS: "192.0.2.0/24" };
const cfg = (over = {}, drop = []) => { const e = { ...good, ...over }; for (const k of drop) delete e[k]; return loadConfig(e); };

// ---------------- configuration ----------------
test("a complete production configuration validates cleanly", () => {
  const r = cfg(); assert.deepEqual(r.errors, []); assert.deepEqual(r.warnings, []);
  assert.equal(r.config.adminTokens[0].name, "alice"); assert.equal(r.config.trustedProxies.length, 1); assert.ok(r.config.allowedOrigins.has("chrome-extension://abcdefabcdefabcdefabcdefabcdefab"));
});
test("production lists EVERY problem at once instead of failing one at a time", () => {
  const r = loadConfig({ NODE_ENV: "production" });
  const text = r.errors.join("\n");
  assert.equal(r.errors.filter((e) => /ALLOWED_ORIGINS/.test(e)).length, 1, "each problem is reported once");
  for (const must of ["REPORT_SALT is required", "CREDENTIAL_SECRET is required", "BACKUP_DIR is required", "ALLOWED_ORIGINS is required"]) assert.match(text, new RegExp(must));
  assert.ok(r.errors.length >= 4);
});
test("secrets: length, distinctness, and the development defaults are never used in production", () => {
  assert.match(cfg({ REPORT_SALT: "short" }).errors.join(), /REPORT_SALT must be at least 32/);
  assert.match(cfg({ CREDENTIAL_SECRET: S32 }).errors.join(), /must differ/);
  const dev = loadConfig({}); assert.deepEqual(dev.errors, []); assert.equal(dev.config.salt, "dev-salt");
  assert.notEqual(cfg().config.salt, "dev-salt");
});
test("trusted proxies: a list that trusts everyone is refused; legacy TRUST_PROXY is an error in production", () => {
  assert.match(cfg({ TRUSTED_PROXIES: "0.0.0.0/0" }).errors.join(), /matches every address/);
  assert.match(cfg({ TRUSTED_PROXIES: "::/0" }).errors.join(), /matches every address/);
  assert.match(cfg({ TRUSTED_PROXIES: "10.0.0.0/33" }).errors.join(), /invalid prefix/);
  assert.match(cfg({ TRUSTED_PROXIES: "not-an-ip" }).errors.join(), /invalid address/);
  assert.match(cfg({ TRUST_PROXY: "true" }).errors.join(), /TRUST_PROXY is no longer supported/);
  assert.equal(loadConfig({ TRUST_PROXY: "true" }).errors.length, 0);                              // development: only a warning
  assert.match(cfg({}, ["TRUSTED_PROXIES"]).warnings.join(), /X-Forwarded-For will be ignored/);
});
test("origins: wildcard banned in production, exact origins only, 'none' allowed", () => {
  assert.match(cfg({ ALLOWED_ORIGINS: "*" }).errors.join(), /not allowed in production/);
  assert.match(cfg({ ALLOWED_ORIGINS: "https://a.example/path" }).errors.join(), /invalid origin/);
  assert.match(cfg({ ALLOWED_ORIGINS: "javascript:alert(1)" }).errors.join(), /invalid origin/);
  assert.deepEqual(cfg({ ALLOWED_ORIGINS: "none" }).errors, []); assert.equal(cfg({ ALLOWED_ORIGINS: "none" }).config.allowedOrigins.size, 0);
  assert.equal(loadConfig({}).config.allowedOrigins, "*");
});
test("moz-extension origins are an explicit opt-in and must be a UUID", () => {
  const uuid = "moz-extension://550e8400-e29b-41d4-a716-446655440000";
  const set = parseOrigins("https://trustcheck.soloinvestor-ai.com");
  assert.equal(cfg().config.allowMozExtensionOrigins, false);
  assert.equal(cfg({ ALLOW_MOZ_EXTENSION_ORIGINS: "true" }).config.allowMozExtensionOrigins, true);
  assert.equal(cfg({ ALLOW_MOZ_EXTENSION_ORIGINS: "1" }).config.allowMozExtensionOrigins, false);
  assert.equal(cfg({ ALLOW_MOZ_EXTENSION_ORIGINS: "TRUE" }).config.allowMozExtensionOrigins, false);
  assert.ok(!originAllowed(uuid, set));
  assert.ok(!originAllowed(uuid, set, { allowMozExtension: false }));
  assert.ok(originAllowed(uuid, set, { allowMozExtension: true }));
  assert.ok(originAllowed(uuid.toUpperCase(), set, { allowMozExtension: true }));
  assert.ok(!originAllowed("moz-extension://not-a-uuid", set, { allowMozExtension: true }));
  assert.ok(!originAllowed("moz-extension://550e8400e29b41d4a716446655440000", set, { allowMozExtension: true }));
  assert.ok(!originAllowed("moz-extension://550e8400-e29b-41d4-a716-446655440000/path", set, { allowMozExtension: true }));
  assert.ok(!originAllowed("moz-extension://550e8400-e29b-41d4-a716-446655440000:443", set, { allowMozExtension: true }));
  assert.ok(!originAllowed("chrome-extension://550e8400-e29b-41d4-a716-446655440000", set, { allowMozExtension: true }));
  assert.ok(!originAllowed("https://550e8400-e29b-41d4-a716-446655440000", set, { allowMozExtension: true }));
  assert.ok(originAllowed("https://trustcheck.soloinvestor-ai.com", set, { allowMozExtension: true }));
  assert.ok(!originAllowed(undefined, set, { allowMozExtension: true }));
});
test("admin tokens: named, long, unique; production warns when the admin API is open to every network", () => {
  assert.match(cfg({ ADMIN_TOKENS: "alice:short" }).errors.join(), /shorter than 24/);
  assert.match(cfg({ ADMIN_TOKENS: `Alice!:${ADM}` }).errors.join(), /name:token/);
  assert.match(cfg({ ADMIN_TOKENS: `alice:${ADM},bob:${ADM}` }).errors.join(), /duplicate/);
  assert.match(cfg({ ADMIN_TOKENS: `alice:${ADM},alice:${ADM}x` }).errors.join(), /duplicate/);
  assert.equal(cfg({ ADMIN_TOKENS: `alice:${ADM},bob:${ADM}b` }).config.adminTokens.length, 2);
  assert.equal(cfg({ ADMIN_TOKENS: "", ADMIN_TOKEN: ADM }).config.adminTokens[0].name, "admin");     // single-token form
  assert.match(cfg({}, ["ADMIN_CIDRS"]).warnings.join(), /ADMIN_CIDRS is empty/);
});
test("alert webhook must be a public https URL", () => {
  assert.deepEqual(cfg({ ALERT_WEBHOOK_URL: "https://hooks.example.com/x" }).errors, []);
  for (const bad of ["http://hooks.example.com/x", "https://localhost/x", "https://10.1.2.3/x", "https://192.168.1.5/x", "not a url"]) assert.match(cfg({ ALERT_WEBHOOK_URL: bad }).errors.join(), /ALERT_WEBHOOK_URL/, bad);
});
test("report tuning overrides are validated: unknown keys, wrong types and negatives are errors", () => {
  assert.deepEqual(cfg({ REPORT_CONFIG_JSON: '{"display":{"minEffective":8}}' }).errors, []);
  assert.equal(cfg({ REPORT_CONFIG_JSON: '{"display":{"minEffective":8}}' }).config.report.display.minEffective, 8);
  assert.match(cfg({ REPORT_CONFIG_JSON: '{"nonsense":1}' }).errors.join(), /unknown setting "nonsense"/);
  assert.match(cfg({ REPORT_CONFIG_JSON: '{"display":{"minEffective":-1}}' }).errors.join(), /non-negative/);
  assert.match(cfg({ REPORT_CONFIG_JSON: '{"display":{"typo":1}}' }).errors.join(), /unknown setting "display.typo"/);
  assert.match(cfg({ REPORT_CONFIG_JSON: "{not json" }).errors.join(), /not valid JSON/);
  assert.match(cfg({ REPORT_CONFIG_JSON: '{"display":5}' }).errors.join(), /must be an object/);
});
test("numeric settings are range-checked", () => {
  for (const [k, v] of [["PORT", "0"], ["PORT", "99999"], ["PORT", "abc"], ["POW_BITS", "3"], ["POW_BITS", "40"], ["MAX_CONNECTIONS", "0"], ["BACKUP_EVERY_HOURS", "-1"]])
    assert.ok(cfg({ [k]: v }).errors.length >= 1, `${k}=${v}`);
  assert.match(cfg({ POW_BITS: "10" }).warnings.join(), /negligible/);
});

// ---------------- networking ----------------
test("IP normalisation and CIDR matching, IPv4 and IPv6", () => {
  assert.equal(normalizeIp("::ffff:10.1.2.3"), "10.1.2.3"); assert.equal(normalizeIp("FE80::1%eth0"), "fe80::1"); assert.equal(normalizeIp("999.1.1.1"), null); assert.equal(normalizeIp("x"), null); assert.equal(normalizeIp(5), null);
  const v4 = parseCidr("10.20.0.0/16"), v6 = parseCidr("2001:db8:abcd::/48"), one = parseCidr("203.0.113.5");
  assert.ok(inCidr("10.20.255.255", v4) && !inCidr("10.21.0.0", v4) && !inCidr("2001:db8::1", v4));
  assert.ok(inCidr("2001:db8:abcd:ffff::1", v6) && !inCidr("2001:db8:abce::1", v6) && !inCidr("10.20.0.1", v6));
  assert.ok(inCidr("203.0.113.5", one) && !inCidr("203.0.113.6", one));
  assert.ok(inCidr("::ffff:10.20.3.4", v4));                                                        // IPv4-mapped IPv6 peers match IPv4 networks
  assert.ok(inCidr("::1", parseCidr("::1/128")) && inCidr("fe80::1", parseCidr("fe80::/10")));
  for (const bad of ["10.0.0.0/", "10.0.0.0/8/8", "10.0.0.0/-1", "10.0.0.0/abc", "300.0.0.0/8"]) assert.throws(() => parseCidr(bad), undefined, bad);
});
const req = (peer, xff) => ({ socket: { remoteAddress: peer }, headers: xff === undefined ? {} : { "x-forwarded-for": xff } });
test("client address resolution: trust only configured proxies, read right to left, reject malformed", () => {
  const trusted = parseCidrList("10.0.0.0/8,2001:db8::/32");
  assert.deepEqual(resolveClientIp(req("198.51.100.7", "1.2.3.4"), trusted), { ip: "198.51.100.7", via: "peer", forwardedIgnored: true });   // spoof from an untrusted peer
  assert.deepEqual(resolveClientIp(req("198.51.100.7", "1.2.3.4"), []), { ip: "198.51.100.7", via: "peer", forwardedIgnored: true });         // no proxies configured at all
  assert.equal(resolveClientIp(req("10.0.0.5", "203.0.113.9"), trusted).ip, "203.0.113.9");
  assert.equal(resolveClientIp(req("10.0.0.5", "6.6.6.6, 203.0.113.9, 10.0.0.4"), trusted).ip, "203.0.113.9");        // client-supplied left entries are ignored
  assert.equal(resolveClientIp(req("10.0.0.5", "10.1.1.1, 10.0.0.4"), trusted).ip, "10.1.1.1");                       // all trusted: leftmost
  assert.equal(resolveClientIp(req("::ffff:10.0.0.5", "203.0.113.9"), trusted).ip, "203.0.113.9");
  assert.equal(resolveClientIp(req("2001:db8::7", "2001:4860::1"), trusted).ip, "2001:4860::1");
  for (const bad of ["junk", "1.2.3.4, junk", "1.2.3.4,", "<script>", Array(12).fill("1.2.3.4").join(", ")]) {
    const r = resolveClientIp(req("10.0.0.5", bad), trusted); assert.equal(r.ip, "10.0.0.5"); assert.equal(r.malformed, true, bad);
  }
  assert.equal(resolveClientIp({ socket: {}, headers: {} }, trusted).ip, "unknown");
  assert.equal(resolveClientIp(req("10.0.0.5"), trusted).ip, "10.0.0.5");
});
test("origin allowlists are exact and case-insensitive", () => {
  const set = parseOrigins("chrome-extension://abcdefabcdefabcdefabcdefabcdefab, HTTPS://App.Example.com");
  assert.ok(originAllowed("https://app.example.com", set) && originAllowed("HTTPS://APP.EXAMPLE.COM", set));
  assert.ok(!originAllowed("https://app.example.com.evil.net", set) && !originAllowed("https://evil.app.example.com", set) && !originAllowed("http://app.example.com", set) && !originAllowed(undefined, set) && !originAllowed("null", set));
  assert.ok(originAllowed("anything", "*"));
});

// ---------------- logging and metrics ----------------
test("redaction removes addresses, token-like strings and sensitive keys, at any depth", () => {
  assert.equal(redactString("from 203.0.113.7 and 2001:db8::1 token abcdefghijklmnopqrstuvwxyz.0123456789abcdef"), "from [ip] and [ip] token [redacted]");
  const r = redact({ ok: 1, authorization: "Bearer x", nested: { password: "p", token: "t", keep: "fine", ip: "1.2.3.4", deeper: { a: { b: { c: { d: 1 } } } } }, list: ["1.2.3.4", "ok"], body: "payload", contact: "a@b.c" });
  assert.equal(r.authorization, "[redacted]"); assert.equal(r.nested.password, "[redacted]"); assert.equal(r.nested.token, "[redacted]"); assert.equal(r.nested.ip, "[redacted]");
  assert.equal(r.nested.keep, "fine"); assert.deepEqual(r.list, ["[ip]", "ok"]); assert.equal(r.body, "[redacted]"); assert.equal(r.contact, "[redacted]"); assert.equal(r.nested.deeper.a.b, "[deep]");
  assert.deepEqual(redact({ credentials: 3, challenges: 12, token: 5, flag_token: true, password: "p" }), { credentials: 3, challenges: 12, token: 5, flag_token: true, password: "[redacted]" });   // counts survive; strings under sensitive keys do not
  assert.equal(redact("word ".repeat(1000)).length, 500); assert.equal(redact("x".repeat(2000)), "[redacted]");   // long strings are truncated; token-shaped ones are removed
});
test("IPv6 addresses are redacted completely in every notation, and timestamps are left alone", () => {
  for (const a of ["2001:db8::1", "::1", "fe80::1%eth0", "2001:0db8:85a3:0000:0000:8a2e:0370:7334", "::ffff:203.0.113.7", "2001:db8:abcd:12::", "1::"]) {
    const out = redactString(`client ${a} connected`);
    assert.ok(!/[0-9a-f]{2,}:/i.test(out.replace("connected", "")) && out.includes("[ip]") || out.startsWith("client ::ffff:[ip]") , `${a} -> ${out}`);
    assert.ok(!out.includes("db8") && !out.includes("85a3") && !out.includes("fe80") && !out.includes("abcd"), `${a} leaked: ${out}`);
  }
  assert.equal(redactString("at 2026-01-02T03:04:05.000Z took 12:30:45"), "at 2026-01-02T03:04:05.000Z took 12:30:45");
  assert.equal(redactString("ratio 3:2 and 1:1"), "ratio 3:2 and 1:1");
});
test("logger emits one JSON object per line, honours levels, and redacts", () => {
  const lines = [], log = createLogger({ write: (l) => lines.push(l), level: "warn", now: () => Date.parse("2026-01-02T03:04:05Z"), base: { service: "s" } });
  log.debug("d"); log.info("i"); log.warn("w", { addr: "1.2.3.4", token: "x", n: 5 }); log.error("e", { msg: "from 10.0.0.1" });
  assert.equal(lines.length, 2);
  const w = JSON.parse(lines[0]); assert.deepEqual(w, { ts: "2026-01-02T03:04:05.000Z", level: "warn", event: "w", service: "s", addr: "[redacted]", token: "[redacted]", n: 5 });
  assert.equal(JSON.parse(lines[1]).msg, "from [ip]");
});
test("metrics render Prometheus text with counters, gauges and histograms; labels cannot inject lines", () => {
  const m = new Metrics();
  m.inc("a_total"); m.inc("a_total", 2); m.inc("b_total", 1, { route: 'GET /x"\n# HELP evil', status: "200" }); m.set("g", 7); m.observe("d_seconds", 0.03, { route: "r" }); m.observe("d_seconds", 3, { route: "r" });
  assert.equal(m.get("a_total"), 3); assert.equal(m.get("g"), 7);
  const t = m.render();
  assert.match(t, /^trustcheck_a_total 3$/m); assert.match(t, /^trustcheck_g 7$/m);
  assert.match(t, /trustcheck_d_seconds_bucket\{route="r",le="0.05"\} 1/); assert.match(t, /trustcheck_d_seconds_bucket\{route="r",le="\+Inf"\} 2/); assert.match(t, /trustcheck_d_seconds_count\{route="r"\} 2/);
  assert.ok(!/^# HELP evil/m.test(t), "a label value cannot start a new line"); assert.equal(t.split("\n").filter((l) => l.includes("evil")).length, 1);
});
