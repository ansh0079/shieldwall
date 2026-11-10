// Price anomaly detection with outlier rejection and match confidence.
const PRICE_RE = /([£$€])\s?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/;

export function parsePrice(text) {
  const m = PRICE_RE.exec(String(text || ""));
  if (!m) return null;
  const value = parseFloat(m[2].replace(/,/g, ""));
  return value > 0 ? { cur: m[1], value } : null;
}

export function median(values) {
  if (!values.length) return 0;
  const v = [...values].sort((a, b) => a - b), mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// Rejects extreme pricing outliers using Interquartile Range (IQR)
export function filterOutliers(numbers) {
  if (numbers.length < 5) return numbers;
  const sorted = [...numbers].sort((a, b) => a - b);
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const q3 = sorted[Math.floor(sorted.length * 0.75)];
  const iqr = q3 - q1;
  if (iqr <= 0) return sorted;
  const low = q1 - 1.5 * iqr;
  const high = q3 + 1.5 * iqr;
  const filtered = sorted.filter((x) => x >= low && x <= high);
  return filtered.length >= 3 ? filtered : sorted;
}

// cardText: text of the hovered result; pagePrices: price strings seen on the results page.
export function priceContext({ cardText, pagePrices = [] }) {
  if (/pre-?owned|\bused\b|refurb|second[- ]?hand/i.test(cardText || "")) return null; // second-hand is cheap legitimately
  const p = parsePrice(cardText);
  if (!p) return null;
  const rawVals = pagePrices.map(parsePrice).filter((x) => x && x.cur === p.cur).map((x) => x.value);
  if (rawVals.length < 5) return null; // too few prices to know the going rate

  const filteredVals = filterOutliers(rawVals);
  const med = median(filteredVals);
  const confidence = filteredVals.length >= 8 ? "high" : "moderate";

  return { cur: p.cur, price: p.value, median: med, n: filteredVals.length, confidence };
}

export function priceSignals(ctx) {
  if (!ctx || !(ctx.median > 0)) return [];
  const ratio = ctx.price / ctx.median, pct = Math.round((1 - ratio) * 100);
  const label = `${ctx.cur}${ctx.price.toFixed(2)} is ${pct}% below the typical ${ctx.cur}${Math.round(ctx.median)} for this search`;
  const qualifier = ctx.confidence === "high" ? "Substantially below comparable prices" : "Possibly below comparable prices";
  const detail = `${qualifier}: compared with ${ctx.n} typical prices on the results page. Goods far below the going rate can indicate counterfeits or non-delivery scams.`;

  if (ratio <= 0.55) return [{ id: "price", label, status: "bad", points: -25, detail, confidence: ctx.confidence }];
  if (ratio <= 0.7) return [{ id: "price", label, status: "warn", points: -12, detail, confidence: ctx.confidence }];
  return [];
}
