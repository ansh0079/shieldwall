// QuietBrowse - cosmetic filtering + cookie pop-up hiding + user-zapped elements
// Generics come from storage (seeded by SW), not from injecting cosmetic_filters.js.

(function () {
  const STYLE_BASE = "__qb_styles_base";
  const STYLE_ZAPPED = "__qb_styles_zapped";
  const STYLE_COOKIE = "__qb_styles_cookie";
  const STYLE_COSMETIC_SITE = "__qb_styles_cosmetic_site";
  const STYLE_COSMETIC_GENERIC = "__qb_styles_cosmetic_generic";
  const STYLE_HAS = "__qb_styles_has";

  const AD_SELECTORS = [
    ".adsbygoogle",
    "ins.adsbygoogle",
    "[id^='div-gpt-ad']",
    "[id^='google_ads_iframe']",
    "[id^='taboola-']",
    ".trc_related_container",
    ".OUTBRAIN",
    "[data-widget-id^='ob-']",
    "iframe[src*='doubleclick.net']",
    "iframe[src*='googlesyndication.com']",
    "iframe[src*='amazon-adsystem.com']",
    "[aria-label='advertisement' i]",
    ".ad-banner",
    ".ad-slot",
    ".advertisement-slot"
  ];

  // Native :has() (Chrome 105+) — collapse leftover empty ad shells.
  const HAS_EMPTY_AD_CSS = `
    div:has(> iframe[src*="doubleclick.net"]),
    div:has(> iframe[src*="googlesyndication.com"]),
    div:has(> iframe[id^="google_ads_iframe"]),
    div:has(> ins.adsbygoogle),
    aside:has(> .adsbygoogle),
    [class*="ad-slot" i]:has(iframe),
    [class*="ad-container" i]:has(iframe),
    [id*="ad-container" i]:has(iframe),
    [data-ad]:has(iframe),
    [data-ad-slot]:empty,
    .ad-unit:has(iframe[src*="doubleclick"]),
    .advertisement:has(iframe),
    div[id^="div-gpt-ad"]:has(iframe),
    div[id^="google_ads_iframe"]:empty {
      display: none !important;
    }
  `;

  const COOKIE_BANNER_SELECTORS = [
    "#onetrust-consent-sdk",
    "#onetrust-banner-sdk",
    ".qc-cmp2-container",
    "#qc-cmp2-container",
    "#CybotCookiebotDialog",
    "#CybotCookiebotDialogBodyUnderlay",
    "#didomi-host",
    ".fc-consent-root",
    "[id^='sp_message_container']",
    ".osano-cm-window",
    ".cc-window",
    ".cc-banner",
    "#cookie-banner",
    ".cookie-banner",
    "#cookie-notice",
    ".cookie-notice",
    "#cookieConsent",
    ".cookie-consent",
    "#gdpr-banner",
    ".gdpr-banner",
    "#hs-eu-cookie-confirmation",
    ".cmplz-cookiebanner",
    "#cmpbox",
    "#cmpbox2",
    ".truste_box_overlay",
    ".truste_overlay"
  ];

  const SCROLL_UNLOCK_CSS = `
    html.sp-message-open, body.sp-message-open,
    html.didomi-popup-open, body.didomi-popup-open,
    body.cmplz-blocked-content-notice-open,
    html.ot-overflow-hidden, body.ot-overflow-hidden {
      overflow: auto !important;
      position: static !important;
    }
  `;

  let genericIdleHandle = null;
  let cookieHideTimer = null;

  function cancelCookieHide() {
    if (cookieHideTimer != null) {
      clearTimeout(cookieHideTimer);
      cookieHideTimer = null;
    }
    document.removeEventListener("qb-cookie-reject-done", onCookieRejectDone);
  }

  function injectCookieHide() {
    whenHeadReady(() => {
      removeStyle(STYLE_COOKIE);
      const style = document.createElement("style");
      style.id = STYLE_COOKIE;
      style.textContent =
        COOKIE_BANNER_SELECTORS.join(",\n") +
        " { display: none !important; }" +
        SCROLL_UNLOCK_CSS;
      document.head.appendChild(style);
    });
  }

  function onCookieRejectDone() {
    cancelCookieHide();
    injectCookieHide();
  }

  function scheduleCookieHide() {
    cancelCookieHide();
    document.addEventListener("qb-cookie-reject-done", onCookieRejectDone, { once: true });
    cookieHideTimer = setTimeout(() => {
      cookieHideTimer = null;
      document.removeEventListener("qb-cookie-reject-done", onCookieRejectDone);
      injectCookieHide();
    }, 5500);
  }

  function buildStorageKeys() {
    const keys = {
      enabled: true,
      siteModes: {},
      hideCookiePopups: true,
      zappedElements: {},
      genericSelectors: null,
      proceduralRules: null
    };
    const labels = location.hostname.toLowerCase().replace(/^www\./, "").split(".");
    for (let i = 0; i <= labels.length - 2; i++) {
      const d = labels.slice(i).join(".");
      keys["cs_" + d] = null;
      keys["cx_" + d] = null;
    }
    return keys;
  }

  function removeStyle(id) {
    document.getElementById(id)?.remove();
  }

  function cancelDeferredGenerics() {
    if (genericIdleHandle != null) {
      if (typeof cancelIdleCallback === "function") {
        cancelIdleCallback(genericIdleHandle);
      } else {
        clearTimeout(genericIdleHandle);
      }
      genericIdleHandle = null;
    }
  }

  function whenHeadReady(fn) {
    if (document.head) return fn();
    new MutationObserver((_, observer) => {
      if (document.head) {
        observer.disconnect();
        fn();
      }
    }).observe(document.documentElement, { childList: true });
  }

  function insertChunk(sheet, selectors) {
    if (selectors.length === 0) return;
    try {
      sheet.insertRule(
        selectors.join(",") + " { display: none !important; }",
        sheet.cssRules.length
      );
    } catch {
      if (selectors.length === 1) return;
      const mid = selectors.length >> 1;
      insertChunk(sheet, selectors.slice(0, mid));
      insertChunk(sheet, selectors.slice(mid));
    }
  }

  function injectSelectorSheet(id, selectors) {
    if (!selectors.length || !document.head) return;
    removeStyle(id);
    const style = document.createElement("style");
    style.id = id;
    document.head.appendChild(style);
    const sheet = style.sheet;
    const CHUNK = 200;
    for (let i = 0; i < selectors.length; i += CHUNK) {
      insertChunk(sheet, selectors.slice(i, i + CHUNK));
    }
  }

  function collectSiteSelectors(data) {
    const unhide = new Set();
    const siteSelectors = [];
    for (const key of Object.keys(data)) {
      if (!Array.isArray(data[key])) continue;
      if (key.startsWith("cx_")) data[key].forEach((s) => unhide.add(s));
      else if (key.startsWith("cs_")) siteSelectors.push(...data[key]);
    }
    return {
      site: [...new Set(siteSelectors)].filter((s) => !unhide.has(s)),
      unhide,
      generic: Array.isArray(data.genericSelectors) ? data.genericSelectors : []
    };
  }

  function deferGenericCosmetics(generic, unhide) {
    cancelDeferredGenerics();
    const filtered = [...new Set(generic)].filter((s) => !unhide.has(s));
    if (filtered.length === 0) return;

    const run = () => {
      genericIdleHandle = null;
      whenHeadReady(() => injectSelectorSheet(STYLE_COSMETIC_GENERIC, filtered));
    };

    if (typeof requestIdleCallback === "function") {
      genericIdleHandle = requestIdleCallback(run, { timeout: 1200 });
    } else {
      genericIdleHandle = setTimeout(run, 0);
    }
  }

  let proceduralObserver = null;

  function applyProceduralRules(rules) {
    if (proceduralObserver) {
      proceduralObserver.disconnect();
      proceduralObserver = null;
    }
    if (!rules || !rules.length) return;

    const host = location.hostname.toLowerCase().replace(/^www\./, "");
    const applicable = rules.filter((r) =>
      !r.domains || r.domains.length === 0 ||
      r.domains.some((d) => host === d || host.endsWith("." + d))
    );
    if (!applicable.length) return;

    function runOnce() {
      for (const rule of applicable) {
        try {
          const elements = document.querySelectorAll(rule.base);
          for (const el of elements) {
            if (rule.type === "remove") {
              el.remove();
            } else if (rule.type === "upward") {
              let target = el;
              for (let i = 0; i < rule.arg; i++) {
                if (!target.parentElement) break;
                target = target.parentElement;
              }
              if (target !== el) target.style.setProperty("display", "none", "important");
            } else if (rule.type === "has-text") {
              const text = el.textContent || "";
              let matches = false;
              if (rule.isRegex) {
                try { matches = new RegExp(rule.arg, rule.flags || "i").test(text); } catch { /* bad regex */ }
              } else {
                matches = text.includes(rule.arg);
              }
              if (matches) el.style.setProperty("display", "none", "important");
            }
          }
        } catch { /* bad selector — skip */ }
      }
    }

    let debounceTimer = null;
    function debounced() {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(runOnce, 120);
    }

    runOnce();
    proceduralObserver = new MutationObserver(debounced);
    const root = document.documentElement || document.body;
    if (root) {
      proceduralObserver.observe(root, { childList: true, subtree: true });
    }

    // Hard upper bound for SPAs: disconnect after a fixed cap to avoid long-lived observers.
    const OBSERVER_CAP_MS = 7000;
    setTimeout(() => {
      if (proceduralObserver) {
        try { proceduralObserver.disconnect(); } catch {}
        proceduralObserver = null;
      }
    }, OBSERVER_CAP_MS);

    // Final pass + disconnect after page settles
    window.addEventListener("load", () => {
      setTimeout(() => {
        if (proceduralObserver) { proceduralObserver.disconnect(); proceduralObserver = null; }
        runOnce();
      }, 3000);
    }, { once: true });
  }

  function applyFilters(data) {
    cancelDeferredGenerics();
    cancelCookieHide();
    removeStyle(STYLE_BASE);
    removeStyle(STYLE_ZAPPED);
    removeStyle(STYLE_COOKIE);
    removeStyle(STYLE_COSMETIC_SITE);
    removeStyle(STYLE_COSMETIC_GENERIC);
    removeStyle(STYLE_HAS);
    // Legacy id from older builds
    removeStyle("__qb_styles_cosmetic");

    if (!data.enabled) return;

    const mode = resolveSiteMode(location.hostname, data.siteModes);
    if (mode === SITE_MODE.OFF) return;

    const host = siteKey(location.hostname);
    const parts = [];
    if (mode === SITE_MODE.FULL) {
      parts.push(AD_SELECTORS.join(",\n") + " { display: none !important; }");
      parts.push(HAS_EMPTY_AD_CSS);
    }

    const zappedSelectors = (data.zappedElements[host] || []).map((z) => z.selector);

    whenHeadReady(() => {
      if (parts.length) {
        const style = document.createElement("style");
        style.id = STYLE_BASE;
        style.textContent = parts.join("\n");
        document.head.appendChild(style);
      }

      // Zapped selectors via insertChunk so one bad selector can't discard the rest.
      if (zappedSelectors.length) {
        injectSelectorSheet(STYLE_ZAPPED, zappedSelectors);
      }

      // Site-specific cosmetics immediately; EasyList generics after idle.
      if (mode === SITE_MODE.FULL) {
        const { site, unhide, generic } = collectSiteSelectors(data);
        injectSelectorSheet(STYLE_COSMETIC_SITE, site);
        deferGenericCosmetics(generic, unhide);
      }
    });

    if (data.hideCookiePopups) {
      scheduleCookieHide();
    }

    // Procedural cosmetic rules (has-text / upward / remove) run after DOM is ready.
    if (mode === SITE_MODE.FULL && Array.isArray(data.proceduralRules) && data.proceduralRules.length) {
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => applyProceduralRules(data.proceduralRules), { once: true });
      } else {
        applyProceduralRules(data.proceduralRules);
      }
    }
  }

  function reloadFromStorage() {
    chrome.storage.local.get(buildStorageKeys(), applyFilters);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settingsRevision) reloadFromStorage();
  });

  function computeTrustScore(callback) {
    const signals = PhishScore.collectSignals();
    chrome.runtime.sendMessage(
      {
        type: "analyzePhish",
        hostname: location.hostname,
        protocol: location.protocol,
        hasPasswordField: signals.passwordFieldCount > 0,
        signals
      },
      (analyzed) => {
        const base =
          analyzed?.ok
            ? {
                riskScore: analyzed.riskScore,
                reasons: analyzed.reasons || [],
                level: analyzed.level,
                trustScore: analyzed.trustScore
              }
            : PhishScore.analyze(
                location.hostname,
                location.protocol,
                signals.passwordFieldCount > 0,
                signals
              );

        chrome.storage.local.get({ enabled: true, siteModes: {} }, (settings) => {
          const mode = resolveSiteMode(location.hostname, settings.siteModes);
          chrome.runtime.sendMessage(
            { type: "getTabInfo", tabId: null, forTrust: true },
            (tabInfo) => {
              if (chrome.runtime.lastError) {
                callback(
                  PhishScore.enrich(base, {
                    enabled: settings.enabled,
                    siteMode: mode,
                    blockedCount: 0,
                    trackerCount: 0
                  })
                );
                return;
              }
              const count = tabInfo?.count || 0;
              const trackers = tabInfo?.trackers?.length || 0;
              callback(
                PhishScore.enrich(base, {
                  enabled: settings.enabled,
                  siteMode: mode,
                  blockedCount: count,
                  trackerCount: trackers
                })
              );
            }
          );
        });
      }
    );
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "getTrustScore") {
      computeTrustScore((result) => sendResponse(result));
      return true;
    } else if (msg.type === "settingsChanged") {
      reloadFromStorage();
      sendResponse({ ok: true });
    }
    return false;
  });

  reloadFromStorage();
})();
