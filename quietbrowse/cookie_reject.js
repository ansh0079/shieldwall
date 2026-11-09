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

  const CMP_CONTEXT_RE =
    /cookie|consent|cmp|gdpr|privacy|onetrust|didomi|sourcepoint|osano|truste|cookiebot|qc-cmp|cmplz|complianz|borlabs|usercentrics|iubenda|quantcast/i;

  let attempted = false;
  let doneSignaled = false;

  function signalDone(rejected) {
    if (doneSignaled) return;
    doneSignaled = true;
    document.dispatchEvent(
      new CustomEvent("qb-cookie-reject-done", { detail: { rejected: !!rejected } })
    );
  }

  function visible(el) {
    if (!el || !(el instanceof Element)) return false;
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // True when the element sits inside something that looks like a consent
  // dialog (id/class of an ancestor mentions cookies/consent/a CMP vendor).
  function inCmpContext(el) {
    let node = el;
    for (let depth = 0; node && node !== document.documentElement && depth < 12; depth++) {
      const id = node.id || "";
      const cls = typeof node.className === "string" ? node.className : "";
      if (CMP_CONTEXT_RE.test(id) || CMP_CONTEXT_RE.test(cls)) return true;
      const aria = node.getAttribute?.("aria-label") || "";
      if (CMP_CONTEXT_RE.test(aria)) return true;
      node = node.parentElement;
    }
    return false;
  }

  function clickEl(el) {
    try {
      el.click();
      return true;
    } catch {
      try {
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        return true;
      } catch {
        return false;
      }
    }
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
        if (requireContext && !inCmpContext(el)) continue;
        if (clickEl(el)) {
          attempted = true;
          signalDone(true);
          return true;
        }
      }
    }
    return false;
  }

  function tryReject() {
    if (attempted) return false;
    if (tryMatches(VENDOR_SELECTORS, false)) return true;
    if (tryMatches(GENERIC_SELECTORS, true)) return true;

    const candidates = document.querySelectorAll("button, a, [role='button']");
    for (const el of candidates) {
      if (!visible(el)) continue;
      if (!inCmpContext(el)) continue;
      const label = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
      if (!label || label.length > 40) continue;
      if (!TEXT_RE.test(label)) continue;
      if (clickEl(el)) {
        attempted = true;
        signalDone(true);
        return true;
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
      signalDone(attempted);
    }, 4500);
  }

  chrome.storage.local.get({ enabled: true, hideCookiePopups: true, siteModes: {} }, (data) => {
    if (!data.enabled || !data.hideCookiePopups) return;
    if (typeof resolveSiteMode === "function" && typeof SITE_MODE !== "undefined") {
      const mode = resolveSiteMode(location.hostname, data.siteModes);
      if (mode === SITE_MODE.OFF) return;
    }
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", schedule, { once: true });
    } else {
      schedule();
    }
    const mo = new MutationObserver(() => {
      if (!attempted) tryReject();
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => mo.disconnect(), 8000);
  });
})();
