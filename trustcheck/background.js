import { registrableDomain } from "./lib/domain.js";
import { urlSignals, pageSignals } from "./lib/heuristics.js";
import { domainAge, safeBrowsing, trustpilot, reviewLinks } from "./lib/providers.js";
import { buildReport } from "./lib/score.js";

const TTL = 6 * 3600 * 1000;
const pageScans = new Map(); // tabId -> scan
const COLORS = { trusted: "#16a34a", caution: "#d97706", risky: "#dc2626" };

async function settings() {
  const s = await chrome.storage.local.get({ sbKey: "", tpKey: "" });
  return s;
}

async function analyze(url, tabId, force = false) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const domain = registrableDomain(u.hostname);
  const cacheKey = "net:" + domain;
  const { sbKey, tpKey } = await settings();

  // Network results are per-domain and cached; local/page signals are recomputed.
  let net = (await chrome.storage.local.get(cacheKey))[cacheKey];
  if (force || !net || Date.now() - net.at > TTL) {
    const tasks = [domainAge(domain)];
    tasks.push(sbKey ? safeBrowsing(u.origin + "/", sbKey) : Promise.resolve(null));
    tasks.push(tpKey ? trustpilot(domain, tpKey) : Promise.resolve(null));
    const [age, sb, tp] = await Promise.allSettled(tasks);
    net = {
      at: Date.now(),
      signals: [
        ...(age.status === "fulfilled" ? age.value : [{ id: "age", label: "Domain age unavailable", status: "info", points: 0, detail: "RDAP lookup failed or not supported for this TLD." }]),
        ...(sb.value ? sb.value.signals : []),
        ...(tp.value ? tp.value.signals : [])
      ],
      flagged: !!sb.value?.flagged,
      reviews: tp.value?.reviews || null,
      errors: [sb, tp].filter((r) => r.status === "rejected").map((r) => String(r.reason))
    };
    await chrome.storage.local.set({ [cacheKey]: net });
  }

  const scan = pageScans.get(tabId);
  const signals = [...urlSignals(url), ...pageSignals(scan && { ...scan, https: u.protocol === "https:" }), ...net.signals];
  if (!sbKey) signals.push({ id: "sb-off", label: "Malware/phishing database not connected", status: "info", points: 0, detail: "Add a free Google Safe Browsing key in Options for stronger protection." });
  if (!tpKey) signals.push({ id: "tp-off", label: "Review-site scores not connected", status: "info", points: 0, detail: "Add a Trustpilot API key in Options, or use the review links below." });
  return buildReport({ url, domain, signals, reviews: net.reviews, links: reviewLinks(domain), flagged: net.flagged });
}

async function refresh(tabId, url, force) {
  const report = await analyze(url, tabId, force);
  if (!report) { chrome.action.setBadgeText({ tabId, text: "" }); return null; }
  chrome.action.setBadgeText({ tabId, text: String(report.score) });
  chrome.action.setBadgeBackgroundColor({ tabId, color: COLORS[report.verdict] });
  await chrome.storage.session?.set({ ["report:" + tabId]: report });
  chrome.tabs.sendMessage(tabId, { type: "report", report }).catch(() => {});
  return report;
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "loading") pageScans.delete(tabId);
  if (info.status === "complete" && tab.url) refresh(tabId, tab.url, false);
});
chrome.tabs.onRemoved.addListener((id) => { pageScans.delete(id); chrome.storage.session?.remove("report:" + id); });

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === "scan" && sender.tab) {
    pageScans.set(sender.tab.id, msg.scan);
    refresh(sender.tab.id, sender.tab.url, false);
  } else if (msg.type === "get" || msg.type === "recheck") {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      reply(tab?.url ? await refresh(tab.id, tab.url, msg.type === "recheck") : null);
    })();
    return true;
  }
});
