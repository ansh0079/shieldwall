import { registrableDomain, isSearchEngine } from "./lib/domain.js";
import { urlSignals, pageSignals } from "./lib/heuristics.js";
import { domainAge, firstArchived, safeBrowsing, reviewLinks } from "./lib/providers.js";
import { historySignals, historyLines } from "./lib/history.js";
import { priceContext, priceSignals } from "./lib/price.js";
import { buildReport } from "./lib/score.js";
import { extractCompanyNumber, fetchCompany, companySignals } from "./lib/companies.js";
import { fetchSummary, submitReport, buyerSignals, buyerFeedback } from "./lib/buyers.js";

const TTL = 6 * 3600 * 1000;
const NET_CACHE_VERSION = 2; // v2 removes paid Trustpilot API data from cached scoring
const pageScans = new Map(); // tabId -> scan
const buyerCache = new Map(); // domain -> {at,sum}
const COLORS = { trusted: "#16a34a", caution: "#d97706", risky: "#dc2626", unverified: "#6b7280" };

async function settings() {
  const s = await chrome.storage.local.get({ sbKey: "", backend: "", chKey: "" });
  return s;
}

async function analyze(url, tabId, force = false) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const domain = registrableDomain(u.hostname);
  if (isSearchEngine(u.hostname)) return { neutral: true, url, domain, verdict: "neutral", signals: [], links: [], feedback: [], checkedAt: Date.now() };
  const cacheKey = "net:" + domain;
  const { sbKey, backend, chKey } = await settings();

  // Network results are per-domain and cached; local/page signals are recomputed.
  let net = (await chrome.storage.local.get(cacheKey))[cacheKey];
  if (force || !net || net.version !== NET_CACHE_VERSION || Date.now() - net.at > TTL) {
    const tasks = [domainAge(domain)];
    const archiveTask = firstArchived(domain);
    tasks.push(sbKey ? safeBrowsing(u.origin + "/", sbKey) : Promise.resolve(null));
    const [age, sb, arch] = await Promise.allSettled([...tasks, archiveTask]);
    net = {
      version: NET_CACHE_VERSION,
      at: Date.now(),
      signals: [
        ...(age.status === "fulfilled" ? age.value : [{ id: "age", label: "Domain age unavailable", status: "info", points: 0, detail: "Lookup failed: " + String(age.reason?.message || age.reason).slice(0, 160) }]),
        ...(sb.value ? sb.value.signals : [])
      ],
      registered: age.status === "fulfilled" ? age.value[0]?.since || null : null,
      archived: arch.status === "fulfilled" ? arch.value : null,
      flagged: !!sb.value?.flagged,
      errors: [sb].filter((r) => r.status === "rejected").map((r) => String(r.reason))
    };
    await chrome.storage.local.set({ [cacheKey]: net });
  }

  // Buyer reports (own server): short in-memory cache so new reports show up quickly.
  let buyer = null;
  if (backend) {
    const c = buyerCache.get(domain);
    if (c && Date.now() - c.at < 5 * 60 * 1000) buyer = c.sum;
    else { try { buyer = await fetchSummary(backend, domain); buyerCache.set(domain, { at: Date.now(), sum: buyer }); } catch { /* server down: skip */ } }
  }

  const scan = pageScans.get(tabId);

  // Companies House: verify the company number shown in the shop's footer (cached 24h per number).
  let companySigs = [];
  const number = scan ? extractCompanyNumber((scan.legal || []).join(" ")) : null;
  if (chKey && number) {
    const ck = "co:" + number;
    let rec = (await chrome.storage.local.get(ck))[ck];
    if (!rec || Date.now() - rec.at > 24 * 3600 * 1000) {
      try { rec = { at: Date.now(), profile: await fetchCompany(number, chKey) }; await chrome.storage.local.set({ [ck]: rec }); }
      catch { rec = null; }
    }
    if (rec) companySigs = companySignals({ number, profile: rec.profile, haystack: `${scan.title} ${domain} ${(scan.legal || []).join(" ")}` });
  } else if (chKey && scan?.isShop && !number) {
    companySigs = [{ id: "company", label: "No company registration number shown", status: "info", points: 0, detail: "UK traders normally show their company number in the site footer." }];
  }

  const pk = "price:" + domain;
  const pc = (await chrome.storage.session.get(pk))[pk];
  const priceSigs = pc && Date.now() - pc.at < 2 * 3600 * 1000 ? priceSignals(pc) : [];
  const signals = [...priceSigs, ...urlSignals(url), ...pageSignals(scan && { ...scan, https: u.protocol === "https:" }), ...net.signals, ...historySignals(net), ...buyerSignals(buyer), ...companySigs];
  if (!chKey) signals.push({ id: "co-off", label: "UK company check not connected", status: "info", points: 0, detail: "Add a free Companies House API key in Options to verify a shop's registered company." });
  if (!sbKey) signals.push({ id: "sb-off", label: "Malware/phishing database not connected", status: "info", points: 0, detail: "Add a free Google Safe Browsing key in Options for stronger protection." });
  const report = buildReport({ url, domain, signals, reviews: null, merchantRating: scan?.merchantRating || null, links: reviewLinks(domain), flagged: net.flagged,
    feedback: buyerFeedback(buyer), buyerTotal: buyer && !buyer.hidden ? buyer.total : 0 });
  const purchase = (await chrome.storage.local.get("purchase:" + domain))["purchase:" + domain];
  if (purchase && Date.now() - purchase.at < 180 * 86400000) report.purchase = purchase;
  report.backendOn = !!backend;
  report.registered = net.registered || null; report.archived = net.archived || null;
  report.history = historyLines(net);
  return report;
}

