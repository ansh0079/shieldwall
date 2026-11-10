// Extract seller-level Schema.org ratings published by the merchant itself.
// Product ratings are deliberately excluded: they do not establish seller trust.
(() => {
  const SELLER_TYPES = new Set(["organization", "corporation", "onlinestore", "store", "localbusiness"]);

  function types(value) {
    return (Array.isArray(value) ? value : [value]).map((x) => String(x || "").toLowerCase());
  }

  function candidates(value, out = []) {
    if (Array.isArray(value)) { for (const item of value) candidates(item, out); return out; }
    if (!value || typeof value !== "object") return out;
    if (types(value["@type"]).some((t) => SELLER_TYPES.has(t)) && value.aggregateRating)
      out.push(value.aggregateRating);
    if (value["@graph"]) candidates(value["@graph"], out);
    return out;
  }

  function parseMerchantRating(jsonTexts) {
    const found = [];
    for (const raw of jsonTexts || []) {
      try { candidates(JSON.parse(raw), found); } catch { /* invalid merchant JSON-LD */ }
    }
    const valid = found.map((r) => {
      const value = Number(r.ratingValue), best = Number(r.bestRating ?? 5), worst = Number(r.worstRating ?? 1);
      const count = Number(r.reviewCount ?? r.ratingCount);
      if (![value, best, worst, count].every(Number.isFinite) || count < 1 || best <= worst || value < worst || value > best) return null;
      return { value, best, worst, count: Math.floor(count), source: "Merchant website", claimed: true };
    }).filter(Boolean).sort((a, b) => b.count - a.count);
    return valid[0] || null;
  }

  globalThis.TrustCheckMerchantRating = Object.freeze({ parseMerchantRating });
})();
