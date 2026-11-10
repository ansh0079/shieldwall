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

  globalThis.TrustCheckSearch = Object.freeze({ explicitSellerUrl });
})();
