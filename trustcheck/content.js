// Scans the page for store-trust cues (re-scanning as you scroll / the page changes)
// and shows a live rating badge on the page.
(() => {
  if (window.top !== window) return;

  // ---------- scanning ----------
  function scan() {
    const text = (document.body?.innerText || "").slice(0, 60000).toLowerCase();
    const links = [...document.querySelectorAll("a[href]")].map((a) => (a.textContent + " " + a.getAttribute("href")).toLowerCase());
    const has = (re) => links.some((l) => re.test(l));
    const hasPaymentFields = !!document.querySelector(
      'input[autocomplete^="cc-"], input[name*="card" i], input[name*="cvv" i], input[name*="cvc" i]');
    const isShop = hasPaymentFields ||
      !!document.querySelector('[class*="cart" i], [id*="cart" i], button[name="add"], form[action*="cart"]') ||
      /add to (cart|bag|basket)/.test(text);
    return {
      isShop, hasPaymentFields,
      hasContact: has(/contact/) || !!document.querySelector('a[href^="mailto:"], a[href^="tel:"]'),
      hasReturns: has(/return|refund|shipping/),
      hasPrivacyTerms: has(/privacy|terms/),
      hasAbout: has(/about/),
      urgency: /(only \d+ left|hurry|limited time|offer ends|\d+ people (are )?(viewing|watching))/.test(text)
    };
  }

  let last = "";
  function send() {
    const s = scan();
    const key = location.href + JSON.stringify(s);
    if (key === last) return;           // only notify when something changed
    last = key;
    try { chrome.runtime.sendMessage({ type: "scan", scan: s }); } catch { /* extension reloaded */ }
  }

  let timer = null;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(send, 1200); };
  send();
  window.addEventListener("scroll", schedule, { passive: true });   // lazy-loaded content / footers
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });

  // ---------- live badge (shadow DOM so site CSS can't break it) ----------
  const COLORS = { trusted: "#16a34a", caution: "#d97706", risky: "#dc2626" };
  const WORDS = { trusted: "Looks trustworthy", caution: "Proceed with caution", risky: "High risk" };
  let host, root, hidden = false;

  function ensureBadge() {
    if (host?.isConnected) return;
    host = document.createElement("div");
    host.id = "trustcheck-badge";
    host.style.cssText = "all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647;";
    root = host.attachShadow({ mode: "closed" });
    document.documentElement.appendChild(host);
  }

  function render(r) {
    if (hidden) return;
    ensureBadge();
    const color = COLORS[r.verdict];
    root.textContent = "";
    const style = document.createElement("style");
    style.textContent = `
      *{box-sizing:border-box;font:13px system-ui,sans-serif}
      .wrap{display:flex;flex-direction:column;align-items:flex-end;gap:8px}
      .dot{width:48px;height:48px;border-radius:50%;background:${color};color:#fff;font-weight:700;font-size:16px;
        display:grid;place-items:center;cursor:pointer;border:2px solid #fff;box-shadow:0 2px 10px rgba(0,0,0,.35)}
      .panel{width:260px;background:#fff;color:#111827;border-radius:10px;padding:10px 12px;box-shadow:0 4px 18px rgba(0,0,0,.35);display:none}
      .panel.open{display:block}
      .t{font-weight:700;color:${color};margin-bottom:6px}
      .s{margin:4px 0;display:flex;gap:6px}.s i{flex:none;width:8px;height:8px;border-radius:50%;margin-top:5px}
      .good i{background:#16a34a}.warn i{background:#d97706}.bad i{background:#dc2626}.info i{background:#9ca3af}
      .x{float:right;cursor:pointer;color:#6b7280;border:0;background:none;font-size:16px}`;
    const wrap = document.createElement("div"); wrap.className = "wrap";
    const panel = document.createElement("div"); panel.className = "panel";
    const x = document.createElement("button"); x.className = "x"; x.textContent = "×"; x.title = "Hide for this page";
    x.onclick = () => { hidden = true; host.remove(); };
    const t = document.createElement("div"); t.className = "t"; t.textContent = `${WORDS[r.verdict]} (${r.score}/100)`;
    panel.append(x, t);
    for (const s of r.signals.filter((s) => s.status !== "info").slice(0, 4)) {
      const d = document.createElement("div"); d.className = "s " + s.status;
      const i = document.createElement("i"), l = document.createElement("span"); l.textContent = s.label;
      d.append(i, l); panel.append(d);
    }
    const dot = document.createElement("div"); dot.className = "dot"; dot.textContent = r.score;
    dot.title = "TrustCheck rating - click for details";
    dot.onclick = () => panel.classList.toggle("open");
    if (r.verdict === "risky") panel.classList.add("open");
    wrap.append(panel, dot);
    root.append(style, wrap);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "report") render(msg.report);
  });
})();
