// QuietBrowse - click Reject/Decline on common CMP banners (then hide as fallback)

(function () {
  // Vendor-specific selectors — unambiguous CMP UI, safe to click directly.
  const VENDOR_SELECTORS = [
    "#onetrust-reject-all-handler",
    "button#onetrust-reject-all-handler",
    ".ot-pc-refuse-all-handler",
    "#reject-all-cookies",
    "#CybotCookiebotDialogBodyButtonDecline",
    ".fc-cta-do-not-consent",
    ".fc-reject-all",
    "#didomi-notice-disagree-button",
    ".cc-deny",
    "#cmpbox .cmptxt_btn_no",
    ".js-reject-cookies"
  ];

  // Generic selectors — words like "reject"/"decline" also appear in
  // calendars, calls, and invites. Only click these inside a CMP container.
  const GENERIC_SELECTORS = [
    "button[aria-label*='Reject' i]",
    "button[aria-label*='Decline' i]",
    "button[aria-label*='Refuse' i]",
    "button[title*='Reject' i]",
    "button[title*='Decline' i]",
    "button[class*='reject' i]",
    "button[class*='decline' i]",
    "button[id*='reject' i]",
    "button[id*='decline' i]",
    "a[id*='reject' i]",
    "[data-testid*='reject' i]",
    "[data-action*='reject' i]",
    "button.reject-all",
    "button.decline-all"
  ];

  const TEXT_RE =
    /^(reject all|reject|decline all|decline|refuse all|refuse|deny|necessary only|only necessary|essentials only|continue without|no thanks)$/i;

  const CMP_CONTAINER = "#onetrust-banner-sdk, #CybotCookiebotDialog, #didomi-host, " +
    ".fc-consent-root, #cmpbox, .cc-window, .cmplz-cookiebanner, " +
    "#cookie-banner, .cookie-banner, #cookie-notice, .cookie-notice, " +
    "#cookie-consent, .cookie-consent, #gdpr-banner, .gdpr-banner";

  let attempted = false;
  let doneSignaled = false;
  let outcome = null;
  let observer;
  let scanTimer;

  function signalDone(status) {
    if (doneSignaled) return;
    doneSignaled = true;
    outcome = status;
    observer?.disconnect();
    clearTimeout(scanTimer);
    document.dispatchEvent(
      new Event("qb-cookie-reject-done")
    );
  }

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.type === "getCookieOutcome") respond({ outcome });
  });

  function visible(el) {
    if (!el || !(el instanceof Element)) return false;
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function clickEl(el) {
    if (el.matches(":disabled, [aria-disabled='true']")) return false;
    const banner = el.parentElement?.closest(CMP_CONTAINER);
    try {
      el.click();
    } catch {
      return false;
    }
    attempted = true;
    setTimeout(() => {
      // A disappearing banner does not establish which consent was stored.
      const dismissed = banner && (!banner.isConnected || !visible(banner));
      signalDone(dismissed ? "dismissed-after-attempt" : "attempted");
    }, 400);
    return true;
  }

  function tryMatches(selectors, requireContext) {
    for (const sel of selectors) {
      let nodes;
      try {
        nodes = document.querySelectorAll(sel);
      } catch {
        continue;
      }
      for (const el of nodes) {
        if (!visible(el)) continue;
        if (requireContext && (!el.parentElement?.closest(CMP_CONTAINER) ||
          !TEXT_RE.test((el.getAttribute("aria-label") || el.textContent || "").trim()))) continue;
        if (clickEl(el)) return true;
      }
    }
    return false;
  }

  function tryReject() {
    if (attempted || doneSignaled) return false;
    if (tryMatches(VENDOR_SELECTORS, false)) return true;
    if (tryMatches(GENERIC_SELECTORS, true)) return true;

    for (const banner of document.querySelectorAll(CMP_CONTAINER)) {
      for (const el of banner.querySelectorAll("button, a, [role='button']")) {
        if (!visible(el)) continue;
        const label = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
        if (!TEXT_RE.test(label)) continue;
        if (clickEl(el)) return true;
      }
    }
    return false;
  }

  function schedule() {
    tryReject();
    setTimeout(tryReject, 800);
    setTimeout(tryReject, 2000);
    setTimeout(() => {
      tryReject();
      if (!attempted) {
        const bannerVisible = [...document.querySelectorAll(CMP_CONTAINER)].some(visible);
        signalDone(bannerVisible ? "hide-fallback" : null);
      }
    }, 4500);
  }

  chrome.storage.local.get({ enabled: true, hideCookiePopups: true, siteModes: {}, siteContentExceptions: {} }, (data) => {
    if (!data.enabled || !data.hideCookiePopups) return;
    if (getSiteContentException(location.hostname, data.siteContentExceptions)?.stage === "page") return;
    if (typeof resolveSiteMode === "function" && typeof SITE_MODE !== "undefined") {
      const mode = resolveSiteMode(location.hostname, data.siteModes);
      if (mode === SITE_MODE.OFF) return;
    }
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", schedule, { once: true });
    } else {
      schedule();
    }
    observer = new MutationObserver(() => {
      if (attempted || scanTimer != null) return;
      scanTimer = setTimeout(() => {
        scanTimer = null;
        tryReject();
      }, 100);
    });
    if (!doneSignaled) observer.observe(document, { childList: true, subtree: true });
  });
})();
