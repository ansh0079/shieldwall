// QuietBrowse - Password Shield + phishing detection

(function () {
  let pwCleanup = null;

  function scrambled() {
    const chars =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%";
    let out = "";
    for (let i = 0; i < 16; i++) {
      out += chars[Math.floor(Math.random() * chars.length)];
    }
    return out;
  }

  function initPasswordShield() {
    const knownPw = new WeakSet();
    const copyHandlers = [];
    const gestureHandlers = [];

    function isPasswordField(el) {
      return (
        el instanceof HTMLInputElement &&
        (el.type === "password" || knownPw.has(el))
      );
    }

    function register(el) {
      if (el instanceof HTMLInputElement && el.type === "password") {
        knownPw.add(el);
      }
    }

    for (const evt of ["copy", "cut"]) {
      const handler = (e) => {
        if (isPasswordField(document.activeElement)) {
          e.preventDefault();
          e.clipboardData.setData("text/plain", scrambled());
        }
      };
      document.addEventListener(evt, handler, true);
      copyHandlers.push({ evt, handler });
    }

    let lastGesture = 0;
    for (const evt of ["pointerdown", "keydown"]) {
      const handler = () => {
        lastGesture = Date.now();
      };
      document.addEventListener(evt, handler, true);
      gestureHandlers.push({ evt, handler });
    }

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === "childList") {
          for (const node of m.addedNodes) {
            if (node instanceof HTMLElement) {
              register(node);
              node.querySelectorAll?.("input[type=password]").forEach(register);
            }
          }
        } else if (
          m.type === "attributes" &&
          m.target instanceof HTMLInputElement &&
          knownPw.has(m.target) &&
          m.target.type !== "password"
        ) {
          if (Date.now() - lastGesture > 1500) {
            m.target.type = "password";
          }
        }
      }
    });

    function start() {
      document.querySelectorAll("input[type=password]").forEach(register);
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["type"]
      });
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }

    return () => {
      for (const { evt, handler } of copyHandlers) {
        document.removeEventListener(evt, handler, true);
      }
      for (const { evt, handler } of gestureHandlers) {
        document.removeEventListener(evt, handler, true);
      }
      observer.disconnect();
    };
  }

  function removePhishUI() {
    document.getElementById("__qb_phish_overlay")?.remove();
    document.getElementById("__qb_phish_banner")?.remove();
  }

  function runPhishingCheck() {
    if (location.protocol !== "http:" && location.protocol !== "https:") return;
    if (sessionStorage.getItem("__qb_phish_dismissed") === location.hostname)
      return;

    removePhishUI();

    const signals = PhishScore.collectSignals();
    const hasPasswordField = signals.passwordFieldCount > 0;

    chrome.runtime.sendMessage(
      {
        type: "analyzePhish",
        hostname: location.hostname,
        protocol: location.protocol,
        hasPasswordField,
        signals
      },
      (result) => {
        if (chrome.runtime.lastError || !result?.ok) return;
        const { riskScore, reasons } = result;
        const insecureLogin =
          location.protocol === "http:" && hasPasswordField;

        if (riskScore >= 3) {
          showOverlay(reasons, location.hostname.toLowerCase());
        } else if (insecureLogin) {
          showBanner(reasons.find((r) => r.includes("http")) || reasons[0]);
        }
      }
    );
  }

  function showOverlay(reasons, host) {
    const overlay = document.createElement("div");
    overlay.id = "__qb_phish_overlay";
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;background:#7f1d1d;" +
      "color:#fff;font-family:'Segoe UI',system-ui,sans-serif;display:flex;" +
      "align-items:center;justify-content:center;padding:24px;";

    const box = document.createElement("div");
    box.style.cssText = "max-width:520px;";

    const h = document.createElement("div");
    h.style.cssText = "font-size:26px;font-weight:700;margin-bottom:12px;";
    h.textContent = "⚠️ QuietBrowse: this site looks dangerous";
    box.appendChild(h);

    const p = document.createElement("div");
    p.style.cssText = "font-size:15px;margin-bottom:10px;opacity:.95;";
    p.textContent = `${host} has warning signs of a phishing site:`;
    box.appendChild(p);

    const ul = document.createElement("ul");
    ul.style.cssText = "font-size:14px;line-height:1.5;margin:0 0 18px 20px;padding:0;";
    for (const r of reasons) {
      const li = document.createElement("li");
      li.textContent = r;
      ul.appendChild(li);
    }
    box.appendChild(ul);

    const warn = document.createElement("div");
    warn.style.cssText = "font-size:14px;margin-bottom:18px;font-weight:600;";
    warn.textContent = "Do not enter passwords, card numbers, or personal details here.";
    box.appendChild(warn);

    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex;gap:10px;";

    const back = document.createElement("button");
    back.textContent = "Take me back to safety";
    back.style.cssText =
      "flex:1;padding:12px;font-size:14px;font-weight:600;border:0;" +
      "border-radius:8px;background:#fff;color:#7f1d1d;cursor:pointer;";
    back.onclick = () => {
      if (history.length > 1) history.back();
      else location.href = "about:blank";
    };

    const stay = document.createElement("button");
    stay.textContent = "I understand the risk — continue";
    stay.style.cssText =
      "padding:12px 16px;font-size:13px;border:1px solid rgba(255,255,255,.5);" +
      "border-radius:8px;background:transparent;color:#fff;cursor:pointer;";
    stay.onclick = () => {
      sessionStorage.setItem("__qb_phish_dismissed", location.hostname);
      overlay.remove();
    };

    btnRow.appendChild(back);
    btnRow.appendChild(stay);
    box.appendChild(btnRow);
    overlay.appendChild(box);
    (document.body || document.documentElement).appendChild(overlay);
  }

  function showBanner(text) {
    const bar = document.createElement("div");
    bar.id = "__qb_phish_banner";
    bar.style.cssText =
      "position:fixed;top:0;left:0;right:0;z-index:2147483646;" +
      "background:#b45309;color:#fff;font-family:'Segoe UI',system-ui,sans-serif;" +
      "font-size:13px;padding:10px 40px 10px 14px;line-height:1.4;";
    bar.textContent = "⚠️ QuietBrowse: " + text;

    const close = document.createElement("button");
    close.textContent = "✕";
    close.style.cssText =
      "position:absolute;right:8px;top:6px;background:transparent;border:0;" +
      "color:#fff;font-size:15px;cursor:pointer;padding:4px;";
    close.onclick = () => bar.remove();
    bar.appendChild(close);

    (document.body || document.documentElement).appendChild(bar);
  }

  let phishObserver = null;
  let spaHookCleanup = null;

  function stopPhishingWatcher() {
    if (phishObserver) {
      phishObserver.disconnect();
      phishObserver = null;
    }
    if (spaHookCleanup) {
      spaHookCleanup();
      spaHookCleanup = null;
    }
  }

  function startPhishingWatcher() {
    stopPhishingWatcher();

    // Re-check when password fields or forms appear later.
    phishObserver = new MutationObserver((mutations) => {
      let relevant = false;
      for (const m of mutations) {
        if (m.type !== "childList") continue;
        for (const node of m.addedNodes) {
          if (node instanceof HTMLElement) {
            if (
              node.matches?.("input[type=password], form") ||
              node.querySelector("input[type=password], form")
            ) {
              relevant = true;
            }
          }
        }
      }
      if (relevant) runPhishingCheck();
    });
    phishObserver.observe(document.documentElement, {
      childList: true,
      subtree: true
    });

    // webNavigation.onHistoryStateUpdated covers pushState/replaceState.
    // Local listeners keep hash and back/forward checks responsive.
    spaHookCleanup = hookSpaNavigation(() => {
      sessionStorage.removeItem("__qb_phish_dismissed");
      removePhishUI();
      runPhishingCheck();
      notifyPopupTrustScore();
    });
  }

  function hookSpaNavigation(onChange) {
    let lastUrl = location.href;

    function maybeFire() {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        onChange();
      }
    }

    const onPop = () => maybeFire();
    const onHash = () => maybeFire();
    window.addEventListener("popstate", onPop);
    window.addEventListener("hashchange", onHash);

    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("hashchange", onHash);
    };
  }

  function notifyPopupTrustScore() {
    try {
      chrome.runtime.sendMessage({ type: "trustScoreUpdated", url: location.href });
    } catch {
      /* popup may not be open */
    }
  }

  function applyShield(settings) {
    if (pwCleanup) {
      pwCleanup();
      pwCleanup = null;
    }
    stopPhishingWatcher();
    removePhishUI();

    if (!settings.enabled) return;

    const mode = resolveSiteMode(location.hostname, settings.siteModes || {});
    if (mode === SITE_MODE.OFF) return;

    if (settings.passwordShield) {
      pwCleanup = initPasswordShield();
    }
    if (settings.phishingWarn) {
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => {
          runPhishingCheck();
          startPhishingWatcher();
        }, { once: true });
      } else {
        runPhishingCheck();
        startPhishingWatcher();
      }
    }
  }

  const SHIELD_SETTINGS = {
    enabled: true,
    passwordShield: true,
    phishingWarn: true,
    siteModes: {}
  };

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settingsRevision) {
      chrome.storage.local.get(SHIELD_SETTINGS, applyShield);
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "settingsChanged") {
      chrome.storage.local.get(SHIELD_SETTINGS, (data) => {
        applyShield(data);
        sendResponse({ ok: true });
      });
      return true;
    } else if (msg.type === "historyStateUpdated") {
      sessionStorage.removeItem("__qb_phish_dismissed");
      removePhishUI();
      chrome.storage.local.get(SHIELD_SETTINGS, (data) => {
        if (data.enabled && data.phishingWarn) {
          runPhishingCheck();
          notifyPopupTrustScore();
        }
        sendResponse({ ok: true });
      });
      return true;
    }
    return false;
  });

  chrome.storage.local.get(SHIELD_SETTINGS, applyShield);
})();
