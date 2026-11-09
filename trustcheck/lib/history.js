// "How long has this shop been online?" Combines domain registration date and first Internet Archive snapshot.
const YEAR = 365.25 * 86400000;
export const fmtMonth = (iso) => new Date(iso).toLocaleDateString("en-GB", { month: "short", year: "numeric" });
export const yearsBetween = (a, b = Date.now()) => (b - new Date(a).getTime()) / YEAR;

// Lines shown to the buyer, most useful first.
export function historyLines({ registered, archived }, now = Date.now()) {
  const out = [];
  if (archived) out.push(`First seen online: ${fmtMonth(archived)} (${yearsText(yearsBetween(archived, now))})`);
  if (registered) out.push(`Domain registered: ${fmtMonth(registered)} (${yearsText(yearsBetween(registered, now))})`);
  return out;
}
export function yearsText(y) {
  if (y < 1 / 12) return "under a month";
  if (y < 1) return `${Math.max(1, Math.round(y * 12))} month${Math.round(y * 12) === 1 ? "" : "s"}`;
  return `${y.toFixed(1)} years`;
}

// An old domain whose site only appeared recently suggests a re-used or bought domain, not a long-trading shop.
export function historySignals({ registered, archived }) {
  if (!registered || !archived) return [];
  const gap = yearsBetween(registered, new Date(archived).getTime());
  if (gap > 2) return [{ id: "reuse", label: `Domain is ${yearsText(yearsBetween(registered))} old, but the site only appeared online in ${fmtMonth(archived)}`,
    status: "warn", points: -10, detail: "The domain may have been bought or re-used. Its age may not reflect how long this shop has traded." }];
  return [];
}
