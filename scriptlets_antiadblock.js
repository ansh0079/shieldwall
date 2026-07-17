// QuietBrowse - anti-adblock bait (MAIN world)
// Uses QuietBrowse-prefixed IDs/classes that cosmetics never hide, so detectors
// measuring offsetHeight still see "present" bait without fighting hide rules.
// Opt-in via Settings → Scriptlets. Paused sites are excluded at registration.

(function () {
  if (window.__qbAntiAdblock) return;
  window.__qbAntiAdblock = true;

  // Prefixed — must NOT match content.js AD_SELECTORS or EasyList generics.
  const BAIT_IDS = [
    "qb-bait-slot-a",
    "qb-bait-slot-b",
    "qb-bait-slot-c",
    "qb-bait-frame",
    "qb-bait-header"
  ];
  const BAIT_CLASS = "qb-bait-unit";

  function injectBait() {
    if (!document.documentElement) return;
    if (document.getElementById("__qb_bait_root")) return;

    const root = document.createElement("div");
    root.id = "__qb_bait_root";
    root.setAttribute("aria-hidden", "true");
    root.style.cssText =
      "position:absolute!important;left:-9999px!important;top:-9999px!important;" +
      "width:2px!important;height:2px!important;overflow:hidden!important;" +
      "pointer-events:none!important;opacity:0.02!important;z-index:-1!important;";

    for (const id of BAIT_IDS) {
      const el = document.createElement("div");
      el.id = id;
      el.className = BAIT_CLASS;
      el.setAttribute("data-ad-slot", "1");
      el.textContent = "\u00a0";
      // Inline dimensions so detectors that check style still see a box.
      el.style.cssText = "width:1px!important;height:1px!important;display:block!important;";
      root.appendChild(el);
    }

    (document.body || document.documentElement).appendChild(root);
  }

  try {
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    if (desc && desc.get) {
      const original = desc.get;
      Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
        configurable: true,
        get: function () {
          const val = original.call(this);
          if (
            val === 0 &&
            this.classList?.contains(BAIT_CLASS) &&
            this.closest?.("#__qb_bait_root")
          ) {
            return 1;
          }
          return val;
        }
      });
    }
  } catch {
    /* never break the page */
  }

  if (document.documentElement) injectBait();
  else {
    const mo = new MutationObserver(() => {
      if (document.documentElement) {
        mo.disconnect();
        injectBait();
      }
    });
    mo.observe(document, { childList: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectBait, { once: true });
  } else {
    injectBait();
  }
})();
