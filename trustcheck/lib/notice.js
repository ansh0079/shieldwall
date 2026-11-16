// When the on-page badge should auto-open its details panel.
// Default ("auto"): only for a real warning, not on every shop page.
// "quiet" / "off": never auto-open. Per-site 30-day mute is handled elsewhere.
(() => {
  const severe = (v) => v === "risky" || v === "dangerous";
  function hasRedFlags(r) {
    const reviews = r && r.reviews;
    const poorReviews = reviews && reviews.score !== null && Number.isFinite(Number(reviews.score)) && reviews.score < 3 && reviews.count >= 5;
    const badSignal = Array.isArray(r && r.signals) && r.signals.some((s) => s && s.status === "bad");
    const neverArrived = r && r.buyerOutcomes && Number(r.buyerOutcomes.never) > 0;
    return !!(poorReviews || badSignal || neverArrived);
  }
  function shouldAutoOpenNotice(r) {
    if (!r) return false;
    const mode = r.ui && r.ui.mode;
    if (mode === "quiet" || mode === "off") return false;
    if (severe(r.verdict)) return true;
    if (r.verdict === "caution") return true;
    if (r.verdict === "limited" && hasRedFlags(r)) return true;
    return false;
  }
  globalThis.shouldAutoOpenNotice = shouldAutoOpenNotice;
})();
