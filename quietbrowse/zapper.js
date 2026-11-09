// QuietBrowse - element zapper (right-click page -> pick element to hide permanently)

(function () {
  let active = false;
  let highlight = null;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "startZapper") {
      startZapper();
      sendResponse({ ok: true });
    }
    return false;
  });

  function startZapper() {
    if (active) return;
    chrome.storage.local.get({ enabled: true, siteModes: {} }, (data) => {
      if (!data.enabled) return;
      const mode = resolveSiteMode(location.hostname, data.siteModes);
      if (mode === SITE_MODE.OFF) return;
      beginZapper();
    });
  }

  function beginZapper() {
    if (active) return;
    active = true;

    highlight = document.createElement("div");
    highlight.id = "__qb_zap_highlight";
    highlight.style.cssText =
      "position:fixed;pointer-events:none;z-index:2147483645;" +
      "border:2px solid #1a73e8;background:rgba(26,115,232,.15);" +
      "border-radius:2px;display:none;";
    document.documentElement.appendChild(highlight);

    const banner = document.createElement("div");
    banner.id = "__qb_zap_banner";
    banner.style.cssText =
      "position:fixed;top:0;left:0;right:0;z-index:2147483646;" +
      "background:#1a73e8;color:#fff;font:600 13px 'Segoe UI',system-ui,sans-serif;" +
      "padding:10px 16px;text-align:center;";
    banner.textContent =
      "QuietBrowse zapper — click an element to hide it. Press Esc to cancel.";
    document.documentElement.appendChild(banner);

    function onMove(e) {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el === highlight || el === banner || el.id?.startsWith("__qb")) {
        highlight.style.display = "none";
        return;
      }
      const r = el.getBoundingClientRect();
      highlight.style.display = "block";
      highlight.style.top = r.top + "px";
      highlight.style.left = r.left + "px";
      highlight.style.width = r.width + "px";
      highlight.style.height = r.height + "px";
    }

    function onClick(e) {
      e.preventDefault();
      e.stopPropagation();
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el.id?.startsWith("__qb")) return;
      const selector = buildSelector(el);
      if (!selector) return;
      saveZapped(selector, el);
      el.style.setProperty("display", "none", "important");
      stopZapper();
    }

    function onKey(e) {
      if (e.key === "Escape") stopZapper();
    }

    function stopZapper() {
      active = false;
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey, true);
      highlight?.remove();
      banner?.remove();
      highlight = null;
    }

    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
  }

  function buildSelector(el) {
    if (!(el instanceof Element)) return null;

    if (el.id && /^[a-zA-Z][\w-]*$/.test(el.id)) {
      const sel = "#" + CSS.escape(el.id);
      try {
        if (document.querySelectorAll(sel).length === 1) return sel;
      } catch {
        /* invalid id */
      }
    }

    if (el.classList.length) {
      const sel =
        el.tagName.toLowerCase() +
        "." +
        [...el.classList].slice(0, 3).map((c) => CSS.escape(c)).join(".");
      try {
        if (document.querySelectorAll(sel).length === 1) return sel;
      } catch {
        /* invalid class */
      }
    }

    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      let seg = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === node.tagName);
        if (same.length > 1) {
          seg += `:nth-of-type(${same.indexOf(node) + 1})`;
        }
      }
      parts.unshift(seg);
      node = parent;
    }
    return parts.join(" > ");
  }

  function saveZapped(selector, el) {
    const domain = siteKey(location.hostname);
    const label =
      el.tagName.toLowerCase() +
      (el.id ? "#" + el.id : "") +
      (el.className && typeof el.className === "string"
        ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".")
        : "");

    chrome.storage.local.get({ zappedElements: {} }, (data) => {
      const all = data.zappedElements;
      const list = all[domain] || [];
      if (list.some((z) => z.selector === selector)) return;
      list.push({
        selector,
        label,
        addedAt: new Date().toISOString()
      });
      all[domain] = list;
      chrome.storage.local.set({ zappedElements: all }, () => {
        chrome.runtime.sendMessage({ type: "broadcastSettings" }).catch(() => {});
      });
    });
  }
})();
