import { registrableDomain } from "./lib/domain.js";
import { sameDocument } from "./lib/url.js";
import { analyze } from "./lib/analyze.js";
import { EvidenceCache, chromeStore } from "./lib/cache.js";
import { TabGuard } from "./lib/tabguard.js";
import { ProviderError } from "./lib/http.js";
import { domainAge, firstArchived, safeBrowsing, trustpilot } from "./lib/providers.js";
import { fetchCompany } from "./lib/companies.js";
import { fetchSummary, submitReport } from "./lib/buyers.js";
import { priceContext } from "./lib/price.js";

const providers = { domainAge, firstArchived, safeBrowsing, trustpilot, fetchCompany, fetchSummary };
const cache = new EvidenceCache(chromeStore(chrome.storage.local, ["ev:", "fail:", "net:", "co:"]));
const guard = new TabGuard();
const pageScans = new Map();                       // tabId -> { url, scan }  (a scan only applies to the URL it came from)
const COLORS = { trusted: "#16a34a", caution: "#d97706", risky: "#dc2626", unverified: "#6b7280" };
const quiet = (p) => Promise.resolve(p).catch(() => {});   // closed tabs reject action/tab calls

cache.prune().catch(() => {});                     // drop expired + legacy cache entries on service-worker start

async function settings() {
  return chrome.storage.local.get({ sbKey: "", tpKey: "", backend: "", chKey: "", sbTtlMin: 30 });
}
async function priceFor(domain) {
  const pk = "price:" + domain, pc = (await chrome.storage.session.get(pk))[pk];
  return pc && Date.now() - pc.at < 2 * 3600 * 1000 ? pc : null;
}

async function publish(tabId, report) {
  if (!report || report.neutral) quiet(chrome.action.setBadgeText({ tabId, text: "" }));
  else {
    quiet(chrome.action.setBadgeText({ tabId, text: report.verdict === "unverified" ? "?" : String(report.score) }));
    quiet(chrome.action.setBadgeBackgroundColor({ tabId, color: COLORS[report.verdict] }));
  }
  if (report) {
    await chrome.storage.session?.set({ ["report:" + tabId]: report });
    quiet(chrome.tabs.sendMessage(tabId, { type: "report", report }));
  }
}

// Analyse a tab's page. A result is published only if the tab has not navigated (or closed) in the meantime.
async function refresh(tabId, url, force) {
  const token = guard.begin(tabId, url);
  let report;
  try {
    const s = pageScans.get(tabId), scan = s && sameDocument(s.url, url) ? s.scan : null;
    const domain = registrableDomain(new URL(url).hostname);
    report = await analyze(url, { cache, providers, settings: await settings() },
      { scan, price: domain ? await priceFor(domain) : null, force, signal: token.signal });
  } catch (e) {
    if (!(e instanceof ProviderError && e.kind === "aborted")) console.warn("TrustCheck: analysis failed:", e?.message);
    return null;
  }
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !guard.isCurrent(token, tab.url)) return null;    // stale: the tab moved on
  await publish(tabId, report);
  return report;
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "loading" || info.url) {                  // navigation started / SPA URL change: in-flight work is stale
    guard.invalidate(tabId);
    quiet(chrome.action.setBadgeText({ tabId, text: "" }));
    if (info.status === "loading") pageScans.delete(tabId);
  }
  if ((info.status === "complete" || info.url) && tab.url) refresh(tabId, tab.url, false);
});
chrome.tabs.onRemoved.addListener((id) => { guard.forget(id); pageScans.delete(id); quiet(chrome.storage.session?.remove("report:" + id)); });

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === "scan" && sender.tab) {
    pageScans.set(sender.tab.id, { url: sender.tab.url, scan: msg.scan });
    refresh(sender.tab.id, sender.tab.url, false);
  } else if (msg.type === "lookup") {
    // Hover lookup from a search page: quick check of one result's domain (no page scan available).
    (async () => {
      const domain = registrableDomain(new URL(msg.url).hostname);
      // Remember how this listing's price compares with the results page, so the shop page can show it too (2h).
      const ctx = msg.priceInfo ? priceContext(msg.priceInfo) : null;
      if (ctx && domain) await chrome.storage.session.set({ ["price:" + domain]: { ...ctx, at: Date.now() } });
      const r = await analyze(msg.url, { cache, providers, settings: await settings() }, { price: ctx || (domain ? await priceFor(domain) : null), hover: true });
      reply(r ? { ...r, quick: true } : { error: "could not read this seller's address" });
    })().catch((e) => reply({ error: String(e?.message || e).slice(0, 200) }));
    return true;
  } else if (msg.type === "submitReport") {
    (async () => {
      try {
        const { backend, installId } = await chrome.storage.local.get({ backend: "", installId: "" });
        if (!backend) return reply({ ok: false, error: "No report server set in Options" });
        let id = installId;
        if (!id) { id = crypto.randomUUID(); await chrome.storage.local.set({ installId: id }); }
        await submitReport(backend, id, msg.domain, msg.outcome, msg.tags || []);
        await cache.store.remove(["ev:buy:" + msg.domain]);
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.url) refresh(tab.id, tab.url, false);
        reply({ ok: true });
      } catch (e) { reply({ ok: false, error: String(e.message || e) }); }
    })();
    return true;
  } else if (msg.type === "get" || msg.type === "recheck") {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.url) return reply(null);
      if (msg.type === "get") {                                  // reuse a fresh report for this exact page instead of racing a new analysis
        const c = (await chrome.storage.session.get("report:" + tab.id))["report:" + tab.id];
        if (c && c.url && sameDocument(c.url, tab.url) && Date.now() - c.checkedAt < 60_000) return reply(c);
      }
      reply(await refresh(tab.id, tab.url, msg.type === "recheck"));
    })();
    return true;
  }
});
