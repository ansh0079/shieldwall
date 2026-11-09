// Scans the page for store-trust cues and shows a warning banner on risky sites.
(() => {
  if (window.top !== window) return;
  const text = (document.body?.innerText || "").slice(0, 60000).toLowerCase();
  const links = [...document.querySelectorAll("a[href]")].map((a) => (a.textContent + " " + a.getAttribute("href")).toLowerCase());
  const has = (re) => links.some((l) => re.test(l));
  const hasPaymentFields = !!document.querySelector(
    'input[autocomplete^="cc-"], input[name*="card" i], input[name*="cvv" i], input[name*="cvc" i]');
  const isShop = hasPaymentFields || !!document.querySelector('[class*="cart" i], [id*="cart" i], button[name="add"], form[action*="cart"]') || /add to (cart|bag|basket)/.test(text);
  chrome.runtime.sendMessage({
    type: "scan",
    scan: {
      isShop, hasPaymentFields,
      hasContact: has(/contact/) || !!document.querySelector('a[href^="mailto:"], a[href^="tel:"]'),
      hasReturns: has(/return|refund|shipping/),
      hasPrivacyTerms: has(/privacy|terms/),
      hasAbout: has(/about/),
      urgency: /(only \d+ left|hurry|limited time|offer ends|\d+ people (are )?(viewing|watching))/.test(text)
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== "report" || msg.report.verdict !== "risky") return;
    if (document.getElementById("trustcheck-banner")) return;
    const b = document.createElement("div");
    b.id = "trustcheck-banner";
    b.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#dc2626;color:#fff;font:600 14px system-ui;padding:10px 16px;display:flex;gap:12px;align-items:center;";
    const t = document.createElement("span");
    t.textContent = `TrustCheck: this site scored ${msg.report.score}/100 and looks risky. Be careful entering payment details.`;
    const x = document.createElement("button");
    x.textContent = "Dismiss";
    x.style.cssText = "margin-left:auto;cursor:pointer";
    x.onclick = () => b.remove();
    b.append(t, x);
    document.documentElement.appendChild(b);
  });
})();
