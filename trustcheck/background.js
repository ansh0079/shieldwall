import { registrableDomain } from "./lib/domain.js";
import { sameDocument } from "./lib/url.js";
import { analyze } from "./lib/analyze.js";
import { EvidenceCache, chromeStore } from "./lib/cache.js";
import { TabGuard } from "./lib/tabguard.js";
import { ProviderError } from "./lib/http.js";
import { domainAge, firstArchived, safeBrowsing, trustpilot } from "./lib/providers.js";
import { fetchCompany } from "./lib/companies.js";
import { fetchSummary, fetchCheck, submitReport, enroll, eraseMyReports } from "./lib/buyers.js";
import { priceContext } from "./lib/price.js";
import { DEFAULT_SETTINGS, DEFAULT_BACKEND } from "./lib/settings.js";
import { createReminder, handleReminderAnswer } from "./lib/reminders.js";
import { isRetailPage } from "./lib/retail.js";

const providers = { domainAge, firstArchived, safeBrowsing, trustpilot, fetchCompany, fetchSummary, fetchCheck };
const cache = new EvidenceCache(chromeStore(chrome.storage.local, ["ev:", "fail:", "net:", "co:"]));
const guard = new TabGuard();
const pageScans = new Map();                       // tabId -> { url, scan }  (a scan only applies to the URL it came from)
const COLORS = { lower: "#16a34a", caution: "#d97706", risky: "#dc2626", dangerous: "#7f1d1d", limited: "#6b7280" };
const quiet = (p) => Promise.resolve(p).catch(() => {});   // closed tabs reject action/tab calls

cache.prune().catch(() => {});                     // drop expired + legacy cache entries on service-worker start

async function settings() {
  const s = await chrome.storage.local.get(DEFAULT_SETTINGS);
  if (!s.backend) s.backend = DEFAULT_BACKEND;
  return s;
}
const HIDE_MS = 30 * 24 * 3600 * 1000;
async function badgeUi(domain) {
  const s = await settings();
  let hidden = false;
  if (domain) {
    const k = "hide:" + domain, at = (await chrome.storage.local.get(k))[k];
    if (at && Date.now() - at < HIDE_MS) hidden = true;
    else if (at) await chrome.storage.local.remove(k);            // expired
  }
  return { mode: s.badgeMode || "auto", hidden };
}
async function priceFor(domain) {
  const pk = "price:" + domain, pc = (await chrome.storage.session.get(pk))[pk];
  return pc && Date.now() - pc.at < 2 * 3600 * 1000 ? pc : null;
}

async function publish(tabId, report) {
  if (!report || report.neutral) quiet(chrome.action.setBadgeText({ tabId, text: "" }));
  else {
    quiet(chrome.action.setBadgeText({ tabId, text: report.verdict === "limited" ? "?" : report.verdict === "dangerous" ? "!" : String(report.score) }));
    quiet(chrome.action.setBadgeBackgroundColor({ tabId, color: COLORS[report.verdict] }));
  }
  if (report) {
    await chrome.storage.session?.set({ ["report:" + tabId]: report });
    quiet(chrome.tabs.sendMessage(tabId, { type: "report", report }));
  }
}

async function attachPurchase(report) {
  if (!report?.domain) return report;
  const key = "purchase:" + report.domain, purchase = (await chrome.storage.local.get(key))[key];
  if (purchase && Date.now() - purchase.at < 180 * 86400000) report.purchase = purchase;
  return report;
}

async function maybeRiskAlert(report) {
  if (!report?.domain || report.neutral) return;
  const baselineKey = "risk-baseline:" + report.domain;
  const baseline = (await chrome.storage.local.get(baselineKey))[baselineKey];
  const severe = report.verdict === "risky" || report.verdict === "dangerous";
  const wasOk = baseline?.verdict && baseline.verdict !== "risky" && baseline.verdict !== "dangerous";
  if (wasOk && severe && Date.now() - (baseline.alertedAt || 0) > 24 * 3600 * 1000 && chrome.notifications) {
    try {
      await chrome.notifications.create("risk-change:" + report.domain, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title: "BeforeYouBuy: seller risk changed",
        message: `${report.domain} now has high risk indicators. Check the evidence before buying.`
      });
      baseline.alertedAt = Date.now();
    } catch { /* notifications may be disabled */ }
  }
  await chrome.storage.local.set({ [baselineKey]: { verdict: report.verdict, alertedAt: baseline?.alertedAt || 0, checkedAt: Date.now() } });
}