async function refresh(tabId, url, force) {
  const report = await analyze(url, tabId, force);
  if (!report) { chrome.action.setBadgeText({ tabId, text: "" }); return null; }
  if (report.neutral) {
    chrome.action.setBadgeText({ tabId, text: "" });
    await chrome.storage.session?.set({ ["report:" + tabId]: report });
    chrome.tabs.sendMessage(tabId, { type: "report", report }).catch(() => {});
    return report;
  }
  chrome.action.setBadgeText({ tabId, text: report.verdict === "unverified" ? "?" : String(report.score) });
  chrome.action.setBadgeBackgroundColor({ tabId, color: COLORS[report.verdict] });
  await chrome.storage.session?.set({ ["report:" + tabId]: report });
  chrome.tabs.sendMessage(tabId, { type: "report", report }).catch(() => {});
  return report;
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "loading") pageScans.delete(tabId);
  if ((info.status === "complete" || info.url) && tab.url) refresh(tabId, tab.url, false); // info.url: SPA navigation
});
chrome.tabs.onRemoved.addListener((id) => { pageScans.delete(id); chrome.storage.session?.remove("report:" + id); });

async function rememberPurchase(tabUrl, scan) {
  if (!scan.purchaseObserved) return;
  const domain = registrableDomain(new URL(tabUrl).hostname), key = "purchase:" + domain;
  const old = (await chrome.storage.local.get(key))[key];
  if (!old || Date.now() - old.at > 86400000)
    await chrome.storage.local.set({ [key]: { id: crypto.randomUUID(), at: Date.now(), reported: false } });
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === "scan" && sender.tab) {
    pageScans.set(sender.tab.id, msg.scan);
    (async () => {
      try { await rememberPurchase(sender.tab.url, msg.scan); } catch { /* invalid tab URL or storage unavailable */ }
      await refresh(sender.tab.id, sender.tab.url, false);
    })();
  } else if (msg.type === "lookup") {
    // Hover lookup from a search page: quick check of one result's domain (no page scan available).
    (async () => {
      // Remember how this listing's price compares with the results page, so the shop page can show it too (2h).
      const ctx = msg.priceInfo ? priceContext(msg.priceInfo) : null;
      if (ctx) {
        try { const d = registrableDomain(new URL(msg.url).hostname); await chrome.storage.session.set({ ["price:" + d]: { ...ctx, at: Date.now() } }); } catch { /* bad url */ }
      }
      const r = await analyze(msg.url, -1, false);
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
        const key = "purchase:" + msg.domain, purchase = (await chrome.storage.local.get(key))[key];
        const purchaseId = purchase && !purchase.reported && purchase.id === msg.purchaseId ? purchase.id : null;
        await submitReport(backend, id, msg.domain, msg.outcome, msg.tags || [], purchaseId);
        if (purchaseId) await chrome.storage.local.set({ [key]: { ...purchase, reported: true } });
        buyerCache.delete(msg.domain);
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.url) refresh(tab.id, tab.url, false);
        reply({ ok: true });
      } catch (e) { reply({ ok: false, error: String(e.message || e) }); }
    })();
    return true;
  } else if (msg.type === "get" || msg.type === "recheck") {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      reply(tab?.url ? await refresh(tab.id, tab.url, msg.type === "recheck") : null);
    })();
    return true;
  }
});
