// Trustpilot summary provider for the BeforeYouBuy report server.
// Runs on the server so API keys are never shipped in the browser extension.
import { summarizeThemes } from "../lib/themes.js";

const ok = async (res) => { if (!res.ok) throw new Error("HTTP " + res.status); return res.json(); };

export async function fetchTrustpilotSummary(domain, apiKey = "") {
  const clean = domain.toLowerCase().trim().replace(/^www\./, "");
  const defaultUrl = `https://www.trustpilot.com/review/${encodeURIComponent(clean)}`;

  // 1. If official API key is provided, use Trustpilot Business API
  if (apiKey) {
    try {
      const buUrl = `https://api.trustpilot.com/v1/business-units/find?name=${encodeURIComponent(clean)}`;
      const bu = await ok(await fetch(buUrl, { headers: { apikey: apiKey }, signal: AbortSignal.timeout(4000) }));
      const rawScore = bu.trustScore?.stars ?? bu.trustScore ?? bu.score;
      const rawCount = bu.numberOfReviews?.total ?? bu.numberOfReviews;
      const score = Number(rawScore);
      const count = Number(rawCount);
      if (!Number.isFinite(score) || !Number.isFinite(count)) throw new Error("invalid Trustpilot response");
      const id = bu.id;

      let themes = [];
      if (id) {
        try {
          const revsUrl = `https://api.trustpilot.com/v1/business-units/${encodeURIComponent(id)}/reviews?perPage=20`;
          const revs = await ok(await fetch(revsUrl, { headers: { apikey: apiKey }, signal: AbortSignal.timeout(4000) }));
          const texts = (revs.reviews || []).map((r) => `${r.title || ""} ${r.text || ""}`).filter(Boolean);
          themes = summarizeThemes(texts).themes;
        } catch { /* reviews fetch failed: themes remain empty */ }
      }

      return {
        source: "Trustpilot",
        score,
        count,
        sample: themes.length ? Math.min(20, count) : 0,
        themes,
        url: defaultUrl
      };
    } catch {
      // Licensed API unavailable: retain only the neutral link below.
    }
  }

  // Always return the direct review link even if score cannot be loaded
  return {
    source: "Trustpilot",
    score: null,
    count: null,
    sample: 0,
    themes: [],
    url: defaultUrl
  };
}