// Analyse a tab's page. A result is published only if the tab has not navigated (or closed) in the meantime.
async function refresh(tabId, url, force) {
  const token = guard.begin(tabId, url);
  let report;
  try {
    const s = pageScans.get(tabId), scan = s && sameDocument(s.url, url) ? s.scan : null;
    // Store behaviour: a page must show buying activity before it gets a shop score.
    if (scan && !isRetailPage(scan)) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab || !guard.isCurrent(token, tab.url)) return null;
      const neutral = { neutral: true, url, domain: registrableDomain(new URL(url).hostname), verdict: "neutral", signals: [], links: [], feedback: [], checkedAt: Date.now() };
      await publish(tabId, neutral);
      return neutral;
    }
    const domain = registrableDomain(new URL(url).hostname);
    report = await analyze(url, { cache, providers, settings: await settings() },
      { scan, price: domain ? await priceFor(domain) : null, force, signal: token.signal });
  } catch (e) {
    if (!(e instanceof ProviderError && e.kind === "aborted")) console.warn("BeforeYouBuy: analysis failed:", e?.message);
    return null;
  }
  if (report && !report.neutral) {
    report.ui = await badgeUi(report.domain);   // on-page badge preferences
    await attachPurchase(report);
    await maybeRiskAlert(report);
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

async function rememberPurchase(tabUrl, scan) {
  if (!scan?.purchaseObserved) return;
  let domain;
  try { domain = registrableDomain(new URL(tabUrl).hostname); } catch { return; }
  const key = "purchase:" + domain;
  const old = (await chrome.storage.local.get(key))[key];
  if (old && Date.now() - old.at <= 86400000) return;
  const purchaseObj = {
    id: crypto.randomUUID(),
    at: Date.now(),
    reported: false,
    amount: scan.orderAmount || null,
    storefrontName: scan.storefrontName || null
  };
  await chrome.storage.local.set({ [key]: purchaseObj });
  try {
    const { orderReminders = true, reminders = [] } = await chrome.storage.local.get({ orderReminders: true, reminders: [] });
    if (!orderReminders) return;
    if (!reminders.some((r) => r.domain === domain && Math.abs(r.createdAt - Date.now()) < 7 * 86400000)) {
      const rem = await createReminder({
        domain,
        amount: scan.orderAmount,
        orderId: scan.orderId,
        storefrontName: scan.storefrontName
      });
      reminders.push(rem);
      await chrome.storage.local.set({ reminders });
    }
  } catch { /* storage unavailable */ }
}

try {
  chrome.alarms?.create("check_order_reminders", { periodInMinutes: 60 });
} catch { /* alarms unsupported */ }

export async function checkDueReminders() {
  try {
    const { orderReminders = true, reminders = [] } = await chrome.storage.local.get({ orderReminders: true, reminders: [] });
    if (!orderReminders || !reminders.length) return;
    const now = Date.now();
    for (let i = 0; i < reminders.length; i++) {
      const rem = reminders[i];
      if (rem.status === "pending" && !rem.shownAt && now >= rem.remindAt) {
        if (chrome.notifications) {
          await chrome.notifications.create(rem.id, {
            type: "basic",
            iconUrl: chrome.runtime.getURL("icons/icon128.png"),
            title: "BeforeYouBuy: Order update",
            message: `Did your order from ${rem.domain}${rem.amount ? ` (${rem.amount})` : ""} arrive?`,
            buttons: [
              { title: "Answer" },
              { title: "Not yet" }
            ],
            requireInteraction: true
          });
          reminders[i] = { ...rem, shownAt: now };
          await chrome.storage.local.set({ reminders });
        }
        break;
      }
    }
  } catch { /* ignore */ }
}

if (chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "check_order_reminders") checkDueReminders();
  });
}
checkDueReminders();

async function saveReminderAnswer(reminders, remIndex, answer, backend = "") {
  const { updatedReminder, report } = handleReminderAnswer(reminders[remIndex], answer);
  reminders[remIndex] = updatedReminder;
  await chrome.storage.local.set({ reminders });
  if (backend && report) {
    const { reportToken } = await chrome.storage.local.get({ reportToken: "" });
    let token = reportToken;
    const ensure = async () => { token = await enroll(backend); await chrome.storage.local.set({ reportToken: token }); };
    if (!token) await ensure();
    try { await submitReport(backend, token, report.domain, report.outcome, report.tags || []); }
    catch (e) { if (e.status !== 401) throw e; await ensure(); await submitReport(backend, token, report.domain, report.outcome, report.tags || []); }
    await cache.store.remove(["ev:buy:" + report.domain, "ev:chk:" + report.domain]);
  }
  return updatedReminder;
}

