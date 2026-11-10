// Conservative fallback for shopping cards that expose a seller as text (for
// example "Footy.com & more") but omit the seller from every link target.
(() => {
  const DOMAIN = /(?:^|[\s(\[{:>])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,24}))(?![a-z0-9.-])/i;
  const SEARCH = /^(?:www\.)?(?:google|bing|duckduckgo|yahoo|ecosia|startpage|brave|yandex|baidu|qwant)\.[a-z.]+$/i;

  function explicitSellerUrl(text) {
    for (const line of String(text || "").split(/\r?\n/)) {
      const match = line.match(DOMAIN);
      if (!match) continue;
      const domain = match[1].toLowerCase();
      if (SEARCH.test(domain)) continue;
      try {
        const url = new URL(`https://${domain}/`);
        if (url.hostname === domain) return url.href;
      } catch { /* malformed visible domain */ }
    }
    return null;
  }

  const productWords = (text) => String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  function sameProduct(cardText, panelHeading) {
    const card = productWords(cardText), heading = productWords(panelHeading);
    return heading.length >= 12 && (` ${card} `).includes(` ${heading} `);
  }

  function visibleSellerName(text) {
    const lines = String(text || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    const price = lines.findIndex((x) => /^[£$€]\s?\d/.test(x));
    if (price < 0) return null;
    for (const line of lines.slice(price + 1, price + 5)) {
      if (line.length < 2 || line.length > 60) continue;
      if (!/[a-z]/i.test(line) || /^& more$/i.test(line)) continue;
      if (/(delivery|returns?|in stock|rating|reviews?|usually|was £|off$)/i.test(line)) continue;
      return line.replace(/\s+& more$/i, "").trim() || null;
    }
    return null;
  }

  globalThis.TrustCheckSearch = Object.freeze({ explicitSellerUrl, sameProduct, visibleSellerName });
})();
