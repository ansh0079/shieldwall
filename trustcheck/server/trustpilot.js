// Trustpilot summary provider for the TrustCheck report server.
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
      const score = Number(bu.trustScore || bu.score || 0);
      const count = Number(bu.numberOfReviews?.total || bu.numberOfReviews || 0);
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
        sample: count,
        themes,
        url: defaultUrl
      };
    } catch {
      // Fall through to public page parsing
    }
  }

  // 2. Fallback: Parse public review page for aggregate schema markup
  try {
    const res = await fetch(defaultUrl, {
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) TrustCheck/0.2.0",
        "accept": "text/html,application/xhtml+xml"
      },
      signal: AbortSignal.timeout(4000)
    });
    if (res.ok) {
      const html = await res.text();
      // Look for JSON-LD schema or data attributes
      const jsonMatch = html.match(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
      let score = null, count = null;
      if (jsonMatch) {
        try {
          const data = JSON.parse(jsonMatch[1]);
          const ar = data.aggregateRating || (Array.isArray(data["@graph"]) && data["@graph"].find((x) => x.aggregateRating)?.aggregateRating);
          if (ar) {
            score = Number(ar.ratingValue);
            count = Number(ar.reviewCount);
          }
        } catch { /* parse error */ }
      }

      // Regex fallback if JSON-LD wasn't present
      if (score === null) {
        const ratingMatch = html.match(/data-rating="([0-9.]+)"|headline-headline[^>]*>([0-9.]+)<\/span>/i);
        const countMatch = html.match(/([0-9,]+)\s+reviews?/i);
        if (ratingMatch) score = parseFloat(ratingMatch[1] || ratingMatch[2]);
        if (countMatch) count = parseInt(countMatch[1].replace(/,/g, ""), 10);
      }

      if (score !== null && !isNaN(score)) {
        return {
          source: "Trustpilot",
          score,
          count: count || 0,
          sample: count || 0,
          themes: [],
          url: defaultUrl
        };
      }
    }
  } catch {
    // Page fetch error
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