if (chrome.notifications?.onButtonClicked) {
  chrome.notifications.onButtonClicked.addListener(async (notifId, buttonIndex) => {
    try {
      const { reminders = [] } = await chrome.storage.local.get({ reminders: [] });
      const remIndex = reminders.findIndex((r) => r.id === notifId);
      if (remIndex === -1) return;
      chrome.notifications.clear(notifId);
      if (buttonIndex === 0) await chrome.tabs.create({ url: chrome.runtime.getURL(`reminder.html?id=${encodeURIComponent(notifId)}`) });
      else {
        const s = await settings();
        await saveReminderAnswer(reminders, remIndex, "not_yet", s.backend);
      }
    } catch { /* ignore */ }
  });
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === "testReminder") {
    try {
      if (chrome.notifications) {
        chrome.notifications.create("test:reminder:" + Date.now(), {
          type: "basic",
          iconUrl: chrome.runtime.getURL("icons/icon128.png"),
          title: "BeforeYouBuy: Order update (Test)",
          message: "Did your order from koadclo.com (£59.99) arrive?",
          buttons: [
            { title: "Answer" },
            { title: "Not yet" }
          ],
          requireInteraction: true
        }, (notificationId) => {
          const err = chrome.runtime.lastError;
          reply(err ? { ok: false, error: err.message } : { ok: !!notificationId });
        });
      } else {
        reply({ ok: false, error: "Notifications API not available" });
      }
    } catch (e) {
      reply({ ok: false, error: e.message });
    }
    return true;
  }
  if (msg.type === "scan" && sender.tab) {
    pageScans.set(sender.tab.id, { url: sender.tab.url, scan: msg.scan });
    (async () => {
      try { await rememberPurchase(sender.tab.url, msg.scan); } catch { /* invalid tab URL or storage unavailable */ }
      await refresh(sender.tab.id, sender.tab.url, false);
    })().catch(() => {});
  } else if (msg.type === "answerReminder") {
    (async () => {
      try {
        const stored = await chrome.storage.local.get({ reminders: [] });
        const s = await settings();
        const remIndex = stored.reminders.findIndex((r) => r.id === msg.id);
        if (remIndex === -1) return reply({ ok: false, error: "Reminder not found" });
        await saveReminderAnswer(stored.reminders, remIndex, msg.answer, s.backend);
        reply({ ok: true });
      } catch (e) { reply({ ok: false, error: String(e.message || e) }); }
    })();
    return true;
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
  } else if (msg.type === "hideBadge" && sender.tab && typeof msg.domain === "string" && msg.domain.length < 260) {
    chrome.storage.local.set({ ["hide:" + msg.domain]: Date.now() });   // user asked: no on-page badge on this site for 30 days
  } else if (msg.type === "submitReport") {
    (async () => {
      try {
        const s = await settings();
        const backend = s.backend;
        if (!backend) return reply({ ok: false, error: "No report server set in Options" });
        const { reportToken } = await chrome.storage.local.get({ reportToken: "" });
        let token = reportToken;
        const ensure = async () => { token = await enroll(backend); await chrome.storage.local.set({ reportToken: token }); };
        if (!token) await ensure();                                   // first report: get a server-issued identity
        try { await submitReport(backend, token, msg.domain, msg.outcome, msg.tags || []); }
        catch (e) { if (e.status !== 401) throw e; await ensure(); await submitReport(backend, token, msg.domain, msg.outcome, msg.tags || []); }   // credential revoked or lost: re-enrol once
        await cache.store.remove(["ev:buy:" + msg.domain, "ev:chk:" + msg.domain]);
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.url) refresh(tab.id, tab.url, false).catch(() => {});
        reply({ ok: true });
      } catch (e) { reply({ ok: false, error: String(e.message || e) }); }
    })();
    return true;
  } else if (msg.type === "eraseReports") {
    (async () => {                                                   // right to erasure: remove my identity and everything it reported
      try {
        const s = await settings();
        const { reportToken } = await chrome.storage.local.get({ reportToken: "" });
        if (s.backend && reportToken) await eraseMyReports(s.backend, reportToken);
        await chrome.storage.local.remove(["reportToken", "installId"]);
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
