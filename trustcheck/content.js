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

  // ---------- live badge: auto drop-down, hover for feedback points ----------
  const COLORS = { trusted: "#16a34a", caution: "#d97706", risky: "#dc2626" };
  const WORDS = { trusted: "Looks trustworthy", caution: "Proceed with caution", risky: "High risk" };
  let host, root, hidden = false, shownFor = "";

  function ensureHost() {
    if (host?.isConnected) return;
    host = document.createElement("div");
    host.id = "trustcheck-badge";
    host.style.cssText = "all:initial;position:fixed;top:0;right:16px;z-index:2147483647;";
    root = host.attachShadow({ mode: "closed" });
    document.documentElement.appendChild(host);
  }

  // Feedback points: buyer-report tags when available (r.feedback), then review-site score, then key findings.
  function feedbackPoints(r) {
    const pts = [];
    for (const f of r.feedback || []) pts.push({ status: "bad", text: `${f.count} buyers: ${f.label}` });
    if (r.reviews) pts.push({ status: r.reviews.score >= 4 ? "good" : r.reviews.score >= 3 ? "warn" : "bad",
      text: `${r.reviews.source} ${r.reviews.score?.toFixed(1)}/5 from ${r.reviews.count.toLocaleString()} reviews` });
    for (const sg of r.signals) if (sg.status !== "info") pts.push({ status: sg.status, text: sg.label });
    return pts.slice(0, 5);
  }

  function render(r) {
    if (hidden) return;
    ensureHost();
    const color = COLORS[r.verdict];
    root.textContent = "";
    const style = document.createElement("style");
    style.textContent = `
      *{box-sizing:border-box;font:13px system-ui,sans-serif}
      .drop{width:270px;background:#fff;color:#111827;border-radius:0 0 12px 12px;box-shadow:0 4px 18px rgba(0,0,0,.35);
        border-top:4px solid ${color};transform:translateY(-100%);transition:transform .35s ease;overflow:hidden}
      .drop.in{transform:translateY(0)}
      .bar{display:flex;align-items:center;gap:10px;padding:8px 10px;cursor:default}
      .score{flex:none;width:38px;height:38px;border-radius:50%;background:${color};color:#fff;font-weight:700;display:grid;place-items:center}
      .v{font-weight:700;color:${color}}.sub{color:#6b7280;font-size:11px}
      .x{margin-left:auto;border:0;background:none;color:#6b7280;font-size:16px;cursor:pointer}
      .more{max-height:0;overflow:hidden;transition:max-height .25s ease;padding:0 12px}
      .drop.open .more{max-height:260px;padding:2px 12px 10px}
      .h{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;margin:6px 0 2px}
      .p{margin:4px 0;display:flex;gap:6px}.p i{flex:none;width:8px;height:8px;border-radius:50%;margin-top:5px}
      .good i{background:#16a34a}.warn i{background:#d97706}.bad i{background:#dc2626}`;
    const drop = document.createElement("div"); drop.className = "drop";
    const bar = document.createElement("div"); bar.className = "bar";
    const sc = document.createElement("div"); sc.className = "score"; sc.textContent = r.score;
    const tx = document.createElement("div");
    const v = document.createElement("div"); v.className = "v"; v.textContent = WORDS[r.verdict];
    const sub = document.createElement("div"); sub.className = "sub"; sub.textContent = "Hover for what buyers & checks say";
    tx.append(v, sub);
    const x = document.createElement("button"); x.className = "x"; x.textContent = "\u00d7"; x.title = "Hide for this page";
    x.onclick = () => { hidden = true; host.remove(); };
    bar.append(sc, tx, x);
    const more = document.createElement("div"); more.className = "more";
    const h = document.createElement("div"); h.className = "h"; h.textContent = "Most common feedback";
    more.append(h);
    for (const pt of feedbackPoints(r)) {
      const d = document.createElement("div"); d.className = "p " + pt.status;
      const i = document.createElement("i"), l = document.createElement("span"); l.textContent = pt.text;
      d.append(i, l); more.append(d);
    }
    drop.append(bar, more);
    root.append(style, drop);

    // Hover / focus on the badge opens the feedback points.
    drop.addEventListener("mouseenter", () => drop.classList.add("open"));
    drop.addEventListener("mouseleave", () => drop.classList.remove("open"));

    // Auto drop-down on a new page/verdict; collapse to a small tab after a few seconds unless risky.
    requestAnimationFrame(() => requestAnimationFrame(() => drop.classList.add("in")));
    const key = location.href + r.verdict;
    if (key !== shownFor) {
      shownFor = key;
      drop.classList.add("open");
      if (r.verdict !== "risky") setTimeout(() => drop.classList.remove("open"), 4000);
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "report") render(msg.report);
  });
})();
