// Scans the page for store-trust cues (re-scanning as you scroll / the page changes)
// and shows a live rating badge on the page.
(() => {
  if (window.top !== window) return;
  const parseMerchantRating = globalThis.TrustCheckMerchantRating?.parseMerchantRating || (() => null);

  // ---------- scanning ----------
  function scan() {
    const text = (document.body?.innerText || "").slice(0, 60000).toLowerCase();
    const links = [...document.querySelectorAll("a[href]")].map((a) => (a.textContent + " " + a.getAttribute("href")).toLowerCase());
    const has = (re) => links.some((l) => re.test(l));
    const hasPaymentFields = !!document.querySelector(
      'input[autocomplete^="cc-"], input[name*="card" i], input[name*="cvv" i], input[name*="cvc" i]');
    const hasCartControl = !!document.querySelector('button[name="add"], form[action*="cart"], button[class*="cart" i], button[id*="cart" i], a[href*="/cart" i], a[href*="/basket" i]');
    const hasProductOffer = [...document.querySelectorAll('script[type="application/ld+json"]')]
      .some((node) => /"@type"\s*:\s*"(?:Product|Offer|ProductGroup)"/i.test(node.textContent || ""));
    const isShop = hasPaymentFields || /add to (cart|bag|basket)/.test(text) ||
      (hasCartControl && (hasProductOffer || /\b(shop|products|delivery|shipping|checkout)\b/i.test(text)));
    const payFrame = !!document.querySelector('iframe[src*="paypal."], iframe[src*="klarna."], iframe[src*="clearpay."], iframe[src*="js.stripe.com"]');
    const payButton = [...document.querySelectorAll("button, input[type=submit], a[role=button]")]
      .some((b) => /(pay now|pay with|place (your )?order|complete (your )?(order|purchase)|buy now|paypal|klarna|clearpay)/i.test(b.textContent || b.value || ""));
    const checkoutActivity = hasPaymentFields || payFrame || payButton || /\/(checkout|payment|pay)(\/|$|\?)/i.test(location.pathname);
    const retailCheckoutContext = isShop || hasProductOffer || hasCartControl ||
      /\b(shipping|delivery|order summary|your order|place order|shopping cart|basket)\b/i.test(text);
    const isCheckout = checkoutActivity && retailCheckoutContext;
    const confirmationText = /(thank you for your (order|purchase)|order (is |has been )?confirmed|order confirmation|we(?:'ve| have) received your order)/i.test(text);
    const confirmationUrl = /\/(order-confirmation|order-complete|order-success|thank-you|thank_you|orders\/|purchase-success)(\/|$|\?)/i.test(location.pathname);
    const purchaseObserved = confirmationText && (confirmationUrl || /order\s*(number|no\.?|#)|confirmation\s*(number|no\.?|#)/i.test(text));
    if (!isShop && !isCheckout && !purchaseObserved) {
      return { pageUrl: location.href, isShop: false, isCheckout: false, purchaseObserved: false };
    }

    let orderAmount = null;
    const amountMatch = text.match(/(?:total|paid|amount|charged)[:\s]*([£$€]\s*\d+(?:\.\d{2})?|\d+(?:\.\d{2})?\s*(?:GBP|USD|EUR))/i);
    if (amountMatch) orderAmount = amountMatch[1].trim();

    let orderId = null;
    const orderMatch = text.match(/(?:order|confirmation)\s*(?:number|no\.?|#)[:\s]*([a-zA-Z0-9_-]{4,30})/i);
    if (orderMatch) orderId = orderMatch[1].trim();

    let receiverName = null;
    const receiverMatch = text.match(/(?:paid (?:with paypal )?to|seller|merchant)[:\s]*([A-Z0-9\s.,&'-]{3,40}(?:LLC|LTD|LIMITED|INC|CORP|GMBH))/i);
    if (receiverMatch) receiverName = receiverMatch[1].trim();

    const storefrontName = (document.title || "").split(/[-|•–]/)[0].trim().slice(0, 80);
    const merchantRating = parseMerchantRating([...document.querySelectorAll('script[type="application/ld+json"]')].map((n) => n.textContent || ""));

    // Known legitimate external payment processors
    const TRUSTED_PAY_GATEWAYS = /(^|\.)(stripe\.com|paypal\.com|braintreegateway\.com|shopify\.com|myshopify\.com|adyen\.com|worldpay\.com|klarna\.com|squareup\.com|checkout\.com|authorizenet\.com|payu\.com|clearpay\.co\.uk|afterpay\.com)$/i;
    let hasInsecurePaymentAction = false, insecureActionHost = "";
    const payForms = [...document.querySelectorAll('form')].filter((f) =>
      f.querySelector('input[autocomplete^="cc-"], input[name*="card" i], input[name*="cvv" i], input[name*="cvc" i]')
    );
    for (const f of payForms) {
      const act = f.getAttribute("action");
      if (act && /^https?:\/\//i.test(act)) {
        try {
          const actUrl = new URL(act, location.href);
          if (actUrl.hostname !== location.hostname && !TRUSTED_PAY_GATEWAYS.test(actUrl.hostname)) {
            hasInsecurePaymentAction = true;
            insecureActionHost = actUrl.hostname;
            break;
          }
        } catch { /* invalid url */ }
      }
    }

    const FREE_EMAIL_PROVIDERS = /(^|\.)(gmail|yahoo|hotmail|outlook|aol|mail|protonmail|proton|zoho|icloud|yandex|gmx)\.(com|me|org|net|co\.uk)$/i;
    const mailtoLinks = [...document.querySelectorAll('a[href^="mailto:"]')].map((a) => {
      const m = /mailto:([^?&]+)/i.exec(a.getAttribute("href") || "");
      return m ? m[1].trim().toLowerCase() : "";
    }).filter(Boolean);
    const hasFreeWebmailContact = mailtoLinks.some((email) => {
      const d = email.split("@")[1];
      return d && FREE_EMAIL_PROVIDERS.test(d);
    });

    const isLiquidationClaim = /(closing down sale|store closing down|warehouse liquidation|all stock must go|everything must go|liquidation sale|bankruptcy sale|closing down forever)/i.test(text);

    // Legal footer lines (company number etc.), sent so the background can verify the company.
    const legal = (document.body?.innerText || "").split(/\n/).filter((l) => l.length < 240 && /(company|registered|registration|reg\.?)\s*(no|number|#)/i.test(l)).slice(0, 4);
    return {
      pageUrl: location.href, isShop, hasPaymentFields, isCheckout, purchaseObserved, merchantRating, legal, title: (document.title || "").slice(0, 120),
      orderAmount, orderId, receiverName, storefrontName,
      hasInsecurePaymentAction, insecureActionHost,
      hasFreeWebmailContact, isLiquidationClaim,
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
  const COLORS = { lower: "#16a34a", caution: "#d97706", risky: "#dc2626", dangerous: "#7f1d1d", limited: "#6b7280" };
  // Text on white needs more contrast than a filled circle: darker variants that pass WCAG AA at small sizes.
  const TEXT = { lower: "#15803d", caution: "#b45309", risky: "#b91c1c", dangerous: "#7f1d1d", limited: "#4b5563" };
  const WORDS = { lower: "Lower risk indicators", caution: "Caution", risky: "High risk", dangerous: "Dangerous", limited: "Limited evidence" };
  const severe = (v) => v === "risky" || v === "dangerous";          // the only verdicts allowed to interrupt a checkout
  const DISCLAIMER = "BeforeYouBuy cannot guarantee a seller or a transaction.";
  let host, root, hidden = false, shownFor = "", lastKey = "", hovering = false;

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
    for (const h of r.history || []) pts.push({ status: "info", text: h });
    if (r.verdict === "limited") pts.push({ status: "warn", text: "Not enough independent evidence found about this shop to judge it" });
    if (r.buyerTotal) pts.push({ status: "info", text: `${r.buyerTotal} unverified buyer reports (30 days, not scored)` });
    for (const f of r.feedback || []) pts.push({ status: "info", text: `${f.count} unverified reports: ${f.label}` });
    if (r.merchantRating) pts.push({ status: "info", text: `Merchant claims ${r.merchantRating.value}/${r.merchantRating.best} from ${r.merchantRating.count.toLocaleString()} ratings` });
    if (r.reviews) pts.push({ status: r.reviews.score >= 4 ? "good" : r.reviews.score >= 3 ? "warn" : "bad",
      text: `${r.reviews.source} ${r.reviews.score?.toFixed(1)}/5 from ${r.reviews.count.toLocaleString()} reviews` });
    for (const th of r.reviews?.themes || []) pts.push({ status: "bad", text: `${th.count} of ${r.reviews.sample} recent ${r.reviews.source} reviews: ${th.label}` });
    // Also show "missing evidence" lines, so a caution score is never explained by green items alone.
    const KEEP = new Set(["age", "buyers", "company", "sb"]);
    for (const sg of r.signals) if ((sg.status !== "info" || KEEP.has(sg.id)) && !(r.history?.length && sg.id === "age" && (sg.status === "info" || sg.status === "good"))) pts.push({ status: sg.status, text: sg.label });
    if (r.verdict === "caution" && !pts.some((p) => p.status === "warn" || p.status === "bad")) {
      pts.push({ status: "warn", text: "Limited independent review or company records verified" });
    }
    return pts.slice(0, 8);
  }

  function render(r) {
    if (r.neutral) { host?.remove(); return; }   // search pages: no rating to show
    if (r.ui?.mode === "off" || r.ui?.hidden) { host?.remove(); return; }   // toolbar-only mode / muted site (the toolbar icon still shows the score)
    if (hidden) return;
    // Skip identical re-sends: rebuilding the badge would close a panel the user is hovering.
    const key = JSON.stringify([r.score, r.verdict, r.feedback, r.reviews, r.buyerTotal, r.buyerOutcomes, r.backendOn, r.merchantRating, r.signals.map((x) => x.label)]);
    if (key === lastKey && host?.isConnected) return;
    lastKey = key;
    const fresh = !host?.isConnected;            // only a brand-new badge slides in
    ensureHost();
    const color = COLORS[r.verdict];
    root.textContent = "";
    const style = document.createElement("style");
    style.textContent = `
      *{box-sizing:border-box;font:13px system-ui,sans-serif}
      .drop{width:min(350px,calc(100vw - 20px));background:#fff;color:#111827;border-radius:0 0 12px 12px;box-shadow:0 4px 18px rgba(0,0,0,.35);
        border-top:4px solid ${color};transform:translateY(-100%);transition:transform .35s ease;overflow:hidden}
      .drop.in{transform:translateY(0)}
      .bar{display:flex;align-items:center;gap:10px;padding:8px 10px;cursor:default}
      .bar:focus-visible{outline:2px solid #2563eb;outline-offset:-2px;border-radius:4px}
      .score{flex:none;width:38px;height:38px;border-radius:50%;background:${color};color:#fff;font-weight:700;display:grid;place-items:center}
      .v{font-weight:700;color:${TEXT[r.verdict]}}.sub{color:#4b5563;font-size:11px}
      .x{margin-left:auto;border:0;background:none;color:#4b5563;font-size:16px;cursor:pointer}
      .x:focus-visible{outline:2px solid #2563eb;border-radius:4px}
      .more{max-height:0;overflow:hidden;transition:max-height .25s ease;padding:0 12px}
      .drop.open .more{max-height:290px;padding:2px 12px 10px}
      .h{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#4b5563;margin:6px 0 2px}
      .p{margin:4px 0;display:flex;gap:6px}.p i{flex:none;width:8px;height:8px;border-radius:50%;margin-top:5px}
      .good i{background:#15803d}.warn i{background:#b45309}.bad i{background:#b91c1c}.info i{background:#6b7280}
      .mute{margin-top:8px;border:0;background:none;color:#4b5563;text-decoration:underline;cursor:pointer;padding:0;font-size:11px}
      @media (prefers-reduced-motion:reduce){.drop,.more{transition:none}}`;
    const drop = document.createElement("div"); drop.className = "drop";
    const bar = document.createElement("div"); bar.className = "bar";
    const sc = document.createElement("div"); sc.className = "score"; sc.textContent = r.verdict === "limited" ? "?" : r.verdict === "dangerous" ? "!" : r.score; sc.setAttribute("aria-label", `Evidence score ${r.score} of 100`);
    const tx = document.createElement("div");
    const v = document.createElement("div"); v.className = "v"; v.textContent = r.verdictLabel || WORDS[r.verdict];
    const sub = document.createElement("div"); sub.className = "sub"; sub.textContent = `${r.confidenceLabel || "Low"} confidence · hover for details`;
    tx.append(v, sub);
    const x = document.createElement("button"); x.className = "x"; x.textContent = "\u00d7"; x.title = "Hide for this page";
    x.setAttribute("aria-label", "Hide the BeforeYouBuy badge on this page");
    x.onclick = (e) => { e.stopPropagation(); hidden = true; host.remove(); };
    bar.append(sc, tx, x);
    // Keyboard access: the bar is a toggle button for the details panel.
    bar.tabIndex = 0; bar.setAttribute("role", "button"); bar.setAttribute("aria-expanded", "false");
    bar.setAttribute("aria-label", `BeforeYouBuy: ${r.verdictLabel || WORDS[r.verdict]}. Press Enter for details`);
    const setOpen = (on) => { drop.classList.toggle("open", on); bar.setAttribute("aria-expanded", String(on)); };
    bar.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(!drop.classList.contains("open")); } });
    bar.addEventListener("click", () => setOpen(!drop.classList.contains("open")));
    const more = document.createElement("div"); more.className = "more";
    const hasFeedback = (r.feedback && r.feedback.length > 0) || !!r.reviews || !!r.buyerTotal;
    const h = document.createElement("div"); h.className = "h"; h.textContent = hasFeedback ? "Most common feedback" : "Key trust checks";
    more.append(h);
    for (const pt of feedbackPoints(r)) {
      const d = document.createElement("div"); d.className = "p " + pt.status;
      const i = document.createElement("i"), l = document.createElement("span"); l.textContent = pt.text;
      d.append(i, l); more.append(d);
    }
    const disc = document.createElement("div"); disc.className = "sub"; disc.textContent = DISCLAIMER; disc.style.marginTop = "6px"; more.append(disc);
    const mute = document.createElement("button"); mute.className = "mute"; mute.textContent = "Don't show this badge on this site for 30 days";
    mute.onclick = (e) => { e.stopPropagation(); try { chrome.runtime.sendMessage({ type: "hideBadge", domain: r.domain }); } catch { /* extension reloaded */ } hidden = true; host.remove(); };
    more.append(mute);
    drop.append(bar, more);
    root.append(style, drop);

    // Hover on the badge opens the feedback points; the state survives a rebuild.
    drop.addEventListener("mouseenter", () => { hovering = true; setOpen(true); });
    drop.addEventListener("mouseleave", () => { hovering = false; if (!severe(r.verdict)) setOpen(false); });
    if (hovering) setOpen(true);

    // Slide in only when first shown; a rebuild appears in place.
    if (fresh) requestAnimationFrame(() => requestAnimationFrame(() => drop.classList.add("in")));
    else { drop.style.transition = "none"; drop.classList.add("in"); }
    // Auto-open on a new page/verdict, then collapse after a few seconds unless risky or hovered.
    // "quiet" mode: the badge appears but never opens on its own.
    const pageKey = location.href + r.verdict;
    if (pageKey !== shownFor) {
      shownFor = pageKey;
      if (r.ui?.mode !== "quiet") {
        setOpen(true);
        if (!severe(r.verdict)) setTimeout(() => {   // the badge may have been rebuilt since: act on whatever is live
          if (hovering) return;
          const d = root.querySelector(".drop");
          d?.classList.remove("open"); d?.querySelector(".bar")?.setAttribute("aria-expanded", "false");
        }, 4000);
      }
    } else if (!hovering && !severe(r.verdict) && !fresh) {
      /* keep whatever state the user left */
    }
  }

  // ---------- checkout interstitial (risky sites only) ----------
  const ACK_MS = 24 * 3600 * 1000;
  let overlay = null;
  let claimed = false;   // set synchronously so concurrent reports can't show two overlays

  async function maybeInterstitial(r) {
    if (claimed || r?.neutral) return;
    let isCheckout = false;
    try { isCheckout = scan().isCheckout; } catch { /* ignore */ }
    if (!isCheckout) return;

    const hasPoorTrustpilot = r.reviews && r.reviews.score !== null && Number.isFinite(Number(r.reviews.score)) && r.reviews.score < 3.0 && r.reviews.count >= 5;
    const hasNonDelivery = r.sixMonthNonDelivery && r.sixMonthNonDelivery >= (r.minReports || 2);
    const hasNotMatched = r.sixMonthNotMatched && r.sixMonthNotMatched >= (r.minReports || 2);

    // Open notice if high-risk / dangerous, or a poor Trustpilot rating, or 6-month non-delivery threshold
    if (!severe(r.verdict) && !hasPoorTrustpilot && !hasNonDelivery && !hasNotMatched) return;

    claimed = true;
    const ackKey = "ack:" + r.domain;
    try {
      const got = (await chrome.storage.local.get(ackKey))[ackKey];
      if (got && Date.now() - got < ACK_MS) return;       // user already chose to continue (stays claimed)
    } catch { /* storage unavailable: show anyway */ }

    overlay = document.createElement("div");
    overlay.id = "trustcheck-interstitial";
    overlay.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;";
    const sh = overlay.attachShadow({ mode: "closed" });
    const st = document.createElement("style");
    st.textContent = `
      *{box-sizing:border-box;font:14px system-ui,sans-serif}
      .bg{position:fixed;inset:0;background:rgba(17,24,39,.82);display:grid;place-items:center;padding:16px}
      .card{max-width:460px;width:100%;background:#fff;color:#111827;border-radius:14px;padding:22px;border-top:6px solid #dc2626;box-shadow:0 10px 40px rgba(0,0,0,.5)}
      h1{font-size:20px;margin:0 0 4px;color:#b91c1c}.sc{color:#4b5563;margin-bottom:12px}
      h2{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;margin:14px 0 6px}
      ul{margin:0;padding:0;list-style:none}li{display:flex;gap:8px;margin:5px 0}
      li i{flex:none;width:9px;height:9px;border-radius:50%;margin-top:5px;background:#dc2626}li.warn i{background:#d97706}
      .tips li i{background:#16a34a}
      .row{display:flex;gap:10px;margin-top:18px;align-items:center}
      .go{flex:1;padding:11px;border:0;border-radius:8px;background:#16a34a;color:#fff;font-weight:700;font-size:15px;cursor:pointer}
      .cont{border:0;background:none;color:#4b5563;text-decoration:underline;cursor:pointer;font-size:12px}
      .go:focus-visible,.cont:focus-visible,a:focus-visible{outline:3px solid #1d4ed8;outline-offset:2px}
      a{color:#1d4ed8}`;
    const bg = document.createElement("div"); bg.className = "bg";
    const card = document.createElement("div"); card.className = "card";
    card.setAttribute("role", "alertdialog"); card.setAttribute("aria-modal", "true"); card.setAttribute("aria-label", "BeforeYouBuy warning");
    const add = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; card.append(e); return e; };
    add("h1", "", r.verdict === "dangerous" ? "Do not enter payment details here" : "Think twice before paying here");
    add("div", "sc", `${r.domain}: ${r.headline || r.verdictLabel}`);

    const reasons = document.createElement("ul");
    const pts = [];
    if (r.buyerTotal) pts.push({ status: "bad", text: `${r.buyerTotal} buyers reported on this shop in the last 30 days:` });
    for (const f of r.feedback || []) pts.push({ status: "info", text: `${f.count} unverified reports: ${f.label}` });
    if (r.reviews) pts.push({ status: r.reviews.score >= 3 ? "warn" : "bad", text: `${r.reviews.source} ${r.reviews.score?.toFixed(1)}/5 from ${r.reviews.count.toLocaleString()} reviews` });
    for (const th of r.reviews?.themes || []) pts.push({ status: "bad", text: `${th.count} of ${r.reviews.sample} recent ${r.reviews.source} reviews: ${th.label}` });
    for (const sg of r.signals) if (sg.status === "bad" || sg.status === "warn") pts.push({ status: sg.status, text: sg.label });
    for (const pt of pts.slice(0, 6)) {
      const li = document.createElement("li"); if (pt.status === "warn") li.className = "warn";
      const i = document.createElement("i"), t = document.createElement("span"); t.textContent = pt.text;
      li.append(i, t); reasons.append(li);
    }
    add("h2", "", "Why we're warning you"); card.append(reasons);
    if (r.missingChecks?.length) add("div", "sc", `${r.missingChecks.length} check${r.missingChecks.length === 1 ? "" : "s"} could not run, so this may be incomplete.`);

    // Direct shop review link (Step 1):
    const tpUrl = r.reviews?.url || `https://www.trustpilot.com/review/${encodeURIComponent(r.domain)}`;
    const linkP = document.createElement("p");
    linkP.style.cssText = "margin:14px 0 10px;";
    const tpLink = document.createElement("a");
    tpLink.href = tpUrl;
    tpLink.target = "_blank";
    tpLink.rel = "noreferrer";
    tpLink.style.cssText = "color:#2563eb;font-weight:700;text-decoration:underline;font-size:14px;";
    tpLink.textContent = `Trustpilot reviews for ${r.domain} \u2197`;
    linkP.append(tpLink);
    card.append(linkP);

    add("h2", "", "Safer steps");
    const tips = document.createElement("ul"); tips.className = "tips";
    const tipText = ["Pay by credit card or a protected method, not a bank transfer or gift cards",
      "Search the shop name + \"scam\" or \"reviews\" before paying",
      "Screenshot the listing, price and seller details"];
    for (const t of tipText) { const li = document.createElement("li"); const i = document.createElement("i"), sp = document.createElement("span"); sp.textContent = t; li.append(i, sp); tips.append(li); }
    card.append(tips);

    const disc = document.createElement("div");
    disc.style.cssText = "font-size:11px;color:#9ca3af;margin-top:14px;line-height:1.4;";
    disc.textContent = "BeforeYouBuy reports public evidence and buyer feedback. It does not guarantee the seller.";
    card.append(disc);

    const row = document.createElement("div"); row.className = "row";
    const prevFocus = document.activeElement;                       // restore the user's place when the dialog closes
    const close = () => { overlay.remove(); try { prevFocus?.focus?.(); } catch { /* element gone */ } };
    const go = document.createElement("button"); go.className = "go"; go.textContent = "Go back to safety";
    go.onclick = () => { close(); if (history.length > 1) history.back(); else location.href = "https://www.google.com/"; };
    const cont = document.createElement("button"); cont.className = "cont"; cont.textContent = "I understand the risk, continue";
    cont.onclick = async () => { try { await chrome.storage.local.set({ [ackKey]: Date.now() }); } catch { /* ignore */ } close(); };
    row.append(go, cont); card.append(row);
    add("div", "sc", DISCLAIMER);

    // Keep keyboard focus inside the warning: Tab cycles through its controls, never into the risky page beneath.
    card.addEventListener("keydown", (e) => {
      if (e.key !== "Tab") return;                                  // Escape deliberately does nothing: closing must be an explicit choice
      const items = [...card.querySelectorAll("a[href], button")];
      if (!items.length) return;
      const i = items.indexOf(sh.activeElement);
      e.preventDefault();
      items[(i + (e.shiftKey ? -1 : 1) + items.length) % items.length].focus();
    });

    bg.append(card); sh.append(st, bg);
    document.documentElement.appendChild(overlay);
    go.focus?.();
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== "report") return;
    render(msg.report);
    maybeInterstitial(msg.report);
  });
})();
