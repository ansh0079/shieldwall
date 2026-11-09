// Builds a report for one URL from independent evidence sources. Pure orchestration: all I/O is injected
// (cache, providers, settings) so it can be tested without a browser.
import { registrableDomain, isSearchEngine, tenantPlatform } from "./domain.js";
import { normalizeUrl, sha256Hex } from "./url.js";
import { urlSignals, pageSignals } from "./heuristics.js";
import { historySignals, historyLines } from "./history.js";
import { priceSignals } from "./price.js";
import { buildReport } from "./score.js";
import { annotate } from "./signals.js";
import { extractCompanyNumber, companySignals } from "./companies.js";
import { buyerSignals, buyerFeedback } from "./buyers.js";
import { reviewLinks } from "./providers.js";
import { ProviderError, describeFailure } from "./http.js";

const H = 3600_000;
export const TTL = { age: 6 * H, archive: 24 * H, reviews: 6 * H, buyers: 5 * 60_000, company: 24 * H, safeBrowsingDefaultMin: 30 };

const unavailable = (id, label, err, scope) => ({ id, label: `${label} unavailable`, status: "info", points: 0, availability: "unavailable", scope,
  detail: `${describeFailure(err)}. This check is missing, not clean.` });

export async function analyze(url, deps, opts = {}) {
  const { cache, providers: P, settings: S } = deps;
  const { scan = null, price = null, force = false, signal, hover = false } = opts;
  const pageUrl = normalizeUrl(url);
  if (!pageUrl) return null;
  const u = new URL(pageUrl);
  const domain = registrableDomain(u.hostname);
  if (!domain) return null;                                       // malformed host
  if (isSearchEngine(u.hostname)) return { neutral: true, url: pageUrl, domain, verdict: "neutral", signals: [], links: [], feedback: [], checkedAt: Date.now() };
  const tenant = tenantPlatform(u.hostname);                      // e.g. "github.io": the site is one tenant of a platform
  const o = { signal };
  const run = async (key, ttl, fn) => {
    try { const r = await cache.cachedMeta(key, ttl, fn, { force }); return { ok: true, v: r.v, at: r.at, ttl }; }
    catch (e) { if (e instanceof ProviderError && e.kind === "aborted") throw e; return { ok: false, e, at: Date.now() }; }
  };
  const stamp = (res, sigs) => sigs.map((x) => annotate(x, { checkedAt: res.at, ttlMs: res.ttl }));   // provenance: when fetched, when it expires

  const sbUrl = normalizeUrl(url, { dropQuery: hover });          // full page URL; hover results drop the tracking-laden query
  const sbTtl = Math.min(24 * 60, Math.max(1, Number(S.sbTtlMin) || TTL.safeBrowsingDefaultMin)) * 60_000;
  const number = scan ? extractCompanyNumber((scan.legal || []).join(" ")) : null;

  const [age, arch, tp, sb, buyer, co] = await Promise.all([
    tenant ? null : run("age:" + domain, TTL.age, () => P.domainAge(domain, o)),
    run("arch:" + domain, TTL.archive, () => P.firstArchived(domain, o)),
    S.tpKey ? run("tp:" + domain, TTL.reviews, () => P.trustpilot(domain, S.tpKey, o)) : null,
    S.sbKey ? run("sb:" + (await sha256Hex(sbUrl)), sbTtl, () => P.safeBrowsing(sbUrl, S.sbKey, o)) : null,   // URL-scoped cache key
    S.backend ? run("buy:" + domain, TTL.buyers, () => P.fetchSummary(S.backend, domain, o)) : null,
    S.chKey && number ? run("co:" + number, TTL.company, () => P.fetchCompany(number, S.chKey, o)) : null
  ]);
  if (signal?.aborted) throw new ProviderError("aborted", "analysis cancelled");

  const sigs = [];
  let registered = null;
  if (tenant) sigs.push({ id: "tenant", label: `Hosted on ${tenant}`, status: "info", points: 0, scope: "tenant",
    detail: `This is one site on a shared hosting platform. ${tenant}'s age and reputation do not apply to it.` });
  else if (age.ok) { sigs.push(...stamp(age, age.v)); registered = age.v[0]?.since || null; }
  else sigs.push(...stamp(age, [unavailable("age", "Domain age check", age.e, "domain")]));
  const archived = arch.ok ? arch.v : null;
  if (!arch.ok) sigs.push(...stamp(arch, [unavailable("archive", "Internet Archive check", arch.e, tenant ? "tenant" : "domain")]));
  else if (archived) sigs.push(...stamp(arch, [{ id: "archive", label: "Site history found in the Internet Archive", status: "info", points: 0, scope: tenant ? "tenant" : "domain", verification: "verified", detail: `First archived snapshot: ${archived.slice(0, 10)}.` }]));
  let reviews = null;
  if (tp) { if (tp.ok) { reviews = tp.v.reviews; sigs.push(...stamp(tp, tp.v.signals)); } else sigs.push(...stamp(tp, [unavailable("tp", "Review-site check", tp.e, "domain")])); }
  let flagged = false;
  if (sb) { if (sb.ok) { flagged = sb.v.flagged; sigs.push(...stamp(sb, sb.v.signals)); } else sigs.push(...stamp(sb, [unavailable("sb", "Malware/phishing check", sb.e, "url")])); }
  const summary = buyer?.ok ? buyer.v : null;
  if (buyer && !buyer.ok) sigs.push(...stamp(buyer, [unavailable("buyers", "Buyer-report check", buyer.e, "domain")]));
  if (co) {
    if (co.ok) sigs.push(...stamp(co, companySignals({ number, profile: co.v, haystack: `${scan.title} ${domain} ${(scan.legal || []).join(" ")}` })));
    else sigs.push(...stamp(co, [unavailable("company", "Company check", co.e, "company")]));
  } else if (S.chKey && scan?.isShop && !number) {
    sigs.push({ id: "company", label: "No company registration number shown", status: "info", points: 0, detail: "UK traders normally show their company number in the site footer." });
  }

  const signals = [...(price ? priceSignals(price) : []), ...urlSignals(pageUrl), ...pageSignals(scan && { ...scan, https: u.protocol === "https:" }),
    ...sigs, ...historySignals({ registered, archived }), ...(summary ? stamp(buyer, buyerSignals(summary)) : buyerSignals(summary))];
  if (!S.chKey) signals.push({ id: "co-off", label: "UK company check not connected", status: "info", points: 0, detail: "Add a free Companies House API key in Options to verify a shop's registered company." });
  if (!S.sbKey) signals.push({ id: "sb-off", label: "Malware/phishing database not connected", status: "info", points: 0, detail: "Add a free Google Safe Browsing key in Options for stronger protection." });
  if (!S.tpKey) signals.push({ id: "tp-off", label: "Review-site scores not connected", status: "info", points: 0, detail: "Add a Trustpilot API key in Options, or use the review links below." });

  const report = buildReport({ url: pageUrl, domain, signals, reviews, links: reviewLinks(domain), flagged,
    feedback: buyerFeedback(summary), buyerTotal: summary && !summary.hidden ? summary.total : 0 });
  report.tenant = tenant; report.backendOn = !!S.backend;
  report.registered = registered; report.archived = archived;
  report.history = historyLines({ registered, archived });
  return report;
}
