// Price anomaly: a listing far below the going rate for the same search is a common fake-shop / counterfeit sign.
const PRICE_RE = /([£$€])\s?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/;

export function parsePrice(text) {
  const m = PRICE_RE.exec(String(text || ""));
  if (!m) return null;
  const value = parseFloat(m[2].replace(/,/g, ""));
  return value > 0 ? { cur: m[1], value } : null;
}

export function median(values) {
  const v = [...values].sort((a, b) => a - b), mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// cardText: text of the hovered result; pagePrices: price strings seen on the results page.
export function priceContext({ cardText, pagePrices = [] }) {
  if (/pre-?owned|\bused\b|refurb|second[- ]?hand/i.test(cardText || "")) return null; // second-hand is cheap legitimately
  const p = parsePrice(cardText);
  if (!p) return null;
  const vals = pagePrices.map(parsePrice).filter((x) => x && x.cur === p.cur).map((x) => x.value);
  if (vals.length < 5) return null; // too few prices to know the going rate
  return { cur: p.cur, price: p.value, median: median(vals), n: vals.length };
}

export function priceSignals(ctx) {
  if (!ctx || !(ctx.median > 0)) return [];
  const ratio = ctx.price / ctx.median, pct = Math.round((1 - ratio) * 100);
  const label = `${ctx.cur}${ctx.price.toFixed(2)} is ${pct}% below the typical ${ctx.cur}${Math.round(ctx.median)} for this search`;
  const detail = `Compared with ${ctx.n} prices on the results page you viewed. Branded goods far below the going rate are a common sign of fake shops or counterfeits, though genuine sales exist.`;
  if (ratio <= 0.55) return [{ id: "price", label, status: "bad", points: -25, detail }];
  if (ratio <= 0.7) return [{ id: "price", label, status: "warn", points: -12, detail }];
  return [];
}
